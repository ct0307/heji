import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../apps/api/src/app.ts';

const server=createApp().listen(0,'127.0.0.1');
let base='';
before(async()=>{
  if(!server.listening)await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
  const address=server.address();
  assert.ok(address && typeof address!=='string');
  base=`http://127.0.0.1:${address.port}`;
});
after(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))});

test('存活接口返回JSON、请求ID，不宣称数据库就绪',async()=>{
  const response=await fetch(`${base}/api/v1/health/live`);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{data:{status:'ok'}});
  assert.match(response.headers.get('x-request-id')??'',/^[\da-f-]{36}$/);
  assert.equal(response.headers.get('x-powered-by'),null);
  assert.match(response.headers.get('content-type')??'',/application\/json/);
});

test('不存在的API返回JSON 404，错误正文与响应头请求ID一致',async()=>{
  const response=await fetch(`${base}/api/v1/missing`);
  const body=await response.json();
  assert.equal(response.status,404);
  assert.equal(body.error.code,'NOT_FOUND');
  assert.equal(body.error.requestId,response.headers.get('x-request-id'));
  assert.equal('stack' in body.error,false);
});

test('JSON格式错误返回400，超出正文上限返回413',async()=>{
  const invalid=await fetch(`${base}/api/v1/missing`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});
  assert.equal(invalid.status,400);
  assert.equal((await invalid.json()).error.code,'INVALID_REQUEST');
  const large=await fetch(`${base}/api/v1/missing`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({note:'a'.repeat(40000)})});
  assert.equal(large.status,413);
  const body=await large.json();
  assert.equal(body.error.code,'INVALID_REQUEST');
  assert.equal('stack' in body.error,false);
});

test('数据库未配置时就绪检查与CSRF入口返回503，不伪造会话',async()=>{
  for(const path of ['/health/ready','/auth/csrf']){
    const response=await fetch(`${base}/api/v1${path}`);
    assert.equal(response.status,503);
    const body=await response.json();
    assert.equal(body.error.code,'SERVICE_UNAVAILABLE');
    assert.equal(body.error.requestId,response.headers.get('x-request-id'));
    assert.equal(response.headers.get('set-cookie'),null);
    assert.equal('stack' in body.error,false);
  }
});

test('无会话读取身份和账本均返回401且禁止缓存',async()=>{
  for(const path of ['/auth/me','/books']){
    const response=await fetch(`${base}/api/v1${path}`);
    assert.equal(response.status,401);
    assert.equal((await response.json()).error.code,'AUTH_REQUIRED');
    assert.match(response.headers.get('cache-control')??'',/no-store/);
  }
});

test('写请求先拒绝缺失或错误Origin，同源无会话仍返回401',async()=>{
  for(const origin of [undefined,'https://wrong.example']){
    const response=await fetch(`${base}/api/v1/auth/register`,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:'{}'});
    assert.equal(response.status,403);
    assert.equal((await response.json()).error.code,'CSRF_INVALID');
  }
  const response=await fetch(`${base}/api/v1/auth/register`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:5174'},body:'{}'});
  assert.equal(response.status,401);
  assert.equal((await response.json()).error.code,'SESSION_EXPIRED');
});
