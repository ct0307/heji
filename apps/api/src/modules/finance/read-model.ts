import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { BalanceDto, ExpenseDto, FinanceSnapshotDto, ConfirmedTransferDto, TransferRequestDto, BookDto, MemberDto, ReportDto } from '../../../../../packages/contracts/src/index.ts';
import { suggestSettlements } from '../../../../../packages/domain/src/ledger.ts';
import { expenseEtag } from './validation.ts';
import { ApiFault } from '../../shared/errors.ts';
import { summaryAmounts } from './mysql-summaries.ts';

export type Row=RowDataPacket;
export const dateText=(value: unknown)=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
export const timeText=(value: unknown)=>value instanceof Date?value.toISOString():String(value);
export function bookDto(row: Row): BookDto{return {id:String(row.id),name:String(row.name),createdByUserId:String(row.createdByUserId),isArchived:!!row.isArchived,financialVersion:String(row.financialVersion)}}
export async function rows(db: PoolConnection,sql: string,values: (string|number|boolean|null)[]=[]): Promise<Row[]>{return (await db.execute<Row[]>(sql,values))[0]}
export async function allMembers(db: PoolConnection,bookId: string): Promise<MemberDto[]>{
  return (await rows(db,'SELECT m.id,m.userId,m.status,u.displayName FROM book_members m JOIN users u ON u.id=m.userId WHERE m.bookId=? ORDER BY m.id',[bookId]))
    .map(row=>({id:String(row.id),userId:String(row.userId),displayName:String(row.displayName),status:row.status as MemberDto['status']}));
}
export async function expenseVersions(db: PoolConnection,bookId: string,id?: string,history=false,selectedIds?:string[]): Promise<ExpenseDto[]>{
  if(selectedIds&&!selectedIds.length)return [];
  const selection=selectedIds?`AND e.id IN (${selectedIds.map(()=>'?').join(',')})`:'';
  const values=id?[bookId,id]:selectedIds?[bookId,...selectedIds]:[bookId];
  const found=await rows(db,`SELECT e.id,e.createdByMemberId,v.* FROM expenses e JOIN expense_versions v ON v.expenseId=e.id ${history?'':'AND v.revision=e.currentRevision'}
    WHERE e.bookId=? ${id?'AND e.id=?':''} ${selection} ORDER BY ${history?'v.revision DESC':'v.occurredOn DESC,e.id DESC'}`,values);
  if(!found.length)return [];
  const shares=await rows(db,`SELECT s.expenseId,s.revision,s.memberId,s.amountFen FROM expense_shares s JOIN expenses e ON e.id=s.expenseId
    WHERE s.bookId=? ${history?'':'AND s.revision=e.currentRevision'} ${id?'AND s.expenseId=?':''} ${selection} ORDER BY s.memberId`,values);
  const grouped=new Map<string,{memberId: string;amountFen: string}[]>();
  for(const row of shares){const key=row.expenseId+':'+row.revision;const list=grouped.get(key)??[];list.push({memberId:String(row.memberId),amountFen:String(row.amountFen)});grouped.set(key,list)}
  return found.map(row=>({id:String(row.id),bookId:String(row.bookId),createdByMemberId:String(row.createdByMemberId),revision:String(row.revision),etag:expenseEtag(String(row.id),String(row.revision)),
    paidByMemberId:String(row.paidByMemberId),amountFen:String(row.amountFen),splitMode:row.splitMode,category:row.category,occurredOn:dateText(row.occurredOn),note:String(row.note),
    isVoided:!!row.isVoided,changedByMemberId:String(row.changedByMemberId),createdAt:timeText(row.createdAt),shares:grouped.get(row.id+':'+row.revision)??[]}));
}
export function requestDto(row: Row): TransferRequestDto{return {id:String(row.id),bookId:String(row.bookId),kind:row.kind,fromMemberId:String(row.fromMemberId),toMemberId:String(row.toMemberId),amountFen:String(row.amountFen),occurredOn:dateText(row.occurredOn),note:String(row.note),initiatorMemberId:String(row.initiatorMemberId),counterpartyMemberId:String(row.counterpartyMemberId),status:row.status,revision:String(row.revision),reversalOfTransferId:row.reversalOfTransferId?String(row.reversalOfTransferId):null,confirmedTransferId:row.confirmedTransferId?String(row.confirmedTransferId):null,createdAt:timeText(row.createdAt)}}
export async function requests(db: PoolConnection,bookId: string,id?: string,lock=false,pendingOnly=false): Promise<TransferRequestDto[]>{
  return (await rows(db,`SELECT r.*,t.id AS confirmedTransferId FROM transfer_requests r LEFT JOIN confirmed_transfers t ON t.requestId=r.id
    WHERE r.bookId=? ${id?'AND r.id=?':''} ${pendingOnly?"AND r.status='PENDING'":''} ORDER BY r.createdAt DESC,r.id DESC ${lock?'FOR UPDATE':''}`,id?[bookId,id]:[bookId])).map(requestDto);
}
export function transferDto(row: Row): ConfirmedTransferDto{return {id:String(row.id),bookId:String(row.bookId),requestId:String(row.requestId),kind:row.kind,fromMemberId:String(row.fromMemberId),toMemberId:String(row.toMemberId),amountFen:String(row.amountFen),occurredOn:dateText(row.occurredOn),confirmedByMemberId:String(row.confirmedByMemberId),confirmedAt:timeText(row.confirmedAt),reversalOfTransferId:row.reversalOfTransferId?String(row.reversalOfTransferId):null}}
export async function transfers(db: PoolConnection,bookId: string,id?: string,lock=false): Promise<ConfirmedTransferDto[]>{return (await rows(db,`SELECT * FROM confirmed_transfers WHERE bookId=? ${id?'AND id=?':''} ORDER BY confirmedAt DESC,id DESC ${lock?'FOR UPDATE':''}`,id?[bookId,id]:[bookId])).map(transferDto)}

