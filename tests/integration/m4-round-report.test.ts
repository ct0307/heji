import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedRoundFiles, summarizeRound, createRoundReport, parseRoundRunId } from '../m4/round-report.ts';

const runId='2026-11-18T05-03-37-078Z';
const options={users:20,warmupMs:30000,durationMs:180000,rounds:3,smoke:false};
const environment={node:'v24.14.1',os:'win32',cpu:'测试CPU',logicalCpus:32,memoryBytes:16340414464,mysql:{version:'8.0.32',sqlMode:'STRICT_TRANS_TABLES',isolationLevel:'REPEATABLE-READ'},mysqlSettings:[{bufferPoolBytes:'134217728',maxConnections:'151'}],poolConnections:8};
const start={expenses:'100',versions:'110',shares:'3000',confirmed:'2',requests:'2'};
const summary=(total:number,p50:number,p95:number,sql:number)=>({total,p50,p95,max:p95,expectedConflicts:0,failures:0,failureRate:0,sql});

// 小型证据手工给定期望统计值，不调用被测统计器制造预期结果。
function fixtures(){
  const result:any[]=[];let scale={...start};
  for(const mode of ['read','write'])for(const distribution of ['same-book','spread-books'])for(let round=1;round<=3;round++){
    const key={mode,distribution,round},index=result.length;
    const sample=(operation:string,ms:number,status:number,sql=3,extra={})=>({...key,phase:ms===9999?'warmup':'measure',sample:{operation,ms,status,sql,...extra}});
    const timings={acquireMs:1,sqlMs:4,bookLockMs:2,bookLockHeldMs:3,aggregateMs:0,shareInsertMs:0};
    const workflowSamples=mode==='read'?[sample('page',9999,200),sample('page',10,200),sample('balance',20,200)]:[sample('equal',9999,201),sample('exact',10,201),sample('confirm',20,200,3,{versionGap:'2',timings})];
    const httpSamples=mode==='read'?workflowSamples.map(x=>({...x,sample:{...x.sample,operation:'read',endpoint:x.sample.operation==='balance'?'balance':'expense'}})):[
      {...sample('write',9999,201),sample:{...sample('write',9999,201).sample,endpoint:'expense'}},
      {...sample('write',10,201),sample:{...sample('write',10,201).sample,endpoint:'expense'}},
      {...sample('write',5,201,1),sample:{...sample('write',5,201,1).sample,endpoint:'request'}},
      {...sample('read',6,200,2),sample:{...sample('read',6,200,2).sample,endpoint:'preview'}},
      {...sample('write',9,200,3),sample:{...sample('write',9,200,3).sample,endpoint:'confirm',versionGap:'2',timings}}
    ];
    result.push({startedAt:'2026-11-18T05:03:37.061Z',completedAt:new Date(Date.UTC(2026,10,18,5,7+index*4)).toISOString(),environment:structuredClone(environment),options:{...options},actualScaleAtGroupStart:{...scale},group:{...key,workflows:summary(2,10,20,6),httpReads:mode==='read'?summary(2,10,20,6):summary(1,6,6,2),httpWrites:mode==='read'?null:summary(3,9,10,7)},workflowSamples,httpSamples});
    if(mode==='write')scale={expenses:String(Number(scale.expenses)+2),versions:String(Number(scale.versions)+2),shares:String(Number(scale.shares)+60),confirmed:String(Number(scale.confirmed)+1),requests:String(Number(scale.requests)+1)};
  }
  return result;
}
function sources(rounds=fixtures()){
  return rounds.map(round=>({filename:`m4-round-formal-${runId}-${round.group.mode}-${round.group.distribution}-${round.group.round}.json`,size:1234,sha256:'a'.repeat(64),round:summarizeRound(round)}));
}

