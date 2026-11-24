import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCompletedRun } from '../m4/evidence.ts';
import { assertM4Target,workload,summarize,benchmarkOptions,validateResumeGroups,validateInterruptedFinalRoundResidual,participantIndexes,parseBenchmarkArgs,participantStudyGroups } from '../m4/policy.ts';
import * as m4Policy from '../m4/policy.ts';

test('M4只允许固定隔离目标，未经明确运行开关不得连接，恢复不能指向源库',()=>{
  for(const target of ['heji_dev','mysql','heji_m4_bench;DROP DATABASE x','heji_m4_restore'])assert.throws(()=>assertM4Target(target,'bench','yes'));
  assert.throws(()=>assertM4Target('heji_m4_bench','bench',undefined));
  assertM4Target('heji_m4_bench','bench','yes');assertM4Target('heji_m4_restore','restore','yes');
  assertM4Target('heji_m4_restore_003','restore','yes');
  assert.throws(()=>assertM4Target('heji_m4_bench','restore','yes'));
  assertM4Target('heji_m4_restore_004','restore','yes');
  assertM4Target('heji_m4_restore_004_timed','restore','yes');
  assert.throws(()=>assertM4Target('heji_m4_restore_004_timed','restore',undefined));
  assert.throws(()=>assertM4Target('heji_m4_restore_004_timed','bench','yes'));
  assert.throws(()=>assertM4Target('heji_m4_restore_005','restore','yes'));
});
test('恢复CLI保留旧目标默认值并且只接受显式固定目标与系统备份名',()=>{
  const parse=Reflect.get(m4Policy,'parseRestoreArgs');
  assert.equal(typeof parse,'function','parseRestoreArgs尚未实现');
  const file='heji-m4-00000000-0000-4000-8000-000000000000.jsonl.gz';
  assert.deepEqual(Reflect.apply(parse,undefined,[[file]]),{database:'heji_m4_restore',file});
  assert.deepEqual(Reflect.apply(parse,undefined,[['--target=heji_m4_restore_003',file]]),{database:'heji_m4_restore_003',file});
  assert.deepEqual(Reflect.apply(parse,undefined,[['--target=heji_m4_restore_004',file]]),{database:'heji_m4_restore_004',file});
  for(const args of [[],[file,file],['--target=heji_m4_restore_005',file],['--target=heji_m4_restore_003','--target=heji_m4_restore',file],['../'+file]])
    assert.throws(()=>Reflect.apply(parse,undefined,[args]));
});
test('固定读写配比；失败样本参与分位数，版本冲突与系统故障分开',()=>{
  assert.deepEqual(Array.from({length:10},(_,i)=>workload('read',i)),['page','page','page','page','page','balance','balance','balance','report','report']);
  assert.deepEqual(Array.from({length:10},(_,i)=>workload('write',i)),['equal','equal','equal','equal','equal','equal','exact','exact','exact','confirm']);
  const result=summarize([{ms:1,status:200},{ms:2,status:201},{ms:900,status:409,code:'PREVIEW_STALE'},{ms:1000,status:503},{ms:2000,status:0}]);
  assert.equal(result.p50,900);assert.equal(result.p95,2000);assert.equal(result.total,5);assert.equal(result.expectedConflicts,1);assert.equal(result.failures,2);assert.equal(result.failureRate,0.4);
  assert.throws(()=>summarize([]));
  assert.equal(summarize([{ms:10,status:409,code:'IDEMPOTENCY_KEY_REUSED'},{ms:20,status:409}]).failures,2);
});
test('参与集合固定大小、包含付款人、按成员索引排序且随序号可复现轮换',()=>{
  const narrow=participantIndexes(7,0,4);
  assert.equal(narrow.length,4);
  assert.ok(narrow.includes(7));
  assert.deepEqual(narrow,[...narrow].sort((a,b)=>a-b));
  assert.equal(new Set(narrow).size,4);
  assert.deepEqual(participantIndexes(7,0,4),narrow);
  assert.notDeepEqual(participantIndexes(7,0,4),participantIndexes(7,1,4));
  assert.deepEqual(participantIndexes(7,0,30),Array.from({length:30},(_,i)=>i));
  for(const args of [[-1,0,4],[30,0,4],[0,-1,4],[0,0,1],[0,0,31],[0,0.5,4]])assert.throws(()=>participantIndexes(...args as [number,number,number]));
});
test('正式基准固定20用户、30秒预热、180秒、3轮，冒烟明确区别且拒绝任意参数',()=>{
  assert.deepEqual(benchmarkOptions([]),{users:20,warmupMs:30000,durationMs:180000,rounds:3,smoke:false});
  assert.equal(benchmarkOptions(['--smoke']).smoke,true);assert.throws(()=>benchmarkOptions(['--duration=1']));
});
test('参与范围研究使用固定三组并拒绝与冒烟、续跑及未知参数混用',()=>{
  assert.deepEqual(benchmarkOptions(['--participant-study']),{users:20,warmupMs:30000,durationMs:180000,rounds:3,smoke:false,participantCounts:[30,4,8]});
  for(const args of [['--participant-study','--smoke'],['--participant-study','--resume=2026-11-18T05-03-37-078Z'],['--participant-study','--participants=2']])assert.throws(()=>benchmarkOptions(args));
});
test('benchmark CLI只保留安全参数并移除单个apply开关',()=>{
  assert.deepEqual(parseBenchmarkArgs(['--apply','--participant-study']),['--participant-study']);
  assert.deepEqual(parseBenchmarkArgs(['--apply','--resume=2026-11-18T05-03-37-078Z']),['--resume=2026-11-18T05-03-37-078Z']);
  for(const args of [['--apply','--apply'],['--participant-study','--target=heji_dev'],['--participants=2']])assert.throws(()=>parseBenchmarkArgs(args));
});
test('参与范围研究仅生成固定30/4/8成员的九个同账本写入轮次',()=>{
  const groups=participantStudyGroups();
  assert.equal(groups.length,9);
  assert.deepEqual(groups.map(x=>`${x.participantCount}/${x.round}`),['30/1','30/2','30/3','4/1','4/2','4/3','8/1','8/2','8/3']);
  assert.ok(groups.every(x=>x.mode==='write'&&x.distribution==='same-book'));
});
test('正式续跑只接受单一安全运行标识，不能与冒烟或任意参数混用',()=>{
  const runId='2026-11-17T16-14-30-235Z';
  assert.deepEqual(benchmarkOptions(['--resume='+runId]),{users:20,warmupMs:30000,durationMs:180000,rounds:3,smoke:false,resumeRunId:runId});
  for(const args of [['--resume=../../other'],['--resume='+runId,'--smoke'],['--resume='+runId,'--resume='+runId],['--resume='+runId,'--duration=1']])assert.throws(()=>benchmarkOptions(args));
});
test('续跑必须正好有11个正式轮次，且缺少的只能是最后分散写入轮',()=>{
  const groups=Array.from({length:12},(_,index)=>({mode:index<6?'read':'write' as 'read'|'write',distribution:index%6<3?'same-book':'spread-books' as 'same-book'|'spread-books',round:index%3+1}));
  const partial=groups.filter(x=>!(x.mode==='write'&&x.distribution==='spread-books'&&x.round===3));
  assert.deepEqual(validateResumeGroups(partial),{mode:'write',distribution:'spread-books',round:3});
  assert.throws(()=>validateResumeGroups(partial.slice(1)));
  assert.throws(()=>validateResumeGroups(groups.filter(x=>!(x.mode==='read'&&x.distribution==='same-book'&&x.round===1))));
  assert.throws(()=>validateResumeGroups([...partial,partial[0]!]));
});
test('续跑仅接受精确核验的最后一轮中断残留',()=>{
  const residual={previousCompletedAt:'2026-11-17T16:54:31.350Z',startedAt:'2026-11-17T16:54:31.351Z',endedAt:'2026-11-17T16:55:24.000Z',expenses:1079,requests:119,confirmed:102,pending:17,auditEvents:{expenseCreated:1079,transferRequested:119,transferConfirmed:102,other:0},byBook:Array.from({length:10},(_,i)=>({book:i,expenses:i===9?107:108,requests:i===9?11:12,confirmed:i===0||i===1?12:i===2?1:11,pending:i===2?11:i>=3&&i<=8?1:0}))};
  assert.deepEqual(validateInterruptedFinalRoundResidual(residual),{expenses:1079,requests:119,confirmed:102,pending:17});
  for(const invalid of [
    {...residual,expenses:residual.expenses+1},
    {...residual,requests:residual.requests+1},
    {...residual,auditEvents:{...residual.auditEvents,other:1}},
    {...residual,startedAt:'2026-11-17T16:54:30.000Z'},
    {...residual,endedAt:'2026-11-17T16:56:32.000Z'},
    {...residual,byBook:residual.byBook.slice(1)},
  ])assert.throws(()=>validateInterruptedFinalRoundResidual(invalid));
});
test('全部轮次已落盘时，从最后一轮的起点与增量核对终点；原始基线不包含中断残留',()=>{
  const seedAndSmoke={expenses:'19261',versions:'23061',shares:'691830',confirmed:'26',requests:'30'};
  const resumeStart={expenses:'45463',versions:'49263',shares:'1477890',confirmed:'1422',requests:'2939'};
  const end={expenses:'50204',versions:'54004',shares:'1620120',confirmed:'1897',requests:'3465'};
  const prior={expenses:25123,requests:2790,confirmed:1294},last={expenses:4741,requests:526,confirmed:475},residue={expenses:1079,requests:119,confirmed:102};
  assert.deepEqual(reconcileCompletedRun(seedAndSmoke,resumeStart,end,prior,last,residue),seedAndSmoke);
  assert.throws(()=>reconcileCompletedRun(seedAndSmoke,resumeStart,{...end,expenses:'50205'},prior,last,residue));
  assert.throws(()=>reconcileCompletedRun(seedAndSmoke,resumeStart,end,{...prior,requests:2791},last,residue));
  assert.throws(()=>reconcileCompletedRun(seedAndSmoke,resumeStart,end,prior,last,{...residue,confirmed:101}));
});
