import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool,PoolConnection } from 'mysql2/promise';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';

function connection(marker:boolean,member=true,markerError=false){
  const sql:string[]=[];
  const db={execute:async(query:string)=>{
    sql.push(query);
    if(query.includes('schema_migrations')){if(markerError)throw new Error('M4标记读取故障');return [marker?[{name:'003_finance_summaries.sql'}]:[],[]]}
    if(query.startsWith('SELECT * FROM books'))return [[{id:'book',financialVersion:'0'}],[]];
    return [member?[{id:'member'}]:[],[]];
  }} as unknown as PoolConnection;
  return {db,sql};
}
test('汇总自动模式在账本锁和成员授权之后读取已提交003标记',async()=>{
  const store=new MysqlFinanceStore({} as Pool);
  for(const marker of [false,true]){
    const {db,sql}=connection(marker);const result=await store.access(db,'actor','book',true);
    assert.equal(result.summaries,marker);assert.match(sql[0]!,/books.*FOR UPDATE/);assert.match(sql[1]!,/book_members.*FOR UPDATE/);assert.match(sql[2]!,/schema_migrations/);
  }
});
test('成员拒绝不探测标记；标记读取失败必须抛错，不静默降级写入',async()=>{
  const store=new MysqlFinanceStore({} as Pool),unauthorized=connection(true,false);
  await assert.rejects(()=>store.access(unauthorized.db,'actor','book',true),error=>(error as {status:number}).status===404);
  assert.equal(unauthorized.sql.length,2);
  await assert.rejects(()=>store.access(connection(true,true,true).db,'actor','book',true),/标记读取故障/);
});
test('临时演练与原事实对照可以显式选模式，不把标记故障当成可回退信号',async()=>{
  for(const summaries of [false,true]){
    const store=new MysqlFinanceStore({} as Pool,{summaries}),{db,sql}=connection(!summaries,true,true);
    assert.equal((await store.access(db,'actor','book')).summaries,summaries);assert.equal(sql.length,2);
  }
});
