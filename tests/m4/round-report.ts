import { isDeepStrictEqual } from 'node:util';
import { summarize, type Sample, type RunGroup } from './policy.ts';
import { mutationCounts, adjustScale, type Scale, type WorkflowRecord } from './evidence.ts';

const formalOptions={users:20,warmupMs:30000,durationMs:180000,rounds:3,smoke:false};
const scaleKeys=['expenses','versions','shares','confirmed','requests'] as const;
const timingKeys=['acquireMs','sqlMs','bookLockMs','bookLockHeldMs','aggregateMs','shareInsertMs'] as const;
const expectedKeys:RunGroup[]=[];
for(const mode of ['read','write'] as const)for(const distribution of ['same-book','spread-books'] as const)for(let round=1;round<=3;round++)expectedKeys.push({mode,distribution,round});

function validRunId(runId:string){
  const match=/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(runId);
  if(!match)throw new Error('runId必须为固定格式YYYY-MM-DDTHH-mm-ss-SSSZ');
  const iso=`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  if(!Number.isFinite(Date.parse(iso))||new Date(iso).toISOString()!==iso)throw new Error('runId日期非法');
  return runId;
}
export function parseRoundRunId(args:string[]){
  if(args.length!==1||!args[0]!.startsWith('--run='))throw new Error('用法：node tests/m4/report-rounds.ts --run=YYYY-MM-DDTHH-mm-ss-SSSZ');
  return validRunId(args[0]!.slice(6));
}
function key(group:RunGroup){
  if(!expectedKeys.some(x=>x.mode===group.mode&&x.distribution===group.distribution&&x.round===group.round))throw new Error('非法轮次键');
  return `${group.mode}-${group.distribution}-${group.round}`;
}
export function expectedRoundFiles(runId:string,names:string[]){
  const prefix=`m4-round-formal-${validRunId(runId)}-`;
  const expected=expectedKeys.map(x=>`${prefix}${key(x)}.json`);
  const selected=names.filter(x=>x.startsWith(prefix));
  if(new Set(selected).size!==selected.length)throw new Error('轮次文件重复');
  if(selected.some(x=>!expected.includes(x)))throw new Error('同run包含非法轮次文件');
  if(selected.length!==12||expected.some(x=>!selected.includes(x)))throw new Error('缺少正式轮次文件：必须恰好12组');
  return expected;
}
function object(value:unknown,label:string):Record<string,any>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label}必须为对象`);
  return value as Record<string,any>;
}
function nonnegative(value:unknown,label:string){
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error(`${label}必须为有限非负数`);
  return value;
}
function timestamp(value:unknown,label:string){
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new Error(`${label}时间非法`);
  return value;
}
function scale(value:unknown):Scale{
  const input=object(value,'计数');
  for(const name of scaleKeys)if(typeof input[name]!=='string'||!/^(0|[1-9]\d*)$/.test(input[name])||!Number.isSafeInteger(Number(input[name])))throw new Error('规模计数必须为安全非负整数字符串');
  return Object.fromEntries(scaleKeys.map(name=>[name,input[name]])) as Scale;
}
function environmentInfo(value:unknown){
  const input=object(value,'environment'),mysql=object(input.mysql,'mysql');
  function string(value:unknown){if(typeof value!=='string'||!value.length)throw new Error('环境字符串缺失');return value}
  function integer(value:unknown){nonnegative(value,'环境数值');if(!Number.isSafeInteger(value)||Number(value)<=0)throw new Error('环境数值非法');return value as number}
  if(!Array.isArray(input.mysqlSettings)||input.mysqlSettings.length!==1)throw new Error('数据库设置缺失');
  const settings=object(input.mysqlSettings[0],'mysqlSettings');
  for(const name of ['bufferPoolBytes','maxConnections'])if(typeof settings[name]!=='string'||!/^[1-9]\d*$/.test(settings[name]))throw new Error('数据库设置非法');
  return {node:string(input.node),os:string(input.os),cpu:string(input.cpu),logicalCpus:integer(input.logicalCpus),memoryBytes:integer(input.memoryBytes),
    mysql:{version:string(mysql.version),sqlMode:string(mysql.sqlMode),isolationLevel:string(mysql.isolationLevel)},
    mysqlSettings:[{bufferPoolBytes:settings.bufferPoolBytes as string,maxConnections:settings.maxConnections as string}],poolConnections:integer(input.poolConnections)};
}
function rows(value:unknown,group:RunGroup,http:boolean):WorkflowRecord[]{
  if(!Array.isArray(value))throw new Error('缺少原始样本数组');
  for(const raw of value){
    const row=object(raw,'样本');
    if(row.mode!==group.mode||row.distribution!==group.distribution||row.round!==group.round)throw new Error('样本所属轮次不匹配');
    if(row.phase!=='warmup'&&row.phase!=='measure')throw new Error('样本phase非法');
    const sample=object(row.sample,'sample');
    nonnegative(sample.ms,'样本ms');nonnegative(sample.sql,'样本SQL');
    if(!Number.isSafeInteger(sample.sql)||!Number.isInteger(sample.status)||sample.status<0||sample.status>599)throw new Error('样本SQL或状态码非法');
    const operations=http?['read','write']:group.mode==='read'?['page','balance','report']:['equal','exact','confirm'];
    if(!operations.includes(sample.operation))throw new Error('样本operation非法');
    if(sample.code!==undefined&&typeof sample.code!=='string')throw new Error('样本错误码非法');
    if(http&&!['expense','balance','report','request','preview','confirm'].includes(sample.endpoint))throw new Error('HTTP endpoint非法');
    if(http){
      const allowed=group.mode==='read'?{expense:'read',balance:'read',report:'read'}:{expense:'write',request:'write',preview:'read',confirm:'write'};
      if((allowed as Record<string,string>)[sample.endpoint]!==sample.operation)throw new Error('HTTP操作与端点或模式不匹配');
    }
    const confirming=http?sample.endpoint==='confirm':sample.operation==='confirm';
    if(sample.code==='PREVIEW_STALE'&&(!confirming||sample.status!==409))throw new Error('仅确认允许预览过期冲突');
    if(sample.status>=200&&sample.status<300){
      const expected=http?(sample.endpoint==='request'||sample.endpoint==='expense'&&sample.operation==='write'?201:200):sample.operation==='equal'||sample.operation==='exact'?201:200;
      if(sample.status!==expected)throw new Error('成功状态与操作语义不匹配');
    }
    if(sample.timings!==undefined){
      const timings=object(sample.timings,'SQL计时');
      for(const name of timingKeys)if(timings[name]!==undefined)nonnegative(timings[name],`SQL计时${name}`);
    }
    if(sample.versionGap!==undefined&&(typeof sample.versionGap!=='string'||!/^(0|[1-9]\d*)$/.test(sample.versionGap)))throw new Error('确认versionGap非法');
  }
  return value as WorkflowRecord[];
}
function distribution(values:number[]){
  const ordered=[...values].sort((a,b)=>a-b),sum=values.reduce((a,b)=>a+b,0),count=values.length;
  return {count,sum,min:ordered[0]??null,p50:ordered[Math.ceil(count*.5)-1]??null,p95:ordered[Math.ceil(count*.95)-1]??null,max:ordered.at(-1)??null,mean:count?sum/count:null};
}
function versionGaps(samples:Sample[]){
  const ordered=samples.flatMap(x=>x.versionGap===undefined?[]:[BigInt(x.versionGap)]).sort((a,b)=>a<b?-1:a>b?1:0),total=ordered.length;
  return {total,min:ordered[0]?.toString()??null,p50:ordered[Math.ceil(total*.5)-1]?.toString()??null,p95:ordered[Math.ceil(total*.95)-1]?.toString()??null,max:ordered.at(-1)?.toString()??null};
}

