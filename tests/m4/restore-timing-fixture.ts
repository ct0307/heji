import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readdir,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { migrations } from './database.ts';
import { headerOf,headerV2Of,type Table } from './backup-format.ts';
import { fixtureVersion } from './policy.ts';
import type { RestoreStageEvent } from './restore-timing.ts';

// 子进程专用合成夹具：所有数据库工厂在导入恢复入口前替换，不加载.env。
const sources=await migrations(true,true),seed='heji-fixed-m4-20261117';
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const names=['audit_events','book_members','books','confirmed_transfers','expense_shares','expense_versions','expenses',
  'finance_daily_categories','finance_daily_members','finance_member_totals','financial_audit_details','idempotency_records',
  'invitations','m4_fixture_meta','rate_limits','schema_migrations','sessions','settlement_windows','transfer_requests','users'];
const file='heji-m4-00000000-0000-4000-8000-000000000000.jsonl.gz';
let mode='',tables:Table[]=[],facts:Record<string,Record<string,unknown>[]>={},commits=0,rollbacks=0,ended=0;
let events:RestoreStageEvent[]=[];
const operations:string[]=[];
const failure=new Error('合成失败：不得输出的业务值');
const packet=(rows:unknown[])=>[rows,[]];
async function query(sql:string,values:unknown[]=[]):Promise<unknown[]>{
  if(sql.startsWith('SET FOREIGN_KEY_CHECKS'))return packet([]);
  if(sql.includes('information_schema.TABLES'))return packet(tables.map(table=>({TABLE_NAME:table.name})));
  if(sql.includes('information_schema.COLUMNS')){
    const table=tables.find(item=>item.name===values[1])!;
    return packet(table.columns.map(column=>({COLUMN_NAME:column.name,DATA_TYPE:mode==='schema'?'int':column.type,EXTRA:''})));
  }
  if(sql.includes('information_schema.KEY_COLUMN_USAGE')&&sql.includes('CONSTRAINT_NAME='))
    return packet(tables.find(table=>table.name===values[1])!.primary.map(COLUMN_NAME=>({COLUMN_NAME})));
  if(sql.startsWith('INSERT INTO')){
    operations.push('insert');if(mode==='import')throw failure;
    const name=/INSERT INTO `([^`]+)`/.exec(sql)![1]!,table=tables.find(table=>table.name===name)!;
    const rows:Record<string,unknown>[]=[];
    for(let start=0;start<values.length;start+=table.columns.length)
      rows.push(Object.fromEntries(table.columns.map((column,index)=>[column.name,values[start+index]])));
    facts[name]=[...(facts[name]??[]),...rows];return packet([]);
  }
  if(sql.includes('ORDER BY')&&sql.includes('LIMIT 500')){
    const name=/FROM `([^`]+)`/.exec(sql)![1]!;
    return packet(mode==='digest'&&name==='schema_migrations'?[]:facts[name]??[]);
  }
  if(sql==='SELECT name FROM schema_migrations ORDER BY name')return packet((mode==='success-v1'?sources.slice(0,2):sources).map(({name})=>({name})));
  if(sql==='SELECT name,checksum FROM schema_migrations ORDER BY name')return packet((mode==='success-v1'?sources.slice(0,2):sources).map(({name,checksum})=>({name,checksum:mode==='metadata'?'f'.repeat(64):checksum})));
  if(sql.includes('FROM m4_fixture_meta'))return packet([{version:fixtureVersion,state:'ready'}]);
  if(sql.includes('information_schema.KEY_COLUMN_USAGE'))return packet([{TABLE_NAME:'users',COLUMN_NAME:'id',REFERENCED_TABLE_NAME:'books',REFERENCED_COLUMN_NAME:'id',CONSTRAINT_NAME:'synthetic_fk',ORDINAL_POSITION:1}]);
  if(sql.startsWith('SELECT COUNT(*) AS count'))return packet([{count:mode==='foreign-key'?1:0}]);
  if(sql.startsWith('SELECT v.expenseId,v.revision FROM expense_versions'))return packet(mode==='history'?[{invalid:1}]:[]);
  if(sql==='SELECT id FROM expenses WHERE currentRevision IS NULL LIMIT 1')return packet(mode==='current'?[{id:'fake'}]:[]);
  if(sql.startsWith('WITH active_expenses'))return packet(mode==='balance'?[{bookId:'fake',total:1}]:[]);
  if(sql==='SELECT * FROM books ORDER BY id')return packet([{id:'synthetic-book-secret',financialVersion:'1'}]);
  if(sql.startsWith('SELECT (SELECT COUNT(*) FROM books)'))return packet([{books:1,members:2,currentExpenses:0,versions:0,transfers:2,reversals:1,activeWindows:mode==='counts'?1:0}]);
  throw new Error('夹具出现未覆盖SQL，停止');
}
const db={query,execute:query,beginTransaction:async()=>{operations.push('begin')},commit:async()=>{
  operations.push('commit');if(mode==='commit')throw failure;commits++;
},rollback:async()=>{operations.push('rollback');rollbacks++},release:()=>operations.push('release')};
mock.module(new URL('./database.ts',import.meta.url).href,{namedExports:{migrations,
  createEmptySchema:async()=>{operations.push('create');if(mode==='existing')throw failure},
  m4Pool:()=>({getConnection:async()=>{if(mode==='connection')throw failure;return db},end:async()=>{ended++}}),
  fixturePool:()=>{throw new Error('禁止连接bench')}
}});
mock.module(new URL('./seed.ts',import.meta.url).href,{namedExports:{seed}});
mock.module(new URL('../../apps/api/src/modules/finance/read-model.ts',import.meta.url).href,{namedExports:{
  model:async(_db:unknown,_book:unknown,_actor:unknown,derived:boolean)=>({snapshot:{value:mode==='derived-balance'&&derived?1:0}})
}});
mock.module(new URL('../../apps/api/src/modules/finance/mysql-reports.ts',import.meta.url).href,{namedExports:{
  periodReport:async(_db:unknown,_book:unknown,_filter:unknown,derived:boolean)=>({value:mode==='derived-report'&&derived?1:0})
}});
const {restoreBackup}=await import('./backup.ts');
process.env.HEJI_ALLOW_M4='yes';
const originalLog=console.log,originalError=console.error;
const scenarios=['success-v2','success-v2-timed','success-v1','file','stream','existing','connection','schema','import','digest','metadata','foreign-key','history','current','balance','derived-balance','derived-report','counts','commit'];
const failedStage:Record<string,string>={file:'file_verification',stream:'stream_preflight',existing:'schema_creation',connection:'database_connection',schema:'target_schema',import:'import',digest:'table_digest',metadata:'migration_metadata','foreign-key':'foreign_key',history:'historical_share_conservation',current:'current_revision_present',balance:'balance_conservation','derived-balance':'derived_balance','derived-report':'derived_report',counts:'financial_counts',commit:'commit'};
const outputs:Array<{scenario:string;success:boolean;failedStage?:string}>=[];
try{
  console.log=()=>{};
  console.error=(line:unknown)=>{
    if(!String(line).startsWith('{')){originalError(line);return}
    const value=JSON.parse(String(line));assert.equal(value.kind,'restore_stage');events.push(value);
  };
  for(const scenario of scenarios){
    mode=scenario;commits=0;rollbacks=0;ended=0;events=[];facts={};operations.length=0;
    const root=await mkdtemp(join(tmpdir(),'heji-offline-restore-timing-'));
    process.chdir(root);await mkdir('.local/m4',{recursive:true});
    tables=(scenario==='success-v1'?['users']:names).map(name=>({name,columns:name==='schema_migrations'?[{name:'name',type:'varchar'},{name:'checksum',type:'char'}]:[{name:'id',type:'char'}],primary:name==='schema_migrations'?['name']:['id']}));
    const head=scenario==='success-v1'?headerOf(tables,seed):headerV2Of(tables,seed,sources);
    const records:unknown[]=[{kind:'header',value:head}],digests:Record<string,{rows:number;sha256:string}>={};
    let total=0;
    for(const table of tables){
      const rows=table.name==='schema_migrations'?sources.map(({name,checksum})=>[name,checksum]):[];
      for(const value of rows)records.push({kind:'row',table:table.name,value});
      records.push({kind:'table-end',table:table.name,rows:rows.length});
      total+=rows.length;digests[table.name]={rows:rows.length,sha256:hash(rows.map(row=>JSON.stringify(row)+'\n').join(''))};
    }
    if(scenario==='stream')records.pop();
    const bytes=gzipSync(records.map(record=>JSON.stringify(record)+'\n').join(''));
    await writeFile(join('.local/m4',file),bytes,{flag:'wx'});
    await writeFile(join('.local/m4',file+'.sha256'),JSON.stringify({format:'heji-m4-sha256-v1',file,sha256:scenario==='file'?'f'.repeat(64):hash(bytes),compressedBytes:bytes.length,tables:tables.length,rows:total,tableDigests:digests}),{flag:'wx'});
    let caught:unknown;
    let restoreTarget='heji_m4_restore_004';
    if(scenario==='success-v1')restoreTarget='heji_m4_restore';
    if(scenario==='success-v2-timed'||scenario==='existing')restoreTarget='heji_m4_restore_004_timed';
    try{await restoreBackup(file,restoreTarget)}catch(error){caught=error}
    const reports=(await readdir('.local/m4')).filter(name=>/^restore-.*\.json$/.test(name));
    assert.equal(JSON.stringify(events).includes('synthetic-book-secret'),false);
    assert.equal(JSON.stringify(events).includes(failure.message),false);
    if(scenario.startsWith('success')){
      assert.equal(caught,undefined);assert.equal(commits,1);assert.equal(reports.length,1);assert.equal(ended,1);
      const report=JSON.parse(await readFile(join('.local/m4',reports[0]!),'utf8'));
      assert.equal(report.restoredDatabase,restoreTarget);
      assert.equal(report.format,'heji-m4-restore-verification-v1');assert.equal(report.elapsedMs,report.timing.elapsedMs);
      assert.equal(report.within30Minutes,true);assert.ok(report.timing.stages.every((row:RestoreStageEvent)=>row.status==='completed'));
      const top=report.timing.stages.filter((row:RestoreStageEvent)=>row.parentId===null).reduce((sum:number,row:RestoreStageEvent)=>sum+row.elapsedMs,0);
      assert.ok(Math.abs(top+report.timing.unmeasuredMs-report.elapsedMs)<0.001);
      assert.equal(report.timing.stages.filter((row:RestoreStageEvent)=>row.stage==='table_digest').length,tables.length);
      assert.equal(report.timing.stages.filter((row:RestoreStageEvent)=>row.stage==='derived_balance').length,scenario==='success-v1'?0:1);
      assert.equal(report.timing.stages.filter((row:RestoreStageEvent)=>row.stage==='derived_report').length,scenario==='success-v1'?0:1);
      assert.ok(operations.indexOf('begin')<operations.indexOf('commit'));
      outputs.push({scenario,success:true});
    }else{
      assert.ok(caught);assert.equal(commits,0);assert.equal(reports.length,0);
      assert.ok(events.some(row=>row.stage===failedStage[scenario]&&row.status==='failed'));
      if(operations.includes('begin'))assert.ok(rollbacks>=1);
      if(['import','connection','existing','commit'].includes(scenario))assert.equal(caught,failure);
      outputs.push({scenario,success:false,failedStage:failedStage[scenario]!});
    }
  }
}finally{console.log=originalLog;console.error=originalError;mock.restoreAll()}
console.log(JSON.stringify({format:'heji-offline-restore-timing-fixture-v1',scenarios:outputs,scope:'synthetic gzip and mocked database only; no MySQL, real backup or .env access'}));
