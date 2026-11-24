import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applySummaryMigration,parseSummaryMigrationArgs,safeSummaryMigrationError,summaryMigrationPlan } from './summary-migration.ts';

/** 入口本身不加载配置文件；仅在直接运行时执行，导入无连接或输出副作用。 */
export async function mainSummaryMigration(args=process.argv.slice(2)):Promise<void> {
  try{
    const options=parseSummaryMigrationArgs(args,process.env.HEJI_ALLOW_MIGRATION);
    if(!options.apply){
      const plan=await summaryMigrationPlan();
      console.log(`${plan.name} ${plan.checksum}`);
      console.log('目标仅限heji_dev或heji_m4_bench；维护窗口、显式目标与迁移许可缺一不可。');
      console.log('仅显示计划：未连接数据库、未加载本机配置、未执行SQL；实际迁移仍需用户确认。');
      return;
    }
    const result=await applySummaryMigration(options,process.env.HEJI_ALLOW_MIGRATION);
    console.log(`汇总迁移提交完成：${result.database}，证据：${result.evidenceFile}`);
  }catch(error){
    const code=safeSummaryMigrationError(error);
    console.error(code==='SUMMARY_MIGRATION_COMMITTED_EVIDENCE_FAILED'
      ?'汇总迁移已经提交并生效，但证据文件写入失败：SUMMARY_MIGRATION_COMMITTED_EVIDENCE_FAILED。保留数据，需人工补核证据，禁止重复迁移。'
      :`汇总迁移停止：${code}。保留全部结构和数据残留，不自动清理或重试。`);
    process.exitCode=1;
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await mainSummaryMigration();
