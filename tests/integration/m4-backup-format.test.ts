import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRow,decodeRow,headerOf,headerV2Of,validateHeader,validateRestorePlan,writableColumns,backupSchemaVersion,validateMigrationManifest,hasActiveSettlementWindow,assertRestoreTarget } from '../m4/backup-format.ts';
import { fixtureVersion,parseRestoreArgs,restoreDatabases } from '../m4/policy.ts';

const table=(name:string)=>({name,columns:[{name:'id',type:'char'}],primary:['id']});
const summaries=['finance_member_totals','finance_daily_members','finance_daily_categories'];
const v2Tables=['schema_migrations','m4_fixture_meta','users','sessions','books','book_members','invitations','audit_events','rate_limits','expenses','expense_versions','expense_shares','transfer_requests','confirmed_transfers','idempotency_records','financial_audit_details',...summaries,'settlement_windows'];
const migrations=['001_m1.sql','002_m2.sql','003_finance_summaries.sql','004_settlement_windows.sql'].map(name=>({name,checksum:'a'.repeat(64)}));

test('恢复目标保留旧默认值并显式接受004新隔离目标',()=>{
  const file='heji-m4-00000000-0000-4000-8000-000000000000.jsonl.gz';
  assert.equal(parseRestoreArgs([file]).database,'heji_m4_restore');
  assert.equal(parseRestoreArgs([file,'--target=heji_m4_restore_003']).database,'heji_m4_restore_003');
  assert.equal(parseRestoreArgs([file,'--target=heji_m4_restore_004']).database,'heji_m4_restore_004');
  assert.equal(parseRestoreArgs([file,'--target=heji_m4_restore_004_timed']).database,'heji_m4_restore_004_timed');
  assert.deepEqual(restoreDatabases,['heji_m4_restore','heji_m4_restore_003','heji_m4_restore_004','heji_m4_restore_004_timed']);
  assert.throws(()=>parseRestoreArgs([file,'--target=heji_m4_restore_004_timed_retry']));
  assert.throws(()=>parseRestoreArgs([file,'--target=heji_dev']));
  assert.throws(()=>parseRestoreArgs([file,'--target=heji_m4_restore_004','--target=heji_m4_restore_003']));
  assert.throws(()=>parseRestoreArgs([file,'--target=']));
});
test('格式版本由完整schema选择，004必须同时含窗口表和全部汇总表',()=>{
  assert.deepEqual(backupSchemaVersion([table('users')]),{format:'heji-m4-backup-v1',includeSummaries:false});
  assert.deepEqual(backupSchemaVersion(['users',...summaries].map(table)),{format:'heji-m4-backup-v1',includeSummaries:true});
  assert.deepEqual(backupSchemaVersion(['users',...summaries,'settlement_windows'].map(table)),{format:'heji-m4-backup-v2',includeSummaries:true,includeWindows:true});
  for(const names of [['settlement_windows'],['finance_member_totals','settlement_windows'],['finance_member_totals','finance_daily_members','settlement_windows']])
    assert.throws(()=>backupSchemaVersion(names.map(table)));
});
test('v2头部须通过固定迁移清单、schema版本和本地checksum校验',()=>{
  const schema=v2Tables.map(table),head=headerV2Of(schema,'heji-fixed-m4-20261117',migrations);
  validateHeader(head,schema,migrations);
  assert.throws(()=>validateHeader({...head,migrations:migrations.slice(1)},schema,migrations));
  assert.throws(()=>validateHeader({...head,migrations:[...migrations].reverse()},schema,migrations));
  assert.throws(()=>validateHeader({...head,migrations:migrations.map((item,index)=>index===3?{...item,checksum:'b'.repeat(64)}:item)},schema,migrations));
  assert.throws(()=>validateHeader(head,schema.slice(0,-1),migrations));
  assert.throws(()=>validateMigrationManifest([...migrations,{name:'005_unknown.sql',checksum:'a'.repeat(64)}],migrations));
  assert.throws(()=>validateHeader({...head,schema:[...schema,table('unknown')]},[...schema,table('unknown')],migrations));
  assert.throws(()=>validateHeader(head,schema));
  assert.throws(()=>validateHeader({...head,schema:schema.filter(item=>item.name!=='users')},schema.filter(item=>item.name!=='users'),migrations));
});
test('v1继续拒绝004表，迁移清单验证准确比较名称、顺序和摘要',()=>{
  const schema=['users',...summaries].map(table),head=headerOf(schema,'heji-fixed-m4-20261117');validateHeader(head,schema);
  assert.throws(()=>validateHeader({...head,schema:[...schema,table('settlement_windows')]},[...schema,table('settlement_windows')]));
  validateMigrationManifest(migrations,migrations);
  for(const invalid of [migrations.slice(1),[...migrations].reverse(),migrations.map((item,index)=>index===0?{...item,name:'bad.sql'}:item),migrations.map((item,index)=>index===0?{...item,checksum:'invalid'}:item)])
    assert.throws(()=>validateMigrationManifest(invalid,migrations));
});
test('004恢复目标严格匹配格式，活动窗口只拒绝未关闭且未到期记录',()=>{
  assertRestoreTarget('heji-m4-backup-v1','heji_m4_restore');
  assertRestoreTarget('heji-m4-backup-v1','heji_m4_restore_003');
  assertRestoreTarget('heji-m4-backup-v2','heji_m4_restore_004');
  assertRestoreTarget('heji-m4-backup-v2','heji_m4_restore_004_timed');
  assert.throws(()=>assertRestoreTarget('heji-m4-backup-v1','heji_m4_restore_004'));
  assert.throws(()=>assertRestoreTarget('heji-m4-backup-v1','heji_m4_restore_004_timed'));
  assert.throws(()=>assertRestoreTarget('heji-m4-backup-v2','heji_m4_restore_003'));
  assert.equal(hasActiveSettlementWindow([{closedAt:null,expiresAtIsFuture:1}]),true);
  assert.equal(hasActiveSettlementWindow([{closedAt:'2026-11-19T00:00:00Z',expiresAtIsFuture:1}]),false);
  assert.equal(hasActiveSettlementWindow([{closedAt:null,expiresAtIsFuture:0}]),false);
  assert.equal(hasActiveSettlementWindow([]),false);
  assert.throws(()=>hasActiveSettlementWindow([{closedAt:null,expiresAtIsFuture:'unknown'}]));
});
test('恢复计划在创建目标前验证格式、目标、schema和本地迁移摘要',()=>{
  const v1Schema=[table('users'),...summaries.map(table)],v1=headerOf(v1Schema,'heji-fixed-m4-20261117');
  assert.deepEqual(validateRestorePlan(v1,'heji_m4_restore_003',migrations),{includeSummaries:true,includeWindows:false});
  const v2Schema=v2Tables.map(table),v2=headerV2Of(v2Schema,'heji-fixed-m4-20261117',migrations);
  assert.deepEqual(validateRestorePlan(v2,'heji_m4_restore_004',migrations),{includeSummaries:true,includeWindows:true});
  assert.throws(()=>validateRestorePlan(v2,'heji_m4_restore_003',migrations));
  assert.throws(()=>validateRestorePlan({...v2,migrations:migrations.map((item,index)=>index===3?{...item,checksum:'b'.repeat(64)}:item)},'heji_m4_restore_004',migrations));
});

