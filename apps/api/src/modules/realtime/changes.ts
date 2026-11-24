import type { PoolConnection } from 'mysql2/promise';
import type { BookChangedEvent } from '../../../../../packages/contracts/src/index.ts';

/** 事务中只缓存元数据；释放数据库连接后才发布，避免广播鉴权与写事务争抢连接造成死锁。 */
export class CommittedChanges {
  private pending=new WeakMap<PoolConnection,BookChangedEvent[]>();
  private listeners=new Set<(events:BookChangedEvent[])=>Promise<void>>();
  private sessions=new Set<(hash:string)=>void>();
  begin(db:PoolConnection){this.pending.set(db,[])}
  record(db:PoolConnection,event:BookChangedEvent){this.pending.get(db)?.push(event)}
  take(db:PoolConnection){const events=this.pending.get(db)??[];this.pending.delete(db);return events}
  onChange(listener:(events:BookChangedEvent[])=>Promise<void>){this.listeners.add(listener);return ()=>{this.listeners.delete(listener)}}
  onSessionClosed(listener:(hash:string)=>void){this.sessions.add(listener);return ()=>{this.sessions.delete(listener)}}
  sessionClosed(hash:string){for(const listener of this.sessions)listener(hash)}
  async publish(events:BookChangedEvent[]){if(events.length)await Promise.allSettled([...this.listeners].map(async listener=>{await listener(events)}))}
}
