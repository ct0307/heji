import { reactive } from 'vue';
import type { UserDto } from '../../../packages/contracts/src/index.ts';

export const session=reactive<{user:UserDto|null;ready:boolean;issue:string}>({user:null,ready:false,issue:''});
let csrfToken='';
let initialization: Promise<void>|undefined;
export function expireSession(){session.user=null;csrfToken=''}
export class ClientFault extends Error {
  status: number; code: string;
  constructor(status: number,code: string,message: string){super(message);this.status=status;this.code=code}
}
export async function api<T>(path: string,method='GET',body?: unknown,headers: Record<string,string>={}): Promise<T> {
  if(method!=='GET'&&!csrfToken)await csrf();
  let response: Response;
  try {response=await fetch('/api/v1'+path,{method,credentials:'same-origin',headers:{...(body===undefined?{}:{'Content-Type':method==='PATCH'?'application/merge-patch+json':'application/json'}),...(method==='GET'?{}:{'X-CSRF-Token':csrfToken}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})})}
  catch {throw new ClientFault(0,'NETWORK_ERROR','连接中断，请检查网络后重试')}
  if(response.status===204)return undefined as T;
  let result: {data?:T;error?:{code:string;message:string}};
  try {result=await response.json()}catch{throw new ClientFault(response.status,'INVALID_RESPONSE','服务响应异常，请稍后重试')}
  if(!response.ok){
    if(response.status===401 && result.error?.code!=='LOGIN_FAILED')expireSession();
    if(result.error?.code==='CSRF_INVALID')csrfToken='';
    throw new ClientFault(response.status,result.error?.code??'SERVICE_ERROR',result.error?.message??'服务暂时不可用');
  }
  return result.data as T;
}
export async function csrf(){csrfToken=(await api<{csrfToken:string}>('/auth/csrf')).csrfToken}
export function initializeSession(): Promise<void> {
  initialization??=(async()=>{
    try {await csrf();session.user=await api<UserDto>('/auth/me');session.issue=''}
    catch(error){if(!(error instanceof ClientFault&&error.status===401))session.issue=error instanceof Error?error.message:'无法加载账号'}
    finally{session.ready=true}
  })();
  return initialization;
}
export async function retrySession(){initialization=undefined;session.issue='';await initializeSession()}
export async function authenticate(input: {email:string;password:string;displayName?:string},registering: boolean){
  const result=await api<{user:UserDto;csrfToken:string}>(registering?'/auth/register':'/auth/login','POST',input);
  session.user=result.user;csrfToken=result.csrfToken;session.issue='';
}
export async function logout(){await api<void>('/auth/logout','POST',{});session.user=null;csrfToken='';sessionStorage.removeItem('heji.pendingInvitation')}
