export const restoreStages=[
  'file_verification','stream_preflight','schema_creation','database_connection','target_schema','import',
  'table_digests','table_digest','migration_metadata','foreign_keys','foreign_key',
  'historical_share_conservation','current_revision_present','balance_conservation',
  'derived_reconciliation','derived_balance','derived_report','financial_counts','commit'
] as const;
export type RestoreStage=typeof restoreStages[number];
export interface RestoreStageDetail {table?:string;bookIndex?:number;constraintIndex?:number}
export interface RestoreStageEvent extends RestoreStageDetail {
  id:number;parentId:number|null;stage:RestoreStage;status:'running'|'completed'|'failed';startedOffsetMs:number;elapsedMs:number;
}
export interface RestoreTimingSnapshot {
  format:'heji-m4-restore-timing-v1';elapsedMs:number;unmeasuredMs:number;stages:RestoreStageEvent[];
}
/** 只观察顺序执行的恢复阶段；观察回调故障不影响原校验/异常，原异常内容不进入进度。 */
export class RestoreTimer {
  private readonly clock:()=>number;
  private readonly observer:((event:RestoreStageEvent)=>void)|undefined;
  private readonly started:number;
  private readonly records:RestoreStageEvent[]=[];
  private readonly stack:RestoreStageEvent[]=[];
  constructor(clock:()=>number=()=>performance.now(),observer?:(event:RestoreStageEvent)=>void){
    this.clock=clock;this.observer=observer;this.started=clock();
  }
  private emit(event:RestoreStageEvent){try{this.observer?.({...event})}catch{/* 终端观察故障不能替代财务执行结果。 */}}
  async measure<T>(stage:RestoreStage,action:()=>Promise<T>,detail:RestoreStageDetail={}):Promise<T>{
    if(!restoreStages.includes(stage)||detail.table!==undefined&&!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(detail.table)
      ||detail.bookIndex!==undefined&&(!Number.isSafeInteger(detail.bookIndex)||detail.bookIndex<1)
      ||detail.constraintIndex!==undefined&&(!Number.isSafeInteger(detail.constraintIndex)||detail.constraintIndex<1))throw new Error('恢复计时标签无效');
    const event:RestoreStageEvent={id:this.records.length+1,parentId:this.stack.at(-1)?.id??null,stage,status:'running',startedOffsetMs:this.clock()-this.started,elapsedMs:0};
    if(detail.table!==undefined)event.table=detail.table;
    if(detail.bookIndex!==undefined)event.bookIndex=detail.bookIndex;
    if(detail.constraintIndex!==undefined)event.constraintIndex=detail.constraintIndex;
    this.records.push(event);this.stack.push(event);this.emit(event);
    try{
      const result=await action();event.status='completed';return result;
    }catch(error){event.status='failed';throw error}
    finally{event.elapsedMs=this.clock()-this.started-event.startedOffsetMs;this.stack.pop();this.emit(event)}
  }
  snapshot():RestoreTimingSnapshot{
    const elapsedMs=this.clock()-this.started;
    const stages=this.records.map(event=>({...event,elapsedMs:event.status==='running'?elapsedMs-event.startedOffsetMs:event.elapsedMs}));
    const measuredMs=stages.filter(event=>event.parentId===null).reduce((sum,event)=>sum+event.elapsedMs,0);
    return {format:'heji-m4-restore-timing-v1',elapsedMs,unmeasuredMs:Math.max(0,elapsedMs-measuredMs),stages};
  }
}
