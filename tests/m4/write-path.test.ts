import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolConnection,RowDataPacket } from 'mysql2/promise';
import type { ExpenseDto } from '../../packages/contracts/src/index.ts';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import { splitEqual } from '../../packages/domain/src/ledger.ts';
import { fixturePool } from './database.ts';
import { bookId,memberId,userId } from './seed.ts';

test('30人支出保存的SQL预算不超过20次，均分/指定/零份额保持一致且整笔可回滚',async t=>{
  const pool=await fixturePool();t.after(()=>pool.end());
  async function state(){return (await pool.query<RowDataPacket[]>('SELECT financialVersion,(SELECT COUNT(*) FROM expenses WHERE bookId=?) expenses,(SELECT COUNT(*) FROM expense_versions WHERE bookId=?) versions,(SELECT COUNT(*) FROM expense_shares WHERE bookId=?) shares FROM books WHERE id=?',Array.from({length:4},()=>bookId(0))))[0][0]}
  for(const mode of ['EQUAL','EXACT'] as const)await t.test(mode,async()=>{
    const before=await state(),expected=splitEqual(17n,Array.from({length:30},(_,i)=>memberId(0,i))).map(x=>({...x,amountFen:x.amountFen.toString()}));
    let calls=0;
    const measured=new Proxy(pool,{get(target,key){
      if(key==='getConnection')return async()=>{
        const db=await target.getConnection();return new Proxy(db,{get(connection,property){
          // 测试完整执行写入及回读，在正式commit边界改为rollback，业务行不留残留。
          if(property==='commit')return ()=>connection.rollback();
          const value=Reflect.get(connection,property);
          if(property==='execute')return (...args:unknown[])=>{calls++;return Reflect.apply(value,connection,args)};
          return typeof value==='function'?value.bind(connection):value;
        }}) as PoolConnection;
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const result=await new MysqlFinanceStore(measured).execute(userId(0),bookId(0),'expense.create',{
      paidByMemberId:memberId(0,0),amountFen:'17',splitMode:mode,
      ...(mode==='EQUAL'?{participantMemberIds:expected.map(x=>x.memberId).reverse()}:{shares:[...expected].reverse()}),
      category:'OTHER',occurredOn:'2026-11-18',note:'M4仅回滚的往返预算回归',
    },{idempotencyKey:randomUUID()});
    const expense=result.data as ExpenseDto;
    assert.equal(result.status,201);assert.deepEqual(expense.shares,expected);
    assert.equal(expense.shares.reduce((sum,x)=>sum+BigInt(x.amountFen),0n),17n);
    assert.equal(expense.shares.filter(x=>x.amountFen==='0').length,13);
    assert.deepEqual(await state(),before,'回滚后版本、支出、历史和份额应完全不变');
    t.diagnostic(`${mode}: ${calls}次业务SQL`);
    assert.ok(calls<=20,`30人保存不应逐份额往返；实际${calls}次业务SQL，预算20次`);
  });
});
