import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../apps/api/src/modules/identity/password.ts';
import { newToken, tokenHash, csrfFor, validCsrf, readSid, identityInput } from '../../apps/api/src/modules/identity/security.ts';

test('Argon2id密码哈希有随机盐，错误密码统一拒绝',async()=>{
  const password='Example-Only-Long-Password';
  const first=await hashPassword(password), second=await hashPassword(password);
  assert.ok(first.startsWith('$argon2id$'));
  assert.notEqual(first,second);
  assert.ok(await verifyPassword(first,password));
  assert.equal(await verifyPassword(first,'wrong'),false);
  assert.equal(await verifyPassword(first,'x'.repeat(129)),false);
});

test('SID不可预测且CSRF绑定会话，拒绝重复或格式错误的Cookie',()=>{
  const sid=newToken(), other=newToken();
  assert.notEqual(sid,other);
  assert.equal(tokenHash(sid).length,64);
  assert.equal(validCsrf(sid,csrfFor(sid)),true);
  assert.equal(validCsrf(other,csrfFor(sid)),false);
  assert.equal(validCsrf(sid,undefined),false);
  assert.equal(readSid(`heji_sid=${sid}`,'heji_sid'),sid);
  assert.equal(readSid(`heji_sid=${sid}; heji_sid=${other}`,'heji_sid'),undefined);
  assert.equal(readSid('heji_sid=short','heji_sid'),undefined);
});

test('账户输入规范化，拒绝客户端指定权限及弱密码',()=>{
  const valid=identityInput({email:'USER@example.com',password:'Example-Only-Long-Password',displayName:'阿宁'},true);
  assert.equal(valid.email,'user@example.com');
  assert.throws(()=>identityInput({email:'a@b.com',password:'short',displayName:'甲'},true));
  assert.throws(()=>identityInput({email:'a@b.com',password:'Example-Only-Long-Password',role:'OWNER'},false));
  assert.throws(()=>identityInput({email:'a@b.com',password:'Example-Only-Long-Password',displayName:' '},true));
});
