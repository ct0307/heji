import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkOptions,parseBenchmarkArgs } from '../m4/policy.ts';
import { windowBenchmarkOptions,parseWindowBenchmarkArgs,summarizeWindowTier,classifySideWrite,classifyWindowConfirm,windowTierPasses,classifyExpiryBoundary,redactWindowEvidence,windowPreflightPasses,expectedWindowTableDelta,expectedWindowAuditDelta } from '../m4/window-benchmark-policy.ts';

test('窗口负载档位、样本数和成功门槛固定且不可自定义',()=>{
  assert.deepEqual(windowBenchmarkOptions([]),{users:20,attemptsPerTier:60,waitMs:[5000,15000,25000],successMinimum:57});
  for(const args of [['--smoke'],['--wait=1'],['--attempts=1'],['--users=2']])assert.throws(()=>windowBenchmarkOptions(args));
  assert.deepEqual(parseWindowBenchmarkArgs(['--apply']),[]);
  assert.deepEqual(parseWindowBenchmarkArgs(['--plan']),['--plan']);
  for(const args of [['--apply','--apply'],['--resume=2026-11-19T00-00-00-000Z'],['--target=heji_dev']])assert.throws(()=>parseWindowBenchmarkArgs(args));
});

test('窗口档统计保留超时和失败，57/60成功才过线',()=>{
  const samples=Array.from({length:60},(_,index)=>({waitMs:5000,status:index<57?200:409,...(index<57?{}:{code:'PREVIEW_STALE'}),ms:100+index}));
  const summary=summarizeWindowTier(samples,5000);
  assert.equal(summary.total,60);assert.equal(summary.successes,57);assert.equal(summary.failures,3);assert.equal(summary.p95,156);
  assert.equal(windowTierPasses(summary),true);
  assert.equal(windowTierPasses({...summary,successes:56,failures:4}),false);
  assert.throws(()=>summarizeWindowTier(samples.slice(0,59),5000));
});

test('窗口有效期内旁路写只有准确409码才算预期拦截',()=>{
  assert.deepEqual(classifySideWrite({status:409,code:'SETTLEMENT_WINDOW_ACTIVE'}),'expected_block');
  for(const sample of [{status:201},{status:409,code:'SETTLEMENT_WINDOW_COOLDOWN'},{status:503,code:'SETTLEMENT_WINDOW_ACTIVE'},{status:0,code:'NETWORK_OR_RESPONSE_FAILURE'}])
    assert.equal(classifySideWrite(sample),'system_failure');
});

test('有效业务冲突计为样本失败但不算系统故障',()=>{
  assert.equal(classifyWindowConfirm({status:409,code:'PREVIEW_STALE'}),'business_conflict');
  assert.equal(classifyWindowConfirm({status:409,code:'SETTLEMENT_WINDOW_EXPIRED'}),'business_conflict');
  assert.equal(classifyWindowConfirm({status:503,code:'PREVIEW_STALE'}),'system_failure');
  assert.equal(classifyWindowConfirm({status:409,code:'UNEXPECTED'}),'system_failure');
  const samples=Array.from({length:60},(_,index)=>({waitMs:5000,status:index<57?200:409,...(index<57?{}:{code:'PREVIEW_STALE'}),ms:100+index}));
  assert.equal(windowTierPasses(summarizeWindowTier(samples,5000)),true);
});

test('自然到期边界只接受旧窗口过期且普通写恢复成功',()=>{
  assert.equal(classifyExpiryBoundary({confirm:{status:409,code:'SETTLEMENT_WINDOW_EXPIRED'},ordinaryWrite:{status:201}}),'passed');
  assert.equal(classifyExpiryBoundary({confirm:{status:409,code:'SETTLEMENT_WINDOW_ACTIVE'},ordinaryWrite:{status:201}}),'failed');
  assert.equal(classifyExpiryBoundary({confirm:{status:409,code:'SETTLEMENT_WINDOW_EXPIRED'},ordinaryWrite:{status:409,code:'SETTLEMENT_WINDOW_COOLDOWN'}}),'failed');
});

test('窗口负载预检拒绝其他连接、活动窗口及冷却窗口',()=>{
  assert.equal(windowPreflightPasses({otherConnections:0,activeWindows:0,coolingWindows:0}),true);
  for(const key of ['otherConnections','activeWindows','coolingWindows'] as const)
    assert.equal(windowPreflightPasses({otherConnections:0,activeWindows:0,coolingWindows:0,[key]:1}),false);
});

test('允许已过期且冷却结束的旧窗口，并按热账本状态计算窗口和审计增量',()=>{
  const preflight={otherConnections:0,activeWindows:0,coolingWindows:0,hotBookHasWindow:true,hotBookExpiredUnclosedWindows:1};
  assert.equal(windowPreflightPasses(preflight),true);
  assert.equal(expectedWindowTableDelta(preflight),0n);
  assert.equal(expectedWindowAuditDelta(180,preflight),725n);
  assert.equal(expectedWindowAuditDelta(180,{...preflight,hotBookExpiredUnclosedWindows:0}),724n);
  assert.equal(expectedWindowTableDelta({...preflight,hotBookHasWindow:false}),1n);
});

test('证据脱敏移除Cookie、成员/账本标识、SQL及业务行字段',()=>{
  const evidence={target:'heji_m4_bench',cookie:'secret',bookId:'book-secret',memberId:'member-secret',sql:'SELECT secret',row:{amountFen:'999'}};
  assert.deepEqual(redactWindowEvidence(evidence),{target:'heji_m4_bench'});
  assert.deepEqual(redactWindowEvidence({tableCounts:{expenses:'100',transfer_requests:'5',audit_events:'200',unknown:'secret'},financialVersionHash:'f'.repeat(64)}),{tableCounts:{expenses:'100',transfer_requests:'5',audit_events:'200'},financialVersionHash:'f'.repeat(64)});
  assert.deepEqual(redactWindowEvidence({phase:'tier_complete',tier:{waitMs:5000,successes:60,passed:true,secret:'private'}}),{phase:'tier_complete',tier:{waitMs:5000,successes:60,passed:true}});
});

test('新增窗口入口不改变旧正式基准和参与范围参数',()=>{
  assert.deepEqual(benchmarkOptions([]),{users:20,warmupMs:30000,durationMs:180000,rounds:3,smoke:false});
  assert.deepEqual(benchmarkOptions(['--participant-study']),{users:20,warmupMs:30000,durationMs:180000,rounds:3,smoke:false,participantCounts:[30,4,8]});
  assert.deepEqual(parseBenchmarkArgs(['--apply','--participant-study']),['--participant-study']);
});
