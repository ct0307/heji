import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { PoolConnection } from 'mysql2/promise';
import type { ExpenseDto } from '../../packages/contracts/src/index.ts';

const moduleUrl=new URL('../../apps/api/src/modules/finance/mysql-summaries.ts',import.meta.url);
const summaries=await import(moduleUrl.href).catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND')assert.fail('缺少已批准设计要求的财务汇总模块');
  throw error;
});
const expense=(changes:Partial<ExpenseDto>={}):ExpenseDto=>({id:'expense',bookId:'book',createdByMemberId:'a',revision:'1',etag:'etag',
  paidByMemberId:'a',amountFen:'101',splitMode:'EXACT',shares:[{memberId:'a',amountFen:'51'},{memberId:'b',amountFen:'50'},{memberId:'zero',amountFen:'0'}],
  category:'FOOD',occurredOn:'2026-11-18',note:'',isVoided:false,changedByMemberId:'a',createdAt:'2026-11-18T00:00:00Z',...changes});
const member=(memberId:string,paidFen:string,shareFen:string,outgoingFen='0',incomingFen='0')=>({bookId:'book',memberId,paidFen,shareFen,outgoingFen,incomingFen});
function recorder(results:Record<string,unknown>[][]=[]) {
  const calls:{sql:string;values:unknown[]}[]=[];
  const db={execute:async(sql:string,values:unknown[]=[])=>{calls.push({sql,values});return [results.shift()??[],[]]}} as unknown as PoolConnection;
  return {db,calls};
}

