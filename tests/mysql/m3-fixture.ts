import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import { createApp } from '../../apps/api/src/app.ts';
import { databaseConfig,createDatabasePool } from '../../apps/api/src/shared/database.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import { tokenHash } from '../../apps/api/src/modules/identity/security.ts';

/** 只向已获准的heji_dev写入虚构夹具；不删除、不打印会话。 */
export async function fixture(t:TestContext,attach?:(server:ReturnType<typeof createServer>,store:MysqlFinanceStore)=>()=>void) {
  const config=databaseConfig();assert.equal(config?.database,'heji_dev');assert.ok(config);
  const prefix=randomUUID();
  class FixtureStore extends MysqlFinanceStore {override consumeLimit(key:string,max:number,seconds:number){return super.consumeLimit(tokenHash(prefix+key),max,seconds)}}
  const pool=createDatabasePool(config),store=new FixtureStore(pool),server=createServer(createApp(store,undefined,store));
  const cleanup=attach?.(server,store);
  server.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{cleanup?.();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end()});
  function client(){return {cookie:'',csrf:'',userId:'',async request(path:string,method='GET',body?:unknown,headers:Record<string,string>={}){
    const response=await fetch(base+'/api/v1'+path,{method,headers:{Cookie:this.cookie,Origin:'http://127.0.0.1:5174','Content-Type':method==='PATCH'?'application/merge-patch+json':'application/json',...(method==='GET'?{}:{'X-CSRF-Token':this.csrf,'Idempotency-Key':randomUUID()}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const cookie of response.headers.getSetCookie())this.cookie=cookie.split(';')[0]!;
    const result=response.status===204?{}:await response.json();if(result.data?.csrfToken)this.csrf=result.data.csrfToken;if(result.data?.user?.id)this.userId=result.data.user.id;
    return {status:response.status,data:result.data,error:result.error,etag:response.headers.get('etag')};
  },async register(label:string){await this.request('/auth/csrf');assert.equal((await this.request('/auth/register','POST',{email:`${prefix}-${label}@example.com`,displayName:'M3虚构'+label,password:'Fictional-M3-Only-2026'})).status,201);return this}}}
  const a=await client().register('A'),b=await client().register('B'),c=await client().register('C'),d=await client().register('D');
  const created=await a.request('/books','POST',{name:'M3虚构验收'});assert.equal(created.status,201);
  const bookId=created.data.id as string,path='/books/'+bookId;
  for(const person of [b,c,d]){const invite=await a.request(path+'/invitations','POST',{});assert.equal((await person.request('/invitations/accept','POST',{token:invite.data.token})).status,200)}
  const members=(await a.request(path+'/members')).data as {id:string;userId:string}[];
  const member=(person:typeof a)=>members.find(m=>m.userId===person.userId)!.id;
  return {pool,store,server,base,a,b,c,d,client,bookId,path,ma:member(a),mb:member(b),mc:member(c),md:member(d)};
}
