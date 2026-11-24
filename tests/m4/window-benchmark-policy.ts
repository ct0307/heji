export interface WindowHttpResult {status:number;code?:string;ms?:number}
export interface WindowPreflight {otherConnections:number;activeWindows:number;coolingWindows:number;hotBookHasWindow?:boolean;hotBookExpiredUnclosedWindows?:number}
export interface WindowTierSample extends WindowHttpResult {waitMs:number}
export interface WindowTierSummary {
  waitMs:number;total:number;successes:number;failures:number;systemFailures:number;
  successRate:number;p50:number;p95:number;max:number;
}

const allowedWaits=[5000,15000,25000] as const;
const safeEvidenceKeys=new Set(['format','runId','target','startedAt','completedAt','stoppedAt','environment','migrationChecksum','initialCounts','finalCounts','preflight','otherConnections','activeWindows','coolingWindows','hotBookHasWindow','hotBookExpiredUnclosedWindows','tiers','tier','expiryBoundary','result','scope','phase','waitMs','attempt','stage','status','code','latencyMs','classification','success','sideWrites','sideBlocked','sideSystemFailures','sideWriteP95','requestCreateP95','windowOpenP95','passed','total','successes','failures','systemFailures','successRate','p50','p95','max','complete','confirm','ordinaryWrite','requestCreate','windowOpen','reason','completedTiers','faults','samples','node','os','cpu','logicalCpus','memoryBytes','mysql','mysqlSettings','poolConnections','version','sqlMode','isolationLevel','bufferPoolBytes','maxConnections','users','books','members','expenses','versions','shares','requests','confirmed','auditEvents','hotBookVersion','tableCounts','financialVersionHash','schema_migrations','m4_fixture_meta','sessions','book_members','invitations','rate_limits','expense_versions','expense_shares','transfer_requests','confirmed_transfers','audit_events','idempotency_records','financial_audit_details','finance_member_totals','finance_daily_members','finance_daily_categories','settlement_windows','expected','classificationCounts']);

export function windowBenchmarkOptions(args:string[]){
  if(args.length)throw new Error('窗口负载档位、样本量和用户数固定，不接受自定义参数');
  return {users:20,attemptsPerTier:60,waitMs:[...allowedWaits],successMinimum:57};
}

export function windowPreflightPasses(preflight:WindowPreflight):boolean{
  return preflight.otherConnections===0&&preflight.activeWindows===0&&preflight.coolingWindows===0;
}

export function expectedWindowTableDelta(preflight:WindowPreflight):bigint{
  return preflight.hotBookHasWindow?0n:1n;
}

export function expectedWindowAuditDelta(successes:number,preflight:WindowPreflight):bigint{
  return 544n+BigInt(successes)+BigInt(preflight.hotBookExpiredUnclosedWindows??0);
}

export function parseWindowBenchmarkArgs(args:string[]):string[]{
  const apply=args.filter(value=>value==='--apply'),rest=args.filter(value=>value!=='--apply');
  if(apply.length>1||rest.some(value=>value!=='--plan'))throw new Error('窗口负载参数无效');
  if(rest.filter(value=>value==='--plan').length>1||apply.length&&rest.length)throw new Error('计划与执行参数不能混用');
  return rest;
}

export function summarizeWindowTier(samples:WindowTierSample[],waitMs:number):WindowTierSummary{
  if(!allowedWaits.includes(waitMs as typeof allowedWaits[number])||samples.length!==60||samples.some(sample=>sample.waitMs!==waitMs))
    throw new Error('窗口档证据必须是固定等待时间下的60个完整样本');
  const latencies=samples.map(sample=>sample.ms).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0).sort((a,b)=>a-b);
  if(latencies.length!==samples.length)throw new Error('窗口档样本缺少有效HTTP延迟');
  const successes=samples.filter(sample=>sample.status===200&&!sample.code).length;
  const businessConflicts=new Set(['PREVIEW_STALE','SETTLEMENT_WINDOW_EXPIRED']);
  const systemFailures=samples.filter(sample=>sample.status===0||sample.status>=500||sample.code==='NETWORK_OR_RESPONSE_FAILURE'||sample.code==='INVALID_RESPONSE'||(sample.status!==200&&!businessConflicts.has(sample.code??''))).length;
  return {waitMs,total:samples.length,successes,failures:samples.length-successes,systemFailures,successRate:successes/samples.length,
    p50:latencies[Math.ceil(latencies.length*.5)-1]!,p95:latencies[Math.ceil(latencies.length*.95)-1]!,max:latencies.at(-1)!};
}

export function windowTierPasses(summary:WindowTierSummary):boolean{
  return summary.total===60&&summary.successes>=57&&summary.failures===summary.total-summary.successes&&summary.systemFailures===0&&summary.p95<=800;
}

export function classifyWindowConfirm(result:WindowHttpResult):'success'|'business_conflict'|'system_failure'{
  if(result.status===200&&!result.code)return 'success';
  if(result.status===409&&['PREVIEW_STALE','SETTLEMENT_WINDOW_EXPIRED'].includes(result.code??''))return 'business_conflict';
  return 'system_failure';
}

export function classifySideWrite(result:WindowHttpResult):'expected_block'|'system_failure'{
  return result.status===409&&result.code==='SETTLEMENT_WINDOW_ACTIVE'?'expected_block':'system_failure';
}

export function classifyExpiryBoundary(result:{confirm:WindowHttpResult;ordinaryWrite:WindowHttpResult}):'passed'|'failed'{
  return result.confirm.status===409&&result.confirm.code==='SETTLEMENT_WINDOW_EXPIRED'&&result.ordinaryWrite.status===201?'passed':'failed';
}

/** 证据采取字段白名单，避免原始请求、凭据、标识符和业务行进入文件。 */
export function redactWindowEvidence(value:Record<string,unknown>):Record<string,unknown>{
  const clean=(item:unknown):unknown=>{
    if(Array.isArray(item))return item.map(clean);
    if(!item||typeof item!=='object')return item;
    return Object.fromEntries(Object.entries(item).filter(([key])=>safeEvidenceKeys.has(key)).map(([key,nested])=>[key,clean(nested)]));
  };
  return clean(value) as Record<string,unknown>;
}

export function fixedWindowWaits():readonly number[]{return allowedWaits}
