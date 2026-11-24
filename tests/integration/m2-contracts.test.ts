import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeExpense, parseIfMatch, expenseEtag, requestDigest, parseTransfer, parseConfirmation } from '../../apps/api/src/modules/finance/validation.ts';
const a=randomUUID(),b=randomUUID();
const expense={paidByMemberId:a,amountFen:'10001',splitMode:'EQUAL',participantMemberIds:[b,a],category:'FOOD',occurredOn:'2026-11-17',note:'晚餐'};
test('支出服务端均分守恒且输入顺序不影响结果，允许零份额',()=>{
  const result=normalizeExpense(expense);
  assert.equal(result.shares.reduce((sum,x)=>sum+BigInt(x.amountFen),0n),10001n);
  assert.deepEqual(result.shares,normalizeExpense({...expense,participantMemberIds:[a,b]}).shares);
  assert.equal(normalizeExpense({...expense,amountFen:'1'}).shares.filter(x=>x.amountFen==='0').length,1);
});
test('拒绝无效分摊、日期、科学计数和伪造操作者；备注补丁保留财务字段',()=>{
  for(const patch of [{amountFen:'1e3'},{occurredOn:'2026-02-30'},{createdByMemberId:b},{shares:[]},{participantMemberIds:[a,a]}])assert.throws(()=>normalizeExpense({...expense,...patch}));
  assert.throws(()=>normalizeExpense({...expense,splitMode:'EXACT',participantMemberIds:undefined,shares:[{memberId:a,amountFen:'10000'}]}));
  const before=normalizeExpense(expense),after=normalizeExpense({note:'已核对'},before);
  assert.equal(after.amountFen,before.amountFen);assert.deepEqual(after.shares,before.shares);assert.equal(after.note,'已核对');
});
test('If-Match强比较支持条件列表和带逗号标签，明确区分缺失、通配符和语法错误',()=>{
  assert.throws(()=>parseIfMatch(undefined),(error:any)=>error.status===428);
  assert.throws(()=>parseIfMatch('*'),(error:any)=>error.code==='SPECIFIC_ETAG_REQUIRED');
  assert.throws(()=>parseIfMatch('unquoted'),(error:any)=>error.status===400);
  assert.deepEqual(parseIfMatch('W/"old", "opaque,tag"'),['"opaque,tag"']);
  const tag=expenseEtag(a,'1');assert.match(tag,/^"[a-f0-9]{64}"$/);assert.notEqual(tag,expenseEtag(a,'2'));
});
test('摘要忽略对象字段顺序但保留语义条件；转账拒绝伪造付款人和无效版本',()=>{
  assert.equal(requestDigest({b:2,a:1}),requestDigest({a:1,b:2}));
  assert.notEqual(requestDigest({ifMatch:'"a"'}),requestDigest({ifMatch:'"b"'}));
  assert.throws(()=>parseTransfer({toMemberId:b,fromMemberId:a,amountFen:'1',occurredOn:'2026-11-17',note:''}));
  assert.equal(parseTransfer({toMemberId:b,amountFen:'1',occurredOn:'2026-11-17',note:''}).amountFen,'1');
  assert.throws(()=>parseConfirmation({expectedRequestRevision:1,expectedFinancialVersion:'0'}));
  assert.deepEqual(parseConfirmation({expectedRequestRevision:'1',expectedFinancialVersion:'0'}),{expectedRequestRevision:'1',expectedFinancialVersion:'0'});
});
