import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../apps/api/src/app.ts';
import type { M1Store } from '../../apps/api/src/modules/m1/contracts.ts';
import type { FinanceStore } from '../../apps/api/src/modules/finance/contracts.ts';
import { csrfFor,newToken } from '../../apps/api/src/modules/identity/security.ts';
import { ApiFault } from '../../apps/api/src/shared/errors.ts';

test('窗口三个HTTP入口复用会话/CSRF，确认透传窗口ID及原两版本，冲突不变成成功',async()=>{
  const sid=newToken(),actor=randomUUID(),book=randomUUID(),id=randomUUID(),calls:unknown[][]=[];
  const identity={findSession:async()=>({user:{id:actor}})} as unknown as M1Store;
  const finance:FinanceStore={read:async(...args)=>{calls.push(args);return {data:{state:'NONE'}}},execute:async(...args)=>{calls.push(args);if(args[2]==='window.close')throw new ApiFault(409,'SETTLEMENT_WINDOW_EXPIRED','窗口已到期');return {data:{ok:true},status:args[2]==='window.open'?201:200}}};
  const server=createApp(identity,undefined,finance).listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/api/v1/books/${book}`;
  const headers={Cookie:`heji_sid=${sid}`,Origin:'http://127.0.0.1:5174','Content-Type':'application/json','X-CSRF-Token':csrfFor(sid),'Idempotency-Key':'window-http-intent'};
  try{
    assert.equal((await fetch(base+'/settlement-window')).status,401);
    assert.equal((await fetch(base+'/settlement-window',{headers})).status,200);
    assert.equal((await fetch(base+`/transfer-requests/${id}/settlement-window`,{method:'POST',headers:{Cookie:headers.Cookie,Origin:headers.Origin,'Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(base+`/transfer-requests/${id}/settlement-window`,{method:'POST',headers,body:'{}'})).status,201);
    const input={expectedFinancialVersion:'7',expectedRequestRevision:'1',expectedWindowId:id};
    assert.equal((await fetch(base+`/transfer-requests/${id}/confirm`,{method:'POST',headers,body:JSON.stringify(input)})).status,200);
    const close=await fetch(base+`/settlement-windows/${id}/close`,{method:'POST',headers,body:'{}'});
    assert.equal(close.status,409);assert.equal((await close.json()).error.code,'SETTLEMENT_WINDOW_EXPIRED');
    assert.equal(calls.length,4);assert.deepEqual(calls[1],[actor,book,'window.open',{}, {idempotencyKey:'window-http-intent',resourceId:id}]);
    assert.deepEqual(calls[2],[actor,book,'request.confirm',input,{idempotencyKey:'window-http-intent',resourceId:id}]);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
});
