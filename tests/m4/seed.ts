import { createHash } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { splitEqual } from '../../packages/domain/src/ledger.ts';
import { hashPassword } from '../../apps/api/src/modules/identity/password.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import type { TransferRequestDto,TransferPreviewDto,ConfirmationDto } from '../../packages/contracts/src/index.ts';
import { createEmptySchema,m4Pool } from './database.ts';
import { fixtureVersion } from './policy.ts';
import { backfillSummaries } from '../../apps/api/src/modules/finance/mysql-summaries.ts';

export const seed='heji-fixed-m4-20261117';
export function seedId(label:string){const chars=createHash('sha256').update(seed+':'+label).digest('hex').split('');chars[12]='4';chars[16]='8';const h=chars.join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`}
export const userId=(index:number)=>seedId('user'+index);
export const bookId=(index:number)=>seedId('book'+index);
export const memberId=(book:number,index:number)=>seedId(`member${book}:${index}`);
type Value=string|number|boolean|null;
async function insert(db:PoolConnection,table:string,columns:string[],data:Value[][]){
  if(!data.length)return;
  for(let i=0;i<data.length;i+=300){const chunk=data.slice(i,i+300);await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${chunk.map(row=>'('+row.map(()=>'?').join(',')+')').join(',')}`,chunk.flat())}
}
/** 固定数据直接作为夹具写入；压测写入另经真实HTTP业务协议，不将种子写入当作性能结果。 */
export async function prepare(){
  await createEmptySchema('heji_m4_bench',true,true);const pool=m4Pool(),db=await pool.getConnection();
  try{
    const passwordHash=await hashPassword('M4-Fictional-Only-Not-For-Login-'+fixtureVersion),created='2026-01-01 00:00:00.000';
    await db.beginTransaction();
    await insert(db,'users',['id','email','displayName','passwordHash','createdAt'],Array.from({length:30},(_,i)=>[userId(i),`m4-${i}@example.invalid`,'M4虚构成员'+i,passwordHash,created]));
    for(let b=0;b<10;b++){
      const count=b===0?10000:1000,book=bookId(b),members=Array.from({length:30},(_,i)=>memberId(b,i));
      await db.execute('INSERT INTO books(id,name,createdByUserId,financialVersion,isArchived,createdAt) VALUES(?,?,?,0,0,?)',[book,'M4隔离虚构账本'+b,userId(0),created]);
      await insert(db,'book_members',['id','bookId','userId','status','joinedAt'],members.map((id,i)=>[id,book,userId(i),'ACTIVE',created]));
      for(let start=0;start<count;start+=100){
        const expenses:Value[][]=[],versions:Value[][]=[],shares:Value[][]=[],audit:Value[][]=[];
        for(let i=start;i<Math.min(start+100,count);i++){
          const id=seedId(`expense${b}:${i}`),old=i%5===0,current=old?2:1,amount=BigInt(1000+i%1000),payer=members[i%30]!,date=`2026-${String(1+i%12).padStart(2,'0')}-${String(1+i%28).padStart(2,'0')}`;
          expenses.push([id,book,members[0]!,null,created]);
          for(let revision=1;revision<=current;revision++){
            const total=old&&revision===1?amount+1n:amount;
            versions.push([id,revision,book,payer,total.toString(),'EQUAL',['FOOD','TRANSPORT','HOUSING','OTHER'][i%4]!,date,'固定种子虚构支出',false,members[0]!,created]);
            for(const share of splitEqual(total,members))shares.push([book,id,revision,share.memberId,share.amountFen.toString()]);
          }
          audit.push([seedId(`audit${b}:${i}`),book,userId(0),'EXPENSE_CREATED',id,`${date} 12:00:00.000`]);
        }
        await insert(db,'expenses',['id','bookId','createdByMemberId','currentRevision','createdAt'],expenses);
        await insert(db,'expense_versions',['expenseId','revision','bookId','paidByMemberId','amountFen','splitMode','category','occurredOn','note','isVoided','changedByMemberId','createdAt'],versions);
        await insert(db,'expense_shares',['bookId','expenseId','revision','memberId','amountFen'],shares);
        await db.query('UPDATE expenses SET currentRevision=CASE WHEN id IN ('+expenses.filter((_x,i)=>(start+i)%5===0).map(()=>'?').join(',')+') THEN 2 ELSE 1 END WHERE bookId=? AND id IN ('+expenses.map(()=>'?').join(',')+')',[...expenses.filter((_x,i)=>(start+i)%5===0).map(x=>x[0]),book,...expenses.map(x=>x[0])]);
        await insert(db,'audit_events',['id','bookId','actorUserId','eventType','entityId','createdAt'],audit);
      }
      await db.execute('UPDATE books SET financialVersion=? WHERE id=?',[String(count+count/5),book]);
      console.log(`种子账本${b+1}/10：${count}当前支出，${count/5}历史版本`);
    }
    // 新夹具尚未ready，原始固定数据与派生汇总在同一事务完成后再运行真实确认。
    await backfillSummaries(db);await db.commit();
    // 通过正式仓储保留一条普通确认和一条冲正，恢复演练必须覆盖非零转账/冲正数据。
    const store=new MysqlFinanceStore(pool),book=bookId(1),actor=userId(1),counterparty=userId(2);
    let operationSequence=0;const context=()=>({idempotencyKey:seedId('seed-operation:'+operationSequence++)});
    const request=(await store.execute(actor,book,'request.create',{toMemberId:memberId(1,2),amountFen:'100',occurredOn:'2026-11-17',note:'恢复验收虚构普通确认'},context())).data as TransferRequestDto;
    const preview=(await store.read(counterparty,book,'preview',request.id)).data as TransferPreviewDto;
    const confirmed=(await store.execute(counterparty,book,'request.confirm',{expectedFinancialVersion:preview.expectedFinancialVersion,expectedRequestRevision:preview.expectedRequestRevision},{...context(),resourceId:request.id})).data as ConfirmationDto;
    const reversal=(await store.execute(actor,book,'transfer.reverse',{occurredOn:'2026-11-17',note:'恢复验收虚构冲正'},{...context(),resourceId:confirmed.transfer.id})).data as TransferRequestDto;
    const reversalPreview=(await store.read(counterparty,book,'preview',reversal.id)).data as TransferPreviewDto;
    await store.execute(counterparty,book,'request.confirm',{expectedFinancialVersion:reversalPreview.expectedFinancialVersion,expectedRequestRevision:reversalPreview.expectedRequestRevision},{...context(),resourceId:reversal.id});
    await db.execute("UPDATE m4_fixture_meta SET state='ready' WHERE id=1");
  }catch(error){await db.rollback();throw error}finally{db.release();await pool.end()}
}
