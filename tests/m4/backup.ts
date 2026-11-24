import { createReadStream,createWriteStream } from 'node:fs';
import { mkdir,readFile,stat,writeFile,lstat } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { createGzip,createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { join,resolve,relative,sep } from 'node:path';
import { once } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import type { PoolConnection,RowDataPacket } from 'mysql2/promise';
import { createEmptySchema,m4Pool,fixturePool,migrations } from './database.ts';
import { assertM4Target,sourceDatabase,restoreDatabase,fixtureVersion,isRestoreDatabase } from './policy.ts';
import { encodeRow,decodeRow,headerOf,headerV2Of,validateHeader,writableColumns,backupSchemaVersion,hasActiveSettlementWindow,type Table,type MigrationRecord } from './backup-format.ts';
import { preflightRecords } from './backup-preflight.ts';
import { checkBalances } from './balance-verification.ts';
import { RestoreTimer } from './restore-timing.ts';
import { seed } from './seed.ts';
import { model } from '../../apps/api/src/modules/finance/read-model.ts';
import { periodReport } from '../../apps/api/src/modules/finance/mysql-reports.ts';

const identifier=(value:string)=>{if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value))throw new Error('隔离数据表或列名不合规');return '`'+value+'`'};
function assertMigrationRows(actual:RowDataPacket[],expected:MigrationRecord[]):void{
  if(actual.length!==expected.length||actual.some((row,index)=>String(row.name)!==expected[index]?.name||String(row.checksum)!==expected[index]?.checksum))
    throw new Error('隔离库迁移标记与固定schema不匹配');
}
async function schema(db:PoolConnection,database:string):Promise<Table[]>{
  const [tables]=await db.execute<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE=\'BASE TABLE\' ORDER BY TABLE_NAME',[database]);
  const output:Table[]=[];
  for(const {TABLE_NAME:name} of tables){
    const [columns]=await db.execute<RowDataPacket[]>('SELECT COLUMN_NAME,DATA_TYPE,IS_NULLABLE,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[database,name]);
    const [keys]=await db.execute<RowDataPacket[]>("SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION",[database,name]);
    if(!keys.length)throw new Error('M4夹具出现无主键数据表');
    output.push({name:String(name),columns:writableColumns(columns as {COLUMN_NAME:unknown;DATA_TYPE:unknown;EXTRA:unknown}[]),primary:keys.map(x=>String(x.COLUMN_NAME))});
  }
  return output;
}
async function* rows(db:PoolConnection,table:Table){
  const names=table.columns.map(x=>identifier(x.name)).join(','),keys=table.primary.map(identifier).join(',');let cursor:unknown[]|undefined;
  for(;;){
    // 展开复合主键游标，使MySQL 8可构造范围扫描，避免元组不等式每页从头过滤。
    const values:unknown[]=[];
    const boundary=cursor?' AND ('+table.primary.map((key,index)=>{
      const prefix=table.primary.slice(0,index).map((part,i)=>{values.push(cursor![i]);return identifier(part)+'=?'});
      values.push(cursor![index]);return '('+[...prefix,identifier(key)+'>?'].join(' AND ')+')';
    }).join(' OR ')+')':'';
    const [batch]=await db.query<RowDataPacket[]>(`SELECT ${names} FROM ${identifier(table.name)} WHERE 1=1 ${boundary} ORDER BY ${keys} LIMIT 500`,values);
    if(!batch.length)break;for(const row of batch)yield row;cursor=table.primary.map(key=>batch.at(-1)![key]);if(batch.length<500)break;
  }
}
function artifactRoot(){return resolve('.local/m4')}
function backupPath(file:string){
  const root=artifactRoot(),target=resolve(root,file),delta=relative(root,target);
  if(!delta||delta==='..'||delta.startsWith('..'+sep)||delta.includes(sep)||!/^heji-m4-[a-f0-9-]{36}\.jsonl\.gz$/.test(file))throw new Error('备份路径必须是.local/m4下的系统生成文件名');
  return {root,target};
}
export async function createBackup(){
  assertM4Target(sourceDatabase,'bench',process.env.HEJI_ALLOW_M4);const pool=await fixturePool();
  const db=await pool.getConnection(),id=randomUUID(),file=`heji-m4-${id}.jsonl.gz`,{root,target}=backupPath(file),hash=createHash('sha256');
  try{
    await mkdir(root,{recursive:true});await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const tables=await schema(db,sourceDatabase),schemaVersion=backupSchemaVersion(tables);
    const expected=await migrations(schemaVersion.includeSummaries,schemaVersion.format==='heji-m4-backup-v2');
    const [applied]=await db.execute<RowDataPacket[]>('SELECT name,checksum FROM schema_migrations ORDER BY name');assertMigrationRows(applied,expected);
    let snapshotAt:string|undefined;
    if(schemaVersion.format==='heji-m4-backup-v2'){
      const [clock]=await db.execute<RowDataPacket[]>("SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ') snapshotAt");
      snapshotAt=String(clock[0]?.snapshotAt);if(!Number.isFinite(Date.parse(snapshotAt)))throw new Error('备份数据库快照时钟无效');
      const [windowRows]=await db.execute<RowDataPacket[]>(`SELECT closedAt,(expiresAt>?) expiresAtIsFuture
        FROM settlement_windows WHERE closedAt IS NULL`,[snapshotAt.replace('T',' ').replace('Z','')]);
      if(hasActiveSettlementWindow(windowRows.map(row=>({closedAt:row.closedAt,expiresAtIsFuture:row.expiresAtIsFuture}))))
        throw new Error('账本存在活动结算窗口，拒绝创建备份');
    }
    const head=schemaVersion.format==='heji-m4-backup-v2'
      ?headerV2Of(tables,seed,expected)
      :headerOf(tables,seed);
    if(snapshotAt)head.createdAt=snapshotAt;
    validateHeader(head,tables,expected);
    const gzip=createGzip({level:6}),out=createWriteStream(target,{flags:'wx',mode:0o600});const pipe=pipeline(gzip,out);void pipe.catch(()=>{});
    async function writeLine(line:string){if(!gzip.write(line+'\n'))await once(gzip,'drain')}
    await writeLine(JSON.stringify({kind:'header',value:head}));
    let total=0;
    const tableDigests:Record<string,{rows:number;sha256:string}>={};
    for(const table of tables){const tableHash=createHash('sha256');let count=0;for await(const row of rows(db,table)){const value=encodeRow(row,table.columns);tableHash.update(JSON.stringify(value)+'\n');await writeLine(JSON.stringify({kind:'row',table:table.name,value}));count++;total++}
      tableDigests[table.name]={rows:count,sha256:tableHash.digest('hex')};
      await writeLine(JSON.stringify({kind:'table-end',table:table.name,rows:count}));console.log(`备份表完成：${table.name}，${count}行`);
    }
    gzip.end();await pipe;await db.commit();
    const stream=createReadStream(target);for await(const chunk of stream)hash.update(chunk);
    const checksum=hash.digest('hex'),bytes=(await stat(target)).size;const manifest={format:'heji-m4-sha256-v1',file,sha256:checksum,compressedBytes:bytes,tables:tables.length,tableDigests,rows:total,createdAt:new Date().toISOString()};
    await writeFile(join(root,file+'.sha256'),JSON.stringify(manifest,null,2),{encoding:'utf8',flag:'wx',mode:0o600});
    console.log(`虚构隔离备份已创建：.local/m4/${file}；SHA-256 ${checksum}；${total}行`);
  }catch(error){await db.rollback();throw error}finally{db.release();await pool.end()}
}
async function* lines(file:string):AsyncGenerator<Record<string,unknown>>{
  const source=createReadStream(file),inflate=createGunzip(),pipe=pipeline(source,inflate);void pipe.catch(()=>{});
  const input=createInterface({input:inflate,crlfDelay:Infinity});
  try{for await(const line of input){if(!line.trim())continue;yield JSON.parse(line) as Record<string,unknown>}await pipe}
  finally{input.close();source.destroy();inflate.destroy()}
}
async function checkForeignKeys(db:PoolConnection,timer:RestoreTimer){
  const [keys]=await db.query<RowDataPacket[]>(`SELECT k.TABLE_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION
    FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION`);
  const groups=new Map<string,RowDataPacket[]>();for(const row of keys){const key=row.TABLE_NAME+'|'+row.CONSTRAINT_NAME;groups.set(key,[...(groups.get(key)??[]),row])}
  let constraintIndex=0;
  for(const rows of groups.values()){
    constraintIndex++;
    const first=rows[0]!,table=identifier(String(first.TABLE_NAME)),target=identifier(String(first.REFERENCED_TABLE_NAME));
    const condition=rows.map((row,index)=>`child.${identifier(String(row.COLUMN_NAME))}=parent.${identifier(String(row.REFERENCED_COLUMN_NAME))}`).join(' AND ');
    const notNull=rows.map(row=>`child.${identifier(String(row.COLUMN_NAME))} IS NOT NULL`).join(' AND ');
    await timer.measure('foreign_key',async()=>{
      const [orphans]=await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${table} child LEFT JOIN ${target} parent ON ${condition} WHERE ${notNull} AND parent.${identifier(String(first.REFERENCED_COLUMN_NAME))} IS NULL`);
      if(String(orphans[0]!.count)!=='0')throw new Error('恢复数据的外键完整性检查失败');
    },{constraintIndex});
  }
}
async function verifyContent(db:PoolConnection,includeSummaries:boolean,includeWindows:boolean,timer:RestoreTimer){
  const checksums=await timer.measure('migration_metadata',async()=>{
    const [version]=await db.execute<RowDataPacket[]>('SELECT name FROM schema_migrations ORDER BY name');
    const expected=await migrations(includeSummaries,includeWindows);
    if(version.length!==expected.length||version.some((row,index)=>String(row.name)!==expected[index]!.name))throw new Error('恢复库迁移清单不完整');
    const [actual]=await db.execute<RowDataPacket[]>('SELECT name,checksum FROM schema_migrations ORDER BY name');
    for(let i=0;i<expected.length;i++)if(String(actual[i]?.name)!==expected[i]!.name||String(actual[i]?.checksum)!==expected[i]!.checksum)throw new Error('恢复库迁移校验和不匹配');
    const [meta]=await db.execute<RowDataPacket[]>("SELECT version,state FROM m4_fixture_meta WHERE id=1");
    if(String(meta[0]?.version)!==fixtureVersion||String(meta[0]?.state)!=='ready')throw new Error('恢复夹具元信息不完整');
    return actual;
  });
  await timer.measure('foreign_keys',()=>checkForeignKeys(db,timer));
  await checkBalances(db,timer);
  if(includeSummaries){
    await timer.measure('derived_reconciliation',async()=>{
      const [books]=await db.execute<RowDataPacket[]>('SELECT * FROM books ORDER BY id');
      for(let index=0;index<books.length;index++){
        const book=books[index]!;
        await timer.measure('derived_balance',async()=>{
          if(!isDeepStrictEqual((await model(db,book,'',true)).snapshot,(await model(db,book,'',false)).snapshot))throw new Error('恢复后的派生余额与原始事实不一致');
        },{bookIndex:index+1});
        await timer.measure('derived_report',async()=>{
          if(!isDeepStrictEqual(await periodReport(db,String(book.id),{},true),await periodReport(db,String(book.id),{},false)))throw new Error('恢复后的派生报表与原始事实不一致');
        },{bookIndex:index+1});
      }
    });
  }
  const count=await timer.measure('financial_counts',async()=>{
    const windowCount=includeWindows?',(SELECT COUNT(*) FROM settlement_windows WHERE closedAt IS NULL AND expiresAt>UTC_TIMESTAMP(3)) activeWindows':'';
    const [counts]=await db.query<RowDataPacket[]>(`SELECT (SELECT COUNT(*) FROM books) books,(SELECT COUNT(*) FROM book_members) members,
      (SELECT COUNT(*) FROM expenses e JOIN expense_versions v ON v.expenseId=e.id AND v.revision=e.currentRevision) currentExpenses,
      (SELECT COUNT(*) FROM expense_versions) versions,(SELECT COUNT(*) FROM confirmed_transfers) transfers,
      (SELECT COUNT(*) FROM confirmed_transfers WHERE kind='REVERSAL') reversals${windowCount} FROM DUAL`);
    if(Number(counts[0]?.transfers)<2||Number(counts[0]?.reversals)<1)throw new Error('恢复夹具缺少非零普通转账/冲正，不能视为完整验收');
    if(includeWindows&&Number(counts[0]?.activeWindows)!==0)throw new Error('恢复库仍含活动结算窗口');
    return counts[0];
  });
  return {migrationChecksums:checksums,counts:count};
}
export async function restoreBackup(file:string,database=restoreDatabase){
  const restoreStarted=performance.now();
  const timer=new RestoreTimer(undefined,event=>console.error(JSON.stringify({kind:'restore_stage',...event})));
  if(!isRestoreDatabase(database))throw new Error('恢复目标必须是固定隔离库');
  assertM4Target(database,'restore',process.env.HEJI_ALLOW_M4);const {root,target}=backupPath(file);
  const manifest=await timer.measure('file_verification',async()=>{
    if((await lstat(target)).isSymbolicLink()||(await lstat(join(root,file+'.sha256'))).isSymbolicLink())throw new Error('不接受符号链接备份');
    const value=JSON.parse(await readFile(join(root,file+'.sha256'),'utf8')) as Record<string,unknown>;
    if(value.format!=='heji-m4-sha256-v1'||value.file!==file||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))throw new Error('备份校验清单无效');
    if((await stat(target)).size!==value.compressedBytes)throw new Error('备份文件长度与清单不一致');
    const hash=createHash('sha256');for await(const chunk of createReadStream(target))hash.update(chunk);
    if(hash.digest('hex')!==value.sha256)throw new Error('备份SHA-256校验失败');
    return value;
  });
  const digests=manifest.tableDigests as Record<string,{rows:number;sha256:string}>|undefined;
  const {head,restorePlan,expected}=await timer.measure('stream_preflight',async()=>{
    const localMigrations=await migrations(true,true);
    const result=await preflightRecords(lines(target),manifest,database,localMigrations);
    const schemaVersion=backupSchemaVersion(result.head.schema);
    return {...result,expected:await migrations(schemaVersion.includeSummaries,schemaVersion.format==='heji-m4-backup-v2')};
  });
  await timer.measure('schema_creation',()=>createEmptySchema(database,false,restorePlan.includeSummaries,restorePlan.includeWindows));
  const {pool,db}=await timer.measure('database_connection',async()=>{
    const connectionPool=m4Pool(database);
    try{return {pool:connectionPool,db:await connectionPool.getConnection()}}
    catch(error){await connectionPool.end();throw error}
  });let imported=0;
  try{
    await timer.measure('target_schema',async()=>validateHeader(head,await schema(db,database),head.format==='heji-m4-backup-v2'?expected:undefined));
    let batch:unknown[][]=[],batchTable:Table|undefined;
    async function flush(){if(!batch.length||!batchTable)return;const table=batchTable;await db.query(`INSERT INTO ${identifier(table.name)} (${table.columns.map(x=>identifier(x.name)).join(',')}) VALUES ${batch.map(values=>'('+values.map(()=>'?').join(',')+')').join(',')}`,batch.flat());batch=[]}
    await timer.measure('import',async()=>{
      await db.query('SET FOREIGN_KEY_CHECKS=0');
      await db.beginTransaction();
      for await(const record of lines(target))if(record.kind==='row'){
        const table=head.schema.find(x=>x.name===record.table)!;const values=decodeRow(record.value as unknown[],table.columns);
        if(batchTable?.name!==table.name){await flush();batchTable=table}batch.push(values);if(batch.length>=300)await flush();imported++;
      }
      await flush();await db.query('SET FOREIGN_KEY_CHECKS=1');
    });
    await timer.measure('table_digests',async()=>{
      if(!digests||Object.keys(digests).length!==head.schema.length)throw new Error('备份缺少逐表内容摘要');
      for(const table of head.schema){
        await timer.measure('table_digest',async()=>{let count=0;const hash=createHash('sha256');for await(const row of rows(db,table)){hash.update(JSON.stringify(encodeRow(row,table.columns))+'\n');count++}
          if(count!==digests[table.name]?.rows||hash.digest('hex')!==digests[table.name]?.sha256)throw new Error('恢复表内容摘要不匹配');
        },{table:table.name});
      }
    });
    const report=await verifyContent(db,restorePlan.includeSummaries,restorePlan.includeWindows,timer);
    await timer.measure('commit',()=>db.commit());const timing=timer.snapshot(),elapsedMs=performance.now()-restoreStarted;
    timing.elapsedMs=elapsedMs;
    const measuredTopLevel=timing.stages.filter(stage=>stage.parentId===null).reduce((sum,stage)=>sum+stage.elapsedMs,0);
    timing.unmeasuredMs=Math.max(0,elapsedMs-measuredTopLevel);
    const evidence={format:'heji-m4-restore-verification-v1',backupFormat:head.format,backup:file,rows:imported,checksum:manifest.sha256,restoredDatabase:database,restoredAt:new Date().toISOString(),elapsedMs,within30Minutes:elapsedMs<=1800000,elapsedScope:'入口至成功commit返回；含文件/流式预检、架构、导入、逐表摘要及全部恢复完整性核验；不含报告写入/连接收尾/安装',timing,report};
    const evidencePath=join(root,'restore-'+randomUUID()+'.json');await writeFile(evidencePath,JSON.stringify(evidence,null,2),{encoding:'utf8',flag:'wx',mode:0o600});
    console.log(`独立虚构库恢复并核验完成：${database}，${imported}行；报告保存在.local/m4/`);
  }catch(error){await db.rollback();throw error}finally{await db.query('SET FOREIGN_KEY_CHECKS=1').catch(()=>{});db.release();await pool.end()}
}
