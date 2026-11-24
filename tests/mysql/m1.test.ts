import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { createApp } from '../../apps/api/src/app.ts';
import { databaseConfig, createDatabasePool } from '../../apps/api/src/shared/database.ts';
import { MysqlM1Store } from '../../apps/api/src/modules/m1/mysql-store.ts';
import { newToken, tokenHash } from '../../apps/api/src/modules/identity/security.ts';

/** 仅通过显式test:db执行。只创建/修改本次虚构夹具，不清理或删除已有记录。 */
test('M1真实MySQL与独立会话验收',async t=>{
  const config=databaseConfig();
  assert.ok(config&&config.database==='heji_dev','须先在本机配置heji_dev并执行已批准迁移');
  const prefix=randomUUID();
  // 仍使用真实MySQL限流，按本次夹具隔离键，避免自动化注册耗尽本地页面额度。
  class FixtureStore extends MysqlM1Store {
    override async consumeLimit(keyHash: string,maximum: number,seconds: number){
      return super.consumeLimit(tokenHash(prefix+keyHash),maximum,seconds);
    }
  }
  const pool=createDatabasePool(config),store=new FixtureStore(pool);
  const server=createApp(store).listen(0,'127.0.0.1');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end()});
  if(!server.listening)await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}`,origin='http://127.0.0.1:5174',password='Fictional-Only-Password-2026';
  function client(){return {
    cookie:'',csrf:'',userId:'',
    async request(path: string,method='GET',body?: unknown,extra: Record<string,string>={}){
      const response=await fetch(base+'/api/v1'+path,{method,headers:{Cookie:this.cookie,Origin:origin,...(method==='GET'?{}:{'X-CSRF-Token':this.csrf}),'Content-Type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
      // 同名Cookie按响应顺序覆盖：登录响应先续期旧SID，再设置轮换后的SID。
      for(const cookie of response.headers.getSetCookie())this.cookie=cookie.split(';')[0]!;
      const result=response.status===204?{}:await response.json();
      if(result.data?.csrfToken)this.csrf=result.data.csrfToken;
      if(result.data?.user?.id)this.userId=result.data.user.id;
      return {status:response.status,result,headers:response.headers};
    },
    async register(label: string){assert.equal((await this.request('/auth/csrf')).status,200);const response=await this.request('/auth/register','POST',{email:`${prefix}-${label}@example.com`,displayName:`验收${label}`,password});assert.equal(response.status,201);return this},
  }}
  const a=client(),b=client(),c=client();
  let bookId='',firstInvite='',memberB='';
  await t.test('匿名CSRF、注册轮换SID和注销旧会话',async()=>{
    const initial=await a.request('/auth/csrf');assert.equal(initial.status,200);assert.match(initial.headers.get('set-cookie')??'',/HttpOnly/);assert.match(initial.headers.get('set-cookie')??'',/SameSite=Lax/);
    const oldCookie=a.cookie,oldCsrf=a.csrf;
    assert.equal((await a.request('/auth/register','POST',{email:`${prefix}-a@example.com`,displayName:'验收甲',password},{Origin:'https://wrong.example'})).status,403);
    assert.equal((await a.request('/auth/register','POST',{email:`${prefix}-a@example.com`,displayName:'验收甲',password},{'X-CSRF-Token':''})).status,403);
    assert.equal((await a.request('/auth/register','POST',{email:`${prefix}-a@example.com`,displayName:'验收甲',password})).status,201);
    assert.ok(a.cookie!==oldCookie);assert.ok(a.csrf!==oldCsrf);
    const old=client();old.cookie=oldCookie;assert.equal((await old.request('/auth/me')).status,401);
    await b.register('b');await c.register('c');
  });
  await t.test('创建账本和非成员404，禁止客户端指定创建者',async()=>{
    assert.equal((await a.request('/books','POST',{name:'虚构验收账本',createdByUserId:b.userId})).status,422);
    const response=await a.request('/books','POST',{name:'虚构验收账本'});assert.equal(response.status,201);bookId=response.result.data.id;
    assert.equal(response.result.data.createdByUserId,a.userId);
    assert.equal((await b.request('/books/'+bookId)).status,404);
    assert.equal((await b.request('/books/'+bookId+'/members')).status,404);
    assert.equal((await b.request('/books')).result.data.length,0);
  });
  await t.test('匿名预览不消费、原使用者重试成功、其他人被拒',async()=>{
    const response=await a.request(`/books/${bookId}/invitations`,'POST',{});assert.equal(response.status,201);firstInvite=response.result.data.token;
    const anonymous=client();await anonymous.request('/auth/csrf');assert.equal((await anonymous.request('/invitations/preview','POST',{token:firstInvite})).status,200);
    assert.equal((await b.request('/invitations/accept','POST',{token:firstInvite})).status,200);
    await pool.execute('UPDATE invitations SET expiresAt=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY) WHERE id=?',[response.result.data.id]);
    assert.equal((await b.request('/invitations/accept','POST',{token:firstInvite})).status,200);
    assert.equal((await c.request('/invitations/accept','POST',{token:firstInvite})).status,409);
    const members=await a.request(`/books/${bookId}/members`);memberB=members.result.data.find((x:{userId:string})=>x.userId===b.userId).id;
  });
  await t.test('已有成员不消费新邀请，普通成员没有邀请和改名管理权',async()=>{
    assert.equal((await b.request(`/books/${bookId}/invitations`,'POST',{})).status,403);
    assert.equal((await b.request(`/books/${bookId}`,'PATCH',{name:'越权改名'})).status,403);
    const response=await a.request(`/books/${bookId}/invitations`,'POST',{}),token=response.result.data.token;
    assert.equal((await b.request('/invitations/accept','POST',{token})).status,200);
    assert.equal((await c.request('/invitations/accept','POST',{token})).status,200);
    assert.equal((await a.request(`/books/${bookId}/members`)).result.data.length,3);
  });
  await t.test('撤销邀请、到期邀请和跨账本撤销保护',async()=>{
    const response=await a.request(`/books/${bookId}/invitations`,'POST',{}),id=response.result.data.id,token=response.result.data.token;
    const other=await a.request('/books','POST',{name:'虚构隔离账本'});
    assert.equal((await a.request(`/books/${other.result.data.id}/invitations/${id}/revoke`,'POST',{})).status,404);
    assert.equal((await a.request(`/books/${bookId}/invitations/${id}/revoke`,'POST',{})).status,204);
    assert.equal((await b.request('/invitations/preview','POST',{token})).status,410);
    const expired=await a.request(`/books/${bookId}/invitations`,'POST',{});
    await pool.execute('UPDATE invitations SET expiresAt=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY) WHERE id=?',[expired.result.data.id]);
    assert.equal((await b.request('/invitations/preview','POST',{token:expired.result.data.token})).status,410);
  });
  await t.test('两人并发消费同一邀请，只允许一人加入',async()=>{
    const d=await client().register('d'),e=await client().register('e');
    const token=(await a.request(`/books/${bookId}/invitations`,'POST',{})).result.data.token;
    const responses=await Promise.all([d.request('/invitations/accept','POST',{token}),e.request('/invitations/accept','POST',{token})]);
    assert.deepEqual(responses.map(x=>x.status).sort(),[200,409]);
    assert.equal((await a.request(`/books/${bookId}/members`)).result.data.length,4);
  });
  await t.test('退出夹具重新加入复用历史成员身份',async()=>{
    await pool.execute("UPDATE book_members SET status='LEFT',leftAt=UTC_TIMESTAMP(3) WHERE id=?",[memberB]);
    assert.equal((await b.request(`/books/${bookId}`)).status,404);
    const token=(await a.request(`/books/${bookId}/invitations`,'POST',{})).result.data.token;
    assert.equal((await b.request('/invitations/preview','POST',{token})).result.data.rejoining,true);
    assert.equal((await b.request('/invitations/accept','POST',{token})).status,200);
    const member=(await a.request(`/books/${bookId}/members`)).result.data.find((x:{userId:string})=>x.userId===b.userId);assert.equal(member.id,memberB);
  });
  await t.test('空闲及绝对会话过期均被拒，注销后旧SID失效',async()=>{
    const sessionHash=tokenHash(c.cookie.split('=')[1]!);
    await pool.execute('UPDATE sessions SET absoluteExpiresAt=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE idHash=UNHEX(?)',[sessionHash]);
    assert.equal((await c.request('/auth/me')).status,401);
    const idle=await client().register('idle');
    await pool.execute('UPDATE sessions SET expiresAt=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE idHash=UNHEX(?)',[tokenHash(idle.cookie.split('=')[1]!)]);
    assert.equal((await idle.request('/auth/me')).status,401);
    const old=client();old.cookie=a.cookie;assert.equal((await a.request('/auth/logout','POST',{})).status,204);assert.equal((await old.request('/auth/me')).status,401);
    await a.request('/auth/csrf');assert.equal((await a.request('/auth/login','POST',{email:`${prefix}-a@example.com`,password})).status,200);
    assert.equal((await a.request('/auth/me')).status,200);
  });
  await t.test('限流计数持久化且过窗口可恢复',async()=>{
    const key=tokenHash(newToken());assert.ok(await store.consumeLimit(key,2,900));assert.ok(await store.consumeLimit(key,2,900));
    assert.equal(await new FixtureStore(pool).consumeLimit(key,2,900),false);
    await pool.execute('UPDATE rate_limits SET windowStartedAt=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 16 MINUTE) WHERE keyHash=UNHEX(?)',[tokenHash(prefix+key)]);assert.ok(await store.consumeLimit(key,2,900));
  });
  await t.test('30位有效成员上限在同一账本锁下检查',async()=>{
    const [counts]=await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM book_members WHERE bookId=? AND status='ACTIVE'",[bookId]);
    for(let i=Number(counts[0]!.total);i<30;i++){
      const userId=randomUUID();await pool.execute('INSERT INTO users(id,email,displayName,passwordHash,createdAt) VALUES(?,?,?,?,UTC_TIMESTAMP(3))',[userId,`${prefix}-filler${i}@example.com`,'虚构填充成员','not-a-login-hash']);
      await pool.execute("INSERT INTO book_members(id,bookId,userId,status,joinedAt) VALUES(?,?,?,'ACTIVE',UTC_TIMESTAMP(3))",[randomUUID(),bookId,userId]);
    }
    const last=await client().register('last'),token=(await a.request(`/books/${bookId}/invitations`,'POST',{})).result.data.token;
    assert.equal((await last.request('/invitations/accept','POST',{token})).status,409);
    assert.equal((await last.request(`/books/${bookId}`)).status,404);
  });
});
