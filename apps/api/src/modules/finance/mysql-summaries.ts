import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ConfirmedTransferDto, ExpenseCategory, ExpenseDto, ReportDto } from '../../../../../packages/contracts/src/index.ts';
import { rows } from './read-model.ts';
import { reportPeriod } from './report-query.ts';

type TransferAmounts=Pick<ConfirmedTransferDto,'bookId'|'fromMemberId'|'toMemberId'|'amountFen'>;
interface MemberDelta {bookId:string;memberId:string;paidFen:string;shareFen:string;outgoingFen:string;incomingFen:string}
interface DailyMemberDelta {bookId:string;occurredOn:string;memberId:string;paidFen:string;shareFen:string}
interface CategoryDelta {bookId:string;occurredOn:string;category:ExpenseCategory;amountFen:string}
export interface ExpenseSummaryDelta {members:MemberDelta[];dailyMembers:DailyMemberDelta[];dailyCategories:CategoryDelta[]}
type MutableMember={bookId:string;memberId:string;paidFen:bigint;shareFen:bigint;outgoingFen:bigint;incomingFen:bigint};
type MutableDaily={bookId:string;occurredOn:string;memberId:string;paidFen:bigint;shareFen:bigint};
type MutableCategory={bookId:string;occurredOn:string;category:ExpenseCategory;amountFen:bigint};
const key=(...parts:string[])=>JSON.stringify(parts);
const emptyMember=(bookId:string,memberId:string):MutableMember=>({bookId,memberId,paidFen:0n,shareFen:0n,outgoingFen:0n,incomingFen:0n});
const memberStrings=(row:MutableMember):MemberDelta=>({...row,paidFen:row.paidFen.toString(),shareFen:row.shareFen.toString(),outgoingFen:row.outgoingFen.toString(),incomingFen:row.incomingFen.toString()});

/** 同一主键先合并净增量；备注、版本和分类变化不会误写全量余额。 */
export function expenseSummaryDelta(previous:ExpenseDto|undefined,next:ExpenseDto):ExpenseSummaryDelta {
  const members=new Map<string,MutableMember>(),dailyMembers=new Map<string,MutableDaily>(),dailyCategories=new Map<string,MutableCategory>();
  function contribute(expense:ExpenseDto|undefined,sign:bigint) {
    if(!expense||expense.isVoided)return;
    const {bookId,occurredOn,category}=expense;
    function addMember(memberId:string,paidFen:bigint,shareFen:bigint) {
      const memberKey=key(bookId,memberId),member=members.get(memberKey)??emptyMember(bookId,memberId);
      member.paidFen+=paidFen;member.shareFen+=shareFen;members.set(memberKey,member);
      const dailyKey=key(bookId,occurredOn,memberId),daily=dailyMembers.get(dailyKey)??{bookId,occurredOn,memberId,paidFen:0n,shareFen:0n};
      daily.paidFen+=paidFen;daily.shareFen+=shareFen;dailyMembers.set(dailyKey,daily);
    }
    const amount=sign*BigInt(expense.amountFen);
    addMember(expense.paidByMemberId,amount,0n);
    for(const share of expense.shares)addMember(share.memberId,0n,sign*BigInt(share.amountFen));
    const categoryKey=key(bookId,occurredOn,category),daily=dailyCategories.get(categoryKey)??{bookId,occurredOn,category,amountFen:0n};
    daily.amountFen+=amount;dailyCategories.set(categoryKey,daily);
  }
  contribute(previous,-1n);contribute(next,1n);
  const sorted=<T>(map:Map<string,T>)=>[...map.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,value])=>value);
  return {
    members:sorted(members).filter(row=>row.paidFen!==0n||row.shareFen!==0n).map(memberStrings),
    dailyMembers:sorted(dailyMembers).filter(row=>row.paidFen!==0n||row.shareFen!==0n).map(row=>({...row,paidFen:row.paidFen.toString(),shareFen:row.shareFen.toString()})),
    dailyCategories:sorted(dailyCategories).filter(row=>row.amountFen!==0n).map(row=>({...row,amountFen:row.amountFen.toString()})),
  };
}

/** 冲正自身就是反向已确认事实；调用方在首次真正入账时调用一次。 */
export function transferSummaryDelta(transfer:TransferAmounts):MemberDelta[] {
  const members=new Map<string,MutableMember>();
  const get=(memberId:string)=>{let member=members.get(memberId);if(!member){member=emptyMember(transfer.bookId,memberId);members.set(memberId,member)}return member};
  get(transfer.fromMemberId).outgoingFen+=BigInt(transfer.amountFen);
  get(transfer.toMemberId).incomingFen+=BigInt(transfer.amountFen);
  return [...members.values()].filter(row=>row.outgoingFen!==0n||row.incomingFen!==0n).sort((a,b)=>a.memberId<b.memberId?-1:a.memberId>b.memberId?1:0).map(memberStrings);
}

