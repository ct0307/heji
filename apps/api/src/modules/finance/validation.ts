import { createHash } from 'node:crypto';
import { ApiFault } from '../../shared/errors.ts';
import { bodyObject, uuid } from '../identity/security.ts';
import { parseFen, splitEqual, splitCustom, MAX_AMOUNT_FEN } from '../../../../../packages/domain/src/ledger.ts';
import type { ExpenseValues, ShareDto } from '../../../../../packages/contracts/src/index.ts';

const expenseFields=['paidByMemberId','amountFen','splitMode','participantMemberIds','shares','category','occurredOn','note'];
function invalid(message: string): never {throw new ApiFault(422,'INVALID_INPUT',message)}
export function memberId(value: unknown): string {try{return uuid(value)}catch{return invalid('成员标识无效')}}
export function amount(value: unknown): string {try{return parseFen(value as string).toString()}catch{throw new ApiFault(422,'INVALID_AMOUNT','金额须为1至100000000的规范整数分字符串')}}
export function businessDate(value: unknown): string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1000-01-01')return invalid('日期格式应为年-月-日');
  const date=new Date(value+'T00:00:00Z');
  if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==value)return invalid('日期不存在');return value;
}
export function note(value: unknown): string {if(value===undefined)return '';if(typeof value!=='string'||value.length>1000)return invalid('说明不能超过1000个字符');return value.trim()}
export function version(value: unknown): string {if(typeof value!=='string'||!/^(0|[1-9]\d{0,19})$/.test(value)||BigInt(value)>18446744073709551615n)return invalid('版本必须为规范整数字符串');return value}
export function normalizeExpense(value: unknown,previous?: ExpenseValues): ExpenseValues {
  const patch=bodyObject(value,expenseFields);
  if(previous&&!Object.keys(patch).length)return invalid('请填写要修改的内容');
  const merged={...previous,...patch};
  const paidByMemberId=memberId(merged.paidByMemberId),amountFen=amount(merged.amountFen);
  if(!['EQUAL','EXACT'].includes(merged.splitMode as string))return invalid('请选择均分或指定金额');
  if(!['FOOD','TRANSPORT','HOUSING','OTHER'].includes(merged.category as string))return invalid('分类无效');
  let shares: ShareDto[];
  if(merged.splitMode==='EQUAL'){
    if('shares' in patch)return invalid('均分模式不能提交分摊金额');
    const ids=patch.participantMemberIds??(previous?.splitMode==='EQUAL'?previous.shares.map(x=>x.memberId):undefined);
    if(!Array.isArray(ids))return invalid('请选择参与分摊的成员');
    try{shares=splitEqual(BigInt(amountFen),ids.map(memberId)).map(x=>({...x,amountFen:x.amountFen.toString()}))}catch(error){if(error instanceof ApiFault)throw error;return invalid('分摊成员须为1至30位且不能重复')}
  }else{
    if(patch.participantMemberIds!==undefined)return invalid('指定金额模式不能同时提交均分成员');
    if(!Array.isArray(merged.shares))return invalid('请填写指定分摊金额');
    const raw=merged.shares.map(value=>{
      const item=bodyObject(value,['memberId','amountFen']);
      if(typeof item.amountFen!=='string'||!/^(0|[1-9]\d{0,8})$/.test(item.amountFen)||BigInt(item.amountFen)>MAX_AMOUNT_FEN)return invalid('分摊金额须为非负整数分');
      return {memberId:memberId(item.memberId),amountFen:BigInt(item.amountFen)};
    });
    try{shares=splitCustom(BigInt(amountFen),raw).map(x=>({...x,amountFen:x.amountFen.toString()}))}catch{throw new ApiFault(422,'SPLIT_SUM_MISMATCH','分摊成员不能重复，且合计必须等于支出金额')}
  }
  return {paidByMemberId,amountFen,splitMode:merged.splitMode as ExpenseValues['splitMode'],shares,category:merged.category as ExpenseValues['category'],occurredOn:businessDate(merged.occurredOn),note:note(merged.note)};
}
export function expenseEtag(id: string,revision: string){return '"'+createHash('sha256').update(id+':'+revision).digest('hex')+'"'}
/** 逐个解析entity-tag，不把带逗号的不透明标签拆断，也不从标签提取版本号。 */
export function parseIfMatch(value: string|undefined): string[] {
  if(value===undefined)throw new ApiFault(428,'PRECONDITION_REQUIRED','请先读取最新支出后再修改');
  if(value.trim()==='*')throw new ApiFault(400,'SPECIFIC_ETAG_REQUIRED','修改必须指定具体支出版本');
  let rest=value.trim();const strong: string[]=[];
  if(!rest)throw new ApiFault(400,'INVALID_CONDITIONAL_HEADER','If-Match格式无效');
  while(rest){
    const match=/^(W\/)?("[\x21\x23-\x7E\x80-\xFF]*")/.exec(rest);
    if(!match)throw new ApiFault(400,'INVALID_CONDITIONAL_HEADER','If-Match格式无效');
    if(!match[1])strong.push(match[2]!);
    rest=rest.slice(match[0].length).replace(/^[ \t]*/,'');
    if(!rest)break;
    if(!rest.startsWith(','))throw new ApiFault(400,'INVALID_CONDITIONAL_HEADER','If-Match格式无效');
    rest=rest.slice(1).replace(/^[ \t]*/,'');
    if(!rest)throw new ApiFault(400,'INVALID_CONDITIONAL_HEADER','If-Match格式无效');
  }
  return strong;
}
export function idempotencyKey(value: string|undefined): string {
  if(!value||!/^[A-Za-z0-9_-]{8,128}$/.test(value))throw new ApiFault(400,'IDEMPOTENCY_KEY_REQUIRED','本次提交需要有效的幂等标识');return value;
}
function canonical(value: unknown): unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)]));
  return value;
}
export function requestDigest(value: unknown): string {return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}
export function parseTransfer(value: unknown){const body=bodyObject(value,['toMemberId','amountFen','occurredOn','note']);return {toMemberId:memberId(body.toMemberId),amountFen:amount(body.amountFen),occurredOn:businessDate(body.occurredOn),note:note(body.note)}}
export function parseConfirmation(value: unknown){const body=bodyObject(value,['expectedRequestRevision','expectedFinancialVersion','expectedWindowId']);return {expectedRequestRevision:version(body.expectedRequestRevision),expectedFinancialVersion:version(body.expectedFinancialVersion),...(body.expectedWindowId!==undefined?{expectedWindowId:uuid(body.expectedWindowId)}:{})}}
export function parseAction(value: unknown){const body=bodyObject(value,['expectedRequestRevision']);return {expectedRequestRevision:version(body.expectedRequestRevision)}}
export function parseReversal(value: unknown){const body=bodyObject(value,['occurredOn','note']);return {occurredOn:businessDate(body.occurredOn),note:note(body.note)}}
