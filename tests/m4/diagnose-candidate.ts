import { fixturePool } from './database.ts';
import { bookId } from './seed.ts';
const pool=await fixturePool();
try {
  for(const sql of [
    `SELECT s.expenseId,s.revision,s.memberId,s.amountFen FROM expense_shares s JOIN expenses e ON e.id=s.expenseId WHERE s.bookId=? AND s.revision=e.currentRevision ORDER BY s.expenseId,s.revision,s.memberId`,
    `SELECT s.memberId,SUM(s.amountFen) shareFen FROM expense_shares s USE INDEX (PRIMARY) STRAIGHT_JOIN expenses e ON e.id=s.expenseId AND e.currentRevision=s.revision AND e.bookId=s.bookId STRAIGHT_JOIN expense_versions v ON v.expenseId=e.id AND v.revision=e.currentRevision WHERE s.bookId=? AND v.isVoided=0 GROUP BY s.memberId`,
    `SELECT s.memberId,SUM(s.amountFen) shareFen FROM expense_shares s JOIN (SELECT e.id,e.currentRevision FROM expenses e JOIN expense_versions v ON v.expenseId=e.id AND v.revision=e.currentRevision WHERE e.bookId=? AND v.isVoided=0 LIMIT 18446744073709551615) c ON c.id=s.expenseId AND c.currentRevision=s.revision GROUP BY s.memberId`
  ]){
    const start=performance.now();const [result]=await pool.query(sql,[bookId(0)]);console.log(`候选 ${Math.round(performance.now()-start)}ms`);
    const [plan]=await pool.query('EXPLAIN ANALYZE '+sql,[bookId(0)]);console.log(JSON.stringify(plan));
  }
}finally{await pool.end()}
