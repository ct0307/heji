import type { Server,IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket,WebSocketServer } from 'ws';
import { readSid,tokenHash,uuid } from '../identity/security.ts';
import type { MysqlM1Store } from '../m1/mysql-store.ts';
import type { M1Options } from '../m1/routes.ts';
import { ApiFault } from '../../shared/errors.ts';
import type { BookChangedEvent } from '../../../../../packages/contracts/src/index.ts';
import { createHeartbeat } from './heartbeat.ts';

interface Client {ws:WebSocket;hash:string;userId:string;books:Set<string>;window:number;count:number;queued:number;heartbeat?:ReturnType<typeof createHeartbeat>}
/** 单进程、尽力失效通知；授权查询失败时不发送业务内容，HTTP始终是权威来源。 */
export function attachRealtime(server:Server,store:MysqlM1Store,options:M1Options) {
  const wss=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false,clientTracking:false}),clients=new Set<Client>();
  let stopped=false,pendingUpgrades=0;
  function send(client:Client,value:unknown){if(client.ws.readyState!==WebSocket.OPEN)return;if(client.ws.bufferedAmount>65536){client.ws.close(1013,'请重新连接同步');return}client.ws.send(JSON.stringify(value))}
  async function validSession(client:Client){const session=await store.findSession(client.hash,false);if(!session?.user||session.user.id!==client.userId){client.ws.close(4401,'请重新登录');return false}return true}
  async function authorized(client:Client,bookId:string){
    if(!await validSession(client))return false;
    try{await store.getBook(client.userId,bookId);return true}
    catch(error){if(error instanceof ApiFault&&error.status===404)return false;throw error}
  }
  async function checkBooks(client:Client){
    if(!await validSession(client))return;
    for(const bookId of [...client.books])if(!await authorized(client,bookId)){client.books.delete(bookId);send(client,{type:'SUBSCRIPTION_REVOKED',bookId})}
  }
  async function broadcast(events:BookChangedEvent[]){
    for(const event of events){
      await Promise.allSettled([...clients].filter(client=>client.books.has(event.bookId)).map(async client=>{
        try{
          if(!await authorized(client,event.bookId)){client.books.delete(event.bookId);if(client.ws.readyState===WebSocket.OPEN)send(client,{type:'SUBSCRIPTION_REVOKED',bookId:event.bookId});return}
          send(client,event);
        }catch{client.ws.close(1013,'稍后重新同步')}
      }));
    }
  }
  const unsubscribe=store.changes.onChange(broadcast),unsubscribeSessions=store.changes.onSessionClosed(hash=>{for(const client of clients)if(client.hash===hash)client.ws.close(4401,'请重新登录')});
  async function message(client:Client,raw:WebSocket.RawData,binary:boolean){
    if(client.ws.readyState!==WebSocket.OPEN)return;
    if(binary){send(client,{type:'ERROR',code:'INVALID_MESSAGE'});return}
    let value:{type:string;bookId:string};
    try{
      const parsed:unknown=JSON.parse(String(raw));
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).sort().join(',')!=='bookId,type')throw new Error();
      const input=parsed as Record<string,unknown>;
      if(!['SUBSCRIBE','UNSUBSCRIBE'].includes(String(input.type)))throw new Error();
      value={type:String(input.type),bookId:uuid(input.bookId)};
    }catch{send(client,{type:'ERROR',code:'INVALID_MESSAGE'});return}
    if(!await validSession(client))return;
    if(value.type==='UNSUBSCRIBE'){client.books.delete(value.bookId);send(client,{type:'UNSUBSCRIBED',bookId:value.bookId});return}
    if(!await authorized(client,value.bookId)){send(client,{type:'ERROR',code:'BOOK_FORBIDDEN',bookId:value.bookId});return}
    if(!client.books.has(value.bookId)&&client.books.size>=10){send(client,{type:'ERROR',code:'SUBSCRIPTION_LIMIT'});return}
    client.books.add(value.bookId);send(client,{type:'SUBSCRIBED',bookId:value.bookId});
  }
  function connected(ws:WebSocket,hash:string,userId:string){
    const client:Client={ws,hash,userId,books:new Set(),window:Date.now(),count:0,queued:0};clients.add(client);
    let queue=Promise.resolve();
    ws.on('message',(raw,binary)=>{
      if(Date.now()-client.window>=10000){client.window=Date.now();client.count=0}
      if(++client.count>30||client.queued>=30){ws.close(1008,'消息过于频繁');return}
      client.queued++;
      queue=queue.then(()=>message(client,raw,binary)).catch(()=>{ws.close(1013,'稍后重新同步')}).finally(()=>{client.queued--});
    });
    client.heartbeat=createHeartbeat({ping(){if(ws.readyState===WebSocket.OPEN)ws.ping()},timeout(){ws.terminate()},check(){void checkBooks(client).catch(()=>ws.close(1013,'稍后重新同步'))}});
    ws.on('pong',()=>client.heartbeat?.pong());
    ws.on('error',()=>{});
    ws.once('close',()=>{client.heartbeat?.stop();client.books.clear();clients.delete(client)});
  }
  function reject(socket:Duplex,status:number){socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)}
  async function upgrade(req:IncomingMessage,socket:Duplex,head:Buffer){
    socket.on('error',()=>{});
    const url=new URL(req.url??'/',options.origin);
    if(url.pathname!=='/ws'){reject(socket,404);return}
    if(url.search){reject(socket,400);return}
    if(req.headers.origin!==options.origin){reject(socket,403);return}
    const sid=readSid(req.headers.cookie,options.secureCookies?'__Host-heji_sid':'heji_sid');
    if(!sid){reject(socket,401);return}
    if(stopped||clients.size+pendingUpgrades>=256){reject(socket,503);return}
    pendingUpgrades++;
    try{
      const hash=tokenHash(sid),session=await store.findSession(hash,false);
      if(!session?.user){reject(socket,401);return}
      if(stopped||[...clients].filter(client=>client.hash===hash).length>=8){reject(socket,429);return}
      const userId=session.user.id;
      wss.handleUpgrade(req,socket,head,ws=>connected(ws,hash,userId));
    }catch{reject(socket,503)}finally{pendingUpgrades--}
  }
  const onUpgrade=(req:IncomingMessage,socket:Duplex,head:Buffer)=>{void upgrade(req,socket,head)};
  server.on('upgrade',onUpgrade);
  function close(){if(stopped)return;stopped=true;unsubscribe();unsubscribeSessions();server.off('upgrade',onUpgrade);for(const client of clients){client.heartbeat?.stop();client.ws.terminate()}clients.clear();wss.close()}
  server.once('close',close);return close;
}
