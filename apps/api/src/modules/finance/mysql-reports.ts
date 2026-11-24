import type { PoolConnection } from 'mysql2/promise';
import type { ReportDto,ExpenseCategory } from '../../../../../packages/contracts/src/index.ts';
import { rows } from './read-model.ts';
import { reportPeriod } from './report-query.ts';
import { summaryPeriodReport } from './mysql-summaries.ts';

/** 汇总只读取当前有效版本；与授权检查共用同一RR快照，聚合金额保留十进制字符串。 */
export async function periodReport(db:PoolConnection,bookId:string,query:Record<string,unknown>,useSummaries=false):Promise<ReportDto> {
  if(useSummaries)return summaryPeriodReport(db,bookId,query);
  const period=reportPeriod(query),where=['e.bookId=?','v.isVoided=0'],values:(string|number|boolean|null)[]=[bookId];
  if(period.from){where.push('v.occurredOn>=?');values.push(period.from)}
  if(period.until){where.push('v.occurredOn<?');values.push(period.until)}
  else if(period.to){where.push('v.occurredOn<=?');values.push(period.to)}
  const current=`SELECT v.* FROM expenses e JOIN expense_versions v ON v.expenseId=e.id AND v.revision=e.currentRevision AND v.bookId=e.bookId WHERE ${where.join(' AND ')}`;
  const categoryRows=await rows(db,`WITH current_expenses AS (${current}) SELECT category,SUM(amountFen) amountFen FROM current_expenses GROUP BY category`,values);
  const categories:ReportDto['categories']=(['FOOD','TRANSPORT','HOUSING','OTHER'] as ExpenseCategory[]).map(category=>({category,amountFen:String(categoryRows.find(row=>row.category===category)?.amountFen??'0')}));
  const memberRows=await rows(db,`WITH current_expenses AS (${current}),
    shares AS (SELECT s.memberId,SUM(s.amountFen) shareFen FROM current_expenses v JOIN expense_shares s ON s.bookId=v.bookId AND s.expenseId=v.expenseId AND s.revision=v.revision GROUP BY s.memberId),
    paid AS (SELECT paidByMemberId memberId,SUM(amountFen) paidFen FROM current_expenses GROUP BY paidByMemberId)
    SELECT m.id memberId,COALESCE(p.paidFen,0) paidFen,COALESCE(s.shareFen,0) shareFen,
      DENSE_RANK() OVER (ORDER BY COALESCE(s.shareFen,0) DESC) rankNo
    FROM book_members m LEFT JOIN shares s ON s.memberId=m.id LEFT JOIN paid p ON p.memberId=m.id
    WHERE m.bookId=? ORDER BY rankNo,m.id`,[...values,bookId]);
  return {period:{from:period.from,to:period.to},expenseTotalFen:categories.reduce((total,row)=>total+BigInt(row.amountFen),0n).toString(),categories,
    members:memberRows.map(row=>({memberId:String(row.memberId),paidFen:String(row.paidFen),shareFen:String(row.shareFen)})),
    ranking:memberRows.map(row=>({memberId:String(row.memberId),amountFen:String(row.shareFen),rankNo:String(row.rankNo)}))};
}
