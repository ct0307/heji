import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { PoolConnection } from 'mysql2/promise';

const moduleUrl=new URL('../../database/scripts/summary-migration.ts',import.meta.url);
const migration=await import(moduleUrl.href).catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND')assert.fail('缺少默认只规划的汇总迁移入口');
  throw error;
});

test('默认和显式plan不需要许可且不接受目标或维护参数',()=>{
  assert.deepEqual(migration.parseSummaryMigrationArgs([],undefined),{apply:false,database:null});
  assert.deepEqual(migration.parseSummaryMigrationArgs(['--plan'],'no'),{apply:false,database:null});
  for(const args of [['--plan','--database=heji_dev'],['--maintenance'],['--database=heji_dev']])assert.throws(()=>migration.parseSummaryMigrationArgs(args,'yes'));
});
test('apply必须同时显式目标、维护开关和yes许可，只允许两个目标',()=>{
  for(const database of ['heji_dev','heji_m4_bench']){
    const args=['--apply','--database='+database,'--maintenance'];
    assert.deepEqual(migration.parseSummaryMigrationArgs(args,'yes'),{apply:true,database});
    for(const permission of [undefined,'YES','true','no'])assert.throws(()=>migration.parseSummaryMigrationArgs(args,permission));
    for(let i=0;i<args.length;i++)assert.throws(()=>migration.parseSummaryMigrationArgs(args.filter((_,index)=>index!==i),'yes'));
  }
});
test('拒绝恢复库、参数注入、未知参数、重复参数和plan混用',()=>{
  for(const args of [
    ['--apply','--database=heji_m4_restore','--maintenance'],['--apply','--database=mysql','--maintenance'],
    ['--apply','--database=heji_dev;DROP DATABASE x','--maintenance'],['--force'],['--plan','--plan'],
    ['--apply','--apply','--database=heji_dev','--maintenance'],['--apply','--database=heji_dev','--database=heji_m4_bench','--maintenance'],
    ['--apply','--database=heji_dev','--maintenance','--maintenance'],['--plan','--apply','--database=heji_dev','--maintenance'],
  ])assert.throws(()=>migration.parseSummaryMigrationArgs(args,'yes'));
});
test('只接受三个固定本机host，远程和伪装本机均拒绝',()=>{
  for(const host of ['127.0.0.1','localhost','::1'])migration.assertSummaryTargetHost(host);
  for(const host of ['127.0.0.2','localhost.example.com','0.0.0.0','mysql',''])assert.throws(()=>migration.assertSummaryTargetHost(host));
});
test('计划读取同源提案和001/002校验和，只允许三条固定建表SQL',async()=>{
  const plan=await migration.summaryMigrationPlan();
  assert.equal(plan.name,'003_finance_summaries.sql');assert.match(plan.checksum,/^[a-f0-9]{64}$/);
  assert.deepEqual(plan.baseline.map((entry:{name:string})=>entry.name),['001_m1.sql','002_m2.sql']);
  assert.equal(plan.statements.length,3);
  for(const [index,table] of ['finance_member_totals','finance_daily_members','finance_daily_categories'].entries())assert.match(plan.statements[index],new RegExp('^CREATE TABLE '+table+' \\('));
  for(const sql of [plan.sql.replace('finance_member_totals','other_table'),plan.sql+'\nDROP TABLE books;',plan.sql.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ')])assert.throws(()=>migration.assertSummaryProposal(sql));
});

async function fakeConnection(options:{existingTable?:string;extraMigration?:boolean;badChecksum?:boolean;failCreate?:boolean;database?:string|null;autocommit?:number;activeTransaction?:boolean}={}){
  const plan=await migration.summaryMigrationPlan(),calls:string[]=[],bound:unknown[][]=[];
  const baseline=plan.baseline.map((entry:{name:string;checksum:string})=>({name:entry.name,checksum:entry.checksum}));
  if(options.extraMigration)baseline.push({name:'003_finance_summaries.sql',checksum:'x'});
  if(options.badChecksum)baseline[0]!.checksum='bad';
  const db={
    execute:async(sql:string,values:unknown[]=[])=>{
      calls.push(sql);bound.push(values);
      if(sql.includes('SELECT DATABASE()'))return [[{databaseName:options.database===undefined?'heji_dev':options.database,autocommit:options.autocommit??1}],[]];
      if(sql.includes('GET_LOCK'))return [[{acquired:1}],[]];
      if(sql.includes('information_schema.TABLES'))return [[...(options.existingTable?[{TABLE_NAME:options.existingTable}]:[])],[]];
      if(sql.includes('SELECT name,checksum FROM schema_migrations'))return [baseline,[]];
      if(sql.startsWith('CREATE TABLE')&&options.failCreate)throw Object.assign(new Error('包含敏感SQL参数的原始错误'),{code:'ER_TABLE_EXISTS_ERROR'});
      if(sql.includes('COUNT(*)'))return [[{count:'0'}],[]];
      if(sql.includes('SUM(paidFen)'))return [[{paidFen:'0',shareFen:'0',outgoingFen:'0',incomingFen:'0'}],[]];
      return [[],[]];
    },
    query:async(sql:string)=>{calls.push(sql);if(options.activeTransaction&&sql==='SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')throw Object.assign(new Error('已有事务'),{code:'ER_CANT_CHANGE_TX_CHARACTERISTICS'});return [[],[]]},
    commit:async()=>{calls.push('COMMIT')},rollback:async()=>{calls.push('ROLLBACK')},
  } as unknown as PoolConnection;
  return {db,plan,calls,bound};
}
test('导出入口拒绝连接实际数据库不符或NULL，任何DDL前停止',async()=>{
  for(const database of ['heji_m4_restore','heji_m4_bench','mysql',null]){
    const {db,plan,calls}=await fakeConnection({database});
    await assert.rejects(()=>migration.executeSummaryMigration(db,'heji_dev',plan));
    assert.ok(calls.some(sql=>sql.includes('SELECT DATABASE()')));
    assert.ok(calls.every(sql=>!/^CREATE|^INSERT|^START TRANSACTION/.test(sql)));
  }
});
test('导出入口在DDL前拒绝关闭autocommit或已有事务，不提交或回滚调用方事务',async()=>{
  for(const options of [{autocommit:0},{activeTransaction:true}]){
    const {db,plan,calls}=await fakeConnection(options);
    await assert.rejects(()=>migration.executeSummaryMigration(db,'heji_dev',plan));
    assert.ok(calls.every(sql=>!/^CREATE|^INSERT|^START TRANSACTION/.test(sql)));
    assert.ok(!calls.includes('COMMIT'));assert.ok(!calls.includes('ROLLBACK'));
  }
});
test('schema门禁拒绝任一现有汇总表、额外标记和旧checksum变化，保持只读',async()=>{
  for(const options of [{existingTable:'finance_member_totals'},{existingTable:'finance_daily_members'},{existingTable:'finance_daily_categories'},{extraMigration:true},{badChecksum:true}]){
    const {db,plan,calls}=await fakeConnection(options);await assert.rejects(()=>migration.checkSummarySchema(db,'heji_dev',plan));
    assert.ok(calls.every(sql=>sql.startsWith('SELECT')));
  }
});
test('迁移取得命名锁并重复门禁，RR先锁账本再做业务一致读，marker最后提交',async()=>{
  const {db,plan,calls,bound}=await fakeConnection();
  const evidence=await migration.executeSummaryMigration(db,'heji_dev',plan);
  assert.equal(calls.filter(sql=>sql.includes('information_schema.TABLES')).length,2);
  assert.equal(calls.filter(sql=>sql.startsWith('CREATE TABLE ')).length,3);
  const transaction=calls.findIndex(sql=>sql==='START TRANSACTION');
  assert.ok(calls[transaction-1]?.includes('REPEATABLE READ'));
  assert.match(calls[transaction+1]!,/^SELECT id FROM books ORDER BY id FOR UPDATE$/);
  assert.ok(calls.findIndex(sql=>sql.includes('COUNT(*)'))>transaction+1);
  const marker=calls.findIndex(sql=>sql.startsWith('INSERT INTO schema_migrations'));
  assert.equal(calls[marker+1],'COMMIT');assert.ok(calls.at(-1)?.includes('RELEASE_LOCK'));
  assert.ok(bound.some(values=>values[0]==='heji_dev_summary_migration'));
  assert.equal(evidence.database,'heji_dev');assert.equal(evidence.reconciliation.checkedBooks,0);
  assert.ok(calls.every(sql=>!/^DELETE|^DROP|^TRUNCATE|CREATE DATABASE/i.test(sql)));
});
test('DDL失败仅回滚事务并保留建表残留，不标记成功或自动重试',async()=>{
  const {db,plan,calls}=await fakeConnection({failCreate:true,database:'heji_m4_bench'});
  await assert.rejects(()=>migration.executeSummaryMigration(db,'heji_m4_bench',plan));
  assert.equal(calls.filter(sql=>sql.startsWith('CREATE TABLE ')).length,1);
  assert.ok(!calls.some(sql=>sql.startsWith('INSERT INTO schema_migrations')));
  assert.ok(calls.every(sql=>!/^DELETE|^DROP|^TRUNCATE/i.test(sql)));
  assert.ok(calls.at(-1)?.includes('RELEASE_LOCK'));
});
test('回填失败回滚数据，不提交激活标记并保留三张DDL',async()=>{
  const {db,plan,calls}=await fakeConnection();
  const execute=db.execute.bind(db);
  db.execute=(async(sql:string,values:(string|number|boolean|null)[]=[])=>{
    if(sql.startsWith('INSERT INTO finance_daily_members'))throw Object.assign(new Error('回填失败且含行内容'),{code:'ER_DATA_OUT_OF_RANGE'});
    return execute(sql,values);
  }) as PoolConnection['execute'];
  await assert.rejects(()=>migration.executeSummaryMigration(db,'heji_dev',plan));
  assert.equal(calls.filter(sql=>sql.startsWith('CREATE TABLE ')).length,3);
  assert.ok(calls.includes('ROLLBACK'));assert.ok(!calls.includes('COMMIT'));
  assert.ok(!calls.some(sql=>sql.startsWith('INSERT INTO schema_migrations')));
});
test('逐成员对账差异必须回滚而不是发布marker',async()=>{
  const {db,plan,calls}=await fakeConnection();
  const execute=db.execute.bind(db);
  db.execute=(async(sql:string,values:(string|number|boolean|null)[]=[])=>{
    if(sql==='SELECT id,financialVersion FROM books ORDER BY id')return [[{id:'book',financialVersion:'0'}],[]];
    if(sql.includes('LEFT JOIN finance_member_totals'))return [[{memberId:'unexpected',paidFen:'1',shareFen:'0',outgoingFen:'0',incomingFen:'0'}],[]];
    return execute(sql,values);
  }) as PoolConnection['execute'];
  await assert.rejects(()=>migration.executeSummaryMigration(db,'heji_dev',plan));
  assert.ok(calls.includes('ROLLBACK'));assert.ok(!calls.includes('COMMIT'));
  assert.ok(!calls.some(sql=>sql.startsWith('INSERT INTO schema_migrations')));
});
test('脱敏错误只输出固定格式错误码',()=>{
  assert.equal(migration.safeSummaryMigrationError(Object.assign(new Error('password=x SQL'),{code:'ER_ACCESS_DENIED_ERROR'})),'ER_ACCESS_DENIED_ERROR');
  assert.equal(migration.safeSummaryMigrationError({code:'token secret'}),'SUMMARY_MIGRATION_STOPPED');
  assert.equal(migration.safeSummaryMigrationError(new Error('password=x')),'SUMMARY_MIGRATION_STOPPED');
});
test('提交后证据写入失败使用独立脱敏状态，避免误报数据库尚未提交',()=>{
  assert.equal(migration.safeSummaryMigrationError({code:'SUMMARY_MIGRATION_COMMITTED_EVIDENCE_FAILED'}),'SUMMARY_MIGRATION_COMMITTED_EVIDENCE_FAILED');
});
test('CLI默认与plan仅展示本地计划，导入入口没有立即执行副作用',async()=>{
  const cli=new URL('../../database/scripts/migrate-summaries.ts',import.meta.url);
  for(const args of [[],['--plan']]){
    const child=spawnSync(process.execPath,[fileURLToPath(cli),...args],{encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/未连接|不连接/);assert.match(child.stdout,/003_finance_summaries.sql/);
  }
  const source=await readFile(cli,'utf8');assert.doesNotMatch(source,/--env-file|dotenv|readFile/);
  await import(cli.href);
});
