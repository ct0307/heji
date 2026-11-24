import { createServer } from 'node:http';
import { createHash,randomUUID } from 'node:crypto';
import { appendFile,mkdir,readdir,writeFile } from 'node:fs/promises';
import { cpus,totalmem,platform,release } from 'node:os';
import { createApp } from '../../apps/api/src/app.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import { newToken,tokenHash,csrfFor } from '../../apps/api/src/modules/identity/security.ts';
import { splitEqual } from '../../packages/domain/src/ledger.ts';
import type { RowDataPacket } from 'mysql2/promise';
import { fixturePool,environment,migrations } from './database.ts';
import { bookId,memberId,userId } from './seed.ts';
import { checkBalances } from './balance-verification.ts';
import { windowBenchmarkOptions,parseWindowBenchmarkArgs,summarizeWindowTier,windowTierPasses,classifySideWrite,classifyWindowConfirm,classifyExpiryBoundary,redactWindowEvidence,windowPreflightPasses,expectedWindowTableDelta,expectedWindowAuditDelta,type WindowHttpResult } from './window-benchmark-policy.ts';

const origin='http://127.0.0.1:5174';
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const evidenceTables=['schema_migrations','m4_fixture_meta','users','sessions','books','book_members','invitations','audit_events','rate_limits','expenses','expense_versions','expense_shares','transfer_requests','confirmed_transfers','idempotency_records','financial_audit_details','finance_member_totals','finance_daily_members','finance_daily_categories','settlement_windows'] as const;
type ResponseRecord=Omit<WindowHttpResult,'ms'>&{ms:number;data?:any;startedAt:number;startedMono:number;endpoint:string};

function runIdNow(){return new Date().toISOString().replace(/[:.]/g,'-')}

