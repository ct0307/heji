import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './m3-fixture.ts';
import { periodReport } from '../../apps/api/src/modules/finance/mysql-reports.ts';
import { writeFile } from 'node:fs/promises';

test('M3期间统计：当前有效版本、并列名次、历史成员和消费口径',async t=>{
  const {a,b,c,path,ma,mb,mc,md,pool,store,bookId}=await fixture(t);
  const input=(amountFen:string,date:string,category='FOOD')=>({paidByMemberId:ma,amountFen,splitMode:'EXACT',shares:[{memberId:ma,amountFen},{memberId:mb,amountFen:'0'}],category,occurredOn:date,note:'虚构报表数据'});
  const original=await a.request(path+'/expenses','POST',input('10001','2026-11-01'));assert.equal(original.status,201);
  assert.equal((await a.request(path+'/expenses/'+original.data.id,'PATCH',{amountFen:'12000',shares:[{memberId:ma,amountFen:'6000'},{memberId:mb,amountFen:'6000'}]},{'If-Match':original.etag!})).status,200);
  await a.request(path+'/expenses','POST',input('5000','2026-10-31','TRANSPORT'));
  await a.request(path+'/expenses','POST',input('7000','2026-12-01','TRANSPORT'));
  const cancelled=await a.request(path+'/expenses','POST',input('9000','2026-11-12'));
  assert.equal((await a.request(path+'/expenses/'+cancelled.data.id+'/void','POST',{note:'虚构作废'},{'If-Match':cancelled.etag!})).status,200);
  const own=await c.request(path+'/expenses','POST',{paidByMemberId:mc,amountFen:'1000',splitMode:'EQUAL',participantMemberIds:[mc],category:'HOUSING',occurredOn:'2026-11-30',note:'历史成员自担'});assert.equal(own.status,201);
  assert.equal((await c.request(path+'/members/me/leave','POST',{})).status,200);
  const transfer=await b.request(path+'/transfer-requests','POST',{toMemberId:ma,amountFen:'6000',occurredOn:'2026-11-02',note:'虚构转账不算消费'});
  const preview=(await a.request(path+`/transfer-requests/${transfer.data.id}/preview`)).data;
  assert.equal((await a.request(path+`/transfer-requests/${transfer.data.id}/confirm`,'POST',{expectedRequestRevision:preview.expectedRequestRevision,expectedFinancialVersion:preview.expectedFinancialVersion})).status,200);
  await t.test('期间合计13000分，当前承担并列第一且历史/零消费成员保留',async()=>{
    const response=await a.request(path+'/reports?from=2026-11-01&to=2026-11-30');assert.equal(response.status,200);
    assert.equal(response.data.expenseTotalFen,'13000');assert.deepEqual(response.data.period,{from:'2026-11-01',to:'2026-11-30'});
    assert.equal(response.data.categories.find((x:any)=>x.category==='FOOD').amountFen,'12000');
    assert.equal(response.data.categories.find((x:any)=>x.category==='TRANSPORT').amountFen,'0');
    const ranking=new Map(response.data.ranking.map((x:any)=>[x.memberId,x]));
    assert.deepEqual(ranking.get(ma),{memberId:ma,amountFen:'6000',rankNo:'1'});
    assert.deepEqual(ranking.get(mb),{memberId:mb,amountFen:'6000',rankNo:'1'});
    assert.deepEqual(ranking.get(mc),{memberId:mc,amountFen:'1000',rankNo:'2'});
    assert.deepEqual(ranking.get(md),{memberId:md,amountFen:'0',rankNo:'3'});
    assert.equal(response.data.members.find((x:any)=>x.memberId===ma).paidFen,'12000');
    assert.equal((await a.request(path+'/reports')).data.expenseTotalFen,'25000');
  });
  await t.test('结束日包含当天，空期间全零且并列第一，非法筛选拒绝',async()=>{
    assert.equal((await a.request(path+'/reports?from=2026-11-30&to=2026-11-30')).data.expenseTotalFen,'1000');
    const empty=await a.request(path+'/reports?from=2027-01-01&to=2027-01-31');assert.equal(empty.status,200);assert.equal(empty.data.expenseTotalFen,'0');assert.ok(empty.data.ranking.every((x:any)=>x.amountFen==='0'&&x.rankNo==='1'));
    for(const query of ['from=2026-11-30&to=2026-11-01','from=2026-02-30','from=2026-11-01&from=2026-11-02','unknown=x'])assert.equal((await a.request(path+'/reports?'+query)).status,422);
    assert.equal((await c.request(path+'/reports?from=2026-11-01')).status,404);
  });
  await t.test('SQL分页保留筛选、包含结束日、同日顺序与页面分摊',async()=>{
    const first=await a.request(path+'/expenses?from=2026-11-01&to=2026-11-30&limit=1');assert.equal(first.status,200);assert.equal(first.data.items[0].occurredOn,'2026-11-30');assert.equal(first.data.items[0].shares[0].amountFen,'1000');
    const second=await a.request(path+'/expenses?from=2026-11-01&to=2026-11-30&limit=1&cursor='+encodeURIComponent(first.data.nextCursor));assert.equal(second.status,200);assert.equal(second.data.items[0].isVoided,true);
    assert.equal((await a.request(path+'/expenses?category=TRANSPORT&from=2026-11-01&to=2026-11-30')).data.items.length,0);
  });
  await t.test('记录实际统计及分页SQL的EXPLAIN ANALYZE证据',async()=>{
    const db=await pool.getConnection(),plans:{kind:string;plan:unknown}[]=[];
    try{
      const proxy=new Proxy(db,{get(target,key){if(key==='execute')return async(sql:string,params:(string|number|boolean|null)[])=>{
        if(sql.startsWith('WITH ')||sql.startsWith('SELECT e.id FROM expenses')){const [plan]=await target.query('EXPLAIN ANALYZE '+sql,params);plans.push({kind:sql.startsWith('WITH ')?'期间统计':'明细分页',plan})}
        return target.execute(sql,params);
      };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});
      await periodReport(proxy,bookId,{from:'2026-11-01',to:'2026-11-30'});await store.expensePage(proxy,bookId,{limit:'2'});
      assert.equal(plans.length,3);assert.ok(JSON.stringify(plans).includes('actual time'));
      const [version]=await db.query('SELECT VERSION() version');
      await writeFile(new URL('../../docs/development/evidence/m3-sql-plans.json',import.meta.url),JSON.stringify({environment:'本机heji_dev虚构小数据，非压力测试',version,plans},null,2),'utf8');
    }finally{db.release()}
  });
});
