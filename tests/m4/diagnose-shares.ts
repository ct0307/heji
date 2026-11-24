import { writeFile } from 'node:fs/promises';
import { fixturePool } from './database.ts';
import { bookId } from './seed.ts';
const pool=await fixturePool();
try {
  const sql=`SELECT s.expenseId,s.revision,s.memberId,s.amountFen FROM expense_shares s JOIN expenses e ON e.id=s.expenseId WHERE s.bookId=? AND s.revision=e.currentRevision ORDER BY s.memberId`;
  const [plan]=await pool.query('EXPLAIN ANALYZE '+sql,[bookId(0)]);
  console.log(JSON.stringify(plan));
  await writeFile(new URL('../../docs/development/evidence/m4-shares-before.json',import.meta.url),JSON.stringify({sql,plan},null,2),'utf8');
} finally {await pool.end()}
