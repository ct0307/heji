import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { createApp } from '../../apps/api/src/app.ts';
import { databaseConfig,createDatabasePool } from '../../apps/api/src/shared/database.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import { tokenHash } from '../../apps/api/src/modules/identity/security.ts';

/** 仅在明确批准的heji_dev中创建本轮虚构数据；不删除或清空。 */
test('M2真实MySQL财务闭环、权限和并发验收',async t=>{
  const config=databaseConfig();assert.ok(config?.database==='heji_dev');
  const prefix=randomUUID();
  class FixtureStore extends MysqlFinanceStore {override consumeLimit(key:string,max:number,seconds:number){return super.consumeLimit(tokenHash(prefix+key),max,seconds)}}
  const pool=createDatabasePool(config),store=new FixtureStore(pool),server=createApp(store,undefined,store).listen(0,'127.0.0.1');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end()});
  if(!server.listening)await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/api/v1`;
  function client(){return {cookie:'',csrf:'',userId:'',async request(path:string,method='GET',body?:unknown,extra:Record<string,string>={}){
    const response=await fetch(base+path,{method,headers:{Cookie:this.cookie,Origin:'http://127.0.0.1:5174','Content-Type':method==='PATCH'?'application/merge-patch+json':'application/json',...(method==='GET'?{}:{'X-CSRF-Token':this.csrf,'Idempotency-Key':randomUUID()}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const cookie of response.headers.getSetCookie())this.cookie=cookie.split(';')[0]!;
    const result=response.status===204?{}:await response.json();if(result.data?.csrfToken)this.csrf=result.data.csrfToken;if(result.data?.user?.id)this.userId=result.data.user.id;
    return {status:response.status,data:result.data,error:result.error,etag:response.headers.get('etag')};
  },async register(label:string){await this.request('/auth/csrf');const response=await this.request('/auth/register','POST',{email:`${prefix}-${tokenHash(label).slice(0,8)}@example.com`,displayName:`财务验收${label}`,password:'Fictional-Only-Password-2026'});assert.equal(response.status,201);return this}}}
  const a=await client().register('甲'),b=await client().register('乙'),c=await client().register('丙');
  async function group(three=false){const created=await a.request('/books','POST',{name:'M2虚构验收'});assert.equal(created.status,201);const id=created.data.id;for(const person of three?[b,c]:[b]){const invite=await a.request(`/books/${id}/invitations`,'POST',{});assert.equal((await person.request('/invitations/accept','POST',{token:invite.data.token})).status,200)}const members=(await a.request(`/books/${id}/members`)).data;return {id,path:`/books/${id}`,ma:members.find((x:any)=>x.userId===a.userId).id,mb:members.find((x:any)=>x.userId===b.userId).id,mc:members.find((x:any)=>x.userId===c.userId)?.id}}
  type Group=Awaited<ReturnType<typeof group>>;
  const expense=(g:Group,amountFen='10000')=>({paidByMemberId:g.ma,amountFen,splitMode:'EQUAL',participantMemberIds:g.mc?[g.ma,g.mb,g.mc]:[g.ma,g.mb],category:'FOOD',occurredOn:'2026-11-17',note:'本轮虚构晚餐'});
  async function request(g:Group,amountFen='5000'){const response=await b.request(g.path+'/transfer-requests','POST',{toMemberId:g.ma,amountFen,occurredOn:'2026-11-17',note:'虚构线下付款登记'});assert.equal(response.status,201);return response.data}
  async function confirm(g:Group,id:string){const preview=await a.request(g.path+`/transfer-requests/${id}/preview`);assert.equal(preview.status,200);const response=await a.request(g.path+`/transfer-requests/${id}/confirm`,'POST',{expectedRequestRevision:preview.data.expectedRequestRevision,expectedFinancialVersion:preview.data.expectedFinancialVersion});assert.equal(response.status,200);return response.data}
  const balance=(snap:any,id:string)=>snap.balances.find((x:any)=>x.memberId===id).balanceFen;
  await t.test('T-03：100.01元三人均分及1分零份额，余额守恒',async()=>{
    const g=await group(true),response=await a.request(g.path+'/expenses','POST',expense(g,'10001'));assert.equal(response.status,201);
    assert.deepEqual(response.data.shares.map((x:any)=>x.amountFen).sort(),['3333','3334','3334']);
    const tiny=await a.request(g.path+'/expenses','POST',expense(g,'1'));assert.equal(tiny.status,201);assert.equal(tiny.data.shares.filter((x:any)=>x.amountFen==='0').length,2);
    const snap=(await a.request(g.path+'/balances')).data;assert.equal(snap.expenseTotalFen,'10002');assert.equal(snap.balances.reduce((sum:bigint,x:any)=>sum+BigInt(x.balanceFen),0n),0n);
  });
  await t.test('T-04/05：指定分摊、代录、字段白名单和回滚，付款人无录入者编辑权',async()=>{
    const g=await group(),payload={paidByMemberId:g.mb,amountFen:'12000',splitMode:'EXACT',shares:[{memberId:g.ma,amountFen:'4000'},{memberId:g.mb,amountFen:'8000'}],category:'HOUSING',occurredOn:'2026-11-17',note:''};
    const bad=await a.request(g.path+'/expenses','POST',{...payload,shares:[{memberId:g.ma,amountFen:'1'}]});assert.equal(bad.status,422);
    assert.equal((await a.request(g.path+'/expenses')).data.items.length,0);
    const created=await a.request(g.path+'/expenses','POST',payload);assert.equal(created.status,201);assert.equal(created.data.createdByMemberId,g.ma);assert.equal(created.data.paidByMemberId,g.mb);
    assert.equal((await b.request(g.path+'/expenses/'+created.data.id,'PATCH',{note:'越权修改'})).status,403);
    assert.equal((await c.request(g.path+'/expenses/'+created.data.id,'PATCH',{note:'跨账本'})).status,404);
    assert.equal((await a.request(g.path+'/expenses','POST',{...payload,createdByMemberId:g.mb})).status,422);
  });
  await t.test('T-06：ETag条件更新、并发修改、历史版本、备注不影响财务版本',async()=>{
    const g=await group(),created=await a.request(g.path+'/expenses','POST',expense(g)),path=g.path+'/expenses/'+created.data.id;
    const before=(await a.request(g.path+'/balances')).data.financialVersion;
    assert.equal((await a.request(path,'PATCH',{note:'无条件头'})).status,428);
    assert.equal((await a.request(path,'PATCH',{note:'错误条件'},{'If-Match':'unquoted'})).status,400);
    assert.equal((await a.request(path,'PATCH',{note:'通配条件'},{'If-Match':'*'})).status,400);
    assert.equal((await a.request(path,'PATCH',{note:'弱标签'},{'If-Match':'W/'+created.etag})).status,412);
    const noted=await a.request(path,'PATCH',{note:'核对备注'},{'If-Match':'"other", '+created.etag});assert.equal(noted.status,200);
    assert.equal((await a.request(g.path+'/balances')).data.financialVersion,before);
    const changes=await Promise.all(['12000','14000'].map(amountFen=>a.request(path,'PATCH',{amountFen},{'If-Match':noted.etag!})));assert.deepEqual(changes.map(x=>x.status).sort(),[200,412]);
    const history=(await a.request(path+'/history')).data;assert.equal(history.length,3);assert.equal(history.filter((x:any)=>x.amountFen==='10000').length,2);
  });
  await t.test('T-07：提交成功后同键重试返回同一记录，同键不同参数409',async()=>{
    const g=await group(),key=randomUUID(),body=expense(g),headers={'Idempotency-Key':key};
    const first=await a.request(g.path+'/expenses','POST',body,headers),again=await a.request(g.path+'/expenses','POST',body,headers);assert.equal(first.status,201);assert.equal(again.status,201);assert.equal(again.data.id,first.data.id);
    const conflict=await a.request(g.path+'/expenses','POST',{...body,note:'另一意图'},headers);assert.equal(conflict.status,409);assert.equal(conflict.error.code,'IDEMPOTENCY_KEY_REUSED');assert.equal((await a.request(g.path+'/expenses')).data.items.length,1);
    assert.equal((await a.request(g.path+'/expenses','POST',body,{'Idempotency-Key':''})).status,400);
  });
  await t.test('T-08：待确认不影响余额；100次并发确认只有一条入账',async()=>{
    const g=await group();await a.request(g.path+'/expenses','POST',expense(g));const item=await request(g);
    assert.equal(balance((await a.request(g.path+'/balances')).data,g.mb),'-5000');
    const preview=(await a.request(g.path+`/transfer-requests/${item.id}/preview`)).data;
    assert.equal(balance({balances:preview.afterBalances},g.mb),'0');
    const body={expectedRequestRevision:preview.expectedRequestRevision,expectedFinancialVersion:preview.expectedFinancialVersion};
    const results=await Promise.all(Array.from({length:100},()=>a.request(g.path+`/transfer-requests/${item.id}/confirm`,'POST',body)));
    const outcomes=results.reduce((counts:Record<string,number>,row)=>{const key=row.status+':'+(row.error?.code??'OK');counts[key]=(counts[key]??0)+1;return counts},{});
    assert.ok(results.every(x=>x.status===200),JSON.stringify(outcomes));assert.equal(new Set(results.map(x=>x.data.transfer.id)).size,1);
    assert.equal((await a.request(g.path+'/transfers')).data.length,1);assert.equal((await a.request(g.path+'/balances')).data.isSettled,true);
  });
  await t.test('T-09：确认与取消竞争只允许一个终态；超额登记允许但有反向余额说明',async()=>{
    const g=await group(),item=await request(g,'1000'),preview=(await a.request(g.path+`/transfer-requests/${item.id}/preview`)).data;
    assert.ok(preview.warnings.length>0);
    const results=await Promise.all([a.request(g.path+`/transfer-requests/${item.id}/confirm`,'POST',{expectedRequestRevision:preview.expectedRequestRevision,expectedFinancialVersion:preview.expectedFinancialVersion}),b.request(g.path+`/transfer-requests/${item.id}/cancel`,'POST',{expectedRequestRevision:item.revision})]);
    assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.ok((await a.request(g.path+'/transfers')).data.length<=1);
  });
  await t.test('T-10：预览后余额变化返回409且请求仍待确认，刷新预览可继续',async()=>{
    const g=await group();await a.request(g.path+'/expenses','POST',expense(g));const item=await request(g),preview=(await a.request(g.path+`/transfer-requests/${item.id}/preview`)).data;
    await a.request(g.path+'/expenses','POST',expense(g,'2000'));
    const stale=await a.request(g.path+`/transfer-requests/${item.id}/confirm`,'POST',{expectedRequestRevision:preview.expectedRequestRevision,expectedFinancialVersion:preview.expectedFinancialVersion});assert.equal(stale.status,409);assert.equal(stale.error.code,'PREVIEW_STALE');
    assert.equal((await a.request(g.path+'/transfer-requests')).data.find((x:any)=>x.id===item.id).status,'PENDING');await confirm(g,item.id);
  });
  await t.test('T-11：结清后修改旧支出产生新增10元应付，原50元转账完整保留',async()=>{
    const g=await group(),created=await a.request(g.path+'/expenses','POST',expense(g)),item=await request(g);await confirm(g,item.id);
    assert.equal((await a.request(g.path+'/expenses/'+created.data.id,'PATCH',{amountFen:'12000'},{'If-Match':created.etag!})).status,200);
    const snap=(await a.request(g.path+'/balances')).data;assert.equal(balance(snap,g.mb),'-1000');assert.equal(balance(snap,g.ma),'1000');assert.equal((await a.request(g.path+'/transfers')).data[0].amountFen,'5000');
  });
  await t.test('T-12：双方撤销错误登记，只能一个待确认和一次成功冲正，原记录保留',async()=>{
    const g=await group(),normal=await request(g,'1000'),confirmed=await confirm(g,normal.id),path=g.path+`/transfers/${confirmed.transfer.id}/reversals`;
    const reverse=await a.request(path,'POST',{occurredOn:'2026-11-17',note:'撤销虚构错误登记'});assert.equal(reverse.status,201);assert.equal(reverse.data.amountFen,'1000');assert.equal(reverse.data.fromMemberId,g.ma);assert.equal(reverse.data.toMemberId,g.mb);
    assert.equal((await b.request(path,'POST',{occurredOn:'2026-11-17',note:''})).status,409);
    const preview=(await b.request(g.path+`/transfer-requests/${reverse.data.id}/preview`)).data;
    const body={expectedRequestRevision:preview.expectedRequestRevision,expectedFinancialVersion:preview.expectedFinancialVersion};
    const results=await Promise.all([b.request(g.path+`/transfer-requests/${reverse.data.id}/confirm`,'POST',body),b.request(g.path+`/transfer-requests/${reverse.data.id}/confirm`,'POST',body)]);assert.ok(results.every(x=>x.status===200));
    assert.equal((await a.request(g.path+'/transfers')).data.length,2);assert.equal((await a.request(g.path+'/balances')).data.isSettled,true);
    const denied=await a.request(path,'POST',{occurredOn:'2026-11-17',note:''});assert.equal(denied.status,409);assert.equal(denied.error.code,'TRANSFER_ALREADY_REVERSED');
    assert.equal((await b.request(g.path+`/transfers/${results[0]!.data.transfer.id}/reversals`,'POST',{occurredOn:'2026-11-17',note:''})).status,409);
  });
  await t.test('结清后的冲正预览要求核对误登记，不提示再次线下付款',async()=>{
    const g=await group();await a.request(g.path+'/expenses','POST',expense(g));
    const confirmed=await confirm(g,(await request(g)).id);
    const reverse=await a.request(g.path+`/transfers/${confirmed.transfer.id}/reversals`,'POST',{occurredOn:'2026-11-17',note:'虚构误登记核对'});assert.equal(reverse.status,201);
    const preview=await b.request(g.path+`/transfer-requests/${reverse.data.id}/preview`);assert.equal(preview.status,200);
    assert.ok(preview.data.warnings.some((message:string)=>message.includes('原登记确实有误')));
    assert.ok(preview.data.warnings.every((message:string)=>!message.includes('线下付款')));
    assert.equal(balance({balances:preview.data.afterBalances},g.mb),'-5000');
  });
  await t.test('T-13：退出条件、历史冻结、重新加入复用身份并解冻',async()=>{
    const g=await group(),created=await a.request(g.path+'/expenses','POST',expense(g)),path=g.path+'/expenses/'+created.data.id;
    assert.equal((await b.request(g.path+'/members/me/leave','POST',{})).status,409);
    await confirm(g,(await request(g)).id);assert.equal((await b.request(g.path+'/members/me/leave','POST',{})).status,200);assert.equal((await b.request(path)).status,404);
    assert.equal((await a.request(path,'PATCH',{amountFen:'12000'},{'If-Match':created.etag!})).status,409);
    const note=await a.request(path,'PATCH',{note:'退出后只补充备注'},{'If-Match':created.etag!});assert.equal(note.status,200);
    assert.equal((await a.request(path+'/void','POST',{note:'不允许绕过冻结'},{'If-Match':note.etag!})).status,409);
    const invite=await a.request(g.path+'/invitations','POST',{});assert.equal((await b.request('/invitations/accept','POST',{token:invite.data.token})).status,200);
    assert.equal((await a.request(g.path+'/members')).data.find((x:any)=>x.userId===b.userId).id,g.mb);
    assert.equal((await a.request(path,'PATCH',{amountFen:'12000'},{'If-Match':note.etag!})).status,200);
  });
  await t.test('T-14：消费统计排除转账与冲正，作废只留历史，归档恢复受状态保护',async()=>{
    const g=await group(),created=await a.request(g.path+'/expenses','POST',expense(g));await confirm(g,(await request(g)).id);
    assert.equal((await a.request(g.path+'/reports')).data.expenseTotalFen,'10000');
    assert.equal((await a.request(g.path+'/archive','POST',{})).status,200);
    assert.equal((await a.request(g.path+'/expenses','POST',expense(g))).status,409);assert.equal((await a.request(g.path+'/invitations','POST',{})).status,409);
    assert.equal((await b.request(g.path+'/restore','POST',{})).status,403);assert.equal((await a.request(g.path+'/restore','POST',{})).status,200);
    const voided=await a.request(g.path+'/expenses/'+created.data.id+'/void','POST',{note:'虚构作废理由'},{'If-Match':created.etag!});assert.equal(voided.status,200);assert.equal(voided.data.isVoided,true);
    assert.equal((await a.request(g.path+'/reports')).data.expenseTotalFen,'0');assert.equal((await a.request(g.path+'/transfers')).data.length,1);assert.equal((await a.request(g.path+'/expenses/'+created.data.id+'/history')).data.length,2);
  });
  await t.test('分页游标保留完整排序元组与筛选归属，复合外键拒绝跨账本成员',async()=>{
    const g=await group(),other=await group();for(let i=0;i<3;i++)await a.request(g.path+'/expenses','POST',expense(g,String(100+i)));
    const first=await a.request(g.path+'/expenses?limit=2'),second=await a.request(g.path+'/expenses?limit=2&cursor='+encodeURIComponent(first.data.nextCursor));assert.equal(first.data.items.length,2);assert.equal(second.data.items.length,1);assert.equal(new Set([...first.data.items,...second.data.items].map(x=>x.id)).size,3);
    assert.ok([400,422].includes((await a.request(other.path+'/expenses?cursor='+encodeURIComponent(first.data.nextCursor))).status));
    const row=first.data.items[0];let foreignKeyRejected=false;
    try{await pool.execute('INSERT INTO expense_shares(bookId,expenseId,revision,memberId,amountFen) VALUES(?,?,?,?,?)',[g.id,row.id,row.revision,other.mb,'0'])}catch(error){foreignKeyRejected=(error as {code:string}).code==='ER_NO_REFERENCED_ROW_2'}
    assert.equal(foreignKeyRejected,true);
    const [counts]=await pool.execute<RowDataPacket[]>('SELECT COUNT(*) total FROM expenses WHERE bookId=? AND currentRevision IS NULL',[g.id]);assert.equal(Number(counts[0]!.total),0);
  });
});