// 表名和列名只能来自下方固定定义，所有业务数据均通过参数绑定。
async function upsertMembers(db:PoolConnection,deltas:MemberDelta[]):Promise<void> {
  if(!deltas.length)return;
  await db.execute(`INSERT INTO finance_member_totals(bookId,memberId,paidFen,shareFen,outgoingFen,incomingFen) VALUES ${deltas.map(()=>'(?,?,?,?,?,?)').join(',')}
    ON DUPLICATE KEY UPDATE paidFen=paidFen+VALUES(paidFen),shareFen=shareFen+VALUES(shareFen),outgoingFen=outgoingFen+VALUES(outgoingFen),incomingFen=incomingFen+VALUES(incomingFen)`,
    deltas.flatMap(row=>[row.bookId,row.memberId,row.paidFen,row.shareFen,row.outgoingFen,row.incomingFen]));
}

/** 必须复用事实写入事务和账本锁；有符号候选值在事务提交前得到非负真实汇总。 */
export async function applyExpenseSummary(db:PoolConnection,previous:ExpenseDto|undefined,next:ExpenseDto):Promise<void> {
  const delta=expenseSummaryDelta(previous,next);
  await upsertMembers(db,delta.members);
  if(delta.dailyMembers.length)await db.execute(`INSERT INTO finance_daily_members(bookId,occurredOn,memberId,paidFen,shareFen) VALUES ${delta.dailyMembers.map(()=>'(?,?,?,?,?)').join(',')}
    ON DUPLICATE KEY UPDATE paidFen=paidFen+VALUES(paidFen),shareFen=shareFen+VALUES(shareFen)`,
    delta.dailyMembers.flatMap(row=>[row.bookId,row.occurredOn,row.memberId,row.paidFen,row.shareFen]));
  if(delta.dailyCategories.length)await db.execute(`INSERT INTO finance_daily_categories(bookId,occurredOn,category,amountFen) VALUES ${delta.dailyCategories.map(()=>'(?,?,?,?)').join(',')}
    ON DUPLICATE KEY UPDATE amountFen=amountFen+VALUES(amountFen)`,
    delta.dailyCategories.flatMap(row=>[row.bookId,row.occurredOn,row.category,row.amountFen]));
}
export async function applyTransferSummary(db:PoolConnection,transfer:TransferAmounts):Promise<void> {
  await upsertMembers(db,transferSummaryDelta(transfer));
}

/** 从成员出发保留全部历史成员；新成员尚无派生行时按零读取。 */
export async function summaryAmounts(db:PoolConnection,bookId:string):Promise<RowDataPacket[]> {
  return rows(db,`SELECT m.id memberId,COALESCE(t.paidFen,0) paidFen,COALESCE(t.shareFen,0) shareFen,
    COALESCE(t.outgoingFen,0) outgoingFen,COALESCE(t.incomingFen,0) incomingFen
    FROM book_members m LEFT JOIN finance_member_totals t ON t.bookId=m.bookId AND t.memberId=m.id
    WHERE m.bookId=? ORDER BY m.id`,[bookId]);
}

export async function summaryPeriodReport(db:PoolConnection,bookId:string,query:Record<string,unknown>):Promise<ReportDto> {
  const period=reportPeriod(query),where=['bookId=?'],values:string[]=[bookId];
  if(period.from){where.push('occurredOn>=?');values.push(period.from)}
  if(period.until){where.push('occurredOn<?');values.push(period.until)}
  else if(period.to){where.push('occurredOn<=?');values.push(period.to)}
  const categoryRows=await rows(db,`SELECT category,SUM(amountFen) amountFen FROM finance_daily_categories WHERE ${where.join(' AND ')} GROUP BY category`,values);
  const categories:ReportDto['categories']=(['FOOD','TRANSPORT','HOUSING','OTHER'] as ExpenseCategory[]).map(category=>({category,amountFen:String(categoryRows.find(row=>row.category===category)?.amountFen??'0')}));
  // 单次引用日期成员表，同时聚合付款与份额，兼容连接级临时表。
  const memberRows=await rows(db,`WITH period_members AS (
    SELECT memberId,SUM(paidFen) paidFen,SUM(shareFen) shareFen FROM finance_daily_members WHERE ${where.join(' AND ')} GROUP BY memberId)
    SELECT m.id memberId,COALESCE(p.paidFen,0) paidFen,COALESCE(p.shareFen,0) shareFen,
      DENSE_RANK() OVER (ORDER BY COALESCE(p.shareFen,0) DESC) rankNo
    FROM book_members m LEFT JOIN period_members p ON p.memberId=m.id WHERE m.bookId=? ORDER BY rankNo,m.id`,[...values,bookId]);
  return {period:{from:period.from,to:period.to},expenseTotalFen:categories.reduce((total,row)=>total+BigInt(row.amountFen),0n).toString(),categories,
    members:memberRows.map(row=>({memberId:String(row.memberId),paidFen:String(row.paidFen),shareFen:String(row.shareFen)})),
    ranking:memberRows.map(row=>({memberId:String(row.memberId),amountFen:String(row.shareFen),rankNo:String(row.rankNo)}))};
}

