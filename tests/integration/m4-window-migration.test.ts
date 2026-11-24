import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseWindowMigrationArgs,windowMigrationPlan,executeWindowMigration } from '../../database/scripts/window-migration.ts';
import { backupIncludesSummaries,backupSchemaVersion } from '../m4/backup-format.ts';
import { migrations } from '../m4/database.ts';
import type { PoolConnection } from 'mysql2/promise';

test('004默认离线计划；apply必须指定本机白名单库、维护及yes许可',()=>{
  assert.deepEqual(parseWindowMigrationArgs([],undefined),{apply:false,database:null});
  for(const args of [['--apply'],['--apply','--database=heji_dev'],['--apply','--database=mysql','--maintenance'],['--plan','--apply','--database=heji_dev','--maintenance'],['--plan','--plan']])assert.throws(()=>parseWindowMigrationArgs(args,'yes'));
  assert.throws(()=>parseWindowMigrationArgs(['--apply','--database=heji_dev','--maintenance'],undefined));
  assert.deepEqual(parseWindowMigrationArgs(['--apply','--database=heji_dev','--maintenance'],'yes'),{apply:true,database:'heji_dev'});
});
test('004只建独立窗口表，不加入旧迁移/恢复入口；包含防跨账本外键',async()=>{
  const plan=await windowMigrationPlan();assert.equal(plan.name,'004_settlement_windows.sql');assert.equal(plan.statements.length,1);
  assert.match(plan.sql,/REFERENCES transfer_requests\(bookId,id\)/);assert.match(plan.sql,/REFERENCES book_members\(bookId,id\)/);
  assert.deepEqual((await migrations()).map(x=>x.name),['001_m1.sql','002_m2.sql']);
  const windowSchema=['finance_member_totals','finance_daily_members','finance_daily_categories','settlement_windows'].map(name=>({name,columns:[],primary:['id']}));
  assert.deepEqual(backupSchemaVersion(windowSchema),{format:'heji-m4-backup-v2',includeSummaries:true,includeWindows:true});
  assert.throws(()=>backupIncludesSummaries(windowSchema),/v1/);
  assert.throws(()=>backupSchemaVersion([{name:'settlement_windows',columns:[],primary:['bookId']}]),/汇总结构/);
});
test('004离线入口不需要数据库配置，不执行SQL',()=>{
  const result=spawnSync(process.execPath,['database/scripts/migrate-windows.ts','--plan'],{encoding:'utf8',env:{...process.env,DB_NAME:'invalid',HEJI_ALLOW_MIGRATION:''}});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/未连接数据库/);
});
test('004迁移拒绝错误连接、已有表及校验和异常，任何DDL前停止；DDL故障不写标记',async()=>{
  const plan=await windowMigrationPlan();
  for(const mode of ['database','table','checksum','ddl','ok']){
    const calls:string[]=[];
    const db={execute:async(sql:string)=>{
      calls.push(sql);
      if(sql.includes('SELECT DATABASE()'))return [[{databaseName:mode==='database'?'mysql':'heji_dev',autocommit:1}],[]];
      if(sql.includes('GET_LOCK'))return [[{acquired:1}],[]];
      if(sql.includes('information_schema.TABLES'))return [mode==='table'?[{TABLE_NAME:'settlement_windows'}]:[],[]];
      if(sql.includes('SELECT name,checksum'))return [plan.baseline.map(x=>({...x,checksum:mode==='checksum'?'bad':x.checksum})),[]];
      if(sql.startsWith('CREATE')&&mode==='ddl')throw new Error('DDL故障');
      return [[],[]];
    },query:async(sql:string)=>{calls.push(sql);return [[],[]]}} as unknown as PoolConnection;
    if(mode==='ok')await executeWindowMigration(db,'heji_dev',plan);
    else await assert.rejects(()=>executeWindowMigration(db,'heji_dev',plan));
    assert.equal(calls.some(x=>x.startsWith('INSERT INTO schema_migrations')),mode==='ok');
    if(['database','table','checksum'].includes(mode))assert.equal(calls.some(x=>x.startsWith('CREATE')),false);
  }
});
