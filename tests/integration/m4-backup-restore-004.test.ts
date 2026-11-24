import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { headerOf,headerV2Of,validateRestorePlan } from '../m4/backup-format.ts';
import { migrations } from '../m4/database.ts';
import { preflightRecords } from '../m4/backup-preflight.ts';

const names=['schema_migrations','m4_fixture_meta','users','sessions','books','book_members','invitations','audit_events','rate_limits','expenses','expense_versions','expense_shares','transfer_requests','confirmed_transfers','idempotency_records','financial_audit_details','finance_member_totals','finance_daily_members','finance_daily_categories','settlement_windows'];
const schema=names.map(name=>({name,columns:[{name:'bookId',type:'char'}],primary:['bookId']}));

test('004 v2恢复只能用新目标，且在建库前核对真实提案迁移清单',async()=>{
  const sources=await migrations(true,true),head=headerV2Of(schema,'heji-fixed-m4-20261117',sources);
  assert.deepEqual(validateRestorePlan(head,'heji_m4_restore_004',sources),{includeSummaries:true,includeWindows:true});
  assert.throws(()=>validateRestorePlan(head,'heji_m4_restore_003',sources));
  const changed=head.migrations.map((entry,index)=>index===3?{...entry,checksum:'f'.repeat(64)}:entry);
  assert.throws(()=>validateRestorePlan({...head,migrations:changed},'heji_m4_restore_004',sources));
  const sql=await readFile(new URL('../../docs/development/proposals/004_settlement_windows.sql',import.meta.url),'utf8');
  assert.equal(sources[3]!.checksum,createHash('sha256').update(sql).digest('hex'));
});

async function fixture(){
  const sources=await migrations(true,true);
  const tables=[...schema.filter(table=>table.name!=='settlement_windows'&&table.name!=='schema_migrations'),
    {name:'schema_migrations',columns:[{name:'name',type:'varchar'},{name:'checksum',type:'char'}],primary:['name']},
    {name:'settlement_windows',columns:[{name:'closedAt',type:'datetime'},{name:'expiresAt',type:'datetime'}],primary:['expiresAt']}];
  const head=headerV2Of(tables,'heji-fixed-m4-20261117',sources);
  head.createdAt='2026-11-19T00:00:00.000Z';
  const records:Array<Record<string,unknown>>=[{kind:'header',value:head}];
  const tableDigests:Record<string,{rows:number;sha256:string}>={};let total=0;
  for(const table of tables){
    const values=table.name==='schema_migrations'?sources.map(({name,checksum})=>[name,checksum])
      :table.name==='settlement_windows'?[[null,'2026-11-18 23:59:59.000']]:[];
    for(const value of values)records.push({kind:'row',table:table.name,value});
    records.push({kind:'table-end',table:table.name,rows:values.length});
    tableDigests[table.name]={rows:values.length,sha256:createHash('sha256').update(values.map(value=>JSON.stringify(value)+'\n').join('')).digest('hex')};total+=values.length;
  }
  return {sources,head,records,manifest:{tables:tables.length,rows:total,tableDigests}};
}
async function* stream(records:Array<Record<string,unknown>>){yield* records}
test('真实恢复共用的流式预检接受完整v2、过期窗口和四条迁移事实',async()=>{
  const data=await fixture();
  const result=await preflightRecords(stream(data.records),data.manifest,'heji_m4_restore_004',data.sources);
  assert.equal(result.head.format,'heji-m4-backup-v2');assert.equal(result.restorePlan.includeWindows,true);
  assert.equal('sql' in result.head.migrations[0]!,false);
});
test('流式预检拒绝活动窗口、迁移行篡改、摘要漂移、记录缺失和错误目标',async()=>{
  for(const mode of ['active','migration','digest','missing','target']){
    const data=await fixture();
    if(mode==='active')data.records.find(record=>record.kind==='row'&&record.table==='settlement_windows')!.value=[null,'2026-11-19 00:00:30.000'];
    if(mode==='migration'){
      data.records.find(record=>record.kind==='row'&&record.table==='schema_migrations')!.value=['001_m1.sql','f'.repeat(64)];
      const values=data.records.filter(record=>record.kind==='row'&&record.table==='schema_migrations').map(record=>JSON.stringify(record.value)+'\n').join('');
      data.manifest.tableDigests.schema_migrations!.sha256=createHash('sha256').update(values).digest('hex');
    }
    if(mode==='digest')data.manifest.tableDigests.schema_migrations!.sha256='f'.repeat(64);
    if(mode==='missing')data.records.pop();
    await assert.rejects(()=>preflightRecords(stream(data.records),data.manifest,mode==='target'?'heji_m4_restore_003':'heji_m4_restore_004',data.sources),mode==='migration'?/迁移/:mode==='active'?/活动窗口/:/备份/);
  }
});
test('已关闭窗口原值保留，未来到期时间不妨碍恢复；旧v1记录流继续可读',async()=>{
  const data=await fixture(),window=data.records.find(record=>record.kind==='row'&&record.table==='settlement_windows')!;
  window.value=['2026-11-18 23:59:59.000','2026-11-19 00:00:30.000'];
  data.manifest.tableDigests.settlement_windows!.sha256=createHash('sha256').update(JSON.stringify(window.value)+'\n').digest('hex');
  await preflightRecords(stream(data.records),data.manifest,'heji_m4_restore_004',data.sources);
  assert.deepEqual(window.value,['2026-11-18 23:59:59.000','2026-11-19 00:00:30.000']);
  const tables=[{name:'users',columns:[{name:'id',type:'char'}],primary:['id']}],head=headerOf(tables,'heji-fixed-m4-20261117');
  const records=[{kind:'header',value:head},{kind:'row',table:'users',value:['demo']},{kind:'table-end',table:'users',rows:1}];
  const manifest={rows:1,tables:1,tableDigests:{users:{rows:1,sha256:createHash('sha256').update('["demo"]\n').digest('hex')}}};
  const result=await preflightRecords(stream(records),manifest,'heji_m4_restore',data.sources);
  assert.deepEqual(result.restorePlan,{includeSummaries:false,includeWindows:false});
});
