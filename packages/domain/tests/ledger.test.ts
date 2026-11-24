import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYuan, parseFen, formatYuan, splitEqual, splitCustom, calculateBalances, suggestSettlements } from '../src/ledger.ts';

test('累计欠款超过单笔上限时，结清建议拆分为可登记金额且守恒',()=>{
  const result=suggestSettlements([{memberId:'a',balanceFen:-100000001n},{memberId:'b',balanceFen:100000001n}]);
  assert.deepEqual(result,[{fromMemberId:'a',toMemberId:'b',amountFen:100000000n},{fromMemberId:'a',toMemberId:'b',amountFen:1n}]);
  for(const row of result)assert.equal(parseFen(row.amountFen.toString()),row.amountFen);
});

test('元字符串精确转换，拒绝浮点、科学计数及越界输入', () => {
  assert.equal(parseYuan('100.01'), 10001n);
  assert.equal(parseYuan('0.01'), 1n);
  for (const value of ['0', '-1', '1e3', '1,000', '01', '1.001', ' 1', '1000000.01', '']) {
    assert.throws(() => parseYuan(value));
  }
  assert.equal(parseYuan('1000000.00'), 100000000n);
  assert.equal(parseFen('10001'), 10001n);
  for (const value of ['01', '1.0', '-1', '0']) assert.throws(() => parseFen(value));
  assert.equal(formatYuan(-10001n), '-100.01');
});

test('均分按稳定成员ID分配尾差，输入顺序不影响结果', () => {
  assert.deepEqual(splitEqual(10001n, ['c', 'a', 'b']), [
    { memberId: 'a', amountFen: 3334n }, { memberId: 'b', amountFen: 3334n }, { memberId: 'c', amountFen: 3333n },
  ]);
  assert.deepEqual(splitEqual(1n, ['c', 'b', 'a']).map(x => x.amountFen), [1n, 0n, 0n]);
  assert.throws(() => splitEqual(100n, []));
  assert.throws(() => splitEqual(100n, ['a', 'a']));
  assert.throws(() => splitEqual(0n, ['a']));
});

test('指定金额可含零份额，但成员唯一、份额非负且金额守恒', () => {
  assert.deepEqual(splitCustom(1n, [{ memberId: 'a', amountFen: 1n }, { memberId: 'b', amountFen: 0n }]).map(x=>x.amountFen), [1n, 0n]);
  assert.throws(() => splitCustom(100n, [{ memberId: 'a', amountFen: 99n }]));
  assert.throws(() => splitCustom(100n, [{ memberId: 'a', amountFen: -1n }, { memberId: 'b', amountFen: 101n }]));
  assert.throws(() => splitCustom(100n, [{ memberId: 'a', amountFen: 50n }, { memberId: 'a', amountFen: 50n }]));
});

const expense = (amount: bigint) => ({ paidBy: 'a', amountFen: amount, shares: splitEqual(amount, ['a', 'b']) });
test('已确认转账独立于支出修改，旧转账保留后仅产生新增欠款', () => {
  const paid = [{ fromMemberId: 'b', toMemberId: 'a', amountFen: 5000n }];
  assert.deepEqual(calculateBalances(['a', 'b'], [expense(10000n)], paid).map(x=>x.balanceFen), [0n, 0n]);
  assert.deepEqual(calculateBalances(['a', 'b'], [expense(12000n)], paid).map(x=>x.balanceFen), [1000n, -1000n]);
  assert.deepEqual(calculateBalances(['a', 'b'], [expense(10000n)], []).map(x=>x.balanceFen), [5000n, -5000n]);
});

test('反向确认冲正抵消原转账，消费统计保持不变', () => {
  const rows = calculateBalances(['a', 'b'], [expense(10000n)], [
    { fromMemberId: 'b', toMemberId: 'a', amountFen: 5000n },
    { fromMemberId: 'a', toMemberId: 'b', amountFen: 5000n },
  ]);
  assert.deepEqual(rows.map(x=>x.balanceFen), [5000n, -5000n]);
  assert.equal(rows.reduce((s,x)=>s+x.shareFen,0n),10000n);
  assert.throws(() => calculateBalances(['a'], [expense(10000n)], []));
  assert.throws(() => calculateBalances(['a','b'], [], [{fromMemberId:'a',toMemberId:'a',amountFen:1n}]));
});

test('结算建议确定且守恒，不能接收不平衡快照', () => {
  const rows = [{memberId:'c',balanceFen:-47600n},{memberId:'a',balanceFen:68000n},{memberId:'b',balanceFen:-20400n}];
  assert.deepEqual(suggestSettlements(rows), [
    {fromMemberId:'b',toMemberId:'a',amountFen:20400n},
    {fromMemberId:'c',toMemberId:'a',amountFen:47600n},
  ]);
  assert.deepEqual(suggestSettlements([...rows].reverse()), suggestSettlements(rows));
  assert.throws(()=>suggestSettlements([{memberId:'a',balanceFen:1n}]));
});

test('固定种子10000组性质检查：均分守恒，建议执行后余额全零', () => {
  let seed=20261117;
  const random=()=>{ seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed; };
  for(let i=0;i<10000;i++) {
    const ids=Array.from({length:1+random()%30},(_,j)=>`m${String(j).padStart(2,'0')}`);
    const total=BigInt(1+random()%100000000);
    const shares=splitEqual(total,[...ids].reverse());
    assert.equal(shares.reduce((sum,x)=>sum+x.amountFen,0n),total,`种子20261117，案例${i}`);
    assert.ok(shares.every(x=>x.amountFen>=0n));
    const costs=[{paidBy:ids[0]!,amountFen:total,shares}];
    const rows=calculateBalances(ids,costs,[]);
    const settled=calculateBalances(ids,costs,suggestSettlements(rows));
    assert.ok(settled.every(x=>x.balanceFen===0n),`种子20261117，案例${i}`);
  }
});
