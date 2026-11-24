import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFile } from 'node:fs/promises';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { fixturePool, environment } from './database.ts';
import { bookId, userId } from './seed.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';

// 仅连接已完成的固定隔离夹具；每次业务读取均由原实现开启READ ONLY事务。
const pool=await fixturePool();
type Trace={view:string;totalMs:number;acquireMs:number;sql:{sql:string;ms:number;rows:number|null}[]};
const context=new AsyncLocalStorage<Trace>();
const plans:{sql:string;plan:unknown}[]=[];
const captured=new Map<string,(string|number|boolean|null)[]>();
const measured=new Proxy(pool,{get(target,key){
  if(key==='getConnection')return async()=>{
    const start=performance.now(),db=await target.getConnection(),trace=context.getStore();
    if(trace)trace.acquireMs+=performance.now()-start;
    return new Proxy(db,{get(connection,property){
      const value=Reflect.get(connection,property);
      if(property==='execute'||property==='query')return async(sql:string,params:(string|number|boolean|null)[]=[])=>{
        const started=performance.now();
        const result=await Reflect.apply(value,connection,[sql,params]) as [unknown,unknown];
        trace?.sql.push({sql,ms:performance.now()-started,rows:Array.isArray(result[0])?result[0].length:null});
        if(property==='execute'&&(sql.startsWith('WITH ')||sql.startsWith('SELECT e.id FROM')))captured.set(sql,params);
        return result;
      };
      return typeof value==='function'?value.bind(connection):value;
    }}) as PoolConnection;
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}});
const store=new MysqlFinanceStore(measured),traces:Trace[]=[];
async function read(view:'expenses'|'snapshot'|'report'){
  const trace:Trace={view,totalMs:0,acquireMs:0,sql:[]},start=performance.now();
  await context.run(trace,()=>store.read(userId(0),bookId(0),view));
  trace.totalMs=performance.now()-start;traces.push(trace);
  return trace;
}
try{
  const [scale]=await pool.query<RowDataPacket[]>('SELECT (SELECT COUNT(*) FROM expenses) expenses,(SELECT COUNT(*) FROM expense_versions) versions,(SELECT COUNT(*) FROM expense_shares) shares');
  for(const view of ['expenses','snapshot','report'] as const){
    const trace=await read(view);console.log(JSON.stringify({view,ms:trace.totalMs,acquireMs:trace.acquireMs,sql:trace.sql.map(x=>({ms:x.ms,rows:x.rows,sql:x.sql.slice(0,100)}))}));
  }
  // 固定20次热点只读请求，观察8连接池的排队；不创建会话或修改业务数据。
  const start=traces.length;
  await Promise.all(Array.from({length:20},(_,i)=>read(i%10<5?'expenses':i%10<8?'snapshot':'report')));
  const concurrent=traces.slice(start).map(({view,totalMs,acquireMs,sql})=>({view,totalMs,acquireMs,sqlMs:sql.reduce((sum,x)=>sum+x.ms,0)}));
  console.log(JSON.stringify({concurrent}));
  const db=await pool.getConnection();
  try{
    await db.query('START TRANSACTION READ ONLY');
    for(const [sql,params] of captured){const [plan]=await db.query('EXPLAIN ANALYZE '+sql,params);plans.push({sql,plan})}
    await db.commit();
  }catch(error){await db.rollback();throw error}finally{db.release()}
  const name='m4-profile-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  await writeFile(new URL('../../docs/development/evidence/'+name,import.meta.url),JSON.stringify({scope:'固定隔离库只读诊断，非HTTP正式基准',environment:await environment(pool),scale,traces,concurrent,plans},null,2),{encoding:'utf8',flag:'wx'});
  console.log(name);
}finally{await pool.end()}
