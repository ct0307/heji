import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import type { PoolConnection } from 'mysql2/promise';
import { parseSummaryMigrationArgs,assertSummaryTargetHost,type SummaryDatabase } from './summary-migration.ts';
import { createDatabasePool,databaseConfig } from '../../apps/api/src/shared/database.ts';
import { rows } from '../../apps/api/src/modules/finance/read-model.ts';
import { windowMigration } from '../../apps/api/src/shared/settlement-window.ts';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const stop=():never=>{throw new Error('004迁移门禁未满足，保留全部结构与数据残留')};
export function parseWindowMigrationArgs(args:string[],permission:string|undefined){
  try{return parseSummaryMigrationArgs(args,permission)}catch{return stop()}
}
export async function windowMigrationPlan(){
  const sql=await readFile(new URL('../../docs/development/proposals/'+windowMigration,import.meta.url),'utf8');
  const statements=sql.replace(/^\s*--.*$/gm,'').split(';').map(x=>x.trim()).filter(Boolean);
  if(statements.length!==1||!statements[0]!.startsWith('CREATE TABLE settlement_windows (')||!statements[0]!.endsWith(') ENGINE=InnoDB')||/\b(?:DROP|ALTER|DELETE|TRUNCATE|INSERT|UPDATE|REPLACE|RENAME|SELECT|IF)\b/i.test(statements[0]!))stop();
  const baseline=await Promise.all(['001_m1.sql','002_m2.sql','003_finance_summaries.sql'].map(async(name,index)=>({name,checksum:hash(await readFile(new URL(index===2?'../../docs/development/proposals/'+name:'../migrations/'+name,import.meta.url),'utf8'))})));
  return {name:windowMigration,sql,checksum:hash(sql),statements,baseline};
}
/** 维护期间单表DDL自提交；失败保留残留，不DROP、不重试、不自动修复。 */
export async function executeWindowMigration(db:PoolConnection,database:SummaryDatabase,plan:Awaited<ReturnType<typeof windowMigrationPlan>>){
  if(!['heji_dev','heji_m4_bench'].includes(database))stop();
  const source=await windowMigrationPlan();
  if(JSON.stringify(plan)!==JSON.stringify(source))stop();
  let acquired=false;
  try{
    const connection=(await rows(db,'SELECT DATABASE() databaseName,@@autocommit autocommit'))[0];
    if(connection?.databaseName!==database||String(connection.autocommit)!=='1')stop();
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    acquired=String((await rows(db,'SELECT GET_LOCK(?,10) acquired',[database+'_migration']))[0]?.acquired)==='1';if(!acquired)stop();
    if((await rows(db,'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',[database,'settlement_windows'])).length)stop();
    const applied=await rows(db,'SELECT name,checksum FROM schema_migrations ORDER BY name');
    if(![2,3].includes(applied.length)||applied.some((row,index)=>row.name!==plan.baseline[index]?.name||row.checksum!==plan.baseline[index]?.checksum))stop();
    // 不回填、不更新账本、成员、转账或汇总；全部写进程需在维护期间统一升级。
    await db.execute(plan.statements[0]!);
    await db.execute('INSERT INTO schema_migrations(name,checksum,appliedAt) VALUES(?,?,UTC_TIMESTAMP(3))',[plan.name,plan.checksum]);
    return {scope:'004 settlement window schema',database,completedAt:new Date().toISOString(),migration:{name:plan.name,checksum:plan.checksum},baseline:applied.map(row=>({name:String(row.name),checksum:String(row.checksum)})),retainedOnFailure:true};
  }finally{if(acquired)await db.execute('SELECT RELEASE_LOCK(?)',[database+'_migration']).catch(()=>{})}
}
export async function applyWindowMigration(args:string[],permission:string|undefined){
  const options=parseWindowMigrationArgs(args,permission);if(!options.apply)return stop();
  const database=options.database??stop(),config=databaseConfig()??stop();assertSummaryTargetHost(config.host);
  const plan=await windowMigrationPlan(),pool=createDatabasePool({...config,database});let db:PoolConnection|undefined;
  try{
    db=await pool.getConnection();
    const evidence=await executeWindowMigration(db,database,plan),filename='m4-window-migration-'+evidence.completedAt.replace(/[:.]/g,'-')+'.json';
    try{await writeFile(new URL('../../docs/development/evidence/'+filename,import.meta.url),JSON.stringify(evidence,null,2)+'\n',{encoding:'utf8',flag:'wx'})}
    catch{throw Object.assign(new Error('004已提交，证据写入失败，禁止重复迁移'),{code:'WINDOW_MIGRATION_COMMITTED_EVIDENCE_FAILED'})}
    return {database:options.database,evidenceFile:filename};
  }finally{db?.release();await pool.end()}
}