/** 只持有当前一轮的样本，返回值不引用原始样本数组。 */
export function summarizeRound(value:unknown){
  const source=object(value,'分轮证据'),rawGroup=object(source.group,'group');
  const group:RunGroup={mode:rawGroup.mode,distribution:rawGroup.distribution,round:rawGroup.round};key(group);
  if(!isDeepStrictEqual(source.options,formalOptions))throw new Error('正式基准参数不匹配');
  const environment=environmentInfo(source.environment);
  const startedAt=timestamp(source.startedAt,'startedAt'),completedAt=timestamp(source.completedAt,'completedAt');
  if(completedAt<=startedAt)throw new Error('完成时间必须晚于起始时间');
  const actualScaleAtGroupStart=scale(source.actualScaleAtGroupStart);
  const workflowRows=rows(source.workflowSamples,group,false),httpRows=rows(source.httpSamples,group,true);
  const measured=workflowRows.filter(x=>x.phase==='measure').map(x=>x.sample),httpMeasured=httpRows.filter(x=>x.phase==='measure').map(x=>x.sample);
  const httpReadSamples=httpMeasured.filter(x=>x.operation==='read'),httpWriteSamples=httpMeasured.filter(x=>x.operation==='write');
  if(!(group.mode==='read'?httpReadSamples.length:httpWriteSamples.length))throw new Error('缺少本模式的测量HTTP样本');
  const workflows=summarize(measured),httpReads=httpReadSamples.length?summarize(httpReadSamples):null,httpWrites=httpWriteSamples.length?summarize(httpWriteSamples):null;
  for(const [name,computed] of Object.entries({workflows,httpReads,httpWrites}))if(!isDeepStrictEqual(rawGroup[name],computed))throw new Error(`${name}已存统计与原始样本重算不一致`);
  const operations=Object.fromEntries([...new Set(measured.map(x=>x.operation!))].map(operation=>{
    const samples=measured.filter(x=>x.operation===operation),successes=samples.filter(x=>x.status>=200&&x.status<300).length;
    return [operation,{...summarize(samples),successes,successRate:successes/samples.length}];
  }));
  const httpEndpoints=Object.fromEntries([...new Set(httpMeasured.map(x=>x.endpoint!))].map(endpoint=>{
    const samples=httpMeasured.filter(x=>x.endpoint===endpoint),sql=distribution(samples.map(x=>x.sql!));
    return [endpoint,{latency:summarize(samples),sql:{...sql,total:sql.sum},timings:Object.fromEntries(timingKeys.map(name=>[name,distribution(samples.flatMap(x=>x.timings?.[name]===undefined?[]:[x.timings[name]]))]))}];
  }));
  const confirms=measured.filter(x=>x.operation==='confirm'),successes=confirms.filter(x=>x.status>=200&&x.status<300).length;
  const changes=mutationCounts(workflowRows);
  return {startedAt,completedAt,environment,options:{...formalOptions},actualScaleAtGroupStart,changes,inferredScaleAtEnd:adjustScale(actualScaleAtGroupStart,changes,1),
    group:{...group,workflows,httpReads,httpWrites,operations,httpEndpoints,
      confirmationSuccess:{total:confirms.length,successes,successRate:confirms.length?successes/confirms.length:null},confirmationVersionGap:versionGaps(confirms),
      workflowLatencyTargetMs:group.mode==='read'?500:800,workflowLatencyPass:workflows.p95<=(group.mode==='read'?500:800),failureRatePass:workflows.failureRate<0.01,
      httpReadLatencyPass:httpReads?httpReads.p95<=500:null,httpWriteLatencyPass:httpWrites?httpWrites.p95<=800:null}};
}
export type RoundSummary=ReturnType<typeof summarizeRound>;
export type RoundSource={filename:string;size:number;sha256:string;round:RoundSummary};

