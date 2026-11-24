import { writeFile } from 'node:fs/promises';
import { fixturePool,environment } from './database.ts';
import { bookId,userId } from './seed.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import { periodReport } from '../../apps/api/src/modules/finance/mysql-reports.ts';

const evidence:unknown[]=[];
const pool=await fixturePool();
const measured=new Proxy(pool,{get(target,key){
  if(key==='getConnection')return async()=>{const db=await target.getConnection();return new Proxy(db,{get(connection,property){
    if(property==='execute')return async(sql:string,params:unknown[])=>{const start=performance.now();const result=await connection.query(sql,params);const ms=performance.now()-start;evidence.push({sql,ms,rows:Array.isArray(result[0])?result[0].length:null});console.log(`SQL ${ms.toFixed(1)}ms ${sql.slice(0,75)}`);return result};
    const value=Reflect.get(connection,property);return typeof value==='function'?value.bind(connection):value;
  }})};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}});
const store=new MysqlFinanceStore(measured);
try{
  for(const view of ['expenses','snapshot','report'] as const){const start=performance.now();await store.read(userId(0),bookId(0),view,undefined,view==='expenses'?{limit:'20'}:{});const ms=performance.now()-start;evidence.push({view,ms});console.log(`${view} 单请求 ${ms.toFixed(1)}ms`)}
  const db=await pool.getConnection();
  try{const proxy=new Proxy(db,{get(target,key){
    if(key==='execute')return async(sql:string,params:unknown[])=>{const start=performance.now();const result=await target.query(sql,params);const ms=performance.now()-start;const [plan]=await target.query('EXPLAIN ANALYZE '+sql,params);evidence.push({sql,params,ms,plan});console.log(`报表SQL ${ms.toFixed(1)}ms`);return result};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});await periodReport(proxy,bookId(0),{})}finally{db.release()}
  const report={environment:await environment(pool),evidence};await writeFile(new URL('../../docs/development/evidence/m4-diagnose-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',import.meta.url),JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx'});
}finally{await pool.end()}
