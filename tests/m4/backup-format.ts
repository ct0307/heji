import { fixtureVersion,isRestoreDatabase,sourceDatabase,windowRestoreDatabase,timedWindowRestoreDatabase } from './policy.ts';

export interface Column {name:string;type:string}
/** GENERATED ALWAYS列由MySQL重算；DEFAULT_GENERATED仍是可写的普通列。 */
export function writableColumns(columns:{COLUMN_NAME:unknown;DATA_TYPE:unknown;EXTRA:unknown}[]):Column[]{
  return columns.filter(column=>!/(?:STORED|VIRTUAL) GENERATED/i.test(String(column.EXTRA)))
    .map(column=>({name:String(column.COLUMN_NAME),type:String(column.DATA_TYPE)}));
}
export interface Table {name:string;columns:Column[];primary:string[]}
export interface MigrationRecord {name:string;checksum:string}
export interface HeaderV1 {format:'heji-m4-backup-v1';database:string;version:string;schema:Table[];createdAt:string;seed:string}
export interface HeaderV2 extends Omit<HeaderV1,'format'> {format:'heji-m4-backup-v2';migrations:MigrationRecord[]}
export type Header=HeaderV1|HeaderV2;
export type BackupSchemaVersion=
  |{format:'heji-m4-backup-v1';includeSummaries:boolean}
  |{format:'heji-m4-backup-v2';includeSummaries:true;includeWindows:true};
const summaryTables=['finance_member_totals','finance_daily_members','finance_daily_categories'];
const migrationNames=['001_m1.sql','002_m2.sql','003_finance_summaries.sql','004_settlement_windows.sql'];
const v2Tables=['schema_migrations','m4_fixture_meta','users','sessions','books','book_members','invitations','audit_events','rate_limits','expenses','expense_versions','expense_shares','transfer_requests','confirmed_transfers','idempotency_records','financial_audit_details',...summaryTables,'settlement_windows'];
const safeIdentifier=(value:string)=>/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
const validChecksum=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

