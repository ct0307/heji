import assert from 'node:assert/strict';
import test from 'node:test';
import { createParticipantStudyReport,expectedParticipantRoundFiles,parseParticipantRunId } from '../m4/participant-report.ts';

const runId='2026-11-18T07-00-00-000Z';
const options={users:20,warmupMs:30000,durationMs:180000,rounds:3,smoke:false,participantStudy:true,participantCounts:[30,4,8]};
const environment={node:'v24.14.1',os:'win32',cpu:'测试CPU',logicalCpus:32,memoryBytes:16340414464,mysql:{version:'8.0.32',sqlMode:'STRICT_TRANS_TABLES',isolationLevel:'REPEATABLE-READ'},mysqlSettings:[{bufferPoolBytes:'134217728',maxConnections:'151'}],poolConnections:8};
const initialScale={expenses:'100',versions:'110',shares:'3000',confirmed:'2',requests:'2'};
const summary=(samples:any[])=>({total:samples.length,p50:samples[0].ms,p95:samples.at(-1).ms,max:samples.at(-1).ms,expectedConflicts:samples.filter(x=>x.status===409&&x.code==='PREVIEW_STALE').length,failures:0,failureRate:0,sql:samples.reduce((sum,x)=>sum+x.sql,0)});

function fixture(){
  const manifestName=`m4-participant-study-run-${runId}.json`,manifest:any={kind:'m4-participant-study',runId,startedAt:'2026-11-18T07:00:00.000Z',completedAt:'2026-11-18T07:40:00.000Z',environment,options,actualScaleAtStart:initialScale,actualScaleAtEnd:null,roundFiles:[]};
  let scale={...initialScale};const sources:any[]=[];
  for(const participantCount of [30,4,8])for(let round=1;round<=3;round++){
    const filename=`m4-round-participant-study-${runId}-p${participantCount}-${round}.json`,stale=participantCount===4&&round===2;
    const workflowSamples=[
      {mode:'write',distribution:'same-book',round,phase:'measure',sample:{operation:'equal',ms:100,status:201,sql:2}},
      {mode:'write',distribution:'same-book',round,phase:'measure',sample:{operation:'confirm',ms:150,status:stale?409:200,code:stale?'PREVIEW_STALE':undefined,sql:2,versionGap:'2',timings:{acquireMs:1,sqlMs:2,bookLockMs:1,bookLockHeldMs:3,aggregateMs:0,shareInsertMs:0}}}
    ];
    const httpSamples=[
      {mode:'write',distribution:'same-book',round,phase:'measure',sample:{operation:'write',endpoint:'expense',ms:100,status:201,sql:2}},
      {mode:'write',distribution:'same-book',round,phase:'measure',sample:{operation:'write',endpoint:'request',ms:90,status:201,sql:2}},
      {mode:'write',distribution:'same-book',round,phase:'measure',sample:{operation:'read',endpoint:'preview',ms:80,status:200,sql:2}},
      {mode:'write',distribution:'same-book',round,phase:'measure',sample:{operation:'write',endpoint:'confirm',ms:150,status:stale?409:200,code:stale?'PREVIEW_STALE':undefined,sql:2,versionGap:'2',timings:{acquireMs:1,sqlMs:2,bookLockMs:1,bookLockHeldMs:3,aggregateMs:0,shareInsertMs:0}}}
    ];
    const changes={expenses:1,requests:1,confirmed:stale?0:1};
    const nextScale={expenses:String(Number(scale.expenses)+1),versions:String(Number(scale.versions)+1),shares:String(Number(scale.shares)+participantCount),confirmed:String(Number(scale.confirmed)+changes.confirmed),requests:String(Number(scale.requests)+1)};
    const roundData={startedAt:manifest.startedAt,completedAt:`2026-11-18T07:${String(2+(sources.length*4)).padStart(2,'0')}:00.000Z`,environment,options,actualScaleAtGroupStart:scale,group:{mode:'write',distribution:'same-book',round,participantCount,workflows:summary(workflowSamples.map(x=>x.sample)),httpReads:summary([httpSamples[2]!.sample]),httpWrites:summary([httpSamples[0]!.sample,httpSamples[1]!.sample,httpSamples[3]!.sample])},workflowSamples,httpSamples};
    sources.push({filename,size:1234,sha256:'a'.repeat(64),round:roundData});manifest.roundFiles.push(filename);scale=nextScale;
  }
  manifest.actualScaleAtEnd=scale;
  return {manifest,manifestName,sources};
}

