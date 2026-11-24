import { isDeepStrictEqual } from 'node:util';
import { adjustParticipantScale,participantStudyCounts,type Scale,type WorkflowRecord } from './evidence.ts';
import { summarize,type Sample } from './policy.ts';

const studyOptions={users:20,warmupMs:30000,durationMs:180000,rounds:3,smoke:false,participantStudy:true,participantCounts:[30,4,8]};
const participants=[30,4,8] as const;
const scaleKeys=['expenses','versions','shares','confirmed','requests'] as const;
const timingKeys=['acquireMs','sqlMs','bookLockMs','bookLockHeldMs','aggregateMs','shareInsertMs'] as const;
type ObjectValue=Record<string,any>;
type RoundSource={filename:string;size:number;sha256:string;round:ObjectValue};

function object(value:unknown,label:string):ObjectValue{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label}必须为对象`);
  return value as ObjectValue;
}
function nonnegative(value:unknown,label:string){
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error(`${label}必须为有限非负数`);
  return value;
}
function timestamp(value:unknown,label:string){
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new Error(`${label}时间非法`);
  return value;
}
function validRunId(runId:string){
  const match=/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(runId);
  if(!match)throw new Error('runId格式非法');
  const iso=`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  if(!Number.isFinite(Date.parse(iso))||new Date(iso).toISOString()!==iso)throw new Error('runId日期非法');
  return runId;
}
export function parseParticipantRunId(args:string[]){
  if(args.length!==1||!args[0]!.startsWith('--run='))throw new Error('用法：npm run m4:report:participants -- --run=YYYY-MM-DDTHH-mm-ss-SSSZ');
  return validRunId(args[0]!.slice(6));
}
export function expectedParticipantRoundFiles(runId:string,names:string[]){
  const prefix=`m4-round-participant-study-${validRunId(runId)}-`;
  const expected=participants.flatMap(count=>[1,2,3].map(round=>`${prefix}p${count}-${round}.json`));
  const selected=names.filter(name=>name.startsWith(prefix));
  if(new Set(selected).size!==selected.length||selected.length!==expected.length||selected.some(name=>!expected.includes(name)))throw new Error('参与范围证据必须恰好包含九个固定轮次');
  return expected;
}
function scale(value:unknown):Scale{
  const input=object(value,'账本规模');
  for(const key of scaleKeys)if(typeof input[key]!=='string'||!/^(0|[1-9]\d*)$/.test(input[key])||!Number.isSafeInteger(Number(input[key])))throw new Error('账本规模非法');
  return Object.fromEntries(scaleKeys.map(key=>[key,input[key]])) as Scale;
}
function distribution(values:number[]){
  const ordered=[...values].sort((a,b)=>a-b),count=ordered.length;
  return {count,min:ordered[0]??null,p50:ordered[Math.ceil(count*.5)-1]??null,p95:ordered[Math.ceil(count*.95)-1]??null,max:ordered.at(-1)??null};
}
function versionGaps(samples:Sample[]){
  const values=samples.flatMap(sample=>sample.versionGap===undefined?[]:[BigInt(sample.versionGap)]).sort((a,b)=>a<b?-1:a>b?1:0),count=values.length;
  return {total:count,min:values[0]?.toString()??null,p50:values[Math.ceil(count*.5)-1]?.toString()??null,p95:values[Math.ceil(count*.95)-1]?.toString()??null,max:values.at(-1)?.toString()??null};
}
function rows(value:unknown,round:{mode:string;distribution:string;round:number},http:boolean):WorkflowRecord[]{
  if(!Array.isArray(value))throw new Error('轮次缺少原始样本');
  for(const raw of value){
    const row=object(raw,'样本记录'),sample=object(row.sample,'HTTP样本');
    if(row.mode!==round.mode||row.distribution!==round.distribution||row.round!==round.round||!['warmup','measure'].includes(row.phase))throw new Error('样本所属轮次非法');
    nonnegative(sample.ms,'样本时延');nonnegative(sample.sql,'样本SQL数');
    if(!Number.isSafeInteger(sample.sql)||!Number.isInteger(sample.status)||sample.status<0||sample.status>599)throw new Error('样本SQL数或状态码非法');
    const operations=http?['read','write']:['equal','exact','confirm'];
    if(!operations.includes(sample.operation))throw new Error('样本操作非法');
    if(http&&!['expense','request','preview','confirm'].includes(sample.endpoint))throw new Error('HTTP端点非法');
    if(http){const expected=sample.endpoint==='preview'?'read':'write';if(sample.operation!==expected)throw new Error('HTTP端点与操作类型不匹配');}
    const confirming=http?sample.endpoint==='confirm':sample.operation==='confirm';
    if(sample.code!==undefined&&typeof sample.code!=='string')throw new Error('错误码非法');
    if(sample.code==='PREVIEW_STALE'&&(!confirming||sample.status!==409))throw new Error('仅确认允许PREVIEW_STALE');
    if(sample.status>=200&&sample.status<300){
      const expected=http?(sample.endpoint==='expense'||sample.endpoint==='request'?201:200):sample.operation==='confirm'?200:201;
      if(sample.status!==expected)throw new Error('样本成功状态与操作不匹配');
    }
    if(sample.versionGap!==undefined&&(!confirming||typeof sample.versionGap!=='string'||!/^(0|[1-9]\d*)$/.test(sample.versionGap)))throw new Error('确认版本差距非法');
    if(sample.timings!==undefined){const timings=object(sample.timings,'SQL计时');for(const key of timingKeys)if(timings[key]!==undefined)nonnegative(timings[key],`SQL计时${key}`);}
  }
  return value as WorkflowRecord[];
}
function summarizeRound(value:unknown,runId:string,participantCount:number,expectedRound:number){
  const source=object(value,'轮次证据'),rawGroup=object(source.group,'轮次摘要');
  const group={mode:rawGroup.mode,distribution:rawGroup.distribution,round:rawGroup.round};
  if(group.mode!=='write'||group.distribution!=='same-book'||group.round!==expectedRound||rawGroup.participantCount!==participantCount)throw new Error('参与人数、模式或轮次不匹配');
  if(!isDeepStrictEqual(source.options,studyOptions))throw new Error('敏感性研究参数不匹配');
  const environment=object(source.environment,'运行环境'),startedAt=timestamp(source.startedAt,'轮次起始'),completedAt=timestamp(source.completedAt,'轮次完成');
  if(completedAt<=startedAt)throw new Error('轮次完成时间必须晚于起始时间');
  const actualScaleAtGroupStart=scale(source.actualScaleAtGroupStart);
  const workflowRows=rows(source.workflowSamples,group,false),httpRows=rows(source.httpSamples,group,true);
  const measured=workflowRows.filter(row=>row.phase==='measure').map(row=>row.sample),httpMeasured=httpRows.filter(row=>row.phase==='measure').map(row=>row.sample);
  if(!measured.length||!httpMeasured.length)throw new Error('轮次缺少测量期工作流或HTTP样本');
  const workflows=summarize(measured),httpReads=httpMeasured.filter(sample=>sample.operation==='read'),httpWrites=httpMeasured.filter(sample=>sample.operation==='write');
  const readsSummary=httpReads.length?summarize(httpReads):null,writesSummary=httpWrites.length?summarize(httpWrites):null;
  for(const [key,computed] of Object.entries({workflows,httpReads:readsSummary,httpWrites:writesSummary}))if(!isDeepStrictEqual(rawGroup[key],computed))throw new Error(`${key}摘要与原始样本不一致`);
  const confirms=measured.filter(sample=>sample.operation==='confirm'),successes=confirms.filter(sample=>sample.status>=200&&sample.status<300).length;
  const changes=participantStudyCounts(workflowRows,participantCount),inferredScaleAtEnd=adjustParticipantScale(actualScaleAtGroupStart,changes,1);
  const operationCounts=Object.fromEntries([...new Set(measured.map(sample=>sample.operation!))].map(operation=>[operation,measured.filter(sample=>sample.operation===operation).length]));
  const httpEndpoints=Object.fromEntries([...new Set(httpMeasured.map(sample=>sample.endpoint as string))].map(endpoint=>{
    const samples=httpMeasured.filter(sample=>sample.endpoint===endpoint),sql=distribution(samples.map(sample=>sample.sql!));
    return [endpoint,{latency:summarize(samples),sql:{...sql,total:samples.reduce((sum,sample)=>sum+sample.sql!,0)},timings:Object.fromEntries(timingKeys.map(key=>[key,distribution(samples.flatMap(sample=>sample.timings?.[key]===undefined?[]:[sample.timings[key]!]))]))}];
  }));
  return {filename:`m4-round-participant-study-${runId}-p${participantCount}-${expectedRound}.json`,size:source.size??0,sha256:source.sha256??'',startedAt,completedAt,environment,actualScaleAtGroupStart,changes,inferredScaleAtEnd,
    completedWorkflowsPerSecond:workflows.total/(studyOptions.durationMs/1000),financialVersionChanges:changes.expenses+changes.confirmed,operationCounts,
    group:{...group,participantCount,workflows,httpReads:readsSummary,httpWrites:writesSummary,httpEndpoints,
      confirmationSuccess:{total:confirms.length,successes,successRate:confirms.length?successes/confirms.length:null,stale:confirms.filter(sample=>sample.status===409&&sample.code==='PREVIEW_STALE').length},
      confirmationVersionGap:versionGaps(confirms)}};
}

