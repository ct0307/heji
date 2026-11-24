import { readFile } from 'node:fs/promises';
import type { PoolConnection } from 'mysql2/promise';

/** 同一提案结构转为连接级空临时表；关闭连接后自然释放，不回填、不操作持久表。 */
export async function createTemporarySummaries(db:PoolConnection):Promise<void> {
  const source=await readFile(new URL('../../docs/development/proposals/003_finance_summaries.sql',import.meta.url),'utf8');
  const statements=source.replace(/^\s*--.*$/gm,'').split(';').map(sql=>sql.trim()).filter(Boolean);
  const names=['finance_member_totals','finance_daily_members','finance_daily_categories'];
  if(statements.length!==names.length||statements.some((sql,index)=>!sql.startsWith(`CREATE TABLE ${names[index]} (`)||/FOREIGN KEY|IF NOT EXISTS/i.test(sql))){
    throw new Error('汇总提案结构与临时表演练不匹配');
  }
  for(const sql of statements)await db.execute(sql.replace(/^CREATE TABLE /,'CREATE TEMPORARY TABLE '));
}