export async function windowBenchmark(args:string[]){
  parseWindowBenchmarkArgs(args);
  const options=windowBenchmarkOptions([]),directory=new URL('../../docs/development/evidence/',import.meta.url),runId=runIdNow(),prefix=`m4-window-benchmark-${runId}`;
  const existing=await readdir(directory);
  if(existing.some(name=>name.startsWith(prefix)))throw new Error('该窗口负载runId已有证据，拒绝重跑或续跑');
  const evidenceFile=`${prefix}.jsonl`,reportFile=`${prefix}-summary.json`,stream=new URL(evidenceFile,directory);
  await mkdir(directory,{recursive:true});await writeFile(stream,'',{encoding:'utf8',flag:'wx'});
  let appendQueue=Promise.resolve();
  const append=(event:Record<string,unknown>)=>{
    appendQueue=appendQueue.then(()=>appendFile(stream,JSON.stringify(redactWindowEvidence(event))+'\n',{encoding:'utf8'}));
    return appendQueue;
  };
  let pool:Awaited<ReturnType<typeof fixturePool>>;
  try{pool=await fixturePool()}catch(error){await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'stopped',stoppedAt:new Date().toISOString(),reason:'固定bench门禁失败'});throw error}
  let migration:Awaited<ReturnType<typeof migrations>>[number];
  try{
    const sourceMigrations=await migrations(true,true);migration=sourceMigrations.find(item=>item.name==='004_settlement_windows.sql')!;
    if(!migration)throw new Error('004迁移源缺失，停止窗口负载');
    const [markers]=await pool.execute<RowDataPacket[]>('SELECT checksum FROM schema_migrations WHERE name=?',['004_settlement_windows.sql']);
    if(markers.length!==1||String(markers[0]!.checksum)!==migration.checksum)throw new Error('bench未应用预期004迁移，停止窗口负载');
  }catch(error){await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'stopped',stoppedAt:new Date().toISOString(),reason:'004迁移checksum预检失败'});await pool.end();throw error}
  const book=bookId(0);
  let preflight:{otherConnections:number;activeWindows:number;coolingWindows:number;hotBookHasWindow:boolean;hotBookExpiredUnclosedWindows:number};
  try{
    const preflightConnection=await pool.getConnection();
    try{
      const [rows]=await preflightConnection.query<RowDataPacket[]>(`SELECT
        (SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()) otherConnections,
        (SELECT COUNT(*) FROM settlement_windows WHERE closedAt IS NULL AND expiresAt>UTC_TIMESTAMP(3)) activeWindows,
        (SELECT COUNT(*) FROM settlement_windows WHERE cooldownUntil>UTC_TIMESTAMP(3)) coolingWindows,
        (SELECT COUNT(*) FROM settlement_windows WHERE bookId=?) hotBookWindows,
        (SELECT COUNT(*) FROM settlement_windows WHERE bookId=? AND closedAt IS NULL AND expiresAt<=UTC_TIMESTAMP(3)) hotBookExpiredUnclosedWindows`,[book,book]);
      preflight={otherConnections:Number(rows[0]!.otherConnections),activeWindows:Number(rows[0]!.activeWindows),coolingWindows:Number(rows[0]!.coolingWindows),hotBookHasWindow:Number(rows[0]!.hotBookWindows)>0,hotBookExpiredUnclosedWindows:Number(rows[0]!.hotBookExpiredUnclosedWindows)};
    }finally{preflightConnection.release()}
    await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'preflight',target:'heji_m4_bench',migrationChecksum:migration.checksum,preflight});
    if(!windowPreflightPasses(preflight))throw new Error('bench存在其他连接、活动窗口或冷却窗口，停止负载且不自动等待/清理');
  }catch(error){await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'stopped',stoppedAt:new Date().toISOString(),reason:'bench只读预检未通过'});await pool.end();throw error}
  const store=new MysqlFinanceStore(pool),app=createApp(store,{origin,secureCookies:false},store);
  const server=createServer(app),route=`/api/v1/books/${book}`,memberIds=Array.from({length:30},(_,index)=>memberId(0,index));
  type Credential={cookie:string;csrf:string;actor:number};
  let credentials:Credential[]=[];
  const measurements:{waitMs:number;status:number;code?:string;ms:number}[][]=[];
  const faults:string[]=[];
  let startedAt=new Date().toISOString(),environmentInfo:Record<string,unknown>={},initialCounts:Record<string,any>={},finalCounts:Record<string,any>={};
  async function counts(){
    const tableCounts=Object.fromEntries(await Promise.all(evidenceTables.map(async table=>{
      const [rows]=await pool.query<RowDataPacket[]>(`SELECT COUNT(*) count FROM \`${table}\``);return [table,String(rows[0]!.count)];
    })));
    const [books]=await pool.query<RowDataPacket[]>('SELECT id,financialVersion FROM books ORDER BY id');
    const financialVersionHash=createHash('sha256');for(const row of books)financialVersionHash.update(`${row.id}\0${row.financialVersion}\n`);
    const hotBookVersion=books.find(row=>String(row.id)===book)?.financialVersion;
    if(hotBookVersion===undefined)throw new Error('固定热点账本缺失');
    return {tableCounts,financialVersionHash:financialVersionHash.digest('hex'),hotBookVersion:String(hotBookVersion)};
  }
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    const address=server.address();if(!address||typeof address==='string')throw new Error('窗口负载本地监听失败');
    const base=`http://127.0.0.1:${address.port}`;
    const [mysqlSettings]=await pool.query('SELECT @@innodb_buffer_pool_size bufferPoolBytes,@@max_connections maxConnections');
    environmentInfo={node:process.version,os:platform()+' '+release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem(),mysql:await environment(pool),mysqlSettings,poolConnections:8};
    initialCounts=await counts();startedAt=new Date().toISOString();
    await append({format:'heji-m4-window-benchmark-progress-v1',runId,target:'heji_m4_bench',phase:'started',startedAt,environment:environmentInfo,migrationChecksum:migration.checksum,preflight,initialCounts,scope:'20个固定虚构会话；单热点账本；不续跑'});
    credentials=await Promise.all(Array.from({length:options.users},async(_,actor)=>{
      const session=newToken();await store.insertSession(pool,tokenHash(session),userId(actor));return {cookie:'heji_sid='+session,csrf:csrfFor(session),actor};
    }));

    async function call(credential:Credential,path:string,method:'GET'|'POST',body?:unknown):Promise<ResponseRecord>{
      const startedMono=performance.now(),startedAt=Date.now();
      try{
        const response=await fetch(base+path,{method,headers:{Cookie:credential.cookie,Origin:origin,'Content-Type':'application/json',...(method==='GET'?{}:{'X-CSRF-Token':credential.csrf,'Idempotency-Key':randomUUID()})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
        const json=await response.json() as {data?:unknown;error?:{code?:unknown}};
        return {status:response.status,...(typeof json.error?.code==='string'?{code:json.error.code}:{}),ms:performance.now()-startedMono,startedAt,startedMono,endpoint:path,...(json.data!==undefined?{data:json.data}:{})};
      }catch{return {status:0,code:'NETWORK_OR_RESPONSE_FAILURE',ms:performance.now()-startedMono,startedAt,startedMono,endpoint:path}}
    }
    const sideActors=credentials.filter(item=>item.actor!==1);
    async function attemptSideWrites(deadline:number,activeWaitMs:number){
      const seen:WindowHttpResult[]=[];let running:Promise<void>[]=[];let stopped=false;
      const loops=sideActors.map(async credential=>{
        while(!stopped&&performance.now()<deadline){
          const participant=memberIds[credential.actor]!,body={paidByMemberId:participant,amountFen:'1',splitMode:'EQUAL',participantMemberIds:memberIds,category:'OTHER',occurredOn:'2026-11-19',note:'窗口负载虚构旁路写入'};
          const request=call(credential,route+'/expenses','POST',body).then(async result=>{
            seen.push(result);const classification=classifySideWrite(result);if(classification!=='expected_block'){faults.push(`side_write_${result.status}_${result.code??'NO_CODE'}`);stopped=true}
            await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'side_write',waitMs:activeWaitMs,classification,status:result.status,code:result.code??null,latencyMs:result.ms});
          });
          running.push(request);await request;
          const next=deadline-performance.now();if(next>0)await pause(Math.min(1000,next));
        }
      });
      const stopper=setTimeout(()=>{stopped=true},Math.max(0,deadline-performance.now()));
      await Promise.all(loops);clearTimeout(stopper);stopped=true;await Promise.all(running);
      return seen;
    }
    const tiers:Record<string,unknown>[]=[];
    let lastCooldownDeadline=performance.now();
    for(const waitMs of options.waitMs){
      const samples:{waitMs:number;status:number;code?:string;ms:number}[]=[];
      const sideResults:WindowHttpResult[]=[];const requestLatencies:number[]=[],openLatencies:number[]=[];let completed=0;
      for(let attempt=1;attempt<=options.attemptsPerTier;attempt++){
        const remaining=lastCooldownDeadline-performance.now();if(remaining>0)await pause(remaining);
        const request=await call(credentials[0]!,route+'/transfer-requests','POST',{toMemberId:memberIds[1],amountFen:'1',occurredOn:'2026-11-19',note:'窗口人工等待负载虚构请求'});
        await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'stage',waitMs,attempt,stage:'request_create',status:request.status,code:request.code??null,latencyMs:request.ms});
        requestLatencies.push(request.ms);
        if(request.status!==201){samples.push({waitMs,status:request.status,...(request.code?{code:request.code}:{}),ms:request.ms});completed=attempt;faults.push(`request_create_${request.status}_${request.code??'NO_CODE'}`);await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'sample_failed',waitMs,attempt,stage:'request_create',status:request.status,code:request.code??null,latencyMs:request.ms});throw new Error(`窗口负载停止：第${waitMs/1000}秒档第${attempt}次请求创建未成功`)}
        const requestId=String(request.data.id),open=await call(credentials[1]!,`${route}/transfer-requests/${requestId}/settlement-window`,'POST',{});
        await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'stage',waitMs,attempt,stage:'window_open',status:open.status,code:open.code??null,latencyMs:open.ms});
        openLatencies.push(open.ms);
        if(open.status!==201){samples.push({waitMs,status:open.status,...(open.code?{code:open.code}:{}),ms:open.ms});completed=attempt;faults.push(`window_open_${open.status}_${open.code??'NO_CODE'}`);await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'sample_failed',waitMs,attempt,stage:'window_open',status:open.status,code:open.code??null,latencyMs:open.ms});throw new Error(`窗口负载停止：第${waitMs/1000}秒档第${attempt}次窗口申请未成功`)}
        const window= open.data.window as {windowId:string;serverTime:string;expiresAt:string;cooldownUntil:string};
        const preview=open.data.preview as {expectedFinancialVersion:string;expectedRequestRevision:string};
        if(!window.windowId||!preview.expectedFinancialVersion||!preview.expectedRequestRevision)throw new Error('窗口响应缺少绑定确认字段，停止负载');
        const sideTask=attemptSideWrites(performance.now()+waitMs,waitMs);
        await pause(waitMs);const side=await sideTask;sideResults.push(...side);
        if(side.some(result=>classifySideWrite(result)!=='expected_block'))throw new Error('旁路财务写入未被窗口完整阻止，立即停止本轮');
        const confirm=await call(credentials[1]!,`${route}/transfer-requests/${requestId}/confirm`,'POST',{
          expectedFinancialVersion:preview.expectedFinancialVersion,expectedRequestRevision:preview.expectedRequestRevision,expectedWindowId:window.windowId,
        });
        await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'stage',waitMs,attempt,stage:'confirm',status:confirm.status,code:confirm.code??null,latencyMs:confirm.ms});
        const succeeded=confirm.status===200&&!confirm.code;
        const confirmationClassification=classifyWindowConfirm(confirm);
        const sample={waitMs,status:confirm.status,...(confirm.code?{code:confirm.code}:{}),ms:confirm.ms};samples.push(sample);completed=attempt;
        if(confirmationClassification==='system_failure')faults.push(`confirm_${confirm.status}_${confirm.code??'NO_CODE'}`);
        await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'sample',waitMs,attempt,requestCreate:{status:request.status,latencyMs:request.ms},windowOpen:{status:open.status,latencyMs:open.ms},confirm:{status:confirm.status,code:confirm.code??null,latencyMs:confirm.ms},sideWrites:side.map(result=>({status:result.status,code:result.code??null,latencyMs:result.ms})),success:succeeded});
        const current=await call(credentials[1]!,route+'/settlement-window','GET');
        if(current.status!==200)throw new Error('无法读取窗口冷却时间，停止负载');
        const state=current.data as {serverTime:string;cooldownUntil:string|null};
        lastCooldownDeadline=current.startedMono+Math.max(0,Date.parse(state.cooldownUntil??state.serverTime)-Date.parse(state.serverTime))+current.ms;
        if(confirmationClassification==='system_failure')
          throw new Error(`窗口负载停止：第${waitMs/1000}秒档第${attempt}次绑定确认出现非预期状态`);
      }
      measurements.push(samples);
      const summary=summarizeWindowTier(samples,waitMs),sideExpected=sideResults.filter(result=>classifySideWrite(result)==='expected_block').length;
      const sideP95=sideResults.map(result=>result.ms??0).sort((a,b)=>a-b)[Math.ceil(sideResults.length*.95)-1]??0;
      const requestP95=requestLatencies.sort((a,b)=>a-b)[Math.ceil(requestLatencies.length*.95)-1]??0;
      const openP95=openLatencies.sort((a,b)=>a-b)[Math.ceil(openLatencies.length*.95)-1]??0;
      const tier={...summary,complete:completed===60,sideWrites:sideResults.length,sideBlocked:sideExpected,sideSystemFailures:sideResults.length-sideExpected,sideWriteP95:sideP95,requestCreateP95:requestP95,windowOpenP95:openP95,passed:windowTierPasses(summary)&&faults.length===0&&sideExpected===sideResults.length&&sideP95<=800&&requestP95<=800&&openP95<=800};
      tiers.push(tier);await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'tier_complete',tier});
      if(!tier.passed)throw new Error(`窗口负载停止：第${waitMs/1000}秒档未达到验收条件`);
    }

    const cooldownRemaining=lastCooldownDeadline-performance.now();if(cooldownRemaining>0)await pause(cooldownRemaining);
    const expiryRequest=await call(credentials[0]!,route+'/transfer-requests','POST',{toMemberId:memberIds[1],amountFen:'1',occurredOn:'2026-11-19',note:'窗口自然到期边界虚构请求'});
    if(expiryRequest.status!==201)throw new Error('自然到期边界请求创建失败');
    const expiryOpen=await call(credentials[1]!,`${route}/transfer-requests/${expiryRequest.data.id}/settlement-window`,'POST',{});
    if(expiryOpen.status!==201)throw new Error('自然到期边界窗口申请失败');
    const expiryWindow=expiryOpen.data.window as {windowId:string;expiresAt:string;serverTime:string};
    const expiryPreview=expiryOpen.data.preview as {expectedFinancialVersion:string;expectedRequestRevision:string};
    const expiryDelay=Date.parse(expiryWindow.expiresAt)-Date.parse(expiryWindow.serverTime)+250;
    if(expiryDelay>0)await pause(expiryDelay);
    const expiredConfirm=await call(credentials[1]!,`${route}/transfer-requests/${expiryRequest.data.id}/confirm`,'POST',{
      expectedFinancialVersion:expiryPreview.expectedFinancialVersion,expectedRequestRevision:expiryPreview.expectedRequestRevision,expectedWindowId:expiryWindow.windowId,
    });
    const ordinaryWrite=await call(credentials[0]!,route+'/expenses','POST',{paidByMemberId:memberIds[0],amountFen:'1',splitMode:'EQUAL',participantMemberIds:memberIds,category:'OTHER',occurredOn:'2026-11-19',note:'窗口到期后恢复写入虚构验证'});
    const expiryBoundary=classifyExpiryBoundary({confirm:expiredConfirm,ordinaryWrite});
    if(expiryBoundary!=='passed')throw new Error('窗口自然到期边界验证失败');
    finalCounts=await counts();
    const connection=await pool.getConnection();try{await checkBalances(connection)}finally{connection.release()}
    const delta=(table:string)=>BigInt(finalCounts.tableCounts[table])-BigInt(initialCounts.tableCounts[table]);
    const successfulConfirmations=tiers.reduce((sum,tier)=>sum+Number(tier.successes),0);
    const unchanged=['schema_migrations','m4_fixture_meta','users','books','book_members','invitations','rate_limits'];
    const auditDelta=expectedWindowAuditDelta(successfulConfirmations,preflight);
    if(unchanged.some(table=>delta(table)!==0n)||delta('sessions')!==20n||delta('transfer_requests')!==181n||delta('confirmed_transfers')!==BigInt(successfulConfirmations)||delta('expenses')!==1n||delta('expense_versions')!==1n||delta('expense_shares')!==30n||delta('audit_events')!==auditDelta||delta('financial_audit_details')!==auditDelta||delta('idempotency_records')!==363n+BigInt(successfulConfirmations)||delta('settlement_windows')!==expectedWindowTableDelta(preflight)||BigInt(finalCounts.hotBookVersion!)-BigInt(initialCounts.hotBookVersion!)!==BigInt(successfulConfirmations+1)||finalCounts.financialVersionHash===initialCounts.financialVersionHash)
      throw new Error('负载逐表事实增量或财务版本摘要不符');
    const endedAt=new Date().toISOString(),allPassed=tiers.length===3&&faults.length===0&&expiryBoundary==='passed';
    const report=redactWindowEvidence({format:'heji-m4-window-benchmark-summary-v1',runId,target:'heji_m4_bench',startedAt,completedAt:endedAt,environment:environmentInfo,migrationChecksum:migration.checksum,initialCounts,finalCounts,tiers,expiryBoundary:{status:expiryBoundary,confirm:{status:expiredConfirm.status,code:expiredConfirm.code??null,latencyMs:expiredConfirm.ms},ordinaryWrite:{status:ordinaryWrite.status,code:ordinaryWrite.code??null,latencyMs:ordinaryWrite.ms}},result:allPassed?'passed':'failed',scope:'仅本机heji_m4_bench固定虚构夹具；不外推其他环境'});
    await writeFile(new URL(reportFile,directory),JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
    await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'completed',completedAt:endedAt,result:allPassed?'passed':'failed',finalCounts});
    if(!allPassed)throw new Error('窗口负载最终完整性门槛未通过');
    console.log(`窗口负载完成：${reportFile}`);
  }catch(error){
    await append({format:'heji-m4-window-benchmark-progress-v1',runId,phase:'stopped',stoppedAt:new Date().toISOString(),reason:error instanceof Error?error.message:'未知错误',completedTiers:measurements.map(samples=>({waitMs:samples[0]?.waitMs??null,samples:samples.length})),faults:faults.length});
    throw error;
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end()}
}

export {parseWindowBenchmarkArgs,windowBenchmarkOptions};
