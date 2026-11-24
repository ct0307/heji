import { formatYuan,parseYuan } from '../../../packages/domain/src/ledger.ts';
import type { SettlementWindowDto } from '../../../packages/contracts/src/index.ts';
export const money=(fen: string)=>formatYuan(BigInt(fen));
export const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
export const categoryNames: Record<string,string>={FOOD:'餐饮',TRANSPORT:'交通',HOUSING:'住宿 / 合租',OTHER:'其他'};
export const statusNames: Record<string,string>={PENDING:'待确认',CONFIRMED:'已确认',REJECTED:'已拒绝',CANCELLED:'已取消'};
export function shareYuan(value: string): string {if(/^0(?:\.0{1,2})?$/.test(value))return '0';return parseYuan(value).toString()}
/** 网络失败沿用同一意图的键；成功或语义改变后生成新键。 */
export function createIntent(){
  let fingerprint='',key='';
  return {headers(path: string,body: unknown,etag?: string){const next=JSON.stringify([path,body,etag]);if(next!==fingerprint){fingerprint=next;key=crypto.randomUUID()}return {'Idempotency-Key':key,...(etag?{'If-Match':etag}:{})}},reset(){fingerprint='';key=''}};
}
/** 每个资源操作独立保留未确定结果的意图，其他操作成功不能清掉它。 */
export function createIntentStore(){
  const intents=new Map<string,ReturnType<typeof createIntent>>();
  return {headers(path:string,body:unknown,etag?:string){let intent=intents.get(path);if(!intent){intent=createIntent();intents.set(path,intent)}return intent.headers(path,body,etag)},reset(path:string){intents.delete(path)}};
}
export type PreviewRefreshResult<T>={kind:'unrelated'}|{kind:'fresh';preview:T}|{kind:'failed';error:unknown};
export async function refreshStalePreview<T>(cause:unknown,invalidate:()=>void,loadLatest:()=>Promise<T>):Promise<PreviewRefreshResult<T>>{
  const stale=cause instanceof Error&&'status' in cause&&cause.status===409&&'code' in cause&&cause.code==='PREVIEW_STALE';
  if(!stale)return {kind:'unrelated'};
  invalidate();
  try{return {kind:'fresh',preview:await loadLatest()}}catch(error){return {kind:'failed',error}}
}
/** 从请求发出时计时，保守扣除完整网络往返；不受电脑时钟校准影响。 */
export function windowReviewDeadline(window:SettlementWindowDto,requestStarted:number):number {
  const remaining=Date.parse(window.expiresAt??'')-Date.parse(window.serverTime);
  return requestStarted+(Number.isFinite(remaining)?Math.max(0,remaining):0);
}
export function windowReviewValid(window:SettlementWindowDto|null,windowId:string,requestId:string,deadline:number,now:number):boolean {
  return !!window&&window.state==='ACTIVE'&&window.mine&&window.windowId===windowId&&window.requestId===requestId&&now<deadline;
}
