import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Nginx开发与TLS模板保持同源路由、WebSocket Upgrade、JSON限流且日志不含Cookie',async()=>{
  const dev=await readFile(new URL('../../deploy/nginx/heji-dev.conf',import.meta.url),'utf8');
  const prod=await readFile(new URL('../../deploy/nginx/heji-prod.conf',import.meta.url),'utf8');
  for(const config of [dev,prod]){
    assert.match(config,/location\s+=\s+\/ws\s*\{/);assert.match(config,/proxy_http_version\s+1\.1/);
    assert.match(config,/proxy_set_header\s+Upgrade\s+\$http_upgrade/);assert.match(config,/proxy_set_header\s+Connection\s+\$connection_upgrade/);
    assert.match(config,/proxy_set_header\s+X-Forwarded-For\s+\$remote_addr/);assert.match(config,/error_page\s+429\s+=\s+@json_429/);
    const log=config.split('\n').find(line=>/^\s*log_format\s/.test(line));assert.ok(log);assert.doesNotMatch(log,/\$http_cookie|\$http_referer|\$request_uri/);
    assert.match(config,/include\s+deploy\/nginx\/proxy-headers\.conf/);
    assert.match(config,/location\s+\^~\s+\/api\//);assert.match(config,/try_files\s+\$uri\s+\$uri\/\s+\/index\.html/);
  }
  assert.match(prod,/listen\s+443\s+ssl/);assert.match(prod,/Strict-Transport-Security/);
  assert.match(dev,/listen\s+127\.0\.0\.1:8088/);
});
