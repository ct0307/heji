import type { Router, Request, Response } from 'express';
import type { FinanceStore, FinanceView, FinanceOperation, FinanceResult } from './contracts.ts';
import type { User } from '../m1/contracts.ts';
import { uuid } from '../identity/security.ts';
import { ApiFault } from '../../shared/errors.ts';

type Authenticate=(req: Request,res: Response,writing?: boolean)=>Promise<{user: User}>;
/** 使用M1同一套会话、来源和CSRF校验，避免财务端点形成第二套认证。 */
export function registerFinanceRoutes(router: Router,store: FinanceStore|undefined,authenticated: Authenticate){
  const getStore=()=>{if(!store)throw new ApiFault(503,'SERVICE_UNAVAILABLE','财务服务暂时不可用，请稍后重试');return store};
  function send(res: Response,result: FinanceResult){
    if(result.etag)res.setHeader('ETag',result.etag);
    if(result.location)res.location(result.location);
    res.status(result.status??200).json({data:result.data});
  }
  const base='/books/:bookId';
  function read(path: string,view: FinanceView){router.get(base+path,async(req,res)=>{
    const {user}=await authenticated(req,res);
    send(res,await getStore().read(user.id,uuid(req.params.bookId),view,req.params.id?uuid(req.params.id):undefined,req.query));
  })}
  function write(path: string,operation: FinanceOperation,method: 'post'|'patch'='post'){
    router[method](base+path,async(req,res)=>{
      const {user}=await authenticated(req,res,true);
      if(method==='patch'&&!req.is('application/merge-patch+json'))throw new ApiFault(415,'UNSUPPORTED_MEDIA_TYPE','修改支出须使用application/merge-patch+json');
      const key=req.get('Idempotency-Key'),ifMatch=req.get('If-Match'),resourceId=req.params.id?uuid(req.params.id):undefined;
      send(res,await getStore().execute(user.id,uuid(req.params.bookId),operation,req.body??{},
        {idempotencyKey:key,...(ifMatch!==undefined?{ifMatch}:{}),...(resourceId?{resourceId}:{})}));
    });
  }
  read('/balances','snapshot');read('/suggestions','snapshot');
  read('/expenses','expenses');read('/expenses/:id','expense');read('/expenses/:id/history','expenseHistory');
  read('/transfer-requests','requests');read('/transfer-requests/:id/preview','preview');read('/transfers','transfers');
  read('/reports','report');read('/audit-events','audit');
  read('/settlement-window','window');
  write('/transfer-requests/:id/settlement-window','window.open');write('/settlement-windows/:id/close','window.close');
  write('/expenses','expense.create');write('/expenses/:id','expense.patch','patch');write('/expenses/:id/void','expense.void');
  write('/transfer-requests','request.create');
  write('/transfer-requests/:id/confirm','request.confirm');write('/transfer-requests/:id/reject','request.reject');write('/transfer-requests/:id/cancel','request.cancel');
  write('/transfers/:id/reversals','transfer.reverse');
  write('/members/me/leave','member.leave');write('/members/:id/remove','member.remove');
  write('/archive','book.archive');write('/restore','book.restore');
}
