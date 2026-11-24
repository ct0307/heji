import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { fixturePool } from './database.ts';
import { bookId } from './seed.ts';

// 只比较SELECT访问路径；不创建索引、不改变业务表或服务器设置。
const pool=await fixturePool(),db=await pool.getConnection();
try{
  const previous=JSON.parse(await readFile(new URL('../../docs/development/evidence/m4-profile-2026-11-18T03-36-26-908Z.json',import.meta.url),'utf8'));
  const original=previous.plans.find((x:{sql:string})=>x.sql.includes('outgoing AS')).sql as string;
  const params=[bookId(0),bookId(0),bookId(0),bookId(0),bookId(0)];
  const variants=[
    {name:'original',sql:original},
    {name:'hash-shares',sql:original.replace('shares AS (SELECT s.memberId','shares AS (SELECT /*+ NO_INDEX(s) */ s.memberId')},
    {name:'materialized-current',sql:original.replace('WHERE e.bookId=? AND v.isVoided=0','WHERE e.bookId=? AND v.isVoided=0 LIMIT 18446744073709551615')},
  ];
  const evidence:unknown[]=[],results:RowDataPacket[][]=[];
  await db.query('START TRANSACTION READ ONLY');
  for(const variant of variants){
    const start=performance.now(),[result]=await db.execute<RowDataPacket[]>(variant.sql,params),ms=performance.now()-start;
    if(results.length)assert.deepEqual(result,results[0]);results.push(result);
    const [plan]=await db.query('EXPLAIN ANALYZE '+variant.sql,params);
    evidence.push({...variant,ms,plan,identical:true});console.log(JSON.stringify({name:variant.name,ms,plan}));
  }
  await db.commit();
  const name='m4-candidates-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  await writeFile(new URL('../../docs/development/evidence/'+name,import.meta.url),JSON.stringify({scope:'同一只读快照，SQL提示与CTE物化对照，不修改业务表',evidence},null,2),{encoding:'utf8',flag:'wx'});
  console.log(name);
}catch(error){await db.rollback();throw error}finally{db.release();await pool.end()}