/** 包含退出成员的历史汇总；有效成员上限30不限制账本累计历史成员数。 */
export function balances(members: MemberDto[],expenses: ExpenseDto[],transfers: Pick<ConfirmedTransferDto,'fromMemberId'|'toMemberId'|'amountFen'>[]): BalanceDto[]{
  const totals=new Map(members.map(member=>[member.id,{memberId:member.id,paidFen:0n,shareFen:0n,incomingFen:0n,outgoingFen:0n,balanceFen:0n}]));
  const get=(id: string)=>{const value=totals.get(id);if(!value)throw new Error('财务记录引用账本外成员');return value};
  for(const expense of expenses.filter(x=>!x.isVoided)){get(expense.paidByMemberId).paidFen+=BigInt(expense.amountFen);for(const share of expense.shares)get(share.memberId).shareFen+=BigInt(share.amountFen)}
  for(const transfer of transfers){get(transfer.fromMemberId).outgoingFen+=BigInt(transfer.amountFen);get(transfer.toMemberId).incomingFen+=BigInt(transfer.amountFen)}
  return [...totals.values()].map(row=>({...row,paidFen:row.paidFen.toString(),shareFen:row.shareFen.toString(),incomingFen:row.incomingFen.toString(),outgoingFen:row.outgoingFen.toString(),balanceFen:(row.paidFen-row.shareFen+row.outgoingFen-row.incomingFen).toString()}));
}
export async function model(db: PoolConnection,book: Row,memberId: string,useSummaries=false){
  const id=String(book.id),members=await allMembers(db,id),pending=await requests(db,id,undefined,false,true);
  // 聚合留在数据库；当前有效版本及已确认转账与授权共用同一个RR快照。
  const amounts=useSummaries?await summaryAmounts(db,id):await rows(db,`WITH current_expenses AS (
    SELECT e.id,e.currentRevision,v.paidByMemberId,v.amountFen FROM expenses e
    JOIN expense_versions v ON v.expenseId=e.id AND v.revision=e.currentRevision AND v.bookId=e.bookId
    WHERE e.bookId=? AND v.isVoided=0
  ), paid AS (SELECT paidByMemberId memberId,SUM(amountFen) paidFen FROM current_expenses GROUP BY paidByMemberId),
  shares AS (SELECT s.memberId,SUM(s.amountFen) shareFen FROM current_expenses v
    JOIN expense_shares s ON s.expenseId=v.id AND s.revision=v.currentRevision AND s.bookId=? GROUP BY s.memberId),
  outgoing AS (SELECT fromMemberId memberId,SUM(amountFen) outgoingFen FROM confirmed_transfers WHERE bookId=? GROUP BY fromMemberId),
  incoming AS (SELECT toMemberId memberId,SUM(amountFen) incomingFen FROM confirmed_transfers WHERE bookId=? GROUP BY toMemberId)
  SELECT m.id memberId,COALESCE(p.paidFen,0) paidFen,COALESCE(s.shareFen,0) shareFen,
    COALESCE(o.outgoingFen,0) outgoingFen,COALESCE(i.incomingFen,0) incomingFen
  FROM book_members m LEFT JOIN paid p ON p.memberId=m.id LEFT JOIN shares s ON s.memberId=m.id
    LEFT JOIN outgoing o ON o.memberId=m.id LEFT JOIN incoming i ON i.memberId=m.id WHERE m.bookId=? ORDER BY m.id`,[id,id,id,id,id]);
  const summary:BalanceDto[]=amounts.map(row=>({memberId:String(row.memberId),paidFen:String(row.paidFen),shareFen:String(row.shareFen),outgoingFen:String(row.outgoingFen),incomingFen:String(row.incomingFen),
    balanceFen:(BigInt(row.paidFen)-BigInt(row.shareFen)+BigInt(row.outgoingFen)-BigInt(row.incomingFen)).toString()}));
  const active=new Set(members.filter(x=>x.status==='ACTIVE').map(x=>x.id));
  const pendingCount=pending.filter(x=>x.status==='PENDING').length;
  const snapshot: FinanceSnapshotDto={financialVersion:String(book.financialVersion),memberId,balances:summary,
    suggestions:suggestSettlements(summary.filter(x=>active.has(x.memberId)).map(x=>({memberId:x.memberId,balanceFen:BigInt(x.balanceFen)}))).map(x=>({...x,amountFen:x.amountFen.toString()})),
    expenseTotalFen:summary.reduce((sum,x)=>sum+BigInt(x.paidFen),0n).toString(),pendingCount,isSettled:pendingCount===0&&summary.every(x=>x.balanceFen==='0')};
  return {members,pending,snapshot};
}
/** 预览仅在当前汇总上模拟待确认转账，正式余额仍只包含已确认事实。 */
export function previewBalances(summary:BalanceDto[],request:TransferRequestDto):BalanceDto[]{
  return summary.map(row=>{
    const outgoing=BigInt(row.outgoingFen)+(request.status==='PENDING'&&row.memberId===request.fromMemberId?BigInt(request.amountFen):0n);
    const incoming=BigInt(row.incomingFen)+(request.status==='PENDING'&&row.memberId===request.toMemberId?BigInt(request.amountFen):0n);
    return {...row,outgoingFen:outgoing.toString(),incomingFen:incoming.toString(),balanceFen:(BigInt(row.paidFen)-BigInt(row.shareFen)+outgoing-incoming).toString()};
  });
}
export function report(snapshot: FinanceSnapshotDto,expenses: ExpenseDto[]): ReportDto {
  const categories: ReportDto['categories']=['FOOD','TRANSPORT','HOUSING','OTHER'].map(category=>({category:category as ReportDto['categories'][number]['category'],amountFen:expenses.filter(x=>!x.isVoided&&x.category===category).reduce((sum,x)=>sum+BigInt(x.amountFen),0n).toString()}));
  const totals=[...new Set(snapshot.balances.map(x=>x.shareFen))].sort((a,b)=>BigInt(a)>BigInt(b)?-1:BigInt(a)<BigInt(b)?1:0);
  return {period:{from:null,to:null},ranking:snapshot.balances.map(row=>({memberId:row.memberId,amountFen:row.shareFen,rankNo:String(totals.indexOf(row.shareFen)+1)})),expenseTotalFen:snapshot.expenseTotalFen,categories,members:snapshot.balances.map(({memberId,paidFen,shareFen})=>({memberId,paidFen,shareFen}))};
}
export function requireFound<T>(value: T|undefined): T {if(!value)throw new ApiFault(404,'RESOURCE_NOT_FOUND','记录不存在');return value}