test('恢复格式保留整数分字符串、二进制、UTC毫秒、JSON及空值，不执行备份中的SQL',()=>{
  const row={amountFen:'9007199254740993',digest:Buffer.from([0,255]),createdAt:new Date('2026-01-01T01:02:03.004Z'),detail:{reason:'虚构恢复验收'},optional:null};
  const columns=[{name:'amountFen',type:'bigint'},{name:'digest',type:'binary'},{name:'createdAt',type:'datetime'},{name:'detail',type:'json'},{name:'optional',type:'varchar'}];
  assert.deepEqual(decodeRow(encodeRow(row,columns),columns),['9007199254740993',Buffer.from([0,255]),'2026-01-01 01:02:03.004','{"reason":"虚构恢复验收"}',null]);
  assert.throws(()=>decodeRow(['bad'],columns));
});
test('恢复只接受固定虚构来源、版本和当前表列，不接受自定义表或跨库指令',()=>{
  const schema=[{name:'users',columns:[{name:'id',type:'char'}],primary:['id']}];
  const header=headerOf(schema,'heji-fixed-m4-20261117');validateHeader(header,schema);
  for(const invalid of [{database:'heji_dev'},{version:'old'},{schema:[{name:'users; DROP DATABASE heji_dev',columns:[],primary:[]}]}])assert.throws(()=>validateHeader({...header,...invalid},schema));
});
test('备份排除MySQL生成列，由恢复库重新计算，不向GENERATED ALWAYS列写入值',()=>{
  const columns=writableColumns([
    {COLUMN_NAME:'id',DATA_TYPE:'char',EXTRA:''},
    {COLUMN_NAME:'pendingReversalId',DATA_TYPE:'char',EXTRA:'STORED GENERATED'},
    {COLUMN_NAME:'calculated',DATA_TYPE:'int',EXTRA:'VIRTUAL GENERATED'},
    {COLUMN_NAME:'createdAt',DATA_TYPE:'datetime',EXTRA:'DEFAULT_GENERATED'}
  ]);
  assert.deepEqual(columns,[{name:'id',type:'char'},{name:'createdAt',type:'datetime'}]);
});