export function createParticipantStudyReport(manifestValue:unknown,sourcesValue:unknown[]){
  const manifest=object(manifestValue,'研究清单'),runId=validRunId(String(manifest.runId));
  if(manifest.kind!=='m4-participant-study'||!isDeepStrictEqual(manifest.options,studyOptions))throw new Error('敏感性研究清单非法');
  const startedAt=timestamp(manifest.startedAt,'研究起始'),completedAt=timestamp(manifest.completedAt,'研究完成');
  if(completedAt<=startedAt)throw new Error('研究完成时间必须晚于起始时间');
  const actualScaleAtStart=scale(manifest.actualScaleAtStart),actualScaleAtEnd=scale(manifest.actualScaleAtEnd),environment=object(manifest.environment,'运行环境');
  const roundFiles=expectedParticipantRoundFiles(runId,Array.isArray(manifest.roundFiles)?manifest.roundFiles:[]);
  if(!Array.isArray(sourcesValue)||sourcesValue.length!==roundFiles.length)throw new Error('敏感性研究缺少轮次来源');
  const sources=sourcesValue.map(value=>object(value,'轮次来源'));
  if(new Set(sources.map(source=>source.filename)).size!==sources.length||roundFiles.some((name,index)=>sources[index]?.filename!==name))throw new Error('轮次来源顺序、文件名或重复项非法');
  const groups=[];let priorScale=actualScaleAtStart,priorCompletedAt=startedAt;
  for(let index=0;index<roundFiles.length;index++){
    const participantCount=Number(/-p(\d+)-/.exec(roundFiles[index]!)![1]),round=index%3+1,source=sources[index]!,result=summarizeRound(source.round,runId,participantCount,round);
    if(!Number.isSafeInteger(source.size)||source.size<=0||typeof source.sha256!=='string'||!/^[a-f0-9]{64}$/.test(source.sha256))throw new Error('轮次文件大小或SHA-256非法');
    if(!isDeepStrictEqual(result.environment,environment)||result.startedAt!==startedAt||result.completedAt<=priorCompletedAt||!isDeepStrictEqual(result.actualScaleAtGroupStart,priorScale))throw new Error('轮次环境、时间或起止规模不连续');
    if(result.completedAt>completedAt)throw new Error('轮次完成时间晚于研究清单');
    groups.push(result);priorScale=result.inferredScaleAtEnd;priorCompletedAt=result.completedAt;
  }
  if(!isDeepStrictEqual(priorScale,actualScaleAtEnd))throw new Error('原始样本推算终点与研究清单实测终点不一致');
  return {sourceType:'participant-sensitivity-round-files',runId,scope:'本机heji_m4_bench同账本HTTP敏感性实验；不代表真实用户分布，不外推生产容量',
    complete:true,startedAt,completedAt,environment,options:studyOptions,actualScaleAtStart,actualScaleAtEnd,groups,
    sourceFiles:sources.map(source=>({filename:source.filename,size:source.size,sha256:source.sha256}))};
}
