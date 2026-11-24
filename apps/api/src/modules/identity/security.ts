import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiFault } from '../../shared/errors.ts';

const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
export const newToken=()=>randomBytes(32).toString('base64url');
export const tokenHash=(token: string)=>createHash('sha256').update(token).digest('hex');
/** SID是仅浏览器持有的256位随机密钥；数据库只保存其摘要。 */
export const csrfFor=(sid: string)=>createHmac('sha256',sid).update('heji-csrf-v1').digest('base64url');
export function validCsrf(sid: string, supplied: string|undefined): boolean {
  if(!supplied||!tokenPattern.test(supplied))return false;
  return timingSafeEqual(Buffer.from(csrfFor(sid)),Buffer.from(supplied));
}
export function readSid(header: string|undefined, cookieName: string): string|undefined {
  const values=(header??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookieName+'='));
  if(values.length!==1)return undefined;
  const value=values[0]!.slice(cookieName.length+1);
  return tokenPattern.test(value)?value:undefined;
}
export function bodyObject(value: unknown, allowed: readonly string[]): Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new ApiFault(422,'INVALID_INPUT','请求包含无效字段');
  return value as Record<string,unknown>;
}
export function textField(value: unknown, name: string, maximum: number): string {
  if(typeof value!=='string'||!value.trim()||value.trim().length>maximum)throw new ApiFault(422,'INVALID_INPUT',`${name}不能为空且不能超过${maximum}个字符`);
  return value.trim();
}
export function identityInput(value: unknown, registering: boolean): {email: string; password: string; displayName: string} {
  const body=bodyObject(value,registering?['email','password','displayName']:['email','password']);
  const email=textField(body.email,'邮箱',254).toLowerCase();
  if(!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email))throw new ApiFault(422,'INVALID_INPUT','请输入有效邮箱');
  if(typeof body.password!=='string'||body.password.length<(registering?10:1)||body.password.length>128)throw new ApiFault(422,'INVALID_PASSWORD','密码须为10至128个字符');
  return {email,password:body.password,displayName:registering?textField(body.displayName,'昵称',40):''};
}
export function uuid(value: unknown): string {
  if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new ApiFault(404,'RESOURCE_NOT_FOUND','资源不存在');
  return value.toLowerCase();
}
export function invitationHash(value: unknown): string {
  if(typeof value!=='string'||!tokenPattern.test(value))throw new ApiFault(404,'INVITATION_NOT_FOUND','邀请不存在或已失效');
  return tokenHash(value);
}
