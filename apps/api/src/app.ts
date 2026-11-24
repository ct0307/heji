import express from 'express';
import { randomUUID } from 'node:crypto';
import type { M1Store } from './modules/m1/contracts.ts';
import { createM1Router, type M1Options } from './modules/m1/routes.ts';
import { ApiFault } from './shared/errors.ts';
import type { FinanceStore } from './modules/finance/contracts.ts';

/** 这里只提供服务基础设施；未实现的业务路由明确返回 JSON 404。 */
export function createApp(store?: M1Store, options: M1Options={origin:'http://127.0.0.1:5174',secureCookies:false},finance?: FinanceStore) {
  const app=express();
  app.disable('x-powered-by');
  app.set('trust proxy',options.trustProxy?((ip:string,index:number)=>index===0&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip)):false);
  app.use((_req,res,next)=>{
    res.locals.requestId=randomUUID();
    res.setHeader('X-Request-Id',res.locals.requestId);
    res.setHeader('X-Content-Type-Options','nosniff');
    next();
  });
  app.use(express.json({limit:'32kb',type:['application/json','application/merge-patch+json']}));
  app.get('/api/v1/health/live',(_req,res)=>res.json({data:{status:'ok'}}));
  app.get('/api/v1/health/ready',async(_req,res)=>{
    try {if(!store)throw new Error();await store.ready();res.json({data:{status:'ready'}})}
    catch {res.status(503).json({error:{code:'SERVICE_UNAVAILABLE',message:'服务暂时不可用，请稍后重试',requestId:res.locals.requestId}})}
  });
  app.use('/api/v1',createM1Router(store,options,finance));
  app.use((_req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'接口不存在',requestId:res.locals.requestId}}));
  app.use((error: unknown,_req: express.Request,res: express.Response,_next: express.NextFunction)=>{
    if(error instanceof ApiFault){if(error.status===429)res.setHeader('Retry-After','900');if(error.code==='TRANSACTION_RETRY_REQUIRED')res.setHeader('Retry-After','1');res.status(error.status).json({error:{code:error.code,message:error.message,requestId:res.locals.requestId}});return}
    const status=typeof error==='object' && error!==null && 'status' in error && typeof error.status==='number' ? error.status : 500;
    const known=status===400||status===413||status===415;
    res.status(known?status:500).json({error:{code:known?'INVALID_REQUEST':'INTERNAL_ERROR',message:known?'请求正文或格式无效':'服务暂时不可用',requestId:res.locals.requestId}});
  });
  return app;
}
