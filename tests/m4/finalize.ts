import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir,readFile,writeFile } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { fixturePool } from './database.ts';
import { bookId,seed } from './seed.ts';
import { benchmarkOptions,summarize,validateResumeGroups,validateInterruptedFinalRoundResidual,type RunGroup } from './policy.ts';
import { mutationCounts,adjustScale,reconcileCompletedRun,type WorkflowRecord,type Scale } from './evidence.ts';

/** 仅校验已落盘的12轮和数据库快照，补生成报告；不重发业务请求、不写数据库。 */
const [runId,apply,...extra]=process.argv.slice(2);
if(!runId||apply!=='--apply'||extra.length||process.env.HEJI_ALLOW_M4!=='yes')throw new Error('补生成需明确M4授权、合法运行标识及--apply');
benchmarkOptions(['--resume='+runId]);
const directory=new URL('../../docs/development/evidence/',import.meta.url);
const names=(await readdir(directory)).filter(name=>name.startsWith(`m4-round-formal-${runId}-`)).sort();
if(names.length!==12)throw new Error('补生成要求12轮均已落盘');
type Round={startedAt:string;completedAt:string;options:ReturnType<typeof benchmarkOptions>;environment:Record<string,unknown>;actualScaleAtGroupStart?:Scale;group:RunGroup&{workflows:unknown;httpReads:unknown;httpWrites:unknown};workflowSamples:WorkflowRecord[];httpSamples:WorkflowRecord[]};
const rounds:Round[]=[],sources:Array<{file:string;sha256:string}>=[];
for(const name of names){
  const raw=await readFile(new URL(name,directory),'utf8'),round=JSON.parse(raw) as Round;
  const {mode,distribution,round:number}=round.group;
  assert.equal(name,`m4-round-formal-${runId}-${mode}-${distribution}-${number}.json`);
  assert.deepEqual(round.options,benchmarkOptions([]));
  if(rounds.length){assert.deepEqual(round.environment,rounds[0]!.environment);assert.equal(round.startedAt,rounds[0]!.startedAt)}
  for(const sample of [...round.workflowSamples,...round.httpSamples]){
    assert.equal(sample.mode,mode);assert.equal(sample.distribution,distribution);assert.equal(sample.round,number);
    assert.ok(['warmup','measure'].includes(sample.phase));assert.ok(Number.isFinite(sample.sample.ms)&&sample.sample.ms>=0);
  }
  const workflow=round.workflowSamples.filter(row=>row.phase==='measure').map(row=>row.sample);
  const http=round.httpSamples.filter(row=>row.phase==='measure').map(row=>row.sample);
  assert.deepEqual(round.group.workflows,summarize(workflow));
  for(const operation of ['read','write']){const samples=http.filter(sample=>sample.operation===operation);assert.deepEqual(operation==='read'?round.group.httpReads:round.group.httpWrites,samples.length?summarize(samples):null)}
  rounds.push(round);sources.push({file:name,sha256:createHash('sha256').update(raw).digest('hex')});
}
const last=rounds.find(round=>round.group.mode==='write'&&round.group.distribution==='spread-books'&&round.group.round===3)!;
const prior=rounds.filter(round=>round!==last);
validateResumeGroups(prior.map(round=>round.group));
const previousCompletedAt=prior.map(round=>round.completedAt).sort().at(-1)!;
assert.ok(last.completedAt>previousCompletedAt);
if(!last.actualScaleAtGroupStart)throw new Error('末轮缺少落库前计数，拒绝反推报告');
const smokeRecords:WorkflowRecord[]=[];
for(const name of (await readdir(directory)).filter(name=>/^m4-benchmark-smoke-.*\.json$/.test(name))){
  const raw=await readFile(new URL(name,directory),'utf8'),smoke=JSON.parse(raw);
  assert.equal(smoke.seed,seed);assert.equal(smoke.options.smoke,true);
  smokeRecords.push(...smoke.workflowSamples);sources.push({file:name,sha256:createHash('sha256').update(raw).digest('hex')});
}
const seedScale:Scale={expenses:'19000',versions:'22800',shares:'684000',confirmed:'2',requests:'2'};
const originalStart=adjustScale(seedScale,mutationCounts(smokeRecords),1);
const pool=await fixturePool(),db=await pool.getConnection();
try{
  await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  const books=Array.from({length:10},(_,index)=>bookId(index));
  const lower=previousCompletedAt.slice(0,23).replace('T',' '),upper=new Date(Date.parse(previousCompletedAt)+120000).toISOString().slice(0,23).replace('T',' ');
  const residue={previousCompletedAt,startedAt:'',endedAt:'',expenses:0,requests:0,confirmed:0,pending:0,auditEvents:{expenseCreated:0,transferRequested:0,transferConfirmed:0,other:0},byBook:books.map((id,book)=>({book,expenses:0,requests:0,confirmed:0,pending:0}))};
  const times:string[]=[];
  const entities=[{table:'expenses',time:'createdAt',type:'EXPENSE_CREATED',counter:'expenses',auditCounter:'expenseCreated'},
    {table:'transfer_requests',time:'createdAt',type:'TRANSFER_REQUESTED',counter:'requests',auditCounter:'transferRequested'},
    {table:'confirmed_transfers',time:'confirmedAt',type:'TRANSFER_CONFIRMED',counter:'confirmed',auditCounter:'transferConfirmed'}] as const;
  for(const entity of entities){
    const [rows]=await db.query<RowDataPacket[]>(`SELECT e.bookId,${entity.counter==='requests'?'e.status':"NULL"} status,DATE_FORMAT(e.${entity.time},'%Y-%m-%dT%H:%i:%s.%fZ') timestamp,
      COUNT(a.id) auditCount,SUM(a.eventType=?) correctAudit FROM ${entity.table} e LEFT JOIN audit_events a ON a.entityId=e.id AND a.bookId=e.bookId
      WHERE e.${entity.time}>? AND e.${entity.time}<=? GROUP BY e.id,e.bookId,${entity.counter==='requests'?'e.status,':''}e.${entity.time}`,[entity.type,lower,upper]);
    for(const row of rows){
      const index=books.indexOf(String(row.bookId));assert.ok(index>=0,'中断窗口含其他账本');
      residue[entity.counter]++;residue.byBook[index]![entity.counter]++;times.push(String(row.timestamp));
      residue.auditEvents[entity.auditCounter]+=Number(row.correctAudit??0);
      residue.auditEvents.other+=Number(row.auditCount)-Number(row.correctAudit??0);
      assert.equal(Number(row.auditCount),1,'每个中断实体必须恰有一条对应审计');
      if(entity.counter==='requests'){
        assert.ok(['PENDING','CONFIRMED'].includes(String(row.status)));
        if(row.status==='PENDING'){residue.pending++;residue.byBook[index]!.pending++}
      }
    }
  }
  residue.startedAt=times.sort()[0]??'';residue.endedAt=times.at(-1)??'';
  validateInterruptedFinalRoundResidual(residue);
  const [scaleRows]=await db.query<RowDataPacket[]>('SELECT (SELECT COUNT(*) FROM expenses) expenses,(SELECT COUNT(*) FROM expense_versions) versions,(SELECT COUNT(*) FROM expense_shares) shares,(SELECT COUNT(*) FROM confirmed_transfers) confirmed,(SELECT COUNT(*) FROM transfer_requests) requests');
  const end=Object.fromEntries(Object.entries(scaleRows[0]!).map(([key,value])=>[key,String(value)])) as Scale;
  reconcileCompletedRun(originalStart,last.actualScaleAtGroupStart,end,mutationCounts(prior.flatMap(round=>round.workflowSamples)),mutationCounts(last.workflowSamples),residue);
  await db.commit();
  rounds.sort((a,b)=>['read','write'].indexOf(a.group.mode)-['read','write'].indexOf(b.group.mode)||['same-book','spread-books'].indexOf(a.group.distribution)-['same-book','spread-books'].indexOf(b.group.distribution)||a.group.round-b.group.round);
  const report={scope:'本机隔离HTTP应用基准，不含Nginx/TLS/WS扇出；不外推2核4GB',seed,runId,startedAt:rounds[0]!.startedAt,completedAt:last.completedAt,assembledAt:new Date().toISOString(),
    continuation:{resumed:true,resumedAt:null,resumeTimestampNote:'精确续跑启动时间未持久化；保留末轮完成时间与起点计数，不推造启动时间',previousCompletedAt,continuousRun:false,previousGroups:11,unmeasuredInterruptedFinalRound:residue,reportRecoveredFromSavedRounds:true},
    seedScale:{books:10,membersPerBook:30,targetCurrentExpenses:10000,otherBooksCurrentExpenses:1000,historicalRatio:0.2},
    actualScaleAtStart:originalStart,actualScaleAtResume:last.actualScaleAtGroupStart,actualScaleAtEnd:end,environment:rounds[0]!.environment,options:benchmarkOptions([]),groups:rounds.map(round=>round.group),workflowSamples:rounds.flatMap(round=>round.workflowSamples),httpSamples:rounds.flatMap(round=>round.httpSamples),sources};
  const file=`m4-benchmark-formal-${runId}.json`;
  await writeFile(new URL(file,directory),JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({file,groups:rounds.length,originalStart,resumeStart:last.actualScaleAtGroupStart,end,unmeasuredInterruptedFinalRound:{expenses:residue.expenses,requests:residue.requests,confirmed:residue.confirmed,pending:residue.pending}},null,2));
}finally{await db.rollback();db.release();await pool.end()}
