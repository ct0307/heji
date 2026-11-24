import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseConfig, createDatabasePool } from '../../apps/api/src/shared/database.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import { ApiFault } from '../../apps/api/src/shared/errors.ts';
import { tokenHash } from '../../apps/api/src/modules/identity/security.ts';
import type { MemberDto, TransferRequestDto, TransferPreviewDto, ConfirmationDto, ExpenseDto, FinanceSnapshotDto } from '../../packages/contracts/src/index.ts';

/** 使用已批准的heji_dev真实事务；只新增无可用登录密码的虚构用户及其账本，不删除数据。 */
test('M2幂等重放先授权、后业务状态回归',async t=>{
  const config=databaseConfig();assert.equal(config?.database,'heji_dev');assert.ok(config);
  const pool=createDatabasePool(config),store=new MysqlFinanceStore(pool);
  t.after(()=>pool.end());
  const a=randomUUID(),b=randomUUID(),c=randomUUID();
  for(const [id,label] of [[a,'甲'],[b,'乙'],[c,'丙']] as const){
    await pool.execute('INSERT INTO users(id,email,displayName,passwordHash,createdAt) VALUES(?,?,?,?,UTC_TIMESTAMP(3))',[id,`replay-${id}@example.test`,`重放虚构${label}`,'fixture-disabled-login']);
  }
  async function group(){
    const book=await store.createBook(a,'M2重放虚构验收');
    for(const id of [b,c]){const hash=tokenHash(randomUUID());await store.createInvitation(a,book.id,hash);await store.acceptInvitation(id,hash)}
    const members=await store.members(a,book.id),member=(userId: string)=>members.find(x=>x.userId===userId) as MemberDto;
    return {id:book.id,ma:member(a).id,mb:member(b).id,mc:member(c).id};
  }
  type Group=Awaited<ReturnType<typeof group>>;
  const context=()=>({idempotencyKey:randomUUID()});
  async function request(g: Group){return (await store.execute(b,g.id,'request.create',{toMemberId:g.ma,amountFen:'100',occurredOn:'2026-11-17',note:'虚构转账'},context())).data as TransferRequestDto}
  async function preview(g: Group,id: string,actor=a){return (await store.read(actor,g.id,'preview',id)).data as TransferPreviewDto}
  const confirmationBody=(value: TransferPreviewDto)=>({expectedRequestRevision:value.expectedRequestRevision,expectedFinancialVersion:value.expectedFinancialVersion});
  async function confirm(g: Group,id: string,actor=a){const body=confirmationBody(await preview(g,id,actor));return (await store.execute(actor,g.id,'request.confirm',body,{...context(),resourceId:id})).data as ConfirmationDto}
  const rejects=(status: number,code: string)=>(error: unknown)=>error instanceof ApiFault&&error.status===status&&error.code===code;

  await t.test('冲正被确认后原提交键重放仍返回原201，新的提交键保持409',async()=>{
    const g=await group(),normal=await request(g),confirmed=await confirm(g,normal.id);
    const input={occurredOn:'2026-11-17',note:'撤销虚构错误登记'},write={...context(),resourceId:confirmed.transfer.id};
    const first=await store.execute(a,g.id,'transfer.reverse',input,write),reversal=first.data as TransferRequestDto;
    assert.equal(first.status,201);await confirm(g,reversal.id,b);
    const replay=await store.execute(a,g.id,'transfer.reverse',input,write);
    assert.deepEqual(replay,first);
    await assert.rejects(store.execute(a,g.id,'transfer.reverse',input,{...context(),resourceId:confirmed.transfer.id}),rejects(409,'TRANSFER_ALREADY_REVERSED'));
    assert.equal(((await store.read(a,g.id,'transfers')).data as unknown[]).length,2);
  });

  await t.test('合法counterparty可在归档后用新键重复确认，仍引用原转账',async()=>{
    const g=await group(),item=await request(g),confirmed=await confirm(g,item.id);
    // 用独立冲正结清余额后归档，原请求仍是CONFIRMED。
    const reverse=(await store.execute(a,g.id,'transfer.reverse',{occurredOn:'2026-11-17',note:''},{...context(),resourceId:confirmed.transfer.id})).data as TransferRequestDto;
    await confirm(g,reverse.id,b);await store.execute(a,g.id,'book.archive',{},context());
    const repeated=(await store.execute(a,g.id,'request.confirm',{expectedRequestRevision:'1',expectedFinancialVersion:'0'},{...context(),resourceId:item.id})).data as ConfirmationDto;
    assert.equal(repeated.transfer.id,confirmed.transfer.id);
    assert.equal(((await store.read(a,g.id,'transfers')).data as unknown[]).length,2);
  });

  await t.test('有效第三人成员持有合法确认键也必须被拒绝403',async()=>{
    const g=await group(),item=await request(g),body=confirmationBody(await preview(g,item.id)),write={...context(),resourceId:item.id};
    await store.execute(a,g.id,'request.confirm',body,write);
    await assert.rejects(store.execute(c,g.id,'request.confirm',body,write),rejects(403,'ACTION_FORBIDDEN'));
  });

  await t.test('退出成员不能凭旧支出创建键重放取回账目',async()=>{
    const g=await group(),input={paidByMemberId:g.mb,amountFen:'100',splitMode:'EQUAL',participantMemberIds:[g.mb],category:'OTHER',occurredOn:'2026-11-17',note:'退出前虚构支出'},write=context();
    const first=await store.execute(b,g.id,'expense.create',input,write);assert.ok((first.data as ExpenseDto).id);
    await store.execute(b,g.id,'member.leave',{},context());
    await assert.rejects(store.execute(b,g.id,'expense.create',input,write),rejects(404,'BOOK_NOT_FOUND'));
  });

  await t.test('余额全零但有待确认请求时快照不能宣称已结清',async()=>{
    const g=await group();await request(g);
    const snapshot=(await store.read(a,g.id,'snapshot')).data as FinanceSnapshotDto;
    assert.ok(snapshot.balances.every(x=>x.balanceFen==='0'));assert.equal(snapshot.pendingCount,1);assert.equal(snapshot.isSettled,false);
  });

  await t.test('金额和份额相同但切换分摊模式时递增财务版本',async()=>{
    const g=await group(),created=(await store.execute(a,g.id,'expense.create',{paidByMemberId:g.ma,amountFen:'100',splitMode:'EQUAL',participantMemberIds:[g.ma,g.mb],category:'OTHER',occurredOn:'2026-11-17',note:''},context())).data as ExpenseDto;
    const before=(await store.read(a,g.id,'snapshot')).data as FinanceSnapshotDto;
    const patched=(await store.execute(a,g.id,'expense.patch',{splitMode:'EXACT',shares:created.shares},{...context(),resourceId:created.id,ifMatch:created.etag})).data as ExpenseDto;
    const after=(await store.read(a,g.id,'snapshot')).data as FinanceSnapshotDto;
    assert.equal(patched.splitMode,'EXACT');assert.deepEqual(patched.shares,created.shares);
    assert.equal(after.financialVersion,(BigInt(before.financialVersion)+1n).toString());
  });

  await t.test('历史版本按版本号倒序，不受发生日期修改影响',async()=>{
    const g=await group(),created=(await store.execute(a,g.id,'expense.create',{paidByMemberId:g.ma,amountFen:'100',splitMode:'EQUAL',participantMemberIds:[g.ma],category:'OTHER',occurredOn:'2026-11-17',note:''},context())).data as ExpenseDto;
    await store.execute(a,g.id,'expense.patch',{occurredOn:'2026-11-16'},{...context(),resourceId:created.id,ifMatch:created.etag});
    const history=(await store.read(a,g.id,'expenseHistory',created.id)).data as ExpenseDto[];
    assert.deepEqual(history.map(x=>x.revision),['2','1']);
  });

  await t.test('过期ETag返回设计约定的ETAG_MISMATCH错误码',async()=>{
    const g=await group(),created=(await store.execute(a,g.id,'expense.create',{paidByMemberId:g.ma,amountFen:'100',splitMode:'EQUAL',participantMemberIds:[g.ma],category:'OTHER',occurredOn:'2026-11-17',note:''},context())).data as ExpenseDto;
    const write={...context(),resourceId:created.id,ifMatch:created.etag};
    await store.execute(a,g.id,'expense.patch',{note:'新版本'},write);
    await assert.rejects(store.execute(a,g.id,'expense.patch',{note:'旧版本冲突'},{...context(),resourceId:created.id,ifMatch:created.etag}),rejects(412,'ETAG_MISMATCH'));
  });
});
