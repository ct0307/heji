import { hash, verify, Algorithm } from '@node-rs/argon2';
import { ApiFault } from '../../shared/errors.ts';

export async function hashPassword(password: string): Promise<string> {
  if(typeof password!=='string'||password.length<10||password.length>128)throw new ApiFault(422,'INVALID_PASSWORD','密码须为10至128个字符');
  return hash(password,{algorithm:Algorithm.Argon2id,memoryCost:19456,timeCost:2,parallelism:1,outputLen:32});
}
export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  if(typeof password!=='string'||password.length>128)return false;
  try { return await verify(encoded,password); } catch { return false; }
}
let dummy: Promise<string> | undefined;
/** 不存在账号也执行相同算法，不通过快速返回泄露账号是否存在。 */
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword('Internal-Dummy-Not-A-User-Password');
  return dummy;
}