test('显式runId和精确12轮文件清单，不受其他旧run影响',()=>{
  const names=fixtures().map(x=>`m4-round-formal-${runId}-${x.group.mode}-${x.group.distribution}-${x.group.round}.json`);
  assert.equal(parseRoundRunId([`--run=${runId}`]),runId);
  assert.deepEqual(expectedRoundFiles(runId,[...names].reverse().concat('m4-round-formal-old-read-same-book-1.json')),names);
  for(const args of [[],['--run=../../escape'],[`--run=${runId}`,'--extra'],['--run=2026-99-18T05-03-37-078Z']])assert.throws(()=>parseRoundRunId(args));
  assert.throws(()=>expectedRoundFiles(runId,names.slice(1)),/12|缺/);
  assert.throws(()=>expectedRoundFiles(runId,[...names,names[0]!]),/重复|12/);
  assert.throws(()=>expectedRoundFiles(runId,[...names.slice(1),`m4-round-formal-${runId}-read-other-1.json`]),/非法|异常|缺/);
});

test('逐轮报告不保留样本；预热不入性能，但计入相邻计数和推算终点',()=>{
  const report=createRoundReport(runId,sources());
  assert.equal(report.complete,true);
  assert.equal(report.groups.length,12);
  assert.deepEqual(report.actualScaleAtStart,start);
  assert.deepEqual(report.inferredScaleAtEnd,{expenses:'112',versions:'122',shares:'3360',confirmed:'8',requests:'8'});
  assert.equal('actualScaleAtEnd' in report,false);
  assert.equal(report.groups[6]!.workflows.total,2);
  assert.equal(report.groups[6]!.workflows.p95,20);
  assert.equal(report.groups[6]!.operations.equal,undefined);
  assert.equal(report.groups[6]!.operations.confirm!.successRate,1);
  assert.deepEqual(report.groups[6]!.confirmationSuccess,{total:1,successes:1,successRate:1});
  assert.equal(report.groups[6]!.httpEndpoints.confirm!.latency.p95,9);
  assert.equal(report.groups[6]!.httpEndpoints.confirm!.sql.total,3);
  assert.equal(report.groups[6]!.httpEndpoints.confirm!.timings.acquireMs!.p95,1);
  assert.equal(report.groups[6]!.httpEndpoints.confirm!.timings.bookLockHeldMs!.p95,3);
  assert.deepEqual(report.groups[6]!.confirmationVersionGap,{total:1,min:'2',p50:'2',p95:'2',max:'2'});
  assert.equal(report.allWorkflowLatencyTargetsPassed,true);
  assert.equal(report.sourceFiles.length,12);
  assert.equal(report.sourceFiles[0]!.sha256,'a'.repeat(64));
  const serialized=JSON.stringify(report);
  assert.equal(serialized.includes('workflowSamples'),false);
  assert.equal(serialized.includes('httpSamples'),false);
});

test('拒绝伪造的12个非法组、重复组、缺组及文件名与内容不匹配',()=>{
  const valid=sources();
  assert.throws(()=>createRoundReport(runId,valid.slice(1)));
  assert.throws(()=>createRoundReport(runId,[...valid.slice(1),valid[1]!]));
  assert.throws(()=>createRoundReport(runId,valid.map((x,i)=>({...x,round:{...x.round,group:{...x.round.group,round:i+20}}}))));
  const changed=[...valid];changed[0]={...valid[0]!,filename:valid[1]!.filename};
  assert.throws(()=>createRoundReport(runId,changed));
});

test('拒绝参数、环境和起始时间漂移，完成时间必须严格递增',()=>{
  for(const change of [
    (x:any)=>{x.options.users=19},(x:any)=>{x.options.smoke=true},
    (x:any)=>{x.options.durationMs=179999},(x:any)=>{x.options.warmupMs=1},(x:any)=>{x.options.rounds=4}
  ]){const rounds=fixtures();change(rounds[1]);assert.throws(()=>sources(rounds));}
  for(const change of [
    (x:any)=>{x.environment.mysql.version='different'},
    (x:any)=>{x.startedAt='2026-11-18T05:03:38.061Z'},
    (x:any)=>{x.completedAt='2026-11-18T05:07:00.000Z'}
  ]){const rounds=fixtures();change(rounds[1]);assert.throws(()=>createRoundReport(runId,sources(rounds)));}
});