/** 只根据完整schema识别格式；迁移是否真的完成由数据库标记另行确认。 */
export function backupSchemaVersion(schema:Table[]):BackupSchemaVersion{
  const hasWindows=schema.some(table=>table.name==='settlement_windows');
  const found=summaryTables.filter(name=>schema.some(table=>table.name===name)).length;
  if(found!==0&&found!==summaryTables.length)throw new Error('备份汇总表集合不完整，拒绝创建恢复库');
  if(hasWindows&&found!==summaryTables.length)throw new Error('004备份缺少完整汇总结构');
  return hasWindows
    ?{format:'heji-m4-backup-v2',includeSummaries:true,includeWindows:true}
    :{format:'heji-m4-backup-v1',includeSummaries:found===summaryTables.length};
}
/** 恢复结构按备份自身版本选择；旧备份不能被当前新提案强制升级。 */
export function backupIncludesSummaries(schema:Table[]):boolean{
  const version=backupSchemaVersion(schema);
  if(version.format==='heji-m4-backup-v2')throw new Error('v2结算窗口备份不能用v1恢复路径');
  return version.includeSummaries;
}
export function validateMigrationManifest(value:unknown,expected:MigrationRecord[]):asserts value is MigrationRecord[]{
  if(!Array.isArray(value)||value.length!==migrationNames.length||expected.length!==migrationNames.length)throw new Error('004备份迁移清单不完整');
  for(let index=0;index<migrationNames.length;index++){
    const entry=value[index] as Partial<MigrationRecord>,source=expected[index]!;
    if(entry?.name!==migrationNames[index]||source.name!==migrationNames[index]||!validChecksum(entry.checksum)||!validChecksum(source.checksum)||entry.checksum!==source.checksum)
      throw new Error('004备份迁移名称、顺序或校验和不匹配');
  }
}
export function assertRestoreTarget(format:Header['format'],database:string):void{
  const windowTarget=database===windowRestoreDatabase||database===timedWindowRestoreDatabase;
  if(!isRestoreDatabase(database)||(format==='heji-m4-backup-v2'&&!windowTarget)||(format==='heji-m4-backup-v1'&&windowTarget))
    throw new Error('备份格式与固定恢复目标不匹配');
}
export function hasActiveSettlementWindow(rows:{closedAt:unknown;expiresAtIsFuture:unknown}[]):boolean{
  return rows.some(row=>{
    const isFuture=Number(row.expiresAtIsFuture);
    if(isFuture!==0&&isFuture!==1)throw new Error('004窗口时间无效，停止备份');
    return row.closedAt===null&&isFuture===1;
  });
}
export function encodeRow(row:Record<string,unknown>,columns:Column[]):unknown[]{return columns.map(column=>{
  const value=row[column.name];if(column.type.toLowerCase()==='json'&&value!==undefined)return JSON.stringify(value);
  if(value===null||value===undefined)return null;
  if(Buffer.isBuffer(value))return {binary:value.toString('base64')};
  if(value instanceof Date)return value.toISOString().replace('T',' ').replace('Z','');
  if(typeof value==='bigint')return value.toString();
  if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')return value;
  if(typeof value==='object')return JSON.stringify(value);
  throw new Error('备份包含不支持的数据类型');
});}
export function decodeRow(values:unknown[],columns:Column[]):unknown[]{
  if(!Array.isArray(values)||values.length!==columns.length)throw new Error('备份行字段数量不匹配');
  return values.map((value,index)=>{
    const type=columns[index]!.type.toLowerCase();if(value===null)return null;
    if(['binary','varbinary','blob','tinyblob','mediumblob','longblob'].includes(type)){
      if(typeof value!=='object'||value===null||!('binary'in value)||typeof value.binary!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.binary))throw new Error('二进制备份格式无效');return Buffer.from(value.binary,'base64');
    }
    if(['date','datetime','timestamp'].includes(type)){
      if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)?$/.test(value))throw new Error('日期备份格式无效');return value;
    }
    if(type==='json'){
      if(typeof value!=='string')throw new Error('JSON备份格式无效');JSON.parse(value);return value;
    }
    if(/^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double)/.test(type)){
      if(typeof value!=='string'&&!Number.isInteger(value))throw new Error('数值备份格式无效');return String(value);
    }
    if(typeof value!=='string'&&typeof value!=='number'&&typeof value!=='boolean')throw new Error('文本备份格式无效');return value;
  });
}
export function validateHeader(header:unknown,current:Table[],expectedMigrations?:MigrationRecord[]):asserts header is Header{
  if(!header||typeof header!=='object')throw new Error('备份头无效');const value=header as Partial<Header>;
  if((value.format!=='heji-m4-backup-v1'&&value.format!=='heji-m4-backup-v2')||value.database!==sourceDatabase||value.version!==fixtureVersion||value.seed!=='heji-fixed-m4-20261117')throw new Error('拒绝非本版本固定M4虚构备份');
  if(!Array.isArray(value.schema)||value.schema.length!==current.length)throw new Error('备份表集合不匹配');
  const version=backupSchemaVersion(value.schema),currentVersion=backupSchemaVersion(current);
  if(version.format!==value.format||currentVersion.format!==value.format)throw new Error('备份格式版本与表结构不匹配');
  if(value.format==='heji-m4-backup-v2'){
    if(!expectedMigrations)throw new Error('v2校验需要本地迁移源清单');
    validateMigrationManifest(value.migrations,expectedMigrations);
    if(value.schema.length!==v2Tables.length||new Set(value.schema.map(table=>table.name)).size!==v2Tables.length||value.schema.some(table=>!v2Tables.includes(table.name)))throw new Error('v2备份表集合与固定004结构不匹配');
  }
  const normal=(items:Table[])=>items.map(table=>{
    if(!table||!safeIdentifier(table.name)||!Array.isArray(table.columns)||!Array.isArray(table.primary)||!table.columns.length||!table.primary.length||table.columns.some(column=>!column||!safeIdentifier(column.name)||typeof column.type!=='string')||table.primary.some(name=>!safeIdentifier(name)||!table.columns.some(column=>column.name===name))||new Set(table.columns.map(column=>column.name)).size!==table.columns.length||new Set(table.primary).size!==table.primary.length)throw new Error('备份架构名称或主键无效');
    return {name:table.name,columns:table.columns.map(({name,type})=>({name,type})),primary:table.primary};
  }).sort((a,b)=>a.name.localeCompare(b.name));
  if(new Set(value.schema.map(table=>table.name)).size!==value.schema.length)throw new Error('备份表名重复');
  if(JSON.stringify(normal(value.schema))!==JSON.stringify(normal(current)))throw new Error('备份表架构与目标隔离库不一致');
}
export function validateRestorePlan(header:unknown,database:string,expectedMigrations:MigrationRecord[]):{includeSummaries:boolean;includeWindows:boolean}{
  if(!header||typeof header!=='object')throw new Error('备份头无效');
  const value=header as Partial<Header>;
  if((value.format!=='heji-m4-backup-v1'&&value.format!=='heji-m4-backup-v2')||!Array.isArray(value.schema))throw new Error('备份格式或schema无效');
  assertRestoreTarget(value.format,database);
  validateHeader(value,value.schema,value.format==='heji-m4-backup-v2'?expectedMigrations:undefined);
  const schemaVersion=backupSchemaVersion(value.schema);
  return {includeSummaries:schemaVersion.includeSummaries,includeWindows:schemaVersion.format==='heji-m4-backup-v2'};
}
export function headerOf(schema:Table[],seed:string):HeaderV1{
  if(backupSchemaVersion(schema).format!=='heji-m4-backup-v1')throw new Error('v2结算窗口结构不能创建v1头部');
  return {format:'heji-m4-backup-v1',database:sourceDatabase,version:fixtureVersion,schema,createdAt:new Date().toISOString(),seed};
}
export function headerV2Of(schema:Table[],seed:string,migrations:MigrationRecord[]):HeaderV2{
  if(backupSchemaVersion(schema).format!=='heji-m4-backup-v2')throw new Error('v2头部需要完整004结构');
  validateMigrationManifest(migrations,migrations);
  return {format:'heji-m4-backup-v2',database:sourceDatabase,version:fixtureVersion,schema,createdAt:new Date().toISOString(),seed,migrations:migrations.map(({name,checksum})=>({name,checksum}))};
}
