import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { fixture } from './m3-fixture.ts';
import { attachRealtime } from '../../apps/api/src/modules/realtime/server.ts';
import { tokenHash,readSid } from '../../apps/api/src/modules/identity/security.ts';

function receive(ws:WebSocket,predicate:(value:any)=>boolean=()=>true):Promise<any>{return new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{cleanup();reject(new Error('等待通知超时'))},2500);
  const handler=(raw:WebSocket.RawData)=>{const value=JSON.parse(String(raw));if(predicate(value)){cleanup();resolve(value)}};
  function cleanup(){clearTimeout(timeout);ws.off('message',handler)}ws.on('message',handler);
})}
function closed(ws:WebSocket){return new Promise<number>(resolve=>ws.once('close',code=>resolve(code)))}
test('M3真实WebSocket：握手、账本授权、提交后通知与会话撤销',async t=>{
  const f=await fixture(t,(server,store)=>attachRealtime(server,store,{origin:'http://127.0.0.1:5174',secureCookies:false}));
  const {a,b,c,d,path,bookId,ma,mb,mc,md,base}=f;
  async function connect(cookie:string,origin='http://127.0.0.1:5174',suffix='/ws'):Promise<WebSocket|number>{return new Promise((resolve,reject)=>{
    const ws=new WebSocket(base.replace('http:','ws:')+suffix,{headers:{Cookie:cookie,Origin:origin}});
    ws.once('open',()=>resolve(ws));ws.once('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode!)});ws.on('error',reject);
    t.after(()=>ws.terminate());
  })}
  const asSocket=(value:WebSocket|number)=>{assert.ok(value instanceof WebSocket);return value};
  await t.test('升级前拒绝错误Origin403、匿名401及URL查询参数400',async()=>{
    assert.equal(await connect(a.cookie,'http://foreign.invalid'),403);assert.equal(await connect(''),401);
    assert.equal(await connect(a.cookie,'http://127.0.0.1:5174','/ws?sid=forbidden'),400);
  });
  const wa=asSocket(await connect(a.cookie)),wb=asSocket(await connect(b.cookie)),wc=asSocket(await connect(c.cookie));
  async function subscribe(ws:WebSocket,id=bookId){const pending=receive(ws);ws.send(JSON.stringify({type:'SUBSCRIBE',bookId:id}));return pending}
  await t.test('订阅只接受合法账本，非成员不可加入任意房间',async()=>{
    assert.equal((await subscribe(wa)).type,'SUBSCRIBED');assert.equal((await subscribe(wb)).type,'SUBSCRIBED');assert.equal((await subscribe(wc)).type,'SUBSCRIBED');
    const outsider=await f.client().register('outsider'),wo=asSocket(await connect(outsider.cookie));
    assert.equal((await subscribe(wo)).code,'BOOK_FORBIDDEN');
    const invalid=receive(wo);wo.send(JSON.stringify({type:'SUBSCRIBE',room:bookId}));assert.equal((await invalid).code,'INVALID_MESSAGE');
  });
  let created:any,version:string;
  await t.test('成功提交才发最小元数据，备注同财务版本也通知且幂等重放不重复通知',async()=>{
    const key=randomUUID(),body={paidByMemberId:ma,amountFen:'1000',splitMode:'EQUAL',participantMemberIds:[ma,mb],category:'FOOD',occurredOn:'2026-11-17',note:'不得出现在通知的私密备注'};
    const pending=receive(wb,x=>x.type==='BOOK_CHANGED');created=await a.request(path+'/expenses','POST',body,{'Idempotency-Key':key});assert.equal(created.status,201);
    const event=await pending;assert.equal(event.bookId,bookId);assert.equal(event.entityId,created.data.id);assert.equal(event.entityType,'EXPENSE');assert.equal(event.revision,'1');assert.ok(event.eventId);version=event.financialVersion;
    assert.deepEqual(Object.keys(event).sort(),['type','eventId','bookId','entityType','entityId','financialVersion','revision'].sort());assert.ok(!JSON.stringify(event).includes(body.note));
    const seen:any[]=[];const listener=(raw:WebSocket.RawData)=>seen.push(JSON.parse(String(raw)));wb.on('message',listener);
    assert.equal((await a.request(path+'/expenses','POST',body,{'Idempotency-Key':key})).status,201);
    const next=receive(wb,x=>x.type==='BOOK_CHANGED');assert.equal((await a.request(path+'/expenses/'+created.data.id,'PATCH',{note:'只改备注'},{'If-Match':created.etag!})).status,200);
    const changed=await next;assert.equal(changed.financialVersion,version);assert.equal(changed.revision,'2');assert.notEqual(changed.eventId,event.eventId);
    assert.equal(seen.filter(x=>x.type==='BOOK_CHANGED').length,1);wb.off('message',listener);
  });
  await t.test('事务已缓存审计事件后回滚：财务与成员事务均不发布且不保留审计',async()=>{
    const events:unknown[]=[];const remove=f.store.changes.onChange(async batch=>{events.push(...batch)});
    const ids=[randomUUID(),randomUUID()];const failure=new Error('模拟审计后事务失败');
    try{for(const [index,run] of [f.store.transaction.bind(f.store),f.store.financeTransaction.bind(f.store)].entries()){
      await assert.rejects(run(async db=>{await f.store.audit(db,bookId,a.userId,'BOOK_RENAMED',ids[index]!);throw failure}),error=>error===failure);
    }}finally{remove()}
    assert.equal(events.length,0);
    const [rows]=await f.pool.execute('SELECT id FROM audit_events WHERE entityId IN (?,?)',ids);assert.deepEqual(rows,[]);
  });
  await t.test('其他账本无串房，失败请求不发通知，退出立即撤销订阅',async()=>{
    const other=await a.request('/books','POST',{name:'M3其他账本'}),otherId=other.data.id;
    const wo=asSocket(await connect(a.cookie));await subscribe(wo,otherId);
    const seen:any[]=[];wo.on('message',raw=>seen.push(JSON.parse(String(raw))));
    assert.equal((await a.request(path+'/expenses','POST',{invalid:true})).status,422);
    const revoked=receive(wc,x=>x.type==='SUBSCRIPTION_REVOKED');assert.equal((await c.request(path+'/members/me/leave','POST',{})).status,200);
    assert.equal((await revoked).bookId,bookId);assert.equal((await subscribe(wc)).code,'BOOK_FORBIDDEN');assert.equal(seen.length,0);
    assert.equal((await a.request(path+'/members/'+mc+'/remove','POST',{})).status,409);
  });
  await t.test('移除有效零余额成员立即撤销其订阅',async()=>{
    const ws=asSocket(await connect(d.cookie));await subscribe(ws);
    const revoked=receive(ws,value=>value.type==='SUBSCRIPTION_REVOKED');assert.equal((await a.request(path+'/members/'+md+'/remove','POST',{})).status,200);
    assert.equal((await revoked).bookId,bookId);assert.equal((await subscribe(ws)).code,'BOOK_FORBIDDEN');
    const invite=await a.request(path+'/invitations','POST',{});assert.equal((await d.request('/invitations/accept','POST',{token:invite.data.token})).status,200);
  });
  await t.test('注销立即关闭同会话连接，旧会话握手被拒',async()=>{
    const old=a.cookie,done=closed(wa);assert.equal((await a.request('/auth/logout','POST',{})).status,204);assert.equal(await done,4401);assert.equal(await connect(old),401);
  });
  await t.test('超过4KiB的消息关闭连接',async()=>{
    const ws=asSocket(await connect(b.cookie)),done=closed(ws);ws.send('x'.repeat(4097));assert.equal(await done,1009);
  });
  await t.test('每10秒超过30条消息关闭，避免无限排队鉴权',async()=>{
    const ws=asSocket(await connect(b.cookie)),done=closed(ws);for(let i=0;i<31;i++)ws.send(JSON.stringify({type:'UNSUBSCRIBE',bookId}));assert.equal(await done,1008);
  });
  await t.test('WS鉴权不续期，到期会话出站拒绝并关闭',async()=>{
    const sid=readSid(b.cookie,'heji_sid');assert.ok(sid);
    const [before]=await f.pool.execute<any[]>('SELECT expiresAt FROM sessions WHERE idHash=UNHEX(?)',[tokenHash(sid)]);
    const ws=asSocket(await connect(b.cookie));await subscribe(ws);
    const [after]=await f.pool.execute<any[]>('SELECT expiresAt FROM sessions WHERE idHash=UNHEX(?)',[tokenHash(sid)]);assert.equal(String(before[0].expiresAt),String(after[0].expiresAt));
    await f.pool.execute('UPDATE sessions SET expiresAt=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE idHash=UNHEX(?)',[tokenHash(sid)]);
    const done=closed(ws);assert.equal((await d.request(path+'/expenses','POST',{paidByMemberId:md,amountFen:'1',splitMode:'EQUAL',participantMemberIds:[md],category:'OTHER',occurredOn:'2026-11-17',note:'到期隔离事件'})).status,201);assert.equal(await done,4401);
  });
});
