import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../apps/api/src/app.ts';
import type { M1Store } from '../../apps/api/src/modules/m1/contracts.ts';
import { tokenHash } from '../../apps/api/src/modules/identity/security.ts';

test('仅显式启用部署代理时信任本机回环上一跳，默认/开发环境拒绝转发头',()=>{
  const options={origin:'https://ledger.example',secureCookies:true};
  assert.equal(createApp(undefined,options).get('trust proxy'),false);
  const trusted=createApp(undefined,{...options,trustProxy:true}).get('trust proxy fn');
  assert.equal(trusted('127.0.0.1',0),true);assert.equal(trusted('127.0.0.1',1),false);assert.equal(trusted('203.0.113.7',0),false);
  assert.equal(createApp(undefined,{...options,trustProxy:false}).get('trust proxy'),false);
});

test('真实HTTP：代理覆盖后的IP用于限流、默认环境不接受伪造转发IP；HTTPS Cookie带Secure',async()=>{
  for(const enabled of [false,true]){
    const keys:string[]=[];
    const identity={consumeLimit:async(key:string)=>{keys.push(key);return true},createAnonymousSession:async()=>{}} as unknown as M1Store;
    const server=createApp(identity,{origin:'https://ledger.example',secureCookies:true,trustProxy:enabled}).listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
    try{
      const response=await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/csrf`,{headers:{'X-Forwarded-For':'203.0.113.7','X-Forwarded-Proto':'https'}});
      assert.equal(response.status,200);assert.equal(keys[0],tokenHash('csrf:'+(enabled?'203.0.113.7':'127.0.0.1')));
      assert.match(response.headers.get('set-cookie')??'',/__Host-heji_sid=/);assert.match(response.headers.get('set-cookie')??'',/; Secure/);
    }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
  }
});
