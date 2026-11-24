import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolConnection } from 'mysql2/promise';
import { assertWindowWrite,windowState,loadWindow,replayWindowDto,windowDto } from '../../apps/api/src/shared/settlement-window.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import { MysqlM1Store } from '../../apps/api/src/modules/m1/mysql-store.ts';
import type { Pool } from 'mysql2/promise';
import { parseConfirmation } from '../../apps/api/src/modules/finance/validation.ts';

const start=Date.parse('2026-11-19T00:00:00.000Z');
const window={bookId:'book',windowId:'window',requestId:'request',holderUserId:'actor',holderMemberId:'member',createdAt:new Date(start).toISOString(),expiresAt:new Date(start+30000).toISOString(),closedAt:null,cooldownUntil:new Date(start+60000).toISOString()};
const allowed={operation:'request.confirm',actorId:'actor',memberId:'member',resourceId:'request',expectedWindowId:'window'};
const windowUuid='11111111-1111-4111-8111-111111111111';
const code=(expected:string)=>(error:unknown)=>(error as {code:string}).code===expected;

test('窗口在30秒边界失效，60秒边界解除冷却；主动关闭从关闭时刻冷却',()=>{
  assert.equal(windowState(window,start+29999),'ACTIVE');
  assert.equal(windowState(window,start+30000),'EXPIRED');
  assert.equal(windowState(window,start+60000),'EXPIRED');
  assert.equal(windowState({...window,closedAt:new Date(start+5000).toISOString()},start+6000),'CLOSED');
  assert.equal(windowState(null,start),'NONE');
});
test('只允许绑定确认者携匹配窗口ID确认；所有其他新财务写入暂停',()=>{
  assert.doesNotThrow(()=>assertWindowWrite(window,start+100,allowed));
  for(const operation of ['expense.create','expense.patch','expense.void','request.create','transfer.reverse','member.leave','member.remove','book.archive','book.restore','member.join']){
    assert.throws(()=>assertWindowWrite(window,start+100,{...allowed,operation}),code('SETTLEMENT_WINDOW_ACTIVE'));
  }
  for(const patch of [{expectedWindowId:undefined},{actorId:'other'},{memberId:'other'},{resourceId:'other'}]){
    assert.throws(()=>assertWindowWrite(window,start+100,{...allowed,...patch}),code('SETTLEMENT_WINDOW_ACTIVE'));
  }
  assert.throws(()=>assertWindowWrite(window,start+100,{...allowed,expectedWindowId:'old'}),code('SETTLEMENT_WINDOW_EXPIRED'));
});
test('到期普通写立即恢复；窗口确认不得回退为普通确认，旧ID不得使用',()=>{
  assert.doesNotThrow(()=>assertWindowWrite(window,start+30000,{operation:'expense.create'}));
  assert.throws(()=>assertWindowWrite(window,start+30000,allowed),code('SETTLEMENT_WINDOW_EXPIRED'));
  assert.throws(()=>assertWindowWrite(null,start,allowed),code('SETTLEMENT_WINDOW_EXPIRED'));
  assert.doesNotThrow(()=>assertWindowWrite(null,start,{operation:'request.confirm'}));
});
test('绑定请求取消/拒绝允许通过窗口门禁，其他请求受阻；对象授权由业务事务先完成',()=>{
  for(const operation of ['request.cancel','request.reject']){
    assert.doesNotThrow(()=>assertWindowWrite(window,start,{operation,resourceId:'request'}));
    assert.throws(()=>assertWindowWrite(window,start,{operation,resourceId:'other'}),code('SETTLEMENT_WINDOW_ACTIVE'));
  }
});
test('004标记缺失不查新表，已激活但表故障返回503；写入使用当前锁定读',async()=>{
  const sql:string[]=[];
  let marker=false,broken=false;
  const db={execute:async(query:string)=>{sql.push(query);if(query.includes('schema_migrations'))return [marker?[{name:'004_settlement_windows.sql'}]:[],[]];if(broken)throw new Error('表故障');return [[],[]]}} as unknown as PoolConnection;
  assert.equal((await loadWindow(db,'book',true)).supported,false);assert.equal(sql.length,1);
  marker=true;assert.equal((await loadWindow(db,'book',true)).supported,true);
  assert.match(sql.at(-1)!,/FOR UPDATE/);
  broken=true;await assert.rejects(()=>loadWindow(db,'book',true),code('SETTLEMENT_WINDOW_UNAVAILABLE'));
});
test('旧申请重放保留首次ID和期限，通过生命周期审计区分主动关闭和自然过期',async()=>{
  const original=windowDto({supported:true,window},start,'actor','owner');
  const closed={...window,closedAt:new Date(start+5000).toISOString(),cooldownUntil:new Date(start+35000).toISOString()};
  const db={execute:async()=>[[{changeSummary:JSON.stringify(closed)}],[]]} as unknown as PoolConnection;
  const result=await replayWindowDto(db,{supported:true,window:null},original,start+61000,'actor','owner','book');
  assert.equal(result.state,'CLOSED');assert.equal(result.windowId,window.windowId);assert.equal(result.expiresAt,window.expiresAt);assert.equal(result.closedAt,closed.closedAt);assert.equal(result.canClose,false);
});

