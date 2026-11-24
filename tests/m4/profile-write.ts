import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { PoolConnection,RowDataPacket } from 'mysql2/promise';
import type { ExpenseDto } from '../../packages/contracts/src/index.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import { fixturePool } from './database.ts';
import { bookId,memberId,userId } from './seed.ts';

// 旧路径由代理把新多行INSERT拆回30次单行执行；两组其余业务逻辑相同，均在commit处回滚。
const pool=await fixturePool(),evidence:unknown[]=[];
async function state(){return (await pool.query<RowDataPacket[]>('SELECT financialVersion,(SELECT COUNT(*) FROM expenses) expenses,(SELECT COUNT(*) FROM expense_versions) versions,(SELECT COUNT(*) FROM expense_shares) shares FROM books WHERE id=?',[bookId(0)]))[0][0]}
try{
  const before=await state();
  for(let round=1;round<=5;round++)for(const mode of (round%2?['legacy','batch']:['batch','legacy'])){
    let sqlCount=0,shareInsertMs=0,lockAcquiredAt=0,bookLockHeldMs=0;
    const measured=new Proxy(pool,{get(target,key){
      if(key==='getConnection')return async()=>{
        const db=await target.getConnection();return new Proxy(db,{get(connection,property){
          if(property==='commit')return async()=>{await connection.rollback();bookLockHeldMs=performance.now()-lockAcquiredAt};
          const value=Reflect.get(connection,property);
          if(property==='execute')return async(sql:string,params:(string|number|boolean|null)[])=>{
            const start=performance.now();
            if(sql.startsWith('INSERT INTO expense_shares')){
              let result:unknown;
              if(mode==='legacy')for(let i=0;i<params.length;i+=5){sqlCount++;result=await connection.execute('INSERT INTO expense_shares(bookId,expenseId,revision,memberId,amountFen) VALUES(?,?,?,?,?)',params.slice(i,i+5))}
              else{sqlCount++;result=await connection.execute(sql,params)}
              shareInsertMs+=performance.now()-start;return result;
            }
            sqlCount++;const result=await connection.execute(sql,params);
            if(sql.startsWith('SELECT * FROM books WHERE id=')&&sql.includes('FOR UPDATE'))lockAcquiredAt=performance.now();
            return result;
          };
          return typeof value==='function'?value.bind(connection):value;
        }}) as PoolConnection;
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const start=performance.now(),result=await new MysqlFinanceStore(measured).execute(userId(0),bookId(0),'expense.create',{
      paidByMemberId:memberId(0,0),amountFen:'10001',splitMode:'EQUAL',participantMemberIds:Array.from({length:30},(_,i)=>memberId(0,i)),category:'OTHER',occurredOn:'2026-11-18',note:'M4回滚写入对照',
    },{idempotencyKey:randomUUID()});
    const totalMs=performance.now()-start,expense=result.data as ExpenseDto;
    assert.equal(expense.shares.length,30);assert.equal(expense.shares.reduce((sum,x)=>sum+BigInt(x.amountFen),0n),10001n);
    const record={round,mode,totalMs,shareInsertMs,bookLockHeldMs,sqlCount};evidence.push(record);console.log(JSON.stringify(record));
  }
  const after=await state();assert.deepEqual(after,before);
  const name='m4-write-profile-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  await writeFile(new URL('../../docs/development/evidence/'+name,import.meta.url),JSON.stringify({scope:'30人单请求，5组交替新旧路径；均回滚，不代表20用户HTTP正式达标',before,after,evidence},null,2),{encoding:'utf8',flag:'wx'});console.log(name);
}finally{await pool.end()}
