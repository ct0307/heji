import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { fixturePool,environment } from './database.ts';
import { bookId } from './seed.ts';

// 复用已有临时索引实验授权；表随连接关闭释放，不修改业务表/迁移/服务器配置。
const pool=await fixturePool(),db=await pool.getConnection();
try{
  const source=JSON.parse(await readFile(new URL('../../docs/development/evidence/m4-profile-2026-11-18T03-36-26-908Z.json',import.meta.url),'utf8'));
  const original=source.plans.find((x:{sql:string})=>x.sql.includes('outgoing AS')).sql as string;
  const params=Array.from({length:5},()=>bookId(0));
  await db.query('CREATE TEMPORARY TABLE m4_share_cover LIKE expense_shares');
  const start=performance.now();
  await db.execute('INSERT INTO m4_share_cover SELECT * FROM expense_shares WHERE bookId=?',[bookId(0)]);
  const copyMs=performance.now()-start;
  const indexStart=performance.now();
  await db.query('ALTER TABLE m4_share_cover ADD INDEX ix_share_current_cover(bookId,expenseId,revision,memberId,amountFen)');
  const indexMs=performance.now()-indexStart;
  const [count]=await db.query<RowDataPacket[]>('SELECT COUNT(*) rowsCopied FROM m4_share_cover');
  const evidence:unknown[]=[],expected=(await db.execute<RowDataPacket[]>(original,params))[0];
  // 在同一张临时表、同一只读快照交替比较，原表结果作为逐成员参考。
  await db.query('START TRANSACTION READ ONLY');
  for(let round=1;round<=3;round++)for(const index of ['PRIMARY','ix_share_current_cover']){
    const sql=original.replace('expense_shares s',`m4_share_cover s FORCE INDEX (${index})`);
    const started=performance.now(),[result]=await db.execute<RowDataPacket[]>(sql,params),ms=performance.now()-started;
    assert.deepEqual(result,expected);
    const [plan]=await db.query('EXPLAIN ANALYZE '+sql,params);
    evidence.push({round,index,ms,identical:true,plan});console.log(JSON.stringify({round,index,ms}));
  }
  await db.commit();
  const name='m4-covering-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  await writeFile(new URL('../../docs/development/evidence/'+name,import.meta.url),JSON.stringify({scope:'单热点账本临时表覆盖索引实验；不证明HTTP正式性能',environment:await environment(pool),count,copyMs,indexMs,original,params,evidence},null,2),{encoding:'utf8',flag:'wx'});
  console.log(name);
}catch(error){await db.rollback();throw error}finally{db.release();await pool.end()}
