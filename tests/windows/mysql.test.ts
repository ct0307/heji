import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { databaseConfig,createDatabasePool } from '../../apps/api/src/shared/database.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import type { TransferRequestDto,SettlementWindowDto,SettlementWindowPreviewDto,ConfirmationDto } from '../../packages/contracts/src/index.ts';

/** 单独获批后运行；新建并保留虚构数据，不迁移、不清库、不修改既有实验事实。 */
test('004真实MySQL多连接与生命周期验收（需独立写入许可）',{timeout:120000},async t=>{
  assert.equal(process.env.HEJI_ALLOW_WINDOW_TEST,'yes','必须先取得本轮真实库写入许可并临时设置HEJI_ALLOW_WINDOW_TEST=yes');
  const config=databaseConfig();assert.ok(config?.database==='heji_dev'&&['127.0.0.1','localhost','::1'].includes(config.host),'仅允许本机heji_dev');
  const pool=createDatabasePool(config);t.after(()=>pool.end());
  assert.equal((await pool.execute<RowDataPacket[]>('SELECT name FROM schema_migrations WHERE name=?',['004_settlement_windows.sql']))[0].length,1,'先独立批准并执行004；本测试不会自动迁移');
  const store=new MysqlFinanceStore(pool),a=randomUUID(),b=randomUUID(),c=randomUUID();
  for(const [id,label] of [[a,'甲'],[b,'乙'],[c,'丙']] as const)await pool.execute('INSERT INTO users(id,email,displayName,passwordHash,createdAt) VALUES(?,?,?,?,UTC_TIMESTAMP(3))',[id,id+'@window.example.test','窗口验收'+label,'TEST_ACCOUNT_LOGIN_DISABLED']);
  const context=(resourceId?:string,key=randomUUID())=>({idempotencyKey:key,...(resourceId?{resourceId}:{})});
  const fault=(code:string)=>(error:unknown)=>(error as {code:string}).code===code;
  async function fixture(){
    const book=await store.createBook(a,'结算窗口虚构验收 '+randomUUID().slice(0,8));
    const invite=createHash('sha256').update(randomUUID()).digest('hex');await store.createInvitation(a,book.id,invite);await store.acceptInvitation(b,invite);
    const members=await store.members(a,book.id),am=members.find(x=>x.userId===a)!.id,bm=members.find(x=>x.userId===b)!.id;
    const expense={paidByMemberId:am,amountFen:'200',splitMode:'EQUAL',participantMemberIds:[am,bm],category:'OTHER',occurredOn:'2026-11-19',note:'本轮虚构窗口测试'};
    await store.execute(a,book.id,'expense.create',expense,context());
    const request=(await store.execute(b,book.id,'request.create',{toMemberId:am,amountFen:'100',occurredOn:'2026-11-19',note:''},context())).data as TransferRequestDto;
    return {book,am,bm,expense,request};
  }
  await t.test('两个连接竞争只取得一个窗口；财务及邀请加入受阻，绑定确认与重放仅入账一次',async()=>{
    const f=await fixture(),keys=[randomUUID(),randomUUID()];
    const results=await Promise.allSettled(keys.map(key=>store.execute(a,f.book.id,'window.open',{},context(f.request.id,key))));
    const wins=results.filter(x=>x.status==='fulfilled');assert.equal(wins.length,1);
    const denied=results.find(x=>x.status==='rejected') as PromiseRejectedResult;assert.ok(fault('SETTLEMENT_WINDOW_ACTIVE')(denied.reason));
    const opened=(wins[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof store.execute>>>).value.data as SettlementWindowPreviewDto;
    const failedKey=randomUUID();
    await assert.rejects(()=>store.execute(a,f.book.id,'expense.create',f.expense,context(undefined,failedKey)),fault('SETTLEMENT_WINDOW_ACTIVE'));
    assert.equal((await pool.execute<RowDataPacket[]>('SELECT requestKey FROM idempotency_records WHERE actorId=? AND bookId=? AND requestKey=?',[a,f.book.id,failedKey]))[0].length,0);
    const invite=createHash('sha256').update(randomUUID()).digest('hex');await store.createInvitation(a,f.book.id,invite);
    await assert.rejects(()=>store.acceptInvitation(c,invite),fault('SETTLEMENT_WINDOW_ACTIVE'));
    await store.renameBook(a,f.book.id,'窗口期间允许改名');
    const other=(await store.read(b,f.book.id,'window')).data as SettlementWindowDto;assert.equal(other.requestId,null);assert.equal(other.mine,false);
    const body={expectedRequestRevision:opened.preview.expectedRequestRevision,expectedFinancialVersion:opened.preview.expectedFinancialVersion,expectedWindowId:opened.window.windowId};
    await assert.rejects(()=>store.execute(a,f.book.id,'request.confirm',{...body,expectedFinancialVersion:'0'},context(f.request.id)),fault('PREVIEW_STALE'));
    const confirmContext=context(f.request.id),confirmed=(await store.execute(a,f.book.id,'request.confirm',body,confirmContext)).data as ConfirmationDto;
    await store.execute(a,f.book.id,'request.confirm',body,confirmContext);await store.execute(a,f.book.id,'request.confirm',body,context(f.request.id));
    assert.equal((await pool.execute<RowDataPacket[]>('SELECT id FROM confirmed_transfers WHERE bookId=? AND requestId=?',[f.book.id,f.request.id]))[0].length,1);
    assert.equal(confirmed.snapshot.balances.every(x=>x.balanceFen==='0'),true);
    assert.equal(((await store.read(a,f.book.id,'window')).data as SettlementWindowDto).state,'CLOSED');
    await store.acceptInvitation(c,invite);
    await store.execute(a,f.book.id,'expense.create',f.expense,context(undefined,failedKey));
  });
  await t.test('绑定取消及拒绝原子关闭窗口，普通写入在冷却期开放',async()=>{
    for(const operation of ['request.cancel','request.reject'] as const){
      const f=await fixture();await store.execute(a,f.book.id,'window.open',{},context(f.request.id));
      await store.execute(operation==='request.cancel'?b:a,f.book.id,operation,{expectedRequestRevision:'1'},context(f.request.id));
      const state=(await store.read(a,f.book.id,'window')).data as SettlementWindowDto;assert.equal(state.state,'CLOSED');
      assert.equal(Date.parse(state.cooldownUntil!)-Date.parse(state.closedAt!),30000);
      await store.execute(a,f.book.id,'expense.create',f.expense,context());
    }
  });
  await t.test('自然到期无需清理即可恢复写入；冷却后新窗口不受旧关闭及旧申请重放影响',async()=>{
    const f=await fixture(),openContext=context(f.request.id),first=(await store.execute(a,f.book.id,'window.open',{},openContext)).data as SettlementWindowPreviewDto;
    await delay(Math.max(0,Date.parse(first.window.expiresAt!)-Date.parse(first.window.serverTime))+100);
    await store.execute(a,f.book.id,'expense.create',f.expense,context());
    await assert.rejects(()=>store.execute(a,f.book.id,'request.confirm',{expectedRequestRevision:'1',expectedFinancialVersion:first.preview.expectedFinancialVersion,expectedWindowId:first.window.windowId},context(f.request.id)),fault('SETTLEMENT_WINDOW_EXPIRED'));
    await assert.rejects(()=>store.execute(a,f.book.id,'window.open',{},context(f.request.id)),fault('SETTLEMENT_WINDOW_COOLDOWN'));
    const expired=(await store.read(a,f.book.id,'window')).data as SettlementWindowDto;
    await delay(Math.max(0,Date.parse(expired.cooldownUntil!)-Date.parse(expired.serverTime))+100);
    const next=(await store.execute(a,f.book.id,'window.open',{},context(f.request.id))).data as SettlementWindowPreviewDto;assert.notEqual(first.window.windowId,next.window.windowId);
    await assert.rejects(()=>store.execute(a,f.book.id,'window.close',{},context(first.window.windowId!)),fault('SETTLEMENT_WINDOW_EXPIRED'));
    const replay=(await store.execute(a,f.book.id,'window.open',{},openContext)).data as SettlementWindowPreviewDto;assert.equal(replay.window.windowId,first.window.windowId);assert.equal(replay.window.state,'EXPIRED');
    assert.equal(((await store.read(a,f.book.id,'window')).data as SettlementWindowDto).windowId,next.window.windowId);
    await store.execute(a,f.book.id,'window.close',{},context(next.window.windowId!));
  });
  await t.test('窗口插入后预览故障，真实事务回滚，无幽灵窗口/幂等/审计',async()=>{
    const f=await fixture(),broken=new MysqlFinanceStore(pool),key=randomUUID();
    broken.confirmationPreview=async()=>{throw new Error('本轮注入预览故障')};
    await assert.rejects(()=>broken.execute(a,f.book.id,'window.open',{},context(f.request.id,key)),/本轮注入预览故障/);
    assert.equal((await pool.execute<RowDataPacket[]>('SELECT bookId FROM settlement_windows WHERE bookId=?',[f.book.id]))[0].length,0);
    assert.equal((await pool.execute<RowDataPacket[]>('SELECT requestKey FROM idempotency_records WHERE bookId=? AND requestKey=?',[f.book.id,key]))[0].length,0);
    assert.equal((await pool.execute<RowDataPacket[]>("SELECT id FROM audit_events WHERE bookId=? AND eventType='SETTLEMENT_WINDOW_OPENED'",[f.book.id]))[0].length,0);
    const opened=(await store.execute(a,f.book.id,'window.open',{},context(f.request.id,key))).data as SettlementWindowPreviewDto;
    await store.execute(a,f.book.id,'window.close',{},context(opened.window.windowId!));
  });
});
