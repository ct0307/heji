import type { PoolConnection,RowDataPacket } from 'mysql2/promise';
import type { RestoreTimer } from './restore-timing.ts';

const balanceCtes=`WITH active_expenses AS (
  SELECT v.bookId,v.expenseId,v.revision,v.paidByMemberId,v.amountFen
  FROM expenses e JOIN expense_versions v ON v.expenseId=e.id AND v.revision=e.currentRevision AND v.bookId=e.bookId WHERE v.isVoided=0
), paid AS (
  SELECT bookId,paidByMemberId memberId,SUM(amountFen) amountFen FROM active_expenses GROUP BY bookId,paidByMemberId
), shared AS (
  SELECT v.bookId,s.memberId,SUM(s.amountFen) amountFen
  FROM active_expenses v JOIN expense_shares s ON s.bookId=v.bookId AND s.expenseId=v.expenseId AND s.revision=v.revision
  GROUP BY v.bookId,s.memberId
), sent AS (
  SELECT bookId,fromMemberId memberId,SUM(amountFen) amountFen FROM confirmed_transfers GROUP BY bookId,fromMemberId
), received AS (
  SELECT bookId,toMemberId memberId,SUM(amountFen) amountFen FROM confirmed_transfers GROUP BY bookId,toMemberId
), balances AS (
  SELECT m.bookId,m.id memberId,
    COALESCE(p.amountFen,0)-COALESCE(s.amountFen,0)+COALESCE(t.amountFen,0)-COALESCE(r.amountFen,0) balanceFen
  FROM book_members m
  LEFT JOIN paid p ON p.bookId=m.bookId AND p.memberId=m.id
  LEFT JOIN shared s ON s.bookId=m.bookId AND s.memberId=m.id
  LEFT JOIN sent t ON t.bookId=m.bookId AND t.memberId=m.id
  LEFT JOIN received r ON r.bookId=m.bookId AND r.memberId=m.id
)`;

// 每类事实按账本/成员只聚合一次；不筛成员状态，不借用003派生表。
// SUM保持数据库精确数值类型，不转Number，也不直接对UNSIGNED金额取负。
export const memberBalancesSql=balanceCtes+' SELECT bookId,memberId,balanceFen FROM balances';
export const balanceConservationSql=balanceCtes+' SELECT bookId,SUM(balanceFen) total FROM balances GROUP BY bookId HAVING SUM(balanceFen)<>0';

export async function checkBalances(db:Pick<PoolConnection,'query'>,timer?:RestoreTimer){
  // 逐版本核对份额，避免总额恰好相抵掩盖某笔损坏；旧版本也应保持完整。
  const validateHistory=async()=>{const [invalid]=await db.query<RowDataPacket[]>(`SELECT v.expenseId,v.revision FROM expense_versions v
    LEFT JOIN (SELECT expenseId,revision,SUM(amountFen) total,COUNT(*) participants FROM expense_shares GROUP BY expenseId,revision) s
      ON s.expenseId=v.expenseId AND s.revision=v.revision
    WHERE s.total IS NULL OR s.total<>v.amountFen OR s.participants NOT BETWEEN 1 AND 30 LIMIT 1`);
    if(invalid.length)throw new Error('恢复后的支出版本分摊不完整或不守恒')};
  if(timer)await timer.measure('historical_share_conservation',validateHistory);else await validateHistory();
  const validateCurrent=async()=>{const [missing]=await db.query<RowDataPacket[]>('SELECT id FROM expenses WHERE currentRevision IS NULL LIMIT 1');
    if(missing.length)throw new Error('恢复后的支出缺少当前版本')};
  if(timer)await timer.measure('current_revision_present',validateCurrent);else await validateCurrent();
  const validateBalances=async()=>{const [rows]=await db.query<RowDataPacket[]>(balanceConservationSql);
    if(rows.length)throw new Error('恢复后的账本余额不守恒')};
  if(timer)await timer.measure('balance_conservation',validateBalances);else await validateBalances();
}