function fixture(options:{saved?:boolean;pending?:boolean;now?:number;member?:string}={}){
  const calls:string[]=[],actor=options.member??'actor';
  const request={id:'request',bookId:'book',kind:'NORMAL',fromMemberId:'sender',toMemberId:'member',amountFen:'100',occurredOn:'2026-11-19',note:'',initiatorMemberId:'sender',counterpartyMemberId:'member',status:options.pending===false?'CONFIRMED':'PENDING',revision:'1',createdAt:new Date(start)};
  const db={beginTransaction:async()=>{calls.push('BEGIN')},query:async(sql:string)=>{calls.push(sql);return [[],[]]},commit:async()=>{calls.push('COMMIT')},rollback:async()=>{calls.push('ROLLBACK')},release:()=>{},execute:async(sql:string,values:unknown[]=[])=>{
    calls.push(sql);
    if(sql.startsWith('SELECT * FROM books'))return [[{id:'book',createdByUserId:'owner',financialVersion:'7',isArchived:0}],[]];
    if(sql.startsWith('SELECT * FROM book_members'))return [[{id:actor==='outsider'?'outsider-member':'member',userId:actor,status:'ACTIVE'}],[]];
    if(sql.includes('schema_migrations'))return [values[0]==='004_settlement_windows.sql'?[{name:values[0]}]:[],[]];
    if(sql.startsWith('SELECT * FROM settlement_windows'))return [[{...window,windowId:windowUuid}],[]];
    if(sql.includes('AS windowNow'))return [[{windowNow:new Date(options.now??start+1000)}],[]];
    if(sql.includes('FROM transfer_requests r'))return [[request],[]];
    if(sql.startsWith('SELECT * FROM idempotency_records'))return [options.saved?[{requestHash:'unused',responseBody:{original:true},httpStatus:200}]:[],[]];
    if(sql.startsWith('SELECT i.*'))return [[{id:'invite',bookId:'book',expired:0}],[]];
    if(sql.startsWith('SELECT COUNT(*)'))return [[{total:2}],[]];
    if(sql.startsWith('INSERT')||sql.startsWith('UPDATE'))return [{affectedRows:1},[]];
    throw new Error('未模拟SQL：'+sql);
  }} as unknown as PoolConnection;
  const pool={getConnection:async()=>db,execute:db.execute.bind(db)} as unknown as Pool;
  return {db,pool,calls};
}
test('HTTP确认解析保留原两版本并允许合法窗口ID，拒绝未知字段',()=>{
  const id='11111111-1111-4111-8111-111111111111';
  assert.equal(parseConfirmation({expectedRequestRevision:'1',expectedFinancialVersion:'7',expectedWindowId:id}).expectedWindowId,id);
  assert.throws(()=>parseConfirmation({expectedRequestRevision:'1',expectedFinancialVersion:'7',expectedWindowId:'invalid'}));
});
test('真实财务事务分发：锁账本/授权/窗口/业务对象；暂停失败回滚且不记成功意图',async()=>{
  const {pool,calls}=fixture(),store=new MysqlFinanceStore(pool);
  await assert.rejects(()=>store.execute('actor','book','request.create',{}, {idempotencyKey:'window-intent'}),code('SETTLEMENT_WINDOW_ACTIVE'));
  const selects=calls.filter(x=>x.startsWith('SELECT'));
  assert.match(selects[0]!,/books.*FOR UPDATE/);assert.match(selects[1]!,/book_members.*FOR UPDATE/);
  assert.ok(calls.findIndex(x=>x.includes('settlement_windows'))<calls.findIndex(x=>x.includes('idempotency_records')));
  assert.ok(calls.includes('ROLLBACK'));assert.ok(!calls.some(x=>x.startsWith('INSERT')));
});
test('确认保持完整财务版本门禁，过期确认回滚；已确认事实重放不被新窗口阻止',async()=>{
  const context={idempotencyKey:'window-confirm',resourceId:'request'};
  for(const [now,input,expected] of [
    [start+1000,{expectedRequestRevision:'1',expectedFinancialVersion:'6',expectedWindowId:'11111111-1111-4111-8111-111111111111'},'PREVIEW_STALE'],
    [start+30000,{expectedRequestRevision:'1',expectedFinancialVersion:'7',expectedWindowId:'11111111-1111-4111-8111-111111111111'},'SETTLEMENT_WINDOW_EXPIRED'],
  ] as const){
    const {pool,calls}=fixture({now}),store=new MysqlFinanceStore(pool);
    await assert.rejects(()=>store.execute('actor','book','request.confirm',input,context),code(expected));
    assert.ok(calls.includes('ROLLBACK'));assert.ok(!calls.some(x=>x.startsWith('INSERT')));
  }
  const {pool,calls}=fixture({pending:false}),store=new MysqlFinanceStore(pool);
  store.confirmedResult=async()=>({original:true}) as never;
  assert.deepEqual((await store.execute('actor','book','request.confirm',{},context)).data,{original:true});
  assert.ok(calls.includes('COMMIT'));assert.ok(!calls.some(x=>x.startsWith('INSERT INTO confirmed_transfers')));
});
test('M1新增/重新加入遇窗口回滚，已有效成员重放仍成功',async()=>{
  for(const active of [false,true]){
    const {pool,calls}=fixture(),store=new MysqlM1Store(pool);
    // 只替换邀请读取，成员读取仍经过生产事务。
    store.invitation=async()=>({id:'invite',bookId:'book',expired:0}) as never;
    const original=pool.getConnection.bind(pool);
    pool.getConnection=async()=>{const db=await original(),execute=db.execute.bind(db);db.execute=(async(sql:string,values:string[])=>{
      if(sql.startsWith('SELECT * FROM book_members')){calls.push(sql);return [[{id:'member',status:active?'ACTIVE':'LEFT'}],[]]}
      return execute(sql,values);
    }) as typeof db.execute;return db};
    if(active)await store.acceptInvitation('actor','hash');
    else await assert.rejects(()=>store.acceptInvitation('actor','hash'),code('SETTLEMENT_WINDOW_ACTIVE'));
    assert.equal(calls.some(x=>x.startsWith('UPDATE book_members')),false);
  }
});