test('只接受固定runId下的九个30/4/8人轮次文件',()=>{
  const {sources}=fixture(),names=sources.map(x=>x.filename);
  assert.deepEqual(expectedParticipantRoundFiles(runId,[...names].reverse()),names);
  assert.throws(()=>expectedParticipantRoundFiles(runId,names.slice(1)));
  assert.throws(()=>expectedParticipantRoundFiles(runId,[...names,names[0]]));
  assert.throws(()=>expectedParticipantRoundFiles('../escape',names));
});
test('报告命令只接受一个格式正确的UTC runId参数',()=>{
  assert.equal(parseParticipantRunId([`--run=${runId}`]),runId);
  for(const args of [[],['--run=../../escape'],[`--run=${runId}`,'--other'],['--run=2026-99-18T07-00-00-000Z']])assert.throws(()=>parseParticipantRunId(args));
});

test('逐轮重算确认成功率、版本差距和成员份额规模，不保留原始样本',()=>{
  const {manifest,sources}=fixture(),report=createParticipantStudyReport(manifest,sources);
  assert.equal(report.complete,true);
  assert.deepEqual(report.actualScaleAtStart,initialScale);
  assert.deepEqual(report.actualScaleAtEnd,manifest.actualScaleAtEnd);
  assert.deepEqual(report.groups.map((x:any)=>x.group.participantCount),[30,30,30,4,4,4,8,8,8]);
  assert.deepEqual(report.groups[4]!.group.confirmationSuccess,{total:1,successes:0,successRate:0,stale:1});
  assert.deepEqual(report.groups[4]!.group.confirmationVersionGap,{total:1,min:'2',p50:'2',p95:'2',max:'2'});
  assert.deepEqual(report.groups[4]!.operationCounts,{equal:1,confirm:1});
  assert.equal(report.groups[4]!.completedWorkflowsPerSecond,2/180);
  assert.equal(report.groups[4]!.financialVersionChanges,1);
  assert.equal(report.sourceFiles.length,9);
  const serialized=JSON.stringify(report);
  assert.equal(serialized.includes('workflowSamples'),false);
  assert.equal(serialized.includes('httpSamples'),false);
});

test('实际基准共享run起始时间时仍要求轮次完成时间递增与规模连续',()=>{
  const {manifest,sources}=fixture();
  const report=createParticipantStudyReport(manifest,sources);
  assert.equal(report.groups.length,9);
  const {manifest:badManifest,sources:badSources}=fixture();
  badSources[1]!.round.completedAt=badSources[0]!.round.completedAt;
  assert.throws(()=>createParticipantStudyReport(badManifest,badSources));
});

test('缺组、重复源、profile或摘要篡改、计数不连续和非确认PREVIEW_STALE均拒绝报告',()=>{
  const base=fixture();
  assert.throws(()=>createParticipantStudyReport(base.manifest,base.sources.slice(1)));
  assert.throws(()=>createParticipantStudyReport(base.manifest,[...base.sources.slice(1),base.sources[1]]));
  for(const change of [
    (x:any)=>{x.round.group.participantCount=6},
    (x:any)=>{x.round.group.workflows.p95++},
    (x:any)=>{x.round.actualScaleAtGroupStart.shares='999'},
    (x:any)=>{x.round.workflowSamples[0].sample.status=409;x.round.workflowSamples[0].sample.code='PREVIEW_STALE'}
  ]){const {manifest,sources}=fixture();change(sources[1]);assert.throws(()=>createParticipantStudyReport(manifest,sources));}
});