/** 只用于初建空表，调用方须停写并在同一事务中执行；失败回滚，不清理残留。 */
export async function backfillSummaries(db:PoolConnection):Promise<void> {
  for(const table of ['finance_member_totals','finance_daily_members','finance_daily_categories'] as const){
    if((await rows(db,`SELECT 1 present FROM ${table} LIMIT 1`)).length)throw new Error('汇总初建回填要求三个汇总表全部为空');
  }
  const current=`FROM expenses e JOIN expense_versions v ON v.bookId=e.bookId AND v.expenseId=e.id AND v.revision=e.currentRevision WHERE v.isVoided=0`;
  // 原始事实可重复扫描；同一语句不重复打开任一临时汇总表。
  await db.execute(`INSERT INTO finance_daily_members(bookId,occurredOn,memberId,paidFen,shareFen)
    SELECT bookId,occurredOn,memberId,SUM(paidFen),SUM(shareFen) FROM (
      SELECT v.bookId,v.occurredOn,v.paidByMemberId memberId,CAST(v.amountFen AS DECIMAL(65,0)) paidFen,CAST(0 AS DECIMAL(65,0)) shareFen ${current}
      UNION ALL SELECT v.bookId,v.occurredOn,s.memberId,CAST(0 AS DECIMAL(65,0)),CAST(s.amountFen AS DECIMAL(65,0))
      FROM expenses e JOIN expense_versions v ON v.bookId=e.bookId AND v.expenseId=e.id AND v.revision=e.currentRevision
      JOIN expense_shares s ON s.bookId=v.bookId AND s.expenseId=v.expenseId AND s.revision=v.revision WHERE v.isVoided=0
    ) contributions GROUP BY bookId,occurredOn,memberId`);
  await db.execute(`INSERT INTO finance_daily_categories(bookId,occurredOn,category,amountFen)
    SELECT v.bookId,v.occurredOn,v.category,SUM(CAST(v.amountFen AS DECIMAL(65,0))) ${current} GROUP BY v.bookId,v.occurredOn,v.category`);
  await db.execute(`INSERT INTO finance_member_totals(bookId,memberId,paidFen,shareFen,outgoingFen,incomingFen)
    SELECT bookId,memberId,SUM(paidFen),SUM(shareFen),SUM(outgoingFen),SUM(incomingFen) FROM (
      SELECT v.bookId,v.paidByMemberId memberId,CAST(v.amountFen AS DECIMAL(65,0)) paidFen,CAST(0 AS DECIMAL(65,0)) shareFen,CAST(0 AS DECIMAL(65,0)) outgoingFen,CAST(0 AS DECIMAL(65,0)) incomingFen ${current}
      UNION ALL SELECT v.bookId,s.memberId,CAST(0 AS DECIMAL(65,0)),CAST(s.amountFen AS DECIMAL(65,0)),CAST(0 AS DECIMAL(65,0)),CAST(0 AS DECIMAL(65,0))
      FROM expenses e JOIN expense_versions v ON v.bookId=e.bookId AND v.expenseId=e.id AND v.revision=e.currentRevision
      JOIN expense_shares s ON s.bookId=v.bookId AND s.expenseId=v.expenseId AND s.revision=v.revision WHERE v.isVoided=0
      UNION ALL SELECT bookId,fromMemberId,CAST(0 AS DECIMAL(65,0)),CAST(0 AS DECIMAL(65,0)),CAST(amountFen AS DECIMAL(65,0)),CAST(0 AS DECIMAL(65,0)) FROM confirmed_transfers
      UNION ALL SELECT bookId,toMemberId,CAST(0 AS DECIMAL(65,0)),CAST(0 AS DECIMAL(65,0)),CAST(0 AS DECIMAL(65,0)),CAST(amountFen AS DECIMAL(65,0)) FROM confirmed_transfers
    ) contributions GROUP BY bookId,memberId`);
}
