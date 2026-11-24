import { randomUUID } from 'node:crypto';
import type { PoolConnection,RowDataPacket } from 'mysql2/promise';
import type { SettlementWindowDto } from '../../../../packages/contracts/src/index.ts';
import { ApiFault } from './errors.ts';

export const windowMigration='004_settlement_windows.sql';
export interface SettlementWindow {
  bookId:string;windowId:string;requestId:string;holderUserId:string;holderMemberId:string;
  createdAt:string;expiresAt:string;closedAt:string|null;cooldownUntil:string;
}
export interface WindowAccess {supported:boolean;window:SettlementWindow|null}
const iso=(value:unknown)=>value instanceof Date?value.toISOString():new Date(String(value).replace(' ','T').replace(/(?<!Z)$/,'Z')).toISOString();
const unavailable=()=>new ApiFault(503,'SETTLEMENT_WINDOW_UNAVAILABLE','结算窗口暂时不可用，请稍后重试');
export function windowState(window:SettlementWindow|null,now:number):SettlementWindowDto['state'] {
  if(!window)return 'NONE';
  if(window.closedAt&&Date.parse(window.closedAt)<Date.parse(window.expiresAt))return 'CLOSED';
  return Date.parse(window.expiresAt)<=now?'EXPIRED':'ACTIVE';
}
export function windowDto(access:WindowAccess,now:number,actorId:string,ownerId:string):SettlementWindowDto {
  const window=access.window,state=windowState(window,now),mine=window?.holderUserId===actorId;
  return {supported:access.supported,state,serverTime:new Date(now).toISOString(),windowId:window?.windowId??null,
    createdAt:window?.createdAt??null,expiresAt:window?.expiresAt??null,closedAt:window?.closedAt??null,cooldownUntil:window?.cooldownUntil??null,
    mine,canClose:state==='ACTIVE'&&(mine||actorId===ownerId),requestId:mine?window!.requestId:null};
}
/** 已被新窗口替代时，从生命周期审计恢复原窗口终态，不能把主动关闭误报为自然到期。 */
export async function replayWindowDto(db:PoolConnection,access:WindowAccess,original:SettlementWindowDto,now:number,actorId:string,ownerId:string,bookId:string):Promise<SettlementWindowDto>{
  requireWindowSupport(access);
  if(access.window?.windowId===original.windowId)return windowDto(access,now,actorId,ownerId);
  const [events]=await db.execute<RowDataPacket[]>(`SELECT d.changeSummary FROM audit_events e JOIN financial_audit_details d ON d.eventId=e.id
    WHERE e.bookId=? AND e.entityId=? AND e.eventType IN ('SETTLEMENT_WINDOW_CLOSED','SETTLEMENT_WINDOW_EXPIRED') ORDER BY e.createdAt DESC,e.id DESC LIMIT 1 FOR SHARE`,[bookId,original.windowId]);
  const raw=events[0]?.changeSummary;
  if(raw){const ended=(typeof raw==='string'?JSON.parse(raw):raw) as SettlementWindow;return windowDto({supported:true,window:ended},now,actorId,ownerId)}
  if(!original.expiresAt||Date.parse(original.expiresAt)>now)throw unavailable();
  return {...original,state:'EXPIRED',serverTime:new Date(now).toISOString(),closedAt:original.expiresAt,canClose:false};
}
/** 必须在账本锁与成员授权之后调用。标记缺失兼容旧结构，任何查询故障均失败关闭。 */
export async function loadWindow(db:PoolConnection,bookId:string,lock=false):Promise<WindowAccess> {
  try{
    const [marker]=await db.execute<RowDataPacket[]>('SELECT name FROM schema_migrations WHERE name=?'+(lock?' FOR SHARE':''),[windowMigration]);
    if(!marker.length)return {supported:false,window:null};
    const [found]=await db.execute<RowDataPacket[]>('SELECT * FROM settlement_windows WHERE bookId=?'+(lock?' FOR UPDATE':''),[bookId]);
    const row=found[0];
    return {supported:true,window:row?{bookId:String(row.bookId),windowId:String(row.windowId),requestId:String(row.requestId),holderUserId:String(row.holderUserId),holderMemberId:String(row.holderMemberId),createdAt:iso(row.createdAt),expiresAt:iso(row.expiresAt),closedAt:row.closedAt?iso(row.closedAt):null,cooldownUntil:iso(row.cooldownUntil)}:null};
  }catch{throw unavailable()}
}
export function requireWindowSupport(access:WindowAccess){if(!access.supported)throw unavailable()}
/** 时间在取得锁后读取，不能使用请求到达时的应用时钟。 */
export async function windowNow(db:PoolConnection):Promise<number> {
  try{const [result]=await db.execute<RowDataPacket[]>('SELECT UTC_TIMESTAMP(3) AS windowNow');return Date.parse(iso(result[0]!.windowNow))}catch{throw unavailable()}
}
interface WriteAttempt {operation:string;actorId?:string;memberId?:string;resourceId?:string|undefined;expectedWindowId?:string|undefined}
export function assertWindowWrite(window:SettlementWindow|null,now:number,attempt:WriteAttempt):void {
  if(attempt.expectedWindowId&&(window?.windowId!==attempt.expectedWindowId||windowState(window,now)!=='ACTIVE'))
    throw new ApiFault(409,'SETTLEMENT_WINDOW_EXPIRED','结算窗口已到期或已结束，请重新打开预览并核对');
  if(windowState(window,now)!=='ACTIVE')return;
  const bound=attempt.resourceId===window!.requestId;
  if(bound&&['request.cancel','request.reject'].includes(attempt.operation))return;
  if(bound&&attempt.operation==='request.confirm'&&attempt.expectedWindowId===window!.windowId&&attempt.actorId===window!.holderUserId&&attempt.memberId===window!.holderMemberId)return;
  throw new ApiFault(409,'SETTLEMENT_WINDOW_ACTIVE','有人正在核对结算，该账本财务写入暂时暂停，请稍后使用原提交重试');
}
export function assertWindowAvailable(access:WindowAccess,now:number):void {
  requireWindowSupport(access);
  if(windowState(access.window,now)==='ACTIVE')throw new ApiFault(409,'SETTLEMENT_WINDOW_ACTIVE','该账本已有结算窗口，请等待结束');
  if(access.window&&Date.parse(access.window.cooldownUntil)>now)throw new ApiFault(409,'SETTLEMENT_WINDOW_COOLDOWN',`结算窗口正在冷却，请${Math.ceil((Date.parse(access.window.cooldownUntil)-now)/1000)}秒后再申请；普通写入已开放`);
}
/** 窗口生命周期不增加财务版本，不发布新的WebSocket消息类型。 */
async function auditWindow(db:PoolConnection,window:SettlementWindow,actorId:string,event:string){
  const id=randomUUID();
  await db.execute('INSERT INTO audit_events(id,bookId,actorUserId,eventType,entityId,createdAt) VALUES(?,?,?,?,?,UTC_TIMESTAMP(3))',[id,window.bookId,actorId,event,window.windowId]);
  await db.execute('INSERT INTO financial_audit_details(eventId,revision,changeSummary) VALUES(?,NULL,?)',[id,JSON.stringify(window)]);
}
export async function expireWindow(db:PoolConnection,access:WindowAccess,now:number,actorId:string):Promise<void> {
  const window=access.window;
  if(window&&!window.closedAt&&windowState(window,now)==='EXPIRED'){
    await db.execute('UPDATE settlement_windows SET closedAt=expiresAt WHERE bookId=? AND windowId=? AND closedAt IS NULL',[window.bookId,window.windowId]);
    window.closedAt=window.expiresAt;await auditWindow(db,window,actorId,'SETTLEMENT_WINDOW_EXPIRED');
  }
}
export async function openWindow(db:PoolConnection,access:WindowAccess,now:number,bookId:string,requestId:string,actorId:string,memberId:string):Promise<SettlementWindow> {
  assertWindowAvailable(access,now);await expireWindow(db,access,now,actorId);
  const window:SettlementWindow={bookId,windowId:randomUUID(),requestId,holderUserId:actorId,holderMemberId:memberId,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),closedAt:null,cooldownUntil:new Date(now+60000).toISOString()};
  const sqlTime=(value:string)=>value.slice(0,23).replace('T',' ');
  await db.execute(`INSERT INTO settlement_windows(bookId,windowId,requestId,holderUserId,holderMemberId,createdAt,expiresAt,closedAt,cooldownUntil)
    VALUES(?,?,?,?,?,?,?,NULL,?) ON DUPLICATE KEY UPDATE windowId=VALUES(windowId),requestId=VALUES(requestId),holderUserId=VALUES(holderUserId),holderMemberId=VALUES(holderMemberId),createdAt=VALUES(createdAt),expiresAt=VALUES(expiresAt),closedAt=NULL,cooldownUntil=VALUES(cooldownUntil)`,
    [bookId,window.windowId,requestId,actorId,memberId,sqlTime(window.createdAt),sqlTime(window.expiresAt),sqlTime(window.cooldownUntil)]);
  access.window=window;await auditWindow(db,window,actorId,'SETTLEMENT_WINDOW_OPENED');return window;
}
export async function closeWindow(db:PoolConnection,access:WindowAccess,now:number,actorId:string):Promise<void> {
  const window=access.window;if(!window||window.closedAt)return;
  if(windowState(window,now)!=='ACTIVE'){await expireWindow(db,access,now,actorId);return}
  await db.execute('UPDATE settlement_windows SET closedAt=?,cooldownUntil=? WHERE bookId=? AND windowId=?',
    [new Date(now).toISOString().slice(0,23).replace('T',' '),new Date(now+30000).toISOString().slice(0,23).replace('T',' '),window.bookId,window.windowId]);
  window.closedAt=new Date(now).toISOString();window.cooldownUntil=new Date(now+30000).toISOString();await auditWindow(db,window,actorId,'SETTLEMENT_WINDOW_CLOSED');
}
