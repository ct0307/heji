export const sourceDatabase='heji_m4_bench';
export const restoreDatabase='heji_m4_restore';
export const summaryRestoreDatabase='heji_m4_restore_003';
export const windowRestoreDatabase='heji_m4_restore_004';
export const timedWindowRestoreDatabase='heji_m4_restore_004_timed';
export const restoreDatabases=[restoreDatabase,summaryRestoreDatabase,windowRestoreDatabase,timedWindowRestoreDatabase] as const;
export const fixtureVersion='m4-v1-20261117';
export interface SqlTimings {acquireMs:number;sqlMs:number;bookLockMs:number;bookLockHeldMs:number;aggregateMs:number;shareInsertMs:number;bookVersion?:string}
export interface Sample {ms:number;status:number;code?:string;operation?:string;sql?:number;phase?:string;endpoint?:string;timings?:SqlTimings;versionGap?:string}
export interface RunGroup {mode:'read'|'write';distribution:'same-book'|'spread-books';round:number}
export function isRestoreDatabase(database:string):database is typeof restoreDatabases[number]{return (restoreDatabases as readonly string[]).includes(database)}
export function parseRestoreArgs(args:string[]):{database:typeof restoreDatabases[number];file:string}{
  const targets=args.filter(value=>value.startsWith('--target='));
  const files=args.filter(value=>!value.startsWith('--'));
  if(args.some(value=>!value.startsWith('--target=')&&!/^heji-m4-[a-f0-9-]{36}\.jsonl\.gz$/.test(value))||targets.length>1||files.length!==1)throw new Error('restore需要一个系统备份文件名和至多一个固定目标参数');
  const database=targets.length?targets[0]!.slice('--target='.length):restoreDatabase;
  if(!isRestoreDatabase(database))throw new Error('恢复目标必须是固定隔离库');
  return {database,file:files[0]!};
}
export function assertM4Target(database:string,purpose:'bench'|'restore',permission:string|undefined){
  if(permission!=='yes')throw new Error('须明确授权并设置HEJI_ALLOW_M4=yes；默认仅检查计划');
  if(purpose==='bench'?database!==sourceDatabase:!isRestoreDatabase(database))throw new Error('拒绝非固定M4隔离数据库');
}
export function workload(mode:'read'|'write',sequence:number){
  const slot=sequence%10;
  return mode==='read'?(slot<5?'page':slot<8?'balance':'report'):(slot<6?'equal':slot<9?'exact':'confirm');
}
export function participantIndexes(actor:number,sequence:number,count:number,memberCount=30){
  if(![actor,sequence,count,memberCount].every(Number.isSafeInteger)||memberCount<2||actor<0||actor>=memberCount||sequence<0||count<2||count>memberCount)throw new Error('参与成员参数无效');
  const selected=[actor];
  for(let offset=0;selected.length<count;offset++)selected.push((actor+1+(sequence+offset)%(memberCount-1))%memberCount);
  return selected.sort((a,b)=>a-b);
}
export function parseBenchmarkArgs(args:string[]){
  const applyCount=args.filter(x=>x==='--apply').length,benchmarkArgs=args.filter(x=>x!=='--apply');
  if(applyCount>1||benchmarkArgs.some(x=>x!=='--smoke'&&x!=='--participant-study'&&!/^--resume=\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(x)))throw new Error('M4基准参数无效');
  return benchmarkArgs;
}
export function participantStudyGroups(participantCounts:readonly number[]=[30,4,8],rounds=3){
  return participantCounts.flatMap(participantCount=>Array.from({length:rounds},(_,index)=>({participantCount,round:index+1,mode:'write' as const,distribution:'same-book' as const})));
}
export function summarize(samples:Sample[]){
  if(!samples.length)throw new Error('没有有效样本，不能计算性能');
  const ordered=samples.map(x=>x.ms).sort((a,b)=>a-b);
  const expected=samples.filter(x=>x.status===409&&x.code==='PREVIEW_STALE').length;
  const failures=samples.filter(x=>!(x.status>=200&&x.status<300)&&!(x.status===409&&x.code==='PREVIEW_STALE')).length;
  return {total:samples.length,p50:ordered[Math.ceil(ordered.length*0.5)-1]!,p95:ordered[Math.ceil(ordered.length*0.95)-1]!,max:ordered.at(-1)!,expectedConflicts:expected,failures,failureRate:failures/samples.length,sql:samples.reduce((sum,x)=>sum+(x.sql??0),0)};
}
export function benchmarkOptions(args:string[]){
  const smoke=args.includes('--smoke'),participantStudy=args.includes('--participant-study'),resume=args.filter(x=>x.startsWith('--resume='));
  if(args.some(x=>x!=='--smoke'&&x!=='--participant-study'&&!x.startsWith('--resume='))||resume.length>1||smoke&&resume.length||participantStudy&&(smoke||resume.length))throw new Error('基准参数组合无效');
  if(resume.length){
    const resumeRunId=resume[0]!.slice('--resume='.length);
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(resumeRunId))throw new Error('续跑标识格式无效');
    return {users:20,warmupMs:30000,durationMs:180000,rounds:3,smoke:false,resumeRunId};
  }
  if(smoke)return {users:2,warmupMs:1000,durationMs:3000,rounds:1,smoke:true};
  if(participantStudy)return {users:20,warmupMs:30000,durationMs:180000,rounds:3,smoke:false,participantCounts:[30,4,8] as const};
  return {users:20,warmupMs:30000,durationMs:180000,rounds:3,smoke:false};
}
export function validateResumeGroups(groups:RunGroup[]):RunGroup{
  const keys=groups.map(x=>`${x.mode}/${x.distribution}/${x.round}`),expected=new Set<string>();
  for(const mode of ['read','write'] as const)for(const distribution of ['same-book','spread-books'] as const)for(let round=1;round<=3;round++)expected.add(`${mode}/${distribution}/${round}`);
  if(keys.length!==11||new Set(keys).size!==11||keys.some(key=>!expected.has(key)))throw new Error('续跑证据必须包含11个不同的正式轮次');
  const missing=[...expected].filter(key=>!keys.includes(key));
  if(missing.length!==1||missing[0]!=='write/spread-books/3')throw new Error('当前只允许续跑最后一组分散账本写入');
  return {mode:'write',distribution:'spread-books',round:3};
}
export interface InterruptedFinalRoundResidual{
  previousCompletedAt:string;startedAt:string;endedAt:string;
  expenses:number;requests:number;confirmed:number;pending:number;
  auditEvents:{expenseCreated:number;transferRequested:number;transferConfirmed:number;other:number};
  byBook:Array<{book:number;expenses:number;requests:number;confirmed:number;pending:number}>;
}
export function validateInterruptedFinalRoundResidual(residual:InterruptedFinalRoundResidual){
  const previous=Date.parse(residual.previousCompletedAt),started=Date.parse(residual.startedAt),ended=Date.parse(residual.endedAt);
  if(!Number.isFinite(previous)||!Number.isFinite(started)||!Number.isFinite(ended)||started<previous||ended<started||ended-previous>120_000)throw new Error('M4中断残留时间不在最后已保存轮次之后');
  if(residual.expenses!==1079||residual.requests!==119||residual.confirmed!==102||residual.pending!==17||residual.auditEvents.expenseCreated!==residual.expenses||residual.auditEvents.transferRequested!==residual.requests||residual.auditEvents.transferConfirmed!==residual.confirmed||residual.auditEvents.other!==0)throw new Error('M4中断残留计数或审计事件不匹配');
  const operations=residual.expenses+residual.requests;let expectedExpenses=0,expectedRequests=0;
  for(let i=0;i<operations;i++)workload('write',i)==='confirm'?expectedRequests++:expectedExpenses++;
  if(expectedExpenses!==residual.expenses||expectedRequests!==residual.requests||residual.byBook.length!==10)throw new Error('M4中断残留不符合固定写入工作负载');
  const books=new Set<number>();let expenses=0,requests=0,confirmed=0,pending=0;
  for(const book of residual.byBook){
    if(!Number.isInteger(book.book)||book.book<0||book.book>=10||books.has(book.book)||![107,108].includes(book.expenses)||![11,12].includes(book.requests)||book.confirmed<0||book.confirmed>book.requests||book.pending!==book.requests-book.confirmed)throw new Error('M4中断残留账本分布不匹配');
    books.add(book.book);expenses+=book.expenses;requests+=book.requests;confirmed+=book.confirmed;pending+=book.pending;
  }
  if(books.size!==10||expenses!==residual.expenses||requests!==residual.requests||confirmed!==residual.confirmed||pending!==residual.pending)throw new Error('M4中断残留账本汇总不匹配');
  return {expenses,requests,confirmed,pending};
}
