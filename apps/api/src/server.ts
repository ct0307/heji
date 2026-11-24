import { createApp } from './app.ts';
import { createServer } from 'node:http';
import { databaseConfig, createDatabasePool } from './shared/database.ts';
import { MysqlFinanceStore } from './modules/finance/mysql-store.ts';
import { attachRealtime } from './modules/realtime/server.ts';

const port=Number(process.env.PORT ?? '3001');
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT须为1至65535的整数');
const origin=process.env.APP_ORIGIN??'http://127.0.0.1:5174';
const secure=process.env.NODE_ENV==='production';
if(new URL(origin).origin!==origin||(secure&&!origin.startsWith('https://')))throw new Error('APP_ORIGIN配置无效');
const config=databaseConfig();
const pool=config?createDatabasePool(config):undefined;
const store=pool?new MysqlFinanceStore(pool):undefined;
const server=createServer(createApp(store,{origin,secureCookies:secure,trustProxy:secure},store));
const closeRealtime=store?attachRealtime(server,store,{origin,secureCookies:secure}):undefined;
server.once('error',(error: NodeJS.ErrnoException)=>{
  console.error(error.code==='EADDRINUSE'?'API端口已被占用，请设置空闲PORT后重试。':'API启动失败，请检查监听配置。');
  process.exitCode=1;
});
server.listen(port,'127.0.0.1',()=>console.log(`API已启动：http://127.0.0.1:${port}`));
function shutdown(){closeRealtime?.();server.close(()=>{void (pool?.end()??Promise.resolve()).finally(()=>process.exit(0))});setTimeout(()=>process.exit(1),10000).unref()}
process.once('SIGINT',shutdown);
process.once('SIGTERM',shutdown);
