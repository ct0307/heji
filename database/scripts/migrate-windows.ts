import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseWindowMigrationArgs,windowMigrationPlan,applyWindowMigration } from './window-migration.ts';

export async function mainWindowMigration(args=process.argv.slice(2)){
  try{
    const options=parseWindowMigrationArgs(args,process.env.HEJI_ALLOW_MIGRATION);
    if(!options.apply){
      const plan=await windowMigrationPlan();console.log(`${plan.name} ${plan.checksum}`);
      console.log('仅离线计划：未连接数据库、未执行SQL。实际迁移必须另获明确许可，指定本机heji_dev或heji_m4_bench和维护模式。');
      console.log('停止全部旧写进程并统一升级后才能激活004；001/002/003不重跑。004备份须用v2，实际备份与独立恢复另需授权。');return;
    }
    const result=await applyWindowMigration(args,process.env.HEJI_ALLOW_MIGRATION);console.log(`004提交完成：${result.database}，证据：${result.evidenceFile}`);
  }catch(error){
    const raw=(error as {code?:string}).code,code=raw&&/^(?:ER_[A-Z0-9_]+|WINDOW_MIGRATION_COMMITTED_EVIDENCE_FAILED)$/.test(raw)?raw:'WINDOW_MIGRATION_STOPPED';
    console.error(`004迁移停止：${code}。保留残留，禁止自动清理或重复迁移；若标记已提交需先人工复核。`);process.exitCode=1;
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await mainWindowMigration();
