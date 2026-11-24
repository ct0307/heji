import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../apps/api/src/app.ts';
import type { M1Store } from '../../apps/api/src/modules/m1/contracts.ts';
import type { FinanceStore } from '../../apps/api/src/modules/finance/contracts.ts';
import { csrfFor, newToken } from '../../apps/api/src/modules/identity/security.ts';

test('财务HTTP复用登录和CSRF，透传合并补丁、条件标签及响应元数据',async()=>{
  const sid=newToken(),actor=randomUUID(),book=randomUUID(),expense=randomUUID();
  const calls: unknown[][]=[];
  const identity={findSession:async()=>({user:{id:actor,email:'http@example.test',displayName:'测试'}})} as unknown as M1Store;
  const finance: FinanceStore={
    read:async(...args)=>{calls.push(args);return {data:{revision:'1'},etag:'"opaque"'}},
    execute:async(...args)=>{calls.push(args);return {status:201,data:{revision:'2'},etag:'"next"',location:'/created'}}
  };
  const server=createApp(identity,undefined,finance).listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}/api/v1/books/${book}`;
  try{
    assert.equal((await fetch(base+'/expenses')).status,401);
    const read=await fetch(base+'/expenses/'+expense,{headers:{Cookie:`heji_sid=${sid}`}});
    assert.equal(read.status,200);assert.equal(read.headers.get('ETag'),'"opaque"');
    const denied=await fetch(base+'/expenses/'+expense,{method:'PATCH',headers:{Cookie:`heji_sid=${sid}`,'Content-Type':'application/merge-patch+json'},body:'{"note":"测试"}'});
    assert.equal(denied.status,403);
    const patched=await fetch(base+'/expenses/'+expense,{method:'PATCH',headers:{Cookie:`heji_sid=${sid}`,Origin:'http://127.0.0.1:5174','X-CSRF-Token':csrfFor(sid),'Content-Type':'application/merge-patch+json','Idempotency-Key':'http-key-1','If-Match':'"opaque"'},body:'{"note":"测试"}'});
    assert.equal(patched.status,201);assert.equal(patched.headers.get('ETag'),'"next"');assert.equal(patched.headers.get('Location'),'/created');
    assert.deepEqual(calls[1],[actor,book,'expense.patch',{note:'测试'},{idempotencyKey:'http-key-1',ifMatch:'"opaque"',resourceId:expense}]);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
});

test('未配置财务仓储时已登录请求返回503',async()=>{
  const sid=newToken();const identity={findSession:async()=>({user:{id:randomUUID()}})} as unknown as M1Store;
  const server=createApp(identity).listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  try{const response=await fetch(`http://127.0.0.1:${address.port}/api/v1/books/${randomUUID()}/balances`,{headers:{Cookie:`heji_sid=${sid}`}});assert.equal(response.status,503)}
  finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
});