test('新增支出合并付款与份额，零份额不产生空增量，金额全部字符串',()=>{
  const delta=summaries.expenseSummaryDelta(undefined,expense());
  assert.deepEqual(delta.members,[member('a','101','51'),member('b','0','50')]);
  assert.deepEqual(delta.dailyMembers,[{bookId:'book',occurredOn:'2026-11-18',memberId:'a',paidFen:'101',shareFen:'51'},
    {bookId:'book',occurredOn:'2026-11-18',memberId:'b',paidFen:'0',shareFen:'50'}]);
  assert.deepEqual(delta.dailyCategories,[{bookId:'book',occurredOn:'2026-11-18',category:'FOOD',amountFen:'101'}]);
  assert.equal(delta.members.reduce((n:bigint,row:{paidFen:string})=>n+BigInt(row.paidFen),0n),101n);
  assert.equal(delta.members.reduce((n:bigint,row:{shareFen:string})=>n+BigInt(row.shareFen),0n),101n);
  for(const rows of Object.values(delta) as Record<string,unknown>[][])for(const row of rows)for(const value of Object.values(row))assert.equal(typeof value,'string');
});
test('修正付款人、金额与份额只保留每个键的净增量',()=>{
  const next=expense({paidByMemberId:'b',amountFen:'201',shares:[{memberId:'a',amountFen:'0'},{memberId:'b',amountFen:'201'}]});
  assert.deepEqual(summaries.expenseSummaryDelta(expense(),next).members,[member('a','-101','-51'),member('b','201','151')]);
});
test('作废减去旧有效版本，已作废版本不计入新增或再次作废',()=>{
  assert.deepEqual(summaries.expenseSummaryDelta(expense(),expense({isVoided:true})).members,[member('a','-101','-51'),member('b','0','-50')]);
  assert.deepEqual(summaries.expenseSummaryDelta(undefined,expense({isVoided:true})),{members:[],dailyMembers:[],dailyCategories:[]});
  assert.deepEqual(summaries.expenseSummaryDelta(expense({isVoided:true}),expense({isVoided:true})),{members:[],dailyMembers:[],dailyCategories:[]});
});
test('备注或版本变化不产生任何汇总SQL',async()=>{
  const {db,calls}=recorder();
  await summaries.applyExpenseSummary(db,expense(),expense({note:'只改备注',revision:'2'}));
  assert.deepEqual(calls,[]);
});
test('分类移动不改余额或成员日汇总，跨日移动保留余额',()=>{
  const category=summaries.expenseSummaryDelta(expense(),expense({category:'OTHER'}));
  assert.deepEqual(category.members,[]);assert.deepEqual(category.dailyMembers,[]);
  assert.deepEqual(category.dailyCategories,[{bookId:'book',occurredOn:'2026-11-18',category:'FOOD',amountFen:'-101'},{bookId:'book',occurredOn:'2026-11-18',category:'OTHER',amountFen:'101'}]);
  const date=summaries.expenseSummaryDelta(expense(),expense({occurredOn:'2026-11-19'}));
  assert.deepEqual(date.members,[]);assert.equal(date.dailyMembers.length,4);assert.equal(date.dailyCategories.length,2);
  assert.equal(date.dailyMembers.reduce((n:bigint,row:{paidFen:string})=>n+BigInt(row.paidFen),0n),0n);
});
test('超过安全整数的金额运算不丢失精度',()=>{
  const huge='900719925474099312345678901234567890';
  const delta=summaries.expenseSummaryDelta(undefined,expense({amountFen:huge,shares:[{memberId:'a',amountFen:huge}]}));
  assert.deepEqual(delta.members,[member('a',huge,huge)]);
});
test('确认转账与冲正分别按事实方向增加，不能变更支出日汇总',async()=>{
  const transfer={bookId:'book',fromMemberId:'a',toMemberId:'b',amountFen:'50'};
  assert.deepEqual(summaries.transferSummaryDelta(transfer),[member('a','0','0','50','0'),member('b','0','0','0','50')]);
  assert.deepEqual(summaries.transferSummaryDelta({...transfer,fromMemberId:'b',toMemberId:'a'}),[member('a','0','0','0','50'),member('b','0','0','50','0')]);
  const {db,calls}=recorder();await summaries.applyTransferSummary(db,transfer);
  assert.equal(calls.length,1);assert.match(calls[0]!.sql,/INSERT INTO finance_member_totals/);
});
test('单次支出最多三条多行参数化UPSERT，负数按字符串传入',async()=>{
  const {db,calls}=recorder();
  await summaries.applyExpenseSummary(db,expense(),expense({paidByMemberId:'b',occurredOn:'2026-11-19'}));
  assert.equal(calls.length,3);
  for(const {sql,values} of calls){assert.match(sql,/ON DUPLICATE KEY UPDATE/);assert.equal((sql.match(/\?/g)??[]).length,values.length);assert.ok(values.every(value=>typeof value==='string'));assert.doesNotMatch(sql,/'book'/)}
  assert.ok(calls.flatMap(call=>call.values).includes('-101'));
});
test('全量余额使用LEFT JOIN覆盖退出或无汇总成员，空行按零',async()=>{
  const {db,calls}=recorder([[{memberId:'left',paidFen:'0',shareFen:'0',outgoingFen:'0',incomingFen:'0'}]]);
  assert.deepEqual(await summaries.summaryAmounts(db,'book'),[{memberId:'left',paidFen:'0',shareFen:'0',outgoingFen:'0',incomingFen:'0'}]);
  assert.match(calls[0]!.sql,/LEFT JOIN finance_member_totals/);assert.match(calls[0]!.sql,/COALESCE/);assert.doesNotMatch(calls[0]!.sql,/status\s*=/);assert.deepEqual(calls[0]!.values,['book']);
});
test('期间报表补齐四类、保留零值历史成员并用DENSE_RANK并列排序',async()=>{
  const {db,calls}=recorder([[{category:'FOOD',amountFen:'102'}],[{memberId:'a',paidFen:'102',shareFen:'51',rankNo:'1'},{memberId:'b',paidFen:'0',shareFen:'51',rankNo:'1'},{memberId:'left',paidFen:'0',shareFen:'0',rankNo:'2'}]]);
  const report=await summaries.summaryPeriodReport(db,'book',{from:'2026-11-01',to:'2026-11-18'});
  assert.equal(report.expenseTotalFen,'102');assert.equal(report.categories.length,4);assert.equal(report.categories[1].amountFen,'0');
  assert.deepEqual(report.period,{from:'2026-11-01',to:'2026-11-18'});assert.deepEqual(report.ranking.map((row:{rankNo:string})=>row.rankNo),['1','1','2']);
  assert.match(calls[1]!.sql,/DENSE_RANK\(\)/);assert.doesNotMatch(calls[1]!.sql,/status\s*=/);assert.ok(calls.every(call=>call.values.includes('2026-11-19')));
  await assert.rejects(()=>summaries.summaryPeriodReport(db,'book',{from:'2026-11-20',to:'2026-11-18'}));
});
test('空期间返回四类零值；最大结束日期使用闭区间',async()=>{
  const {db,calls}=recorder([[],[{memberId:'left',paidFen:'0',shareFen:'0',rankNo:'1'}]]);
  const report=await summaries.summaryPeriodReport(db,'book',{to:'9999-12-31'});
  assert.equal(report.expenseTotalFen,'0');assert.ok(report.categories.every((row:{amountFen:string})=>row.amountFen==='0'));
  assert.ok(calls.every(call=>/occurredOn<=\?/.test(call.sql)&&call.values.includes('9999-12-31')));
});
test('回填拒绝任意非空汇总表，并且不执行清理',async()=>{
  for(let i=0;i<3;i++){
    const results=Array.from({length:3},(_,j)=>j===i?[{present:'1'}]:[]);
    const {db,calls}=recorder(results);await assert.rejects(()=>summaries.backfillSummaries(db),/空/);
    assert.ok(calls.every(call=>/^SELECT/.test(call.sql.trim())));
  }
});
test('空表初建回填仅聚合当前有效事实且每个SQL只引用每张汇总表一次',async()=>{
  const {db,calls}=recorder();await summaries.backfillSummaries(db);
  const inserts=calls.filter(call=>/^INSERT/.test(call.sql.trim()));assert.ok(inserts.length>=3);
  for(const {sql} of inserts){assert.doesNotMatch(sql,/DELETE|TRUNCATE|UPDATE\s+finance_/i);assert.match(sql,/currentRevision|confirmed_transfers/);
    for(const table of ['finance_member_totals','finance_daily_members','finance_daily_categories'])assert.ok((sql.match(new RegExp(table,'g'))??[]).length<=1);
  }
  assert.ok(inserts.some(call=>/isVoided=0/.test(call.sql)));
});
test('提案只建三表且允许有符号增量；临时表助手只建空连接表',async()=>{
  const sql=await readFile(new URL('../../docs/development/proposals/003_finance_summaries.sql',import.meta.url),'utf8');
  assert.equal((sql.match(/CREATE TABLE /g)??[]).length,3);assert.doesNotMatch(sql,/IF NOT EXISTS|UNSIGNED|CHECK|DELETE|TRUNCATE|INSERT INTO/i);
  assert.equal((sql.match(/DECIMAL\(65,0\)/g)??[]).length,7);assert.match(sql,/ENUM\('FOOD','TRANSPORT','HOUSING','OTHER'\)/);
  const {createTemporarySummaries}=await import('../m4/summary-tables.ts');const {db,calls}=recorder();await createTemporarySummaries(db);
  assert.equal(calls.length,3);for(const call of calls){assert.match(call.sql,/^CREATE TEMPORARY TABLE /);assert.doesNotMatch(call.sql,/INSERT|FOREIGN KEY|IF NOT EXISTS/i)}
});
