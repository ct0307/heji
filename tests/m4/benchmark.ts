import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { writeFile,mkdir,readdir,readFile } from 'node:fs/promises';
import { cpus,totalmem,platform,release } from 'node:os';
import { createApp } from '../../apps/api/src/app.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import { newToken,tokenHash,csrfFor } from '../../apps/api/src/modules/identity/security.ts';
import { splitEqual } from '../../packages/domain/src/ledger.ts';
import { fixturePool,environment } from './database.ts';
import { bookId,memberId,userId,seed } from './seed.ts';
import { benchmarkOptions,summarize,workload,participantIndexes,participantStudyGroups,validateResumeGroups,validateInterruptedFinalRoundResidual,type Sample,type RunGroup,type SqlTimings } from './policy.ts';
import type { Pool,PoolConnection } from 'mysql2/promise';
import { mutationCounts,adjustScale,type Scale,type WorkflowRecord } from './evidence.ts';

const origin='http://127.0.0.1:5174';
type RoundEvidence={startedAt:string;completedAt:string;environment:Record<string,unknown>;options:{users:number;warmupMs:number;durationMs:number;rounds:number;smoke:boolean;participantCounts?:readonly number[]};group:RunGroup&Record<string,any>;workflowSamples:WorkflowRecord[];httpSamples:WorkflowRecord[]};
async function resumeEvidence(directory:URL,runId:string){
  const prefix=`m4-round-formal-${runId}-`,existing=(await readdir(directory)).filter(name=>name.startsWith(prefix));
  if((await readdir(directory)).includes(`m4-benchmark-formal-${runId}.json`))throw new Error('该运行已有完整报告，不允许续跑');
  const rounds:RoundEvidence[]=[],keys:string[]=[];
  for(const name of existing){
    if(!/^m4-round-formal-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(read|write)-(same-book|spread-books)-[1-3]\.json$/.test(name))throw new Error('续跑目录包含异常证据文件');
    const round=JSON.parse(await readFile(new URL(name,directory),'utf8')) as RoundEvidence;
    const {mode,distribution,round:number}=round.group;
    if(name!==`${prefix}${mode}-${distribution}-${number}.json`||round.options.smoke||round.options.users!==20||round.options.warmupMs!==30000||round.options.durationMs!==180000||round.options.rounds!==3||!Array.isArray(round.workflowSamples)||!Array.isArray(round.httpSamples))throw new Error('续跑轮次证据元数据不匹配');
    keys.push(`${mode}/${distribution}/${number}`);rounds.push(round);
  }
  const missing=validateResumeGroups(rounds.map(x=>x.group));
  return {rounds,missing,workflowSamples:rounds.flatMap(x=>x.workflowSamples),httpSamples:rounds.flatMap(x=>x.httpSamples),groups:rounds.map(x=>x.group),startedAt:rounds[0]!.startedAt,previousCompletedAt:rounds.map(x=>x.completedAt).sort().at(-1)!,environment:rounds[0]!.environment};
}
export async function benchmark(args:string[]){
  const options=benchmarkOptions(args),directory=new URL('../../docs/development/evidence/',import.meta.url),participantCounts='participantCounts' in options?options.participantCounts:undefined,participantStudy=participantCounts!==undefined,studyRunId=participantStudy?new Date().toISOString().replace(/[:.]/g,'-'):undefined;
  if(studyRunId){const names=await readdir(directory),prefix=`m4-round-participant-study-${studyRunId}-`;if(names.some(name=>name.startsWith(prefix))||names.includes(`m4-participant-study-run-${studyRunId}.json`)||names.includes(`m4-participant-study-summary-${studyRunId}.json`))throw new Error('该参与范围runId已有证据，拒绝重跑');}
  const resume=options.resumeRunId?await resumeEvidence(directory,options.resumeRunId):undefined,rawPool=await fixturePool();
  type Counter={sql:number;timings:SqlTimings;lockAcquiredAt?:number};
  const counters=new AsyncLocalStorage<Counter>(),finished=new Map<string,Counter>();
  function instrument<T extends Pool|PoolConnection>(target:T):T{return new Proxy(target,{get(db,key){
    if(key==='getConnection')return async()=>{const start=performance.now(),connection=await rawPool.getConnection(),count=counters.getStore();if(count)count.timings.acquireMs+=performance.now()-start;return instrument(connection)};
    const value=Reflect.get(db,key);
    if((key==='commit'||key==='rollback')&&typeof value==='function')return async()=>{
      const count=counters.getStore();try{return await Reflect.apply(value,db,[])}finally{if(count?.lockAcquiredAt!==undefined){count.timings.bookLockHeldMs+=performance.now()-count.lockAcquiredAt;delete count.lockAcquiredAt}}
    };
    if((key==='execute'||key==='query')&&typeof value==='function')return async(...params:unknown[])=>{
      const count=counters.getStore(),start=performance.now(),sql=String(params[0]);if(count)count.sql++;
      try{
        const result=await Reflect.apply(value,db,params) as [unknown,unknown];
        if(count&&sql.startsWith('SELECT * FROM books WHERE id=')&&Array.isArray(result[0])&&result[0][0]){
          count.timings.bookVersion=String(result[0][0].financialVersion);
          if(sql.includes('FOR UPDATE'))count.lockAcquiredAt=performance.now();
        }
        return result;
      }finally{if(count){const ms=performance.now()-start;count.timings.sqlMs+=ms;
        if(sql.startsWith('SELECT * FROM books WHERE id=')&&sql.includes('FOR UPDATE'))count.timings.bookLockMs+=ms;
        if(sql.startsWith('WITH current_expenses'))count.timings.aggregateMs+=ms;
        if(sql.startsWith('INSERT INTO expense_shares'))count.timings.shareInsertMs+=ms;
      }}
    };
    return typeof value==='function'?value.bind(db):value;
  }})}
  const pool=instrument(rawPool),store=new MysqlFinanceStore(pool),app=createApp(store,{origin,secureCookies:false},store);
  const server=createServer((req,res)=>counters.run({sql:0,timings:{acquireMs:0,sqlMs:0,bookLockMs:0,bookLockHeldMs:0,aggregateMs:0,shareInsertMs:0}},()=>{const count=counters.getStore()!;res.once('finish',()=>{finished.set(String(res.getHeader('X-Request-Id')),count)});app(req,res)}));
  const records:WorkflowRecord[]=[...(resume?.workflowSamples??[])],httpRecords:WorkflowRecord[]=[...(resume?.httpSamples??[])];
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    const address=server.address();if(!address||typeof address==='string')throw new Error('测试监听失败');const base=`http://127.0.0.1:${address.port}/api/v1`;
    async function scale():Promise<Scale>{const [rows]=await rawPool.query<import('mysql2/promise').RowDataPacket[]>(`SELECT (SELECT COUNT(*) FROM expenses) expenses,(SELECT COUNT(*) FROM expense_versions) versions,(SELECT COUNT(*) FROM expense_shares) shares,(SELECT COUNT(*) FROM confirmed_transfers) confirmed,(SELECT COUNT(*) FROM transfer_requests) requests`);return Object.fromEntries(Object.entries(rows[0]!).map(([key,value])=>[key,String(value)])) as Scale}
    async function interruptedRoundResidual(previousCompletedAt:string){
      const books=Array.from({length:10},(_,i)=>bookId(i)),placeholders=books.map(()=>'?').join(','),boundary=previousCompletedAt.slice(0,23).replace('T',' ');
      const [expenses]=await rawPool.query<import('mysql2/promise').RowDataPacket[]>(`SELECT bookId,COUNT(*) count FROM expenses WHERE bookId IN (${placeholders}) AND createdAt>? GROUP BY bookId`,[...books,boundary]);
      const [requests]=await rawPool.query<import('mysql2/promise').RowDataPacket[]>(`SELECT bookId,status,COUNT(*) count FROM transfer_requests WHERE bookId IN (${placeholders}) AND createdAt>? GROUP BY bookId,status`,[...books,boundary]);
      const [confirmed]=await rawPool.query<import('mysql2/promise').RowDataPacket[]>(`SELECT bookId,COUNT(*) count FROM confirmed_transfers WHERE bookId IN (${placeholders}) AND confirmedAt>? GROUP BY bookId`,[...books,boundary]);
      const [audit]=await rawPool.query<import('mysql2/promise').RowDataPacket[]>(`SELECT eventType,COUNT(*) count FROM (
        SELECT a.eventType FROM expenses e JOIN audit_events a ON a.bookId=e.bookId AND a.entityId=e.id WHERE e.bookId IN (${placeholders}) AND e.createdAt>?
        UNION ALL SELECT a.eventType FROM transfer_requests r JOIN audit_events a ON a.bookId=r.bookId AND a.entityId=r.id WHERE r.bookId IN (${placeholders}) AND r.createdAt>?
        UNION ALL SELECT a.eventType FROM confirmed_transfers t JOIN audit_events a ON a.bookId=t.bookId AND a.entityId=t.id WHERE t.bookId IN (${placeholders}) AND t.confirmedAt>?
      ) recent GROUP BY eventType`,[...books,boundary,...books,boundary,...books,boundary]);
      const [times]=await rawPool.query<import('mysql2/promise').RowDataPacket[]>(`SELECT DATE_FORMAT(MIN(createdAt),'%Y-%m-%dT%H:%i:%s.%fZ') startedAt,DATE_FORMAT(MAX(createdAt),'%Y-%m-%dT%H:%i:%s.%fZ') endedAt FROM (
        SELECT createdAt FROM expenses WHERE bookId IN (${placeholders}) AND createdAt>?
        UNION ALL SELECT createdAt FROM transfer_requests WHERE bookId IN (${placeholders}) AND createdAt>?
        UNION ALL SELECT confirmedAt createdAt FROM confirmed_transfers WHERE bookId IN (${placeholders}) AND confirmedAt>?
      ) recent`,[...books,boundary,...books,boundary,...books,boundary]);
      const byBook=books.map((id,book)=>({book,expenses:0,requests:0,confirmed:0,pending:0}));
      for(const row of expenses)byBook[books.indexOf(String(row.bookId))]!.expenses=Number(row.count);
      for(const row of requests){const target=byBook[books.indexOf(String(row.bookId))]!;target.requests+=Number(row.count);if(row.status==='PENDING')target.pending+=Number(row.count)}
      for(const row of confirmed)byBook[books.indexOf(String(row.bookId))]!.confirmed=Number(row.count);
      const eventCounts=Object.fromEntries(audit.map(row=>[String(row.eventType),Number(row.count)]));
      const start=times[0]?.startedAt,end=times[0]?.endedAt;
      if(typeof start!=='string'||typeof end!=='string')throw new Error('M4中断残留缺少可核验时间戳，拒绝续跑');
      const residual={previousCompletedAt,startedAt:start,endedAt:end,expenses:expenses.reduce((sum,row)=>sum+Number(row.count),0),requests:requests.reduce((sum,row)=>sum+Number(row.count),0),confirmed:confirmed.reduce((sum,row)=>sum+Number(row.count),0),pending:byBook.reduce((sum,row)=>sum+row.pending,0),auditEvents:{expenseCreated:eventCounts.EXPENSE_CREATED??0,transferRequested:eventCounts.TRANSFER_REQUESTED??0,transferConfirmed:eventCounts.TRANSFER_CONFIRMED??0,other:Object.entries(eventCounts).filter(([type])=>!['EXPENSE_CREATED','TRANSFER_REQUESTED','TRANSFER_CONFIRMED'].includes(type)).reduce((sum,[,count])=>sum+count,0)},byBook};
      const counts=validateInterruptedFinalRoundResidual(residual);
      return {startedAt:start,endedAt:end,...counts,auditEvents:residual.auditEvents};
    }
    const scaleAtStart=await scale(),startedAt=resume?.startedAt??new Date().toISOString(),resumedAt=resume?new Date().toISOString():undefined;
    const [mysqlSettings]=await rawPool.query('SELECT @@innodb_buffer_pool_size bufferPoolBytes,@@max_connections maxConnections');
    const environmentInfo={node:process.version,os:platform()+' '+release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem(),mysql:await environment(rawPool),mysqlSettings,poolConnections:8};
    await mkdir(directory,{recursive:true});
    let interruptedResidual:Awaited<ReturnType<typeof interruptedRoundResidual>>|null=null;
    if(resume){
      if(JSON.stringify(environmentInfo)!==JSON.stringify(resume.environment))throw new Error('续跑运行环境与原始轮次不同，拒绝合并');
      const formalChanges=mutationCounts(resume.workflowSamples),inferredStart=adjustScale(scaleAtStart,formalChanges,-1);
      const smokeFiles=(await readdir(directory)).filter(name=>/^m4-benchmark-smoke-.*\.json$/.test(name));
      const smokeRecords:WorkflowRecord[]=[];for(const name of smokeFiles){const run=JSON.parse(await readFile(new URL(name,directory),'utf8'));smokeRecords.push(...run.workflowSamples)}
      const seedScale:Scale={expenses:'19000',versions:'22800',shares:'684000',confirmed:'2',requests:'2'};
      const expectedStart=adjustScale(seedScale,mutationCounts(smokeRecords),1);
      if(JSON.stringify(inferredStart)!==JSON.stringify(expectedStart)){
        interruptedResidual=await interruptedRoundResidual(resume.previousCompletedAt);
        const withInterruptedResidual=adjustScale(expectedStart,interruptedResidual,1);
        if(JSON.stringify(inferredStart)!==JSON.stringify(withInterruptedResidual))throw new Error('M4隔离库计数无法由种子、既有样本和已核验中断残留解释，拒绝续跑：'+JSON.stringify({actual:scaleAtStart,afterExistingFormal:inferredStart,expectedFromSeedSmokeAndInterruptedRound:withInterruptedResidual}));
        console.log(`已核验未保存的最后一轮中断残留：${interruptedResidual.expenses}笔支出、${interruptedResidual.requests}个请求、${interruptedResidual.confirmed}次确认；仅计入基线，不计入性能样本。`);
      }
      console.log(`已校验${resume.rounds.length}/12个原始轮次及隔离库计数；本次只补测write/spread-books/3。`);
    }
    const credentials=await Promise.all(Array.from({length:30},async(_,i)=>{const sid=newToken();await store.insertSession(pool,tokenHash(sid),userId(i));return {cookie:'heji_sid='+sid,csrf:csrfFor(sid)}}));
    const runId=options.resumeRunId??studyRunId??new Date().toISOString().replace(/[:.]/g,'-');
    const persistedOptions={users:options.users,warmupMs:options.warmupMs,durationMs:options.durationMs,rounds:options.rounds,smoke:options.smoke,...(participantStudy?{participantStudy:true,participantCounts}: {})};
    const groups:unknown[]=resume?.groups??[];
    const completed=new Set(groups.map((x:any)=>`${x.mode}/${x.distribution}/${x.round}`));
    const scenarios: Array<{mode:'read'|'write';distribution:'same-book'|'spread-books';round:number;participantCount?:number}>=participantStudy?participantStudyGroups(participantCounts):(['read','write'] as const).flatMap(mode=>(['same-book','spread-books'] as const).flatMap(distribution=>Array.from({length:options.rounds},(_,i)=>({mode,distribution,round:i+1}))));
    const studyFiles:string[]=[];
    for(const {mode,distribution,round,participantCount} of scenarios){
      if(completed.has(`${mode}/${distribution}/${round}`))continue;
      if(resume&&(mode!==resume.missing.mode||distribution!==resume.missing.distribution||round!==resume.missing.round))continue;
      const measured:Sample[]=[],httpMeasured:Sample[]=[],roundRecords:WorkflowRecord[]=[],roundHttpRecords:WorkflowRecord[]=[];let sequence=0;
      const actualScaleAtGroupStart=await scale();
      for(const phase of ['warmup','measure']){
        const end=performance.now()+(phase==='warmup'?options.warmupMs:options.durationMs);
        async function call(actor:number,path:string,method='GET',body?:unknown):Promise<{sample:Sample;data:any}>{
          const start=performance.now();let data:any,sample:Sample={ms:0,status:0,sql:0};
          try{
            const response=await fetch(base+path,{method,headers:{Cookie:credentials[actor]!.cookie,Origin:origin,'Content-Type':'application/json',...(method==='GET'?{}:{'X-CSRF-Token':credentials[actor]!.csrf,'Idempotency-Key':randomUUID()})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
            const json=await response.json();data=json.data;const code=json.error?.code;
            const requestId=response.headers.get('x-request-id')??'',count=finished.get(requestId);sample={ms:performance.now()-start,status:response.status,sql:count?.sql??0,...(count?{timings:count.timings}:{}),...(typeof code==='string'?{code}:{})};finished.delete(requestId);
          }catch{sample.ms=performance.now()-start;sample.code='NETWORK_OR_RESPONSE_FAILURE'}
          sample.operation=method==='GET'?'read':'write';sample.endpoint=path.includes('/transfer-requests/')?(path.endsWith('/preview')?'preview':'confirm'):path.includes('/transfer-requests')?'request':path.includes('/reports')?'report':path.includes('/balances')?'balance':'expense';const record={mode,distribution,round,phase,sample};httpRecords.push(record);roundHttpRecords.push(record);if(phase==='measure')httpMeasured.push(sample);return {sample,data};
        }
        await Promise.all(Array.from({length:options.users},async()=>{
          while(performance.now()<end){
            const current=sequence++,actor=current%30,b=distribution==='same-book'?0:Math.floor(current/10)%10,book=bookId(b),path='/books/'+book,operation=workload(mode,current),start=performance.now();
            let response:{sample:Sample;data:any};
            if(mode==='read')response=await call(actor,path+(operation==='page'?'/expenses?limit=20':operation==='balance'?'/balances':'/reports?from=2026-01-01&to=2026-12-31'));
            else if(operation==='confirm'){
              const recipient=(actor+1)%30,created=await call(actor,path+'/transfer-requests','POST',{toMemberId:memberId(b,recipient),amountFen:'1',occurredOn:'2026-11-17',note:'M4虚构转账验收'});
              response=created;
              if(created.sample.status===201){const target=path+'/transfer-requests/'+created.data.id,preview=await call(recipient,target+'/preview');response=preview;
                if(preview.sample.status===200){
                  response=await call(recipient,target+'/confirm','POST',{expectedFinancialVersion:preview.data.expectedFinancialVersion,expectedRequestRevision:preview.data.expectedRequestRevision});
                  const observed=response.sample.timings?.bookVersion;
                  if(observed!==undefined)response.sample.versionGap=(BigInt(observed)-BigInt(preview.data.expectedFinancialVersion)).toString();
                }
              }
            }else{
              const indexes=participantCount===undefined?Array.from({length:30},(_,i)=>i):participantIndexes(actor,current,participantCount),members=indexes.map(i=>memberId(b,i));
              response=await call(actor,path+'/expenses','POST',{paidByMemberId:memberId(b,actor),amountFen:'10001',splitMode:operation==='equal'?'EQUAL':'EXACT',...(operation==='equal'?{participantMemberIds:members}:{shares:splitEqual(10001n,members).map(x=>({...x,amountFen:x.amountFen.toString()}))}),category:'FOOD',occurredOn:'2026-11-17',note:'M4虚构压力开销'});
            }
            const sample:Sample={...response.sample,ms:performance.now()-start,operation},record={mode,distribution,round,phase,sample};records.push(record);roundRecords.push(record);if(phase==='measure')measured.push(sample);
          }
        }));
      }
      const summary=summarize(measured),httpReads=httpMeasured.filter(x=>x.operation==='read'),httpWrites=httpMeasured.filter(x=>x.operation==='write');
      const group={mode,distribution,round,...(participantCount===undefined?{}:{participantCount}),workflows:summary,httpReads:httpReads.length?summarize(httpReads):null,httpWrites:httpWrites.length?summarize(httpWrites):null};groups.push(group);
      // 每轮独立落盘，长测试中断时仍保留已经完成的真实样本。
      const filename=participantStudy?`m4-round-participant-study-${runId}-p${participantCount}-${round}.json`:`m4-round-${options.smoke?'smoke':'formal'}-${runId}-${mode}-${distribution}-${round}.json`;
      await writeFile(new URL(filename,directory),JSON.stringify({startedAt,completedAt:new Date().toISOString(),environment:environmentInfo,options:persistedOptions,actualScaleAtGroupStart,group,workflowSamples:roundRecords,httpSamples:roundHttpRecords},null,2),{encoding:'utf8',flag:'wx'});
      if(participantStudy)studyFiles.push(filename);
      console.log(`${participantStudy?`${participantCount}人参与`:`${mode}/${distribution}`}第${round}轮：${summary.total}工作流，P95 ${summary.p95.toFixed(1)}ms，故障${summary.failures}，预期冲突${summary.expectedConflicts}`);
    }
    if(participantStudy){
      const manifestName=`m4-participant-study-run-${runId}.json`;
      await writeFile(new URL(manifestName,directory),JSON.stringify({kind:'m4-participant-study',runId,startedAt,completedAt:new Date().toISOString(),environment:environmentInfo,options:persistedOptions,actualScaleAtStart:scaleAtStart,actualScaleAtEnd:await scale(),roundFiles:studyFiles},null,2),{encoding:'utf8',flag:'wx'});
      console.log(`参与范围研究9轮证据已落盘；请在运行结束后使用只读报告命令汇总${manifestName}。`);
      return;
    }
    groups.sort((a:any,b:any)=>['read','write'].indexOf(a.mode)-['read','write'].indexOf(b.mode)||['same-book','spread-books'].indexOf(a.distribution)-['same-book','spread-books'].indexOf(b.distribution)||a.round-b.round);
    const name='m4-benchmark-'+(options.smoke?'smoke-':'formal-')+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
    const evidenceStartWithResidue=resume?adjustScale(scaleAtStart,mutationCounts(resume.workflowSamples),-1):scaleAtStart;
    const evidenceStart=interruptedResidual?adjustScale(evidenceStartWithResidue,interruptedResidual,-1):evidenceStartWithResidue;
    await writeFile(new URL(name,directory),JSON.stringify({scope:'本机隔离HTTP应用基准，不含Nginx/TLS/WS扇出；不外推2核4GB',seed,startedAt,completedAt:new Date().toISOString(),...(resume?{continuation:{resumed:true,resumedAt,previousCompletedAt:resume.previousCompletedAt,continuousRun:false,previousGroups:resume.rounds.length,...(interruptedResidual?{unmeasuredInterruptedFinalRound:interruptedResidual}:{})}}:{}),seedScale:{books:10,membersPerBook:30,targetCurrentExpenses:10000,otherBooksCurrentExpenses:1000,historicalRatio:0.2},actualScaleAtStart:evidenceStart,actualScaleAtResume:resume?scaleAtStart:null,actualScaleAtEnd:await scale(),environment:environmentInfo,options:persistedOptions,groups,workflowSamples:records,httpSamples:httpRecords},null,2),{encoding:'utf8',flag:'wx'});
    console.log(`性能记录已写入docs/development/evidence/${name}；冒烟不作为正式达标结论。`);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rawPool.end()}
}