test('拒绝相邻计数漂移；未知确认结果即使只在预热出现也拒绝',()=>{
  const rounds=fixtures();rounds[7].actualScaleAtGroupStart.expenses='101';
  assert.throws(()=>createRoundReport(runId,sources(rounds)),/计数|规模/);
  const unknown=fixtures()[6];unknown.workflowSamples[0].sample.operation='confirm';unknown.workflowSamples[0].sample.status=500;
  assert.throws(()=>summarizeRound(unknown),/确认/);
});

test('逐项核对已存工作流、HTTP读写统计，拒绝篡改',()=>{
  for(const target of ['workflows','httpReads','httpWrites']){
    const round=fixtures()[6];round.group[target].p95++;
    assert.throws(()=>summarizeRound(round),/统计/);
  }
  const round=fixtures()[0];round.group.httpWrites=summary(1,1,1,1);
  assert.throws(()=>summarizeRound(round),/统计/);
});

test('每条样本必须属于本组且phase/ms/sql/timings合法',()=>{
  for(const kind of ['workflowSamples','httpSamples'])for(const change of [
    (x:any)=>{x.round=3},(x:any)=>{x.phase='other'},
    (x:any)=>{x.sample.ms=-1},(x:any)=>{x.sample.ms=Infinity},
    (x:any)=>{x.sample.sql=-1},(x:any)=>{x.sample.timings={acquireMs:-1}},
    (x:any)=>{x.sample.operation='unknown'}
  ]){const round=fixtures()[0];change(round[kind][0]);assert.throws(()=>summarizeRound(round));}
});

test('预期冲突不计故障，但确认独立成功率必须反映冲突',()=>{
  const round=fixtures()[6];
  for(const sample of [round.workflowSamples[2].sample,round.httpSamples[4].sample]){sample.status=409;sample.code='PREVIEW_STALE';sample.versionGap='9007199254740993';}
  round.group.workflows.expectedConflicts=1;round.group.httpWrites.expectedConflicts=1;
  const result=summarizeRound(round);
  assert.equal(result.group.failureRatePass,true);
  assert.deepEqual(result.group.confirmationSuccess,{total:1,successes:0,successRate:0});
  assert.equal(result.group.confirmationVersionGap.max,'9007199254740993');
  assert.equal(result.inferredScaleAtEnd.confirmed,'2');
  assert.equal(result.inferredScaleAtEnd.requests,'3');
});

test('慢请求及真实故障令对应工作流、HTTP和总体标记失败',()=>{
  const rounds=fixtures(),round=rounds[0];
  for(const sample of [round.workflowSamples[1].sample,round.httpSamples[1].sample]){sample.ms=501;sample.status=503;}
  for(const name of ['workflows','httpReads'])round.group[name]={...summary(2,20,501,6),failures:1,failureRate:0.5};
  const report=createRoundReport(runId,sources(rounds));
  assert.equal(report.groups[0]!.workflowLatencyPass,false);
  assert.equal(report.groups[0]!.httpReadLatencyPass,false);
  assert.equal(report.groups[0]!.failureRatePass,false);
  assert.equal(report.allWorkflowLatencyTargetsPassed,false);
  assert.equal(report.allHttpLatencyTargetsPassed,false);
  assert.equal(report.allFailureRateTargetsPassed,false);
});

test('缺失测量HTTP、错误成功状态和非确认预期冲突不能生成达标报告',()=>{
  const absent=fixtures()[0];absent.httpSamples=[];absent.group.httpReads=null;
  assert.throws(()=>summarizeRound(absent));
  const wrong=fixtures()[11];wrong.workflowSamples[0].sample.status=200;
  assert.throws(()=>summarizeRound(wrong));
  const stale=fixtures()[0];stale.workflowSamples[0].sample.status=409;stale.workflowSamples[0].sample.code='PREVIEW_STALE';
  assert.throws(()=>summarizeRound(stale));
});

test('环境必需信息缺失被拒绝，额外数组不进入小摘要',()=>{
  const empty=fixtures()[0];empty.environment={};assert.throws(()=>summarizeRound(empty));
  const extra=fixtures()[0];extra.environment.largeSamples=[1,2,3];
  assert.equal('largeSamples' in summarizeRound(extra).environment,false);
});
