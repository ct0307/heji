/** FR-05/06：领域层只处理整数分，不依赖 HTTP 或数据库。 */
export const MAX_AMOUNT_FEN = 100000000n;
export interface Share { memberId: string; amountFen: bigint }
export interface Expense { paidBy: string; amountFen: bigint; shares: readonly Share[] }
/** 仅允许仓储返回已确认的事实；待确认请求不得传入此集合。 */
export interface ConfirmedTransfer { fromMemberId: string; toMemberId: string; amountFen: bigint }
export interface Balance {
  memberId: string; paidFen: bigint; shareFen: bigint;
  outgoingFen: bigint; incomingFen: bigint; balanceFen: bigint;
}
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function validateAmount(amount: bigint): void {
  if (typeof amount !== 'bigint' || amount < 1n || amount > MAX_AMOUNT_FEN) throw new Error('金额须为1至100000000整数分');
}
function memberIds(ids: readonly string[]): string[] {
  if (!ids.length || ids.length > 30 || ids.some(id=>typeof id !== 'string' || !id.trim() || id !== id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('成员须为1至30位且ID不可为空或重复');
  }
  return [...ids].sort(compareId);
}
export function parseYuan(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value) || value.length>16) throw new Error('请输入最多两位小数的规范金额');
  const [whole, fraction=''] = value.split('.');
  const amount = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2,'0'));
  validateAmount(amount);
  return amount;
}
export function parseFen(value: string): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,8}$/.test(value)) throw new Error('金额须为规范整数分字符串');
  const amount=BigInt(value);
  validateAmount(amount);
  return amount;
}
export function formatYuan(amount: bigint): string {
  const value=amount<0n?-amount:amount;
  return `${amount<0n?'-':''}${value/100n}.${String(value%100n).padStart(2,'0')}`;
}
export function splitEqual(amount: bigint, ids: readonly string[]): Share[] {
  validateAmount(amount);
  const sorted=memberIds(ids), count=BigInt(sorted.length);
  return sorted.map((memberId,index)=>({memberId,amountFen:amount/count+(BigInt(index)<amount%count?1n:0n)}));
}
export function splitCustom(amount: bigint, shares: readonly Share[]): Share[] {
  validateAmount(amount);
  memberIds(shares.map(x=>x.memberId));
  if(shares.some(x=>typeof x.amountFen!=='bigint' || x.amountFen<0n) || shares.reduce((s,x)=>s+x.amountFen,0n)!==amount) throw new Error('分摊份额须非负且合计等于总额');
  return shares.map(x=>({...x})).sort((a,b)=>compareId(a.memberId,b.memberId));
}
/** 调用方须提供当前有效支出版本、已确认转账及独立反向冲正。 */
export function calculateBalances(ids: readonly string[], expenses: readonly Expense[], confirmedTransfers: readonly ConfirmedTransfer[]): Balance[] {
  const rows=new Map(memberIds(ids).map(memberId=>[memberId,{memberId,paidFen:0n,shareFen:0n,outgoingFen:0n,incomingFen:0n,balanceFen:0n}]));
  function get(id: string): Balance { const row=rows.get(id); if(!row)throw new Error('记录引用了账本外成员'); return row; }
  for(const expense of expenses) {
    const shares=splitCustom(expense.amountFen,expense.shares);
    get(expense.paidBy).paidFen+=expense.amountFen;
    for(const share of shares)get(share.memberId).shareFen+=share.amountFen;
  }
  for(const transfer of confirmedTransfers) {
    validateAmount(transfer.amountFen);
    if(transfer.fromMemberId===transfer.toMemberId)throw new Error('不能向自己转账');
    get(transfer.fromMemberId).outgoingFen+=transfer.amountFen;
    get(transfer.toMemberId).incomingFen+=transfer.amountFen;
  }
  for(const row of rows.values()) row.balanceFen=row.paidFen-row.shareFen+row.outgoingFen-row.incomingFen;
  return [...rows.values()];
}
export function suggestSettlements(balances: readonly Pick<Balance,'memberId'|'balanceFen'>[]): ConfirmedTransfer[] {
  memberIds(balances.map(x=>x.memberId));
  if(balances.reduce((s,x)=>s+x.balanceFen,0n)!==0n)throw new Error('余额快照不守恒');
  const sorted=[...balances].sort((a,b)=>compareId(a.memberId,b.memberId));
  const creditors=sorted.filter(x=>x.balanceFen>0n).map(x=>({id:x.memberId,left:x.balanceFen}));
  const debtors=sorted.filter(x=>x.balanceFen<0n).map(x=>({id:x.memberId,left:-x.balanceFen}));
  const suggestions: ConfirmedTransfer[]=[];
  let i=0,j=0;
  while(i<debtors.length && j<creditors.length) {
    const from=debtors[i]!, to=creditors[j]!, remainder=from.left<to.left?from.left:to.left;
    const amountFen=remainder>MAX_AMOUNT_FEN?MAX_AMOUNT_FEN:remainder;
    suggestions.push({fromMemberId:from.id,toMemberId:to.id,amountFen});
    from.left-=amountFen; to.left-=amountFen;
    if(from.left===0n)i++;
    if(to.left===0n)j++;
  }
  return suggestions;
}
