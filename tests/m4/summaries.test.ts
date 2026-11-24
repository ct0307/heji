import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolConnection,RowDataPacket } from 'mysql2/promise';
import type { ExpenseDto,FinanceSnapshotDto,ReportDto,TransferRequestDto,TransferPreviewDto,ConfirmationDto } from '../../packages/contracts/src/index.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import { backfillSummaries } from '../../apps/api/src/modules/finance/mysql-summaries.ts';
import { createTemporarySummaries } from './summary-tables.ts';
import { fixturePool } from './database.ts';
import { bookId,memberId,userId } from './seed.ts';

test('M4增量汇总：真实临时表、原始事实对账、全部写入回滚',async t=>{
  const pool=await fixturePool(),db=await pool.getConnection();
  t.after(async()=>{await db.rollback();db.release();await pool.end()});
  await createTemporarySummaries(db);await db.query('START TRANSACTION');
  await backfillSummaries(db);await db.commit();
  await assert.rejects(()=>backfillSummaries(db),/空|初建/);
  const sql:string[]=[];
  const measured=new Proxy(db,{get(target,key){const value=Reflect.get(target,key);
    if(key==='execute')return (...args:unknown[])=>{sql.push(String(args[0]));return Reflect.apply(value,target,args)};
    return typeof value==='function'?value.bind(target):value;
  }});
  // 多个业务调用共享一轮测试事务；只测试持账本锁内逻辑，最终整轮回滚。
  class TransactionStore extends MysqlFinanceStore {override financeTransaction<T>(work:(connection:PoolConnection)=>Promise<T>){return work(measured)}}
  const store=new TransactionStore(pool,{summaries:true}),reference=new TransactionStore(pool,{summaries:false});
  const book=bookId(9),a=userId(0),b=userId(1),ma=memberId(9,0),mb=memberId(9,1);
  async function snapshot(target:TransactionStore=store){return (await target.read(a,book,'snapshot')).data as FinanceSnapshotDto}
  async function report(target:TransactionStore=store,query:Record<string,unknown>={}){return (await target.read(a,book,'report',undefined,query)).data as ReportDto}
  async function compare(){
    const actual=await snapshot(),expected=await snapshot(reference);assert.deepEqual(actual,expected);
    assert.equal(actual.balances.reduce((sum,x)=>sum+BigInt(x.balanceFen),0n),0n);
    assert.deepEqual(await report(),await report(reference));
    for(const query of [{from:'2026-11-18',to:'2026-11-18'},{from:'2026-11-19',to:'2026-11-19'},{from:'2028-01-01'}])assert.deepEqual(await report(store,query),await report(reference,query));
  }
  async function execute(actor:string,operation:Parameters<typeof store.execute>[2],input:unknown,resourceId?:string,ifMatch?:string,key=randomUUID()){
    return store.execute(actor,book,operation,input,{idempotencyKey:key,...(resourceId?{resourceId}:{}),...(ifMatch?{ifMatch}:{})});
  }
  await db.query('START TRANSACTION');
  const before=await snapshot(reference);
  const [auditBefore]=await db.execute<RowDataPacket[]>('SELECT COUNT(*) count FROM audit_events WHERE bookId=?',[book]);
  await t.test('初建与原始余额/期间一致，汇总读取不扫描原始份额',async()=>{
    sql.length=0;await snapshot();await report();
    assert.ok(sql.some(x=>x.includes('finance_member_totals')),'新模式必须读取成员汇总');
    assert.ok(!sql.some(x=>x.includes('expense_shares')),'汇总读不应再扫描原始份额');await compare();
    await assert.rejects(()=>store.read(userId(0),randomUUID(),'snapshot'),error=>(error as {status:number}).status===404);
  });
  await t.test('退出成员历史汇总保留，新成员缺汇总行按零',async()=>{
    // 新空账本只建成员，尚无任何汇总行；所有读应是零值且仍有成员排行。
    const emptyBook=randomUUID(),emptyMember=randomUUID(),historic=randomUUID();
    await db.execute('INSERT INTO books(id,name,createdByUserId,financialVersion,isArchived,createdAt) VALUES(?,?,?,0,0,UTC_TIMESTAMP(3))',[emptyBook,'仅回滚的新账本',a]);
    await db.execute("INSERT INTO book_members(id,bookId,userId,status,joinedAt) VALUES(?,?,?,'ACTIVE',UTC_TIMESTAMP(3))",[emptyMember,emptyBook,a]);
    await db.execute("INSERT INTO book_members(id,bookId,userId,status,joinedAt) VALUES(?,?,?,'ACTIVE',UTC_TIMESTAMP(3))",[historic,emptyBook,b]);
    assert.equal((await store.execute(b,emptyBook,'member.leave',{}, {idempotencyKey:randomUUID()})).status??200,200);
    const empty=(await store.read(a,emptyBook,'snapshot')).data as FinanceSnapshotDto;
    assert.equal(empty.expenseTotalFen,'0');assert.equal(empty.balances.length,2);assert.ok(empty.balances.every(row=>row.balanceFen==='0'));
    assert.ok(empty.balances.some(row=>row.memberId===historic));
    const report=(await store.read(a,emptyBook,'report')).data as ReportDto;
    assert.equal(report.expenseTotalFen,'0');assert.equal(report.ranking.length,2);assert.ok(report.ranking.every(row=>row.amountFen==='0'&&row.rankNo==='1'));
  });
  let expense:ExpenseDto;
  await t.test('新增零份额、同键重放不重复增量',async()=>{
    const key=randomUUID(),body={paidByMemberId:ma,amountFen:'1',splitMode:'EQUAL',participantMemberIds:[ma,mb],category:'FOOD',occurredOn:'2026-11-18',note:'临时汇总回归'};
    expense=(await execute(a,'expense.create',body,undefined,undefined,key)).data as ExpenseDto;
    assert.equal(expense.shares.filter(x=>x.amountFen==='0').length,1);
    const version=(await snapshot()).financialVersion;
    assert.deepEqual((await execute(a,'expense.create',body,undefined,undefined,key)).data,expense);
    assert.equal((await snapshot()).financialVersion,version);await compare();
  });
  await t.test('备注不改汇总；分类/日期更新期间且不改财务版本',async()=>{
    const version=(await snapshot()).financialVersion;sql.length=0;
    expense=(await execute(a,'expense.patch',{note:'仅备注'},expense.id,expense.etag)).data as ExpenseDto;
    assert.ok(!sql.some(x=>/INSERT INTO finance_/.test(x)));
    expense=(await execute(a,'expense.patch',{category:'HOUSING',occurredOn:'2026-11-19'},expense.id,expense.etag)).data as ExpenseDto;
    assert.equal((await snapshot()).financialVersion,version);await compare();
  });
  await t.test('改金额/付款人/指定分摊与作废减旧加新，历史仅算当前',async()=>{
    expense=(await execute(a,'expense.patch',{paidByMemberId:mb,amountFen:'101',splitMode:'EXACT',shares:[{memberId:ma,amountFen:'21'},{memberId:mb,amountFen:'80'}]},expense.id,expense.etag)).data as ExpenseDto;
    await compare();expense=(await execute(a,'expense.void',{note:'作废'},expense.id,expense.etag)).data as ExpenseDto;await compare();
  });
  await t.test('登记不入账、预览过期拒绝、刷新后确认与重复确认/冲正只算一次',async()=>{
    const request=(await execute(a,'request.create',{toMemberId:mb,amountFen:'1',occurredOn:'2026-11-18',note:'登记不入账'})).data as TransferRequestDto;
    const pending=await snapshot();assert.deepEqual(pending.balances,before.balances);
    let preview=(await store.read(b,book,'preview',request.id)).data as TransferPreviewDto;
    const extra=(await execute(a,'expense.create',{paidByMemberId:ma,amountFen:'2',splitMode:'EQUAL',participantMemberIds:[ma,mb],category:'OTHER',occurredOn:'2026-11-18'})).data as ExpenseDto;
    await assert.rejects(()=>execute(b,'request.confirm',{expectedFinancialVersion:preview.expectedFinancialVersion,expectedRequestRevision:preview.expectedRequestRevision},request.id),error=>(error as {code:string}).code==='PREVIEW_STALE');
    preview=(await store.read(b,book,'preview',request.id)).data as TransferPreviewDto;
    const input={expectedFinancialVersion:preview.expectedFinancialVersion,expectedRequestRevision:preview.expectedRequestRevision};
    const confirmed=(await execute(b,'request.confirm',input,request.id)).data as ConfirmationDto;
    assert.deepEqual(confirmed.snapshot.balances,preview.afterBalances);
    const once=await snapshot();await execute(b,'request.confirm',input,request.id);assert.deepEqual(await snapshot(),once);
    await compare();
    const reversal=(await execute(a,'transfer.reverse',{occurredOn:'2026-11-18',note:'登记错误冲正'},confirmed.transfer.id)).data as TransferRequestDto;
    const reversePreview=(await store.read(b,book,'preview',reversal.id)).data as TransferPreviewDto;
    await execute(b,'request.confirm',{expectedFinancialVersion:reversePreview.expectedFinancialVersion,expectedRequestRevision:reversePreview.expectedRequestRevision},reversal.id);
    await compare();await execute(a,'expense.void',{},extra.id,extra.etag);
  });
  await db.rollback();await db.query('START TRANSACTION READ ONLY');
  assert.deepEqual(await snapshot(),before,'事实、版本、汇总、待确认均整轮回滚');
  const [auditAfter]=await db.execute<RowDataPacket[]>('SELECT COUNT(*) count FROM audit_events WHERE bookId=?',[book]);assert.deepEqual(auditAfter,auditBefore);
  await db.rollback();
  await t.test('真实financeTransaction在汇总写完后故障，事实/汇总/审计/幂等全回滚且不发布',async()=>{
    const broken=new Proxy(db,{get(target,key){
      if(key==='release')return ()=>{};
      const value=Reflect.get(target,key);
      if(key==='execute')return (query:string,params:unknown[])=>{
        if(query.startsWith('INSERT INTO idempotency_records'))throw new Error('M4汇总更新后的受控故障');
        return Reflect.apply(value,target,[query,params]);
      };
      return typeof value==='function'?value.bind(target):value;
    }});
    const pinned=new Proxy(pool,{get(target,key){if(key==='getConnection')return async()=>broken;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});
    const faulty=new MysqlFinanceStore(pinned,{summaries:true});let published=0;faulty.changes.onChange(async()=>{published++});
    await assert.rejects(()=>faulty.execute(a,book,'expense.create',{paidByMemberId:ma,amountFen:'101',splitMode:'EQUAL',participantMemberIds:[ma,mb],category:'OTHER',occurredOn:'2026-11-18'}, {idempotencyKey:randomUUID()}),/受控故障/);
    await db.query('START TRANSACTION READ ONLY');assert.deepEqual(await snapshot(),before);assert.equal(published,0);
    const [audit]=await db.execute<RowDataPacket[]>('SELECT COUNT(*) count FROM audit_events WHERE bookId=?',[book]);assert.deepEqual(audit,auditBefore);
    await db.rollback();
  });
  await t.test('提交处模拟死锁，首轮全回滚后重试一次，汇总不重复且只发布一次',async()=>{
    let commits=0,published=0;
    const retryDb=new Proxy(db,{get(target,key){
      if(key==='release')return ()=>{};
      if(key==='commit')return async()=>{
        commits++;if(commits===1)throw Object.assign(new Error('M4受控提交死锁'),{code:'ER_LOCK_DEADLOCK'});
        // 第二轮在返回成功前检查所有事实与派生结果，仍以rollback结束，不保留实验行。
        assert.deepEqual(await snapshot(),await snapshot(reference));await target.rollback();
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const retryPool=new Proxy(pool,{get(target,key){if(key==='getConnection')return async()=>retryDb;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});
    const retryStore=new MysqlFinanceStore(retryPool,{summaries:true});retryStore.changes.onChange(async events=>{published+=events.length});
    const result=await retryStore.execute(a,book,'expense.create',{paidByMemberId:ma,amountFen:'101',splitMode:'EQUAL',participantMemberIds:[ma,mb],category:'OTHER',occurredOn:'2026-11-18'}, {idempotencyKey:randomUUID()});
    assert.equal(result.status,201);assert.equal(commits,2);assert.equal(published,1);
    await db.query('START TRANSACTION READ ONLY');assert.deepEqual(await snapshot(),before);await db.rollback();
  });
});
