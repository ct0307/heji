import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntentStore } from '../../apps/web/src/finance.ts';
test('登记响应丢失后，其他请求操作及其成功不会改变原登记的重试键',()=>{
  const intents=createIntentStore(),path='/books/example/transfer-requests',body={amountFen:'5000',toMemberId:'friend'};
  const original=intents.headers(path,body)['Idempotency-Key'];
  const cancellation=path+'/other/cancel';intents.headers(cancellation,{expectedRequestRevision:'1'});intents.reset(cancellation);
  assert.equal(intents.headers(path,body)['Idempotency-Key'],original);
  assert.notEqual(intents.headers(path,{...body,amountFen:'6000'})['Idempotency-Key'],original);
});
test('登记成功后同内容再次主动提交是新意图，条件头改变也是新意图',()=>{
  const intents=createIntentStore(),path='/books/example/expenses',body={note:'晚餐'};
  const first=intents.headers(path,body,'"one"')['Idempotency-Key'];intents.reset(path);
  assert.notEqual(intents.headers(path,body,'"one"')['Idempotency-Key'],first);
  assert.notEqual(intents.headers(path,body,'"two"')['Idempotency-Key'],first);
});
