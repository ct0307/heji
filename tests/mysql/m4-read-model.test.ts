import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool,PoolConnection } from 'mysql2/promise';
import { fixture } from './m3-fixture.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import { allMembers,expenseVersions,transfers,balances } from '../../apps/api/src/modules/finance/read-model.ts';
import type { FinanceSnapshotDto,TransferPreviewDto } from '../../packages/contracts/src/index.ts';

test('M4快照及预览与逐笔计算一致，快照不向应用传输逐笔份额',async t=>{
  const {a,b,path,ma,mb,pool,bookId}=await fixture(t);
  for(let i=0;i<8;i++){
    const expense=await a.request(path+'/expenses','POST',{paidByMemberId:ma,amountFen:'10001',splitMode:'EQUAL',participantMemberIds:[ma,mb],category:'FOOD',occurredOn:'2026-11-17',note:'M4汇总回归虚构支出'});
    assert.equal(expense.status,201);
    if(i===0)assert.equal((await a.request(path+'/expenses/'+expense.data.id,'PATCH',{amountFen:'12001'},{'If-Match':expense.etag!})).status,200);
    if(i===1)assert.equal((await a.request(path+'/expenses/'+expense.data.id+'/void','POST',{note:'作废不计汇总'},{'If-Match':expense.etag!})).status,200);
  }
  const request=await b.request(path+'/transfer-requests','POST',{toMemberId:ma,amountFen:'1234',occurredOn:'2026-11-17',note:'待确认不入账'});
  assert.equal(request.status,201);
  const db=await pool.getConnection();
  let reference:ReturnType<typeof balances>;
  let expectedAfter:ReturnType<typeof balances>;
  try{
    const members=await allMembers(db,bookId),expenses=await expenseVersions(db,bookId),confirmed=await transfers(db,bookId);
    reference=balances(members,expenses,confirmed);
    expectedAfter=balances(members,expenses,[...confirmed,request.data]);
  }finally{db.release()}
  const fetched:number[]=[];
  const measured=new Proxy(pool,{get(target,key){
    if(key==='getConnection')return async()=>measure(await target.getConnection());
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  function measure(db:PoolConnection):PoolConnection{return new Proxy(db,{get(target,key){
    if(key==='execute')return async(...args:unknown[])=>{const result=await Reflect.apply(target.execute,target,args);if(Array.isArray(result[0]))fetched.push(result[0].length);return result};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }})}
  const store=new MysqlFinanceStore(measured);
  const snapshot=(await store.read(a.userId,bookId,'snapshot')).data as FinanceSnapshotDto;
  assert.deepEqual(snapshot.balances,reference!);assert.equal(snapshot.expenseTotalFen,'72007');assert.equal(snapshot.pendingCount,1);
  assert.ok(Math.max(...fetched)<=4,'快照查询只应返回成员汇总，不能传输全部支出/分摊');
  const preview=(await store.read(a.userId,bookId,'preview',request.data.id)).data as TransferPreviewDto;
  assert.deepEqual(preview.beforeBalances,reference!);assert.deepEqual(preview.afterBalances,expectedAfter!);
});
