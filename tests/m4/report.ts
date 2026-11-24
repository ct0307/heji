import { readdir,readFile,writeFile } from 'node:fs/promises';
import { summarize,type Sample } from './policy.ts';

/** 仅归纳已落盘证据，不连接数据库，不把缺失轮次或冒烟当作正式验收。 */
const directory=new URL('../../docs/development/evidence/',import.meta.url);
const names=(await readdir(directory)).filter(x=>/^m4-benchmark-formal-.*\.json$/.test(x)).sort();
if(!names.length)throw new Error('尚无完整正式基准，不能生成正式结论');
const filename=names.at(-1)!;
const source=JSON.parse(await readFile(new URL(filename,directory),'utf8'));
type RecordSample={mode:string;distribution:string;round:number;phase:string;sample:Sample};
const workflows=source.workflowSamples as RecordSample[];
const groups=source.groups.map((group:any)=>{
  const records=workflows.filter(x=>x.phase==='measure'&&x.mode===group.mode&&x.distribution===group.distribution&&x.round===group.round);
  const operations=Object.fromEntries([...new Set(records.map(x=>x.sample.operation))].map(operation=>{
    const samples=records.filter(x=>x.sample.operation===operation).map(x=>x.sample);
    const successes=samples.filter(x=>x.status>=200&&x.status<300).length;
    return [operation,{...summarize(samples),successes,successRate:successes/samples.length}];
  }));
  return {...group,operations,workflowLatencyTargetMs:group.mode==='read'?500:800,workflowLatencyPass:group.workflows.p95<=(group.mode==='read'?500:800),failureRatePass:group.workflows.failureRate<0.01,
    httpReadLatencyPass:group.httpReads?group.httpReads.p95<=500:null,httpWriteLatencyPass:group.httpWrites?group.httpWrites.p95<=800:null};
});
const unique=new Set(groups.map((x:any)=>x.mode+'/'+x.distribution+'/'+x.round));
const complete=unique.size===12&&source.options.users===20&&source.options.warmupMs===30000&&source.options.durationMs===180000&&source.options.rounds===3&&!source.options.smoke;
if(!complete)throw new Error('正式基准参数或12组轮次不完整，拒绝生成验收结论');
const result={source:filename,createdAt:new Date().toISOString(),scope:source.scope,environment:source.environment,startedAt:source.startedAt,completedAt:source.completedAt,continuation:source.continuation??null,actualScaleAtStart:source.actualScaleAtStart,actualScaleAtResume:source.actualScaleAtResume??null,actualScaleAtEnd:source.actualScaleAtEnd,
  complete,allWorkflowLatencyTargetsPassed:groups.every((x:any)=>x.workflowLatencyPass),allHttpLatencyTargetsPassed:groups.every((x:any)=>x.httpReadLatencyPass!==false&&x.httpWriteLatencyPass!==false),allFailureRateTargetsPassed:groups.every((x:any)=>x.failureRatePass),groups};
const report='m4-performance-summary-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
await writeFile(new URL(report,directory),JSON.stringify(result,null,2)+'\n',{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify({...result,groups:groups.map((x:any)=>({mode:x.mode,distribution:x.distribution,round:x.round,count:x.workflows.total,p95:Math.round(x.workflows.p95),failureRate:x.workflows.failureRate,expectedConflicts:x.workflows.expectedConflicts,latencyPass:x.workflowLatencyPass,confirm:x.operations.confirm??null}))},null,2));
