import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { cpus,totalmem } from 'node:os';
import type { PoolConnection,RowDataPacket } from 'mysql2/promise';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import { backfillSummaries } from '../../apps/api/src/modules/finance/mysql-summaries.ts';
import { createTemporarySummaries } from './summary-tables.ts';
import { fixturePool,environment } from './database.ts';
import { bookId,userId } from './seed.ts';

// 同一连接/原始规模下只比较临时汇总与旧查询；不冒充20用户HTTP正式基准。
const pool=await fixturePool(),db=await pool.getConnection(),evidence:unknown[]=[],plans:unknown[]=[];
const captured=new Map<string,(string|number|boolean|null)[]>();
let currentSqlMs=0;
const measured=new Proxy(db,{get(target,key){const value=Reflect.get(target,key);
  if(key==='execute')return async(sql:string,params:(string|number|boolean|null)[]=[])=>{
    const start=performance.now();const result=await target.execute(sql,params);currentSqlMs+=performance.now()-start;
    if((sql.includes('finance_member_totals')||sql.includes('finance_daily_'))&&!captured.has(sql))captured.set(sql,params);
    return result;
  };
  return typeof value==='function'?value.bind(target):value;
}});
class ReadStore extends MysqlFinanceStore {override financeTransaction<T>(work:(connection:PoolConnection)=>Promise<T>){return work(measured)}}
try{
  async function scale(){return (await db.query<RowDataPacket[]>('SELECT (SELECT COUNT(*) FROM expenses) expenses,(SELECT COUNT(*) FROM expense_versions) versions,(SELECT COUNT(*) FROM expense_shares) shares,(SELECT COUNT(*) FROM confirmed_transfers) confirmed,(SELECT COUNT(*) FROM transfer_requests) requests'))[0][0]}
  const before=await scale();
  await createTemporarySummaries(db);await db.query('START TRANSACTION');
  const start=performance.now();await backfillSummaries(db);const backfillMs=performance.now()-start;await db.commit();
  const fast=new ReadStore(pool,{summaries:true}),reference=new ReadStore(pool,{summaries:false});
  await db.query('START TRANSACTION READ ONLY');
  for(let book=0;book<10;book++)for(const view of ['snapshot','report'] as const){
    currentSqlMs=0;let start=performance.now();const expected=await reference.read(userId(0),bookId(book),view),legacyMs=performance.now()-start,legacySqlMs=currentSqlMs;
    const samples=[];
    for(let round=1;round<=5;round++){
      currentSqlMs=0;start=performance.now();const actual=await fast.read(userId(0),bookId(book),view),ms=performance.now()-start;
      assert.deepEqual(actual,expected);samples.push({round,ms,sqlMs:currentSqlMs});
    }
    const record={book,view,legacyMs,legacySqlMs,samples,identical:true};evidence.push(record);console.log(JSON.stringify(record));
  }
  // 新汇总查询的真实计划（仅记录热点参数，避免同形查询重复输出）。
  for(const [sql,params] of captured){if(!params.includes(bookId(0)))continue;const [plan]=await db.query('EXPLAIN ANALYZE '+sql,params);plans.push({sql,plan})}
  const after=await scale();assert.deepEqual(after,before);await db.commit();
  const [settings]=await db.query('SELECT @@innodb_buffer_pool_size bufferPoolBytes,@@max_connections maxConnections');
  const name='m4-summary-profile-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  await writeFile(new URL('../../docs/development/evidence/'+name,import.meta.url),JSON.stringify({scope:'同一连接的临时汇总表、只读逐账本对账和五轮查询，非20用户HTTP达标证据',environment:{mysql:await environment(pool),settings,node:process.version,cpu:cpus()[0]?.model,memoryBytes:totalmem()},before,after,backfillMs,evidence,plans},null,2),{encoding:'utf8',flag:'wx'});console.log(name);
}catch(error){await db.rollback();throw error}finally{db.release();await pool.end()}
