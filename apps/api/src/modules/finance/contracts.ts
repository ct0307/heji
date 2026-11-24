export type FinanceView = 'snapshot'|'expenses'|'expense'|'expenseHistory'|'requests'|'preview'|'transfers'|'report'|'audit'|'window';
export type FinanceOperation = 'expense.create'|'expense.patch'|'expense.void'|'request.create'|'request.confirm'|'request.reject'|'request.cancel'|'transfer.reverse'|'member.leave'|'member.remove'|'book.archive'|'book.restore'|'window.open'|'window.close';
export interface FinanceResult { data: unknown; status?: number; etag?: string; location?: string }
export interface WriteContext { idempotencyKey: string|undefined; ifMatch?: string; resourceId?: string }
export interface FinanceStore {
  read(actorId: string,bookId: string,view: FinanceView,resourceId?: string,query?: Record<string,unknown>): Promise<FinanceResult>;
  execute(actorId: string,bookId: string,operation: FinanceOperation,input: unknown,context: WriteContext): Promise<FinanceResult>;
}
