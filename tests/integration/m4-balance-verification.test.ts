import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import type { PoolConnection } from 'mysql2/promise';
import { checkBalances,memberBalancesSql,balanceConservationSql } from '../m4/balance-verification.ts';

function fixture(){
  const db=new DatabaseSync(':memory:');
  // 内存库用于执行真实SQL与损坏注入，不连接MySQL，不写项目数据库。
  db.exec(`CREATE TABLE book_members(bookId TEXT,id TEXT,status TEXT);
    CREATE TABLE expenses(id TEXT,bookId TEXT,currentRevision INTEGER);
    CREATE TABLE expense_versions(expenseId TEXT,revision INTEGER,bookId TEXT,paidByMemberId TEXT,amountFen INTEGER,isVoided INTEGER);
    CREATE TABLE expense_shares(expenseId TEXT,revision INTEGER,bookId TEXT,memberId TEXT,amountFen INTEGER);
    CREATE TABLE confirmed_transfers(bookId TEXT,fromMemberId TEXT,toMemberId TEXT,amountFen INTEGER,kind TEXT);
    CREATE TABLE transfer_requests(bookId TEXT,fromMemberId TEXT,toMemberId TEXT,amountFen INTEGER,state TEXT);
    INSERT INTO book_members VALUES ('b1','m1','ACTIVE'),('b1','m2','LEFT'),('b1','m3','ACTIVE'),('b2','m4','ACTIVE');
    INSERT INTO expenses VALUES ('e1','b1',2),('e2','b1',1),('e3','b1',1);
    INSERT INTO expense_versions VALUES ('e1',1,'b1','m1',99,0),('e1',2,'b1','m1',101,0),('e2',1,'b1','m2',40,0),('e3',1,'b1','m1',50,1);
    INSERT INTO expense_shares VALUES ('e1',1,'b1','m1',99),('e1',2,'b1','m1',51),('e1',2,'b1','m2',50),('e2',1,'b1','m1',40),('e2',1,'b1','m2',0),('e3',1,'b1','m2',50);
    INSERT INTO confirmed_transfers VALUES ('b1','m2','m1',20,'NORMAL'),('b1','m1','m2',7,'REVERSAL');
    INSERT INTO transfer_requests VALUES ('b1','m2','m1',900,'PENDING');`);
  return db;
}
function read(db:DatabaseSync,sql:string){
  const statement=db.prepare(sql);statement.setReadBigInts(true);
  return statement.all().map(row=>({...row}));
}
function connection(db:DatabaseSync){
  // 仅适配驱动接口；SQL本身由内存数据库执行，非预设返回结果。
  return {query:async(sql:string)=>[read(db,sql),[]]} as unknown as Pick<PoolConnection,'query'>;
}
function balances(db:DatabaseSync){return read(db,memberBalancesSql+' ORDER BY bookId,memberId')}
const expected=[
  {bookId:'b1',memberId:'m1',balanceFen:-3n},
  {bookId:'b1',memberId:'m2',balanceFen:3n},
  {bookId:'b1',memberId:'m3',balanceFen:0n},
  {bookId:'b2',memberId:'m4',balanceFen:0n}
];

