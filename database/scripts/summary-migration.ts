import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import type { PoolConnection } from 'mysql2/promise';
import { createDatabasePool,databaseConfig } from '../../apps/api/src/shared/database.ts';
import { rows,model } from '../../apps/api/src/modules/finance/read-model.ts';
import { periodReport } from '../../apps/api/src/modules/finance/mysql-reports.ts';
import { backfillSummaries,summaryAmounts,summaryPeriodReport } from '../../apps/api/src/modules/finance/mysql-summaries.ts';

export type SummaryDatabase='heji_dev'|'heji_m4_bench';
export interface SummaryMigrationOptions {apply:boolean;database:SummaryDatabase|null}
interface MigrationFile {name:string;checksum:string}
export interface SummaryMigrationPlan extends MigrationFile {sql:string;statements:string[];baseline:MigrationFile[]}
const summaryTables=['finance_member_totals','finance_daily_members','finance_daily_categories'] as const;
const baselineNames=['001_m1.sql','002_m2.sql'] as const;
const factTables=['books','book_members','expenses','expense_versions','expense_shares','transfer_requests','confirmed_transfers','audit_events','financial_audit_details','idempotency_records'] as const;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function stop():never {throw new Error('汇总迁移门禁未满足；保留已有数据与结构')}
function target(value:unknown):asserts value is SummaryDatabase {if(value!=='heji_dev'&&value!=='heji_m4_bench')stop()}

