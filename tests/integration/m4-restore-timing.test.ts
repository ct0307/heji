import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RestoreTimer,type RestoreStageEvent } from '../m4/restore-timing.ts';
import { checkBalances } from '../m4/balance-verification.ts';
import type { PoolConnection } from 'mysql2/promise';

test('单调计时保留返回值、包含空档且快照不受后续修改影响',async()=>{
  let now=10;const events:RestoreStageEvent[]=[];
  const timer=new RestoreTimer(()=>now,event=>events.push(event));
  now=12;
  assert.equal(await timer.measure('file_verification',async()=>{now=17;return '完成'}),'完成');
  now=20;
  const snapshot=timer.snapshot();
  assert.equal(snapshot.format,'heji-m4-restore-timing-v1');
  assert.equal(snapshot.elapsedMs,10);assert.equal(snapshot.unmeasuredMs,5);
  assert.deepEqual(snapshot.stages,[{id:1,parentId:null,stage:'file_verification',status:'completed',startedOffsetMs:2,elapsedMs:5}]);
  assert.deepEqual(events.map(event=>event.status),['running','completed']);
  snapshot.stages[0]!.elapsedMs=999;events[1]!.elapsedMs=888;
  assert.equal(timer.snapshot().stages[0]!.elapsedMs,5);
});
test('嵌套逐表计时不双算，父子关系及零行表保留',async()=>{
  let now=0;const timer=new RestoreTimer(()=>now);
  await timer.measure('table_digests',async()=>{
    now=1;
    await timer.measure('table_digest',async()=>{now=4},{table:'expense_shares'});
    await timer.measure('table_digest',async()=>{}, {table:'settlement_windows'});
    now=6;
  });
  const result=timer.snapshot();
  assert.equal(result.elapsedMs,6);assert.equal(result.unmeasuredMs,0);
  assert.equal(result.stages[0]!.elapsedMs,6);assert.equal(result.stages[1]!.parentId,1);
  assert.equal(result.stages[1]!.elapsedMs,3);assert.equal(result.stages[2]!.elapsedMs,0);
  assert.equal(result.stages[2]!.table,'settlement_windows');
});
test('失败透传同一异常，父子均标失败，不输出异常消息或业务内容',async()=>{
  let now=0;const events:RestoreStageEvent[]=[];
  const timer=new RestoreTimer(()=>now,event=>events.push(event));
  const error=new Error('模拟敏感行内容');
  await assert.rejects(()=>timer.measure('derived_reconciliation',async()=>{
    now=2;await timer.measure('derived_balance',async()=>{now=9;throw error},{bookIndex:1});
  }),actual=>actual===error);
  assert.deepEqual(timer.snapshot().stages.map(row=>row.status),['failed','failed']);
  assert.equal(timer.snapshot().unmeasuredMs,0);
  assert.equal(JSON.stringify(events).includes(error.message),false);
  await timer.measure('commit',async()=>{});
  assert.equal(timer.snapshot().stages.at(-1)!.parentId,null);
});
test('日志观察失败或修改事件不能改变业务结果或计时记录',async()=>{
  let now=0;
  const timer=new RestoreTimer(()=>now,event=>{event.elapsedMs=777;throw new Error('模拟终端断开')});
  assert.equal(await timer.measure('financial_counts',async()=>{now=4;return 42}),42);
  assert.equal(timer.snapshot().stages[0]!.elapsedMs,4);
  const original=new Error('财务失败');
  await assert.rejects(()=>timer.measure('commit',async()=>{throw original}),error=>error===original);
});
test('运行中快照和脱敏明细可用于定位慢阶段',async()=>{
  let now=0;const timer=new RestoreTimer(()=>now);
  await timer.measure('import',async()=>{
    now=7;const snapshot=timer.snapshot();
    assert.equal(snapshot.stages[0]!.status,'running');assert.equal(snapshot.stages[0]!.elapsedMs,7);
    assert.equal(snapshot.unmeasuredMs,0);
  });
  assert.equal(timer.snapshot().stages[0]!.status,'completed');
  await assert.rejects(()=>timer.measure('table_digest',async()=>{}, {table:'unsafe table'}));
  await assert.rejects(()=>timer.measure('derived_balance',async()=>{}, {bookIndex:0}));
});
function fakeConnection(failAt:number,clock:{now:number}){
  let calls=0;
  const db={query:async()=>{calls++;clock.now+=calls;return [calls===failAt?[{invalid:1}]:[],[]]}} as unknown as Pick<PoolConnection,'query'>;
  return {db,calls:()=>calls};
}
test('余额三项核验各自计时，无计时参数的旧调用仍可用',async()=>{
  const clock={now:0};const timer=new RestoreTimer(()=>clock.now);
  await checkBalances(fakeConnection(0,clock).db,timer);
  const snapshot=timer.snapshot();
  assert.deepEqual(snapshot.stages.map(row=>row.stage),['historical_share_conservation','current_revision_present','balance_conservation']);
  assert.deepEqual(snapshot.stages.map(row=>row.elapsedMs),[1,2,3]);
  assert.equal(snapshot.elapsedMs,6);assert.equal(snapshot.unmeasuredMs,0);
  await checkBalances(fakeConnection(0,clock).db);
});
test('余额结果断言包含在失败阶段内，损坏立即停止后续核验',async()=>{
  for(const failAt of [1,2,3]){
    const clock={now:0},timer=new RestoreTimer(()=>clock.now),fake=fakeConnection(failAt,clock);
    await assert.rejects(()=>checkBalances(fake.db,timer),/恢复后/);
    assert.equal(fake.calls(),failAt);
    assert.equal(timer.snapshot().stages.length,failAt);
    assert.equal(timer.snapshot().stages.at(-1)!.status,'failed');
  }
});
test('计时覆盖全部恢复完整性阶段且保持现有财务校验和提交顺序',async()=>{
  const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../m4/backup.ts',import.meta.url),'utf8'));
  const balance=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../m4/balance-verification.ts',import.meta.url),'utf8'));
  for(const stage of ['file_verification','stream_preflight','schema_creation','database_connection','target_schema','import','table_digests',
    'migration_metadata','foreign_keys','derived_reconciliation','derived_balance','derived_report','financial_counts','commit'])
    assert.ok(source.includes(`'${stage}'`),'缺少计时阶段 '+stage);
  for(const stage of ['historical_share_conservation','current_revision_present','balance_conservation'])
    assert.ok(balance.includes(`'${stage}'`),'缺少余额计时阶段 '+stage);
  assert.match(source,/await db\.query\('SET FOREIGN_KEY_CHECKS=0'\);\s*await db\.beginTransaction\(\)/);
  assert.ok(source.indexOf("await timer.measure('table_digests'")<source.indexOf('verifyContent(db,restorePlan.includeSummaries'));
  assert.ok(source.indexOf('verifyContent(db,restorePlan.includeSummaries')<source.indexOf("await timer.measure('commit'"));
  assert.ok(source.indexOf("await timer.measure('commit'")<source.indexOf("format:'heji-m4-restore-verification-v1'"));
  assert.match(source,/within30Minutes:elapsedMs<=1800000/);
  assert.match(source,/elapsedScope:'入口至成功commit返回/);
  assert.match(source,/await db\.rollback\(\);throw error/);
  assert.match(source,/await db\.query\('SET FOREIGN_KEY_CHECKS=1'\)\.catch\(\(\)=>\{\}\)/);
});
test('附加计时保持原v1报告读取器可用，子对象单独标记计时版本',async()=>{
  const fs=await import('node:fs/promises');
  const source=await fs.readFile(new URL('../m4/backup.ts',import.meta.url),'utf8');
  const consumer=await fs.readFile(new URL('../m4/document-report.py',import.meta.url),'utf8');
  assert.match(consumer,/heji-m4-restore-verification-v1/);
  assert.match(source,/format:'heji-m4-restore-verification-v1'/);
  assert.match(source,/elapsedScope:[^\n]+timing,report/);
  assert.equal(new RestoreTimer().snapshot().format,'heji-m4-restore-timing-v1');
});
test('隔离合成恢复执行v1/v2完整流程和16类失败，不连接真实数据库',()=>{
  const runner=fileURLToPath(new URL('../m4/restore-timing-fixture.ts',import.meta.url));
  const result=spawnSync(process.execPath,['--experimental-test-module-mocks',runner],{encoding:'utf8',timeout:20000,env:{SystemRoot:process.env.SystemRoot??'C:/Windows'}});
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout.trim());
  assert.equal(output.scenarios.length,19);
  assert.equal(output.scenarios.filter((item:{success:boolean})=>item.success).length,3);
  assert.ok(output.scope.includes('no MySQL'));
});
