/** ADR-02：接口中的金额和版本保持十进制字符串，不能序列化 BigInt。 */
export interface ApiError { error: { code: string; message: string; requestId: string } }
export interface ApiSuccess<T> { data: T }
export interface UserDto { id: string; email: string; displayName: string }
export interface BookDto { id: string; name: string; createdByUserId: string; isArchived: boolean; financialVersion: string }
export interface MemberDto { id: string; userId: string; displayName: string; status: 'ACTIVE'|'LEFT' }
export interface InvitationPreviewDto { bookId: string; bookName: string; alreadyJoined: boolean; rejoining: boolean }
export type TransferStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED';
export interface ShareDto { memberId: string; amountFen: string }
export interface BalanceDto {
  memberId: string; paidFen: string; shareFen: string;
  incomingFen: string; outgoingFen: string; balanceFen: string;
}
export interface SettlementSuggestionDto {
  financialVersion: string;
  suggestions: { fromMemberId: string; toMemberId: string; amountFen: string }[];
}
export type SplitMode = 'EQUAL'|'EXACT';
export type ExpenseCategory = 'FOOD'|'TRANSPORT'|'HOUSING'|'OTHER';
export interface ExpenseValues {
  paidByMemberId: string; amountFen: string; splitMode: SplitMode; shares: ShareDto[];
  category: ExpenseCategory; occurredOn: string; note: string;
}
export interface ExpenseDto extends ExpenseValues {
  id: string; bookId: string; createdByMemberId: string; revision: string; etag: string;
  isVoided: boolean; changedByMemberId: string; createdAt: string;
}
export interface ExpensePageDto { items: ExpenseDto[]; nextCursor: string|null }
export interface ConfirmedTransferDto {
  id: string; bookId: string; requestId: string; kind: 'NORMAL'|'REVERSAL';
  fromMemberId: string; toMemberId: string; amountFen: string; occurredOn: string;
  confirmedByMemberId: string; confirmedAt: string; reversalOfTransferId: string|null;
}
export interface TransferRequestDto {
  id: string; bookId: string; kind: 'NORMAL'|'REVERSAL'; fromMemberId: string; toMemberId: string;
  amountFen: string; occurredOn: string; note: string; initiatorMemberId: string;
  counterpartyMemberId: string; status: TransferStatus; revision: string;
  reversalOfTransferId: string|null; confirmedTransferId: string|null; createdAt: string;
}
export interface FinanceSnapshotDto {
  financialVersion: string; memberId: string; balances: BalanceDto[]; suggestions: SettlementSuggestionDto['suggestions'];
  expenseTotalFen: string; pendingCount: number; isSettled: boolean;
}
export interface TransferPreviewDto {
  request: TransferRequestDto; expectedFinancialVersion: string; expectedRequestRevision: string;
  beforeBalances: BalanceDto[]; afterBalances: BalanceDto[]; warnings: string[];
}
export interface ConfirmationDto { request: TransferRequestDto; transfer: ConfirmedTransferDto; snapshot: FinanceSnapshotDto }
export interface SettlementWindowDto {
  supported:boolean;state:'NONE'|'ACTIVE'|'CLOSED'|'EXPIRED';serverTime:string;
  windowId:string|null;requestId:string|null;createdAt:string|null;expiresAt:string|null;closedAt:string|null;cooldownUntil:string|null;
  mine:boolean;canClose:boolean;
}
export interface SettlementWindowPreviewDto {window:SettlementWindowDto;preview:TransferPreviewDto}
export interface ReportDto {
  expenseTotalFen: string; categories: {category: ExpenseCategory; amountFen: string}[];
  members: {memberId: string; paidFen: string; shareFen: string}[];
  period: {from: string|null; to: string|null};
  ranking: {memberId: string; amountFen: string; rankNo: string}[];
}
/** 失效通知只提示重新读取，不能包含备注、金额、会话或可作为余额真值的内容。 */
export interface BookChangedEvent {
  type:'BOOK_CHANGED'; eventId:string; bookId:string; entityType:string; entityId:string;
  financialVersion:string; revision?:string;
}
