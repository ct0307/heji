import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { M1Store, User } from './contracts.ts';
import { ApiFault } from '../../shared/errors.ts';
import { newToken, tokenHash, csrfFor, validCsrf, readSid, identityInput, bodyObject, textField, uuid, invitationHash } from '../identity/security.ts';
import { hashPassword, verifyPassword, dummyPasswordHash } from '../identity/password.ts';
import type { FinanceStore } from '../finance/contracts.ts';
import { registerFinanceRoutes } from '../finance/routes.ts';

export interface M1Options { origin: string; secureCookies: boolean; trustProxy?: boolean }
export function createM1Router(store: M1Store|undefined,options: M1Options,finance?: FinanceStore) {
  const router=Router();
  const cookieName=options.secureCookies?'__Host-heji_sid':'heji_sid';
  const cookieOptions={httpOnly:true,secure:options.secureCookies,sameSite:'lax' as const,path:'/'};
  const getStore=()=>{if(!store)throw new ApiFault(503,'SERVICE_UNAVAILABLE','服务暂时不可用，请稍后重试');return store};
  function setCookie(res: Response,sid: string){res.cookie(cookieName,sid,{...cookieOptions,maxAge:12*60*60*1000})}
  async function load(req: Request,res: Response) {
    res.setHeader('Cache-Control','private, no-store');
    const sid=readSid(req.headers.cookie,cookieName);
    if(!sid)return undefined;
    const session=await getStore().findSession(tokenHash(sid));
    if(!session){res.clearCookie(cookieName,cookieOptions);return undefined}
    setCookie(res,sid);return {sid,user:session.user};
  }
  async function write(req: Request,res: Response) {
    if(req.get('Origin')!==options.origin)throw new ApiFault(403,'CSRF_INVALID','请求来源无效，请刷新页面');
    const context=await load(req,res);
    if(!context)throw new ApiFault(401,'SESSION_EXPIRED','会话已过期，请重新登录');
    if(!validCsrf(context.sid,req.get('X-CSRF-Token')))throw new ApiFault(403,'CSRF_INVALID','页面会话已更新，请刷新后重试');
    return context;
  }
  async function authenticated(req: Request,res: Response,writing=false) {
    const context=writing?await write(req,res):await load(req,res);
    if(!context?.user)throw new ApiFault(401,'AUTH_REQUIRED','请先登录');
    return {sid:context.sid,user:context.user};
  }
  async function limit(req: Request,key: string,maximum: number,seconds=900) {
    if(!await getStore().consumeLimit(tokenHash(`${key}:${req.ip??'unknown'}`),maximum,seconds))throw new ApiFault(429,'RATE_LIMITED','尝试次数较多，请稍后再试');
  }
  router.get('/auth/csrf',async(req,res)=>{
    await limit(req,'csrf',120,60);
    let context=await load(req,res);
    if(!context){const sid=newToken();await getStore().createAnonymousSession(tokenHash(sid));setCookie(res,sid);context={sid,user:null}}
    res.json({data:{csrfToken:csrfFor(context.sid)}});
  });
  router.get('/auth/me',async(req,res)=>{const {user}=await authenticated(req,res);res.json({data:user})});
  router.post('/auth/register',async(req,res)=>{
    const context=await write(req,res);
    if(context.user)throw new ApiFault(409,'ALREADY_AUTHENTICATED','请先退出当前账号');
    await limit(req,'register',20);
    const input=identityInput(req.body,true), sid=newToken();
    const user: User={id:randomUUID(),email:input.email,displayName:input.displayName};
    await getStore().register({...user,passwordHash:await hashPassword(input.password)},tokenHash(context.sid),tokenHash(sid));
    setCookie(res,sid);res.location('/api/v1/auth/me').status(201).json({data:{user,csrfToken:csrfFor(sid)}});
  });
  router.post('/auth/login',async(req,res)=>{
    const context=await write(req,res);
    if(context.user)throw new ApiFault(409,'ALREADY_AUTHENTICATED','请先退出当前账号');
    const input=identityInput(req.body,false);
    await limit(req,'login-ip',60);await limit(req,`login-account:${input.email}`,10);
    const user=await getStore().findUser(input.email);
    const valid=await verifyPassword(user?.passwordHash??await dummyPasswordHash(),input.password);
    if(!user||!valid)throw new ApiFault(401,'LOGIN_FAILED','邮箱或密码不正确');
    const sid=newToken();await getStore().rotateSession(tokenHash(context.sid),tokenHash(sid),user.id);
    setCookie(res,sid);res.json({data:{user:{id:user.id,email:user.email,displayName:user.displayName},csrfToken:csrfFor(sid)}});
  });
  router.post('/auth/logout',async(req,res)=>{
    const context=await write(req,res);await getStore().deleteSession(tokenHash(context.sid));res.clearCookie(cookieName,cookieOptions);res.status(204).end();
  });
  router.get('/books',async(req,res)=>{const {user}=await authenticated(req,res);res.json({data:await getStore().listBooks(user.id)})});
  router.post('/books',async(req,res)=>{
    const {user}=await authenticated(req,res,true),body=bodyObject(req.body,['name']);
    const book=await getStore().createBook(user.id,textField(body.name,'账本名称',80));res.location(`/api/v1/books/${book.id}`).status(201).json({data:book});
  });
  router.get('/books/:bookId',async(req,res)=>{const {user}=await authenticated(req,res);res.json({data:await getStore().getBook(user.id,uuid(req.params.bookId))})});
  router.patch('/books/:bookId',async(req,res)=>{
    const {user}=await authenticated(req,res,true),body=bodyObject(req.body,['name']);
    res.json({data:await getStore().renameBook(user.id,uuid(req.params.bookId),textField(body.name,'账本名称',80))});
  });
  router.get('/books/:bookId/members',async(req,res)=>{const {user}=await authenticated(req,res);res.json({data:await getStore().members(user.id,uuid(req.params.bookId))})});
  router.post('/books/:bookId/invitations',async(req,res)=>{
    const {user}=await authenticated(req,res,true);bodyObject(req.body??{},[]);
    const token=newToken(),bookId=uuid(req.params.bookId);
    const invite=await getStore().createInvitation(user.id,bookId,tokenHash(token));
    res.location(`/api/v1/books/${bookId}`).status(201).json({data:{...invite,token}});
  });
  router.post('/books/:bookId/invitations/:id/revoke',async(req,res)=>{
    const {user}=await authenticated(req,res,true);bodyObject(req.body??{},[]);
    await getStore().revokeInvitation(user.id,uuid(req.params.bookId),uuid(req.params.id));res.status(204).end();
  });
  router.post('/invitations/preview',async(req,res)=>{
    const context=await write(req,res),body=bodyObject(req.body,['token']);await limit(req,'invitation-preview',60);
    res.json({data:await getStore().previewInvitation(context.user?.id??null,invitationHash(body.token))});
  });
  router.post('/invitations/accept',async(req,res)=>{
    const {user}=await authenticated(req,res,true),body=bodyObject(req.body,['token']);
    res.json({data:await getStore().acceptInvitation(user.id,invitationHash(body.token))});
  });
  registerFinanceRoutes(router,finance,authenticated);
  return router;
}