/** 纯参数门禁；默认计划从不读取本机配置或建立连接。 */
export function parseSummaryMigrationArgs(args:string[],permission:string|undefined):SummaryMigrationOptions {
  const seen=new Set<string>();let apply=false,plan=false,maintenance=false,database:SummaryDatabase|null=null;
  for(const argument of args){
    const name=argument.startsWith('--database=')?'--database':argument;
    if(seen.has(name))stop();seen.add(name);
    if(argument==='--apply')apply=true;
    else if(argument==='--plan')plan=true;
    else if(argument==='--maintenance')maintenance=true;
    else if(argument.startsWith('--database=')){const selected=argument.slice('--database='.length);target(selected);database=selected}
    else stop();
  }
  if(!apply){if(database!==null||maintenance)stop();return {apply:false,database:null}}
  if(plan||!maintenance||database===null||permission!=='yes')stop();
  return {apply:true,database};
}
export function assertSummaryTargetHost(host:string):void {
  if(!['127.0.0.1','localhost','::1'].includes(host))stop();
}
/** 所有标识符固定；提案不能带隐式覆盖、额外SQL或其它建表目标。 */
export function assertSummaryProposal(sql:string):string[] {
  const statements=sql.replace(/^\s*--.*$/gm,'').split(';').map(statement=>statement.trim()).filter(Boolean);
  if(statements.length!==summaryTables.length)stop();
  for(const [index,statement] of statements.entries()){
    if(!statement.startsWith(`CREATE TABLE ${summaryTables[index]} (`)||!statement.endsWith(') ENGINE=InnoDB')||/\b(?:DROP|ALTER|DELETE|TRUNCATE|INSERT|UPDATE|REPLACE|RENAME|SELECT|IF|FOREIGN|UNSIGNED|CHECK)\b/i.test(statement))stop();
  }
  return statements;
}
export async function summaryMigrationPlan():Promise<SummaryMigrationPlan> {
  const name='003_finance_summaries.sql',sql=await readFile(new URL('../../docs/development/proposals/'+name,import.meta.url),'utf8');
  const baseline=await Promise.all(baselineNames.map(async name=>({name,checksum:hash(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'))})));
  return {name,sql,checksum:hash(sql),statements:assertSummaryProposal(sql),baseline};
}

/** 不创建schema_migrations、不覆盖失败残留；未迁移的原001/002须完整匹配。 */
export async function checkSummarySchema(db:PoolConnection,database:SummaryDatabase,plan:SummaryMigrationPlan):Promise<void> {
  target(database);
  const tables=await rows(db,'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (?,?,?)',[database,...summaryTables]);
  if(tables.length)stop();
  const applied=await rows(db,'SELECT name,checksum FROM schema_migrations ORDER BY name');
  if(applied.length!==2||plan.baseline.length!==2||plan.baseline.some((entry,index)=>entry.name!==baselineNames[index])||applied.some((row,index)=>row.name!==plan.baseline[index]?.name||row.checksum!==plan.baseline[index]?.checksum))stop();
}
async function factState(db:PoolConnection) {
  const counts:Record<string,string>={};
  for(const table of factTables)counts[table]=String((await rows(db,`SELECT COUNT(*) count FROM ${table}`))[0]?.count??'0');
  const versions=(await rows(db,'SELECT id,financialVersion FROM books ORDER BY id')).map(row=>[String(row.id),String(row.financialVersion)]);
  return {counts,financialVersionHash:hash(JSON.stringify(versions))};
}
function same(actual:unknown,expected:unknown):void {if(JSON.stringify(actual)!==JSON.stringify(expected))stop()}
function balanceAmounts(memberId:string,paidFen:string,shareFen:string,outgoingFen:string,incomingFen:string){
  return {memberId,paidFen,shareFen,outgoingFen,incomingFen,balanceFen:(BigInt(paidFen)-BigInt(shareFen)+BigInt(outgoingFen)-BigInt(incomingFen)).toString()};
}
async function reconcile(db:PoolConnection) {
  const books=await rows(db,'SELECT id,financialVersion FROM books ORDER BY id');
  let checkedPeriods=0;
  for(const book of books){
    const bookId=String(book.id),old=(await model(db,book,'',false)).snapshot;
    const actual=(await summaryAmounts(db,bookId)).map(row=>balanceAmounts(String(row.memberId),String(row.paidFen),String(row.shareFen),String(row.outgoingFen),String(row.incomingFen)));
    same(actual,old.balances);
    const months=await rows(db,`SELECT DISTINCT DATE_FORMAT(v.occurredOn,'%Y-%m') monthText FROM expenses e
      JOIN expense_versions v ON v.bookId=e.bookId AND v.expenseId=e.id AND v.revision=e.currentRevision
      WHERE e.bookId=? AND v.isVoided=0 ORDER BY monthText`,[bookId]);
    const periods:Record<string,unknown>[]=[{}, {from:'2026-11-01',to:'2026-11-30'}];
    for(const row of months){
      const month=String(row.monthText);if(!/^\d{4}-\d{2}$/.test(month))stop();
      const year=Number(month.slice(0,4)),monthNo=Number(month.slice(5,7));
      const lastDay=monthNo===2?(year%4===0&&(year%100!==0||year%400===0)?29:28):[4,6,9,11].includes(monthNo)?30:31;
      periods.push({from:month+'-01',to:month+'-'+lastDay});
    }
    const unique=new Map(periods.map(period=>[JSON.stringify(period),period]));
    for(const period of unique.values()){same(await summaryPeriodReport(db,bookId,period),await periodReport(db,bookId,period,false));checkedPeriods++}
    const total=actual.reduce((sum,row)=>({paidFen:sum.paidFen+BigInt(row.paidFen),shareFen:sum.shareFen+BigInt(row.shareFen),outgoingFen:sum.outgoingFen+BigInt(row.outgoingFen),incomingFen:sum.incomingFen+BigInt(row.incomingFen)}),{paidFen:0n,shareFen:0n,outgoingFen:0n,incomingFen:0n});
    if(total.paidFen!==total.shareFen||total.outgoingFen!==total.incomingFen)stop();
  }
  for(const [table,columns] of [
    ['finance_member_totals',['paidFen','shareFen','outgoingFen','incomingFen']],
    ['finance_daily_members',['paidFen','shareFen']],['finance_daily_categories',['amountFen']],
  ] as const){if((await rows(db,`SELECT 1 invalid FROM ${table} WHERE ${columns.map(column=>column+'<0').join(' OR ')} LIMIT 1`)).length)stop()}
  return {checkedBooks:books.length,checkedPeriods,balancesEqual:true,periodReportsEqual:true,conservation:true,nonnegative:true};
}

/**
 * 维护窗口专用。CREATE TABLE在MySQL中自提交，失败后DDL不能被ROLLBACK撤销。
 * 本入口绝不DROP/清空/重试；只回滚本轮数据，保留全部残留以供人工审查。
 */
export async function executeSummaryMigration(db:PoolConnection,database:SummaryDatabase,plan:SummaryMigrationPlan) {
  target(database);
  if(plan.name!=='003_finance_summaries.sql'||plan.checksum!==hash(plan.sql))stop();
  same(plan.statements,assertSummaryProposal(plan.sql));
  const lockName=database+'_summary_migration';let acquired=false,transaction=false;
  const startedAt=new Date().toISOString(),started=performance.now();
  try{
    const connection=(await rows(db,'SELECT DATABASE() databaseName,@@autocommit autocommit'))[0];
    if(connection?.databaseName!==database||String(connection.autocommit)!=='1')stop();
    // MySQL在已有活动事务时拒绝SET TRANSACTION；在任何自提交DDL前验证，避免隐式提交外来事务。
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await checkSummarySchema(db,database,plan);
    acquired=String((await rows(db,'SELECT GET_LOCK(?,10) acquired',[lockName]))[0]?.acquired)==='1';
    if(!acquired)stop();
    await checkSummarySchema(db,database,plan);
    for(const statement of plan.statements)await db.execute(statement);
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await db.query('START TRANSACTION');transaction=true;
    // RR当前读先锁全部账本和主键末端gap；此之前不建立业务一致读快照。
    await rows(db,'SELECT id FROM books ORDER BY id FOR UPDATE');
    const before=await factState(db);
    await backfillSummaries(db);
    const reconciliation=await reconcile(db),after=await factState(db);same(after,before);
    const summaryCounts:Record<string,string>={};
    for(const table of summaryTables)summaryCounts[table]=String((await rows(db,`SELECT COUNT(*) count FROM ${table}`))[0]?.count??'0');
    // 激活标记最后写入，与派生数据一起提交；应用只在可见标记存在时启用新路径。
    await db.execute('INSERT INTO schema_migrations(name,checksum,appliedAt) VALUES(?,?,UTC_TIMESTAMP(3))',[plan.name,plan.checksum]);
    await db.commit();transaction=false;
    return {scope:'M4 finance summaries initial migration',database,startedAt,completedAt:new Date().toISOString(),elapsedMs:performance.now()-started,
      proposal:{name:plan.name,checksum:plan.checksum},baseline:plan.baseline,factsBefore:before,factsAfter:after,summaryCounts,reconciliation,
      retainedOnFailure:true};
  }catch(error){
    if(transaction)await db.rollback().catch(()=>{});
    throw error;
  }finally{
    if(acquired)await db.execute('SELECT RELEASE_LOCK(?)',[lockName]).catch(()=>{});
  }
}

/** 仅显式apply通过纯门禁后获取本机连接配置；不创建数据库、不读取任何配置文件。 */
export async function applySummaryMigration(options:SummaryMigrationOptions,permission:string|undefined) {
  if(!options.apply||options.database===null)stop();
  const selected=parseSummaryMigrationArgs(['--apply','--database='+options.database,'--maintenance'],permission);target(selected.database);
  const plan=await summaryMigrationPlan(),config=databaseConfig();if(!config)stop();
  assertSummaryTargetHost(config.host);
  // 专用新建池的首次连接，没有应用事务或先前会话状态。
  const pool=createDatabasePool({...config,database:selected.database});let db:PoolConnection|undefined;
  try{
    db=await pool.getConnection();
    const evidence=await executeSummaryMigration(db,selected.database,plan);
    const filename='m4-summary-migration-'+evidence.completedAt.replace(/[:.]/g,'-')+'.json';
    // 成功证据仅含计数、校验和及对账结论；wx拒绝覆盖任何既有记录。
    try{
      await writeFile(new URL('../../docs/development/evidence/'+filename,import.meta.url),JSON.stringify(evidence,null,2)+'\n',{encoding:'utf8',flag:'wx'});
    }catch{
      throw Object.assign(new Error('汇总迁移已经提交，证据文件未能写入'),{code:'SUMMARY_MIGRATION_COMMITTED_EVIDENCE_FAILED'});
    }
    return {database:selected.database,evidenceFile:filename};
  }finally{db?.release();await pool.end()}
}
export function safeSummaryMigrationError(error:unknown):string {
  const code=(error as {code?:unknown}|null)?.code;
  if(code==='SUMMARY_MIGRATION_COMMITTED_EVIDENCE_FAILED')return code;
  return typeof code==='string'&&/^(?:ER_[A-Z0-9_]+|E(?:ACCES|XIST|NOENT|CONNREFUSED|TIMEDOUT))$/.test(code)?code:'SUMMARY_MIGRATION_STOPPED';
}