test('余额SQL计划消除逐成员相关子查询',()=>{
  const db=fixture();try{
    const plan=db.prepare('EXPLAIN QUERY PLAN '+balanceConservationSql).all();
    assert.equal(plan.filter(row=>/CORRELATED/i.test(String(row.detail))).length,0,'不得随成员重复执行相关子查询');
  }finally{db.close()}
});
test('当前有效版本、退出成员、零份额、待确认和反向冲正按原口径计入精确成员余额',async()=>{
  const db=fixture();try{assert.deepEqual(balances(db),expected);await checkBalances(connection(db));assert.deepEqual(read(db,balanceConservationSql),[])}finally{db.close()}
});
test('空库及仅有零余额成员的账本均通过',async()=>{
  const db=fixture();try{
    db.exec('DELETE FROM expenses; DELETE FROM expense_versions; DELETE FROM expense_shares; DELETE FROM confirmed_transfers;');
    await checkBalances(connection(db));assert.equal(balances(db).length,4);
    db.exec('DELETE FROM book_members;');await checkBalances(connection(db));assert.deepEqual(balances(db),[]);
  }finally{db.close()}
});
test('累计超过Number安全整数仍精确到分',async()=>{
  const db=fixture();try{
    const amount=9007199254740993n;
    db.prepare("UPDATE expense_versions SET amountFen=? WHERE expenseId='e1' AND revision=2").run(amount);
    db.prepare("UPDATE expense_shares SET amountFen=? WHERE expenseId='e1' AND revision=2 AND memberId='m1'").run(amount-50n);
    assert.deepEqual(balances(db),expected);await checkBalances(connection(db));
  }finally{db.close()}
});
test('逐版本校验拒绝历史损坏、相互抵消损坏、缺失/过多份额及作废版本损坏',async()=>{
  const mutations=[
    "UPDATE expense_shares SET amountFen=98 WHERE expenseId='e1' AND revision=1",
    "UPDATE expense_shares SET amountFen=amountFen+1 WHERE expenseId='e1' AND revision=2 AND memberId='m1'; UPDATE expense_shares SET amountFen=amountFen-1 WHERE expenseId='e2' AND memberId='m1'",
    "DELETE FROM expense_shares WHERE expenseId='e1' AND revision=1",
    "UPDATE expense_shares SET amountFen=49 WHERE expenseId='e3'",
    ...[30,31].map(count=>"INSERT INTO expense_shares "+Array.from({length:count},(_,i)=>`SELECT 'e1',1,'b1','extra${i}',0`).join(' UNION ALL '))
  ];
  for(const sql of mutations){const db=fixture();try{db.exec(sql);await assert.rejects(()=>checkBalances(connection(db)),/支出版本分摊/)}finally{db.close()}}
});
test('30名参与者为合法上限',async()=>{
  const db=fixture();try{
    for(let i=0;i<29;i++)db.prepare('INSERT INTO expense_shares VALUES (?,?,?,?,?)').run('e1',1,'b1','extra'+i,0);
    await checkBalances(connection(db));
  }finally{db.close()}
});
test('缺失当前版本标记仍拒绝',async()=>{
  const db=fixture();try{db.exec("UPDATE expenses SET currentRevision=NULL WHERE id='e1'");await assert.rejects(()=>checkBalances(connection(db)),/缺少当前版本/)}finally{db.close()}
});
test('各账本分别守恒，成员关联或bookId损坏不能跨账本抵消',async()=>{
  for(const sql of [
    "UPDATE expense_shares SET memberId='unknown' WHERE expenseId='e1' AND revision=2 AND memberId='m2'",
    "UPDATE expense_shares SET bookId='b2' WHERE expenseId='e1' AND revision=2 AND memberId='m2'",
    "INSERT INTO confirmed_transfers VALUES ('b1','m1','unknown',11,'NORMAL'),('b2','unknown','m4',11,'NORMAL')"
  ]){const db=fixture();try{db.exec(sql);await assert.rejects(()=>checkBalances(connection(db)),/账本余额不守恒/)}finally{db.close()}}
});
test('恢复入口调用共用核验，保留外键和003余额/期间报表对账',async()=>{
  const source=await readFile(new URL('../m4/backup.ts',import.meta.url),'utf8');
  assert.match(source,/import \{ checkBalances \} from '\.\/balance-verification\.ts'/);
  assert.ok(source.includes("await timer.measure('foreign_keys',()=>checkForeignKeys(db,timer));"));
  assert.ok(source.includes('await checkBalances(db,timer);'));
  assert.match(source,/model\(db,book,'',true\)/);assert.match(source,/model\(db,book,'',false\)/);
  assert.match(source,/periodReport\(db,String\(book.id\),\{\},true\)/);assert.match(source,/periodReport\(db,String\(book.id\),\{\},false\)/);
});
