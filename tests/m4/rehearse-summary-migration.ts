import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import type { PoolConnection,RowDataPacket } from 'mysql2/promise';
import { executeSummaryMigration,summaryMigrationPlan } from '../../database/scripts/summary-migration.ts';
import { fixturePool } from './database.ts';

// 真实迁移算法只接收这个受限连接：DDL改为TEMPORARY，标记抑制，最终commit改为rollback。
// 不调用applySummaryMigration，不创建或修改任何持久结构，不改变001/002/003记录。
const pool=await fixturePool(),db=await pool.getConnection();let markerChecked=false;
const temporary=new Proxy(db,{get(target,key){
  if(key==='commit')return ()=>target.rollback();
  if(key==='execute')return async(sql:string,params:(string|number|boolean|null)[]=[])=>{
    if(sql.startsWith('CREATE TABLE finance_'))return target.execute(sql.replace('CREATE TABLE ','CREATE TEMPORARY TABLE '),params);
    if(sql.startsWith('INSERT INTO schema_migrations')){
      assert.equal(params[0],'003_finance_summaries.sql');markerChecked=true;
      return [{affectedRows:1},[]];
    }
    if(/^(?:CREATE|ALTER|DROP|TRUNCATE|DELETE|UPDATE|REPLACE)\b/i.test(sql))throw new Error('临时演练拒绝非指定DDL或持久修改');
    if(/^INSERT INTO /i.test(sql)&&!/^INSERT INTO finance_(?:member_totals|daily_members|daily_categories)\b/.test(sql))throw new Error('临时演练拒绝写入事实表');
    return target.execute(sql,params);
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}}) as PoolConnection;
try{
  const report=await executeSummaryMigration(temporary,'heji_m4_bench',await summaryMigrationPlan());
  assert.equal(markerChecked,true);
  const [markers]=await db.execute<RowDataPacket[]>('SELECT name FROM schema_migrations WHERE name=?',['003_finance_summaries.sql']);assert.equal(markers.length,0);
  const [persisted]=await db.execute<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='heji_m4_bench' AND TABLE_NAME IN ('finance_member_totals','finance_daily_members','finance_daily_categories')");assert.equal(persisted.length,0);
  const [remaining]=await db.execute<RowDataPacket[]>('SELECT COUNT(*) count FROM finance_member_totals');assert.equal(String(remaining[0]!.count),'0');
  const name='m4-summary-migration-rehearsal-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  const result={scope:'连接级临时表执行真实迁移算法，标记抑制且最终回滚；不是实际003迁移',executedPersistentDdl:false,activationWritten:false,transactionCommitted:false,markerChecked,report};
  await writeFile(new URL('../../docs/development/evidence/'+name,import.meta.url),JSON.stringify(result,null,2),{encoding:'utf8',flag:'wx'});console.log(JSON.stringify({file:name,elapsedMs:report.elapsedMs,reconciliation:report.reconciliation,executedPersistentDdl:false}));
}finally{await db.rollback();db.release();await pool.end()}