/** 聚合12个小摘要；不会重新拼接样本或读取完整formal总报告。 */
export function createRoundReport(runId:string,sources:RoundSource[]){
  const filenames=expectedRoundFiles(runId,sources.map(x=>x.filename)),byName=new Map(sources.map(x=>[x.filename,x]));
  if(sources.length!==12)throw new Error('必须恰好12份轮次证据');
  const ordered=filenames.map(filename=>byName.get(filename)!);
  const first=ordered[0]!.round;
  for(let index=0;index<ordered.length;index++){
    const item=ordered[index]!,round=item.round;
    if(item.filename!==`m4-round-formal-${runId}-${key(round.group)}.json`)throw new Error('文件名与轮次内容不匹配');
    if(!Number.isSafeInteger(item.size)||item.size<=0||!/^[a-f0-9]{64}$/.test(item.sha256))throw new Error('源文件大小或SHA256非法');
    if(!isDeepStrictEqual(round.options,formalOptions)||!isDeepStrictEqual(round.environment,first.environment)||round.startedAt!==first.startedAt)throw new Error('轮次参数、环境或startedAt漂移');
    const prior=ordered[index-1]?.round;
    if(prior){
      if(round.completedAt<=prior.completedAt)throw new Error('完成时间未严格递增');
      if(!isDeepStrictEqual(round.actualScaleAtGroupStart,prior.inferredScaleAtEnd))throw new Error('相邻轮次起点计数不连续');
    }
  }
  const groups=ordered.map(x=>x.round.group);
  return {sourceType:'formal-round-files',runId,scope:'本机隔离HTTP应用基准，不含Nginx/TLS/WS扇出；不外推2核4GB',
    environment:first.environment,options:first.options,startedAt:first.startedAt,completedAt:ordered.at(-1)!.round.completedAt,continuation:null,
    actualScaleAtStart:first.actualScaleAtGroupStart,inferredScaleAtEnd:ordered.at(-1)!.round.inferredScaleAtEnd,
    scaleEvidence:{start:'observed-first-round-start',end:'inferred-from-last-round-start-and-all-phase-mutations',adjacentRoundStartsVerified:true},
    complete:true,allWorkflowLatencyTargetsPassed:groups.every(x=>x.workflowLatencyPass),allHttpLatencyTargetsPassed:groups.every(x=>x.httpReadLatencyPass!==false&&x.httpWriteLatencyPass!==false),allFailureRateTargetsPassed:groups.every(x=>x.failureRatePass),groups,
    sourceFiles:ordered.map(({filename,size,sha256})=>({filename,size,sha256}))};
}
