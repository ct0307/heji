import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { fixturePool,environment } from './database.ts';
import { bookId } from './seed.ts';

export async function sqlExperiment(){
  const pool=await fixturePool(),db=await pool.getConnection();
  try{
    // 临时表仅存在于本次连接；不修改原审计表或已执行迁移。
    await db.query('CREATE TEMPORARY TABLE m4_audit_baseline(id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,createdAt DATETIME(3) NOT NULL) ENGINE=InnoDB');
    await db.query('CREATE TEMPORARY TABLE m4_audit_indexed LIKE m4_audit_baseline');
    await db.query('ALTER TABLE m4_audit_indexed ADD INDEX ix_m4_book_time(bookId,createdAt,id)');
    await db.execute('INSERT INTO m4_audit_baseline SELECT id,bookId,createdAt FROM audit_events WHERE bookId=? ORDER BY id LIMIT 10000',[bookId(0)]);
    await db.query('INSERT INTO m4_audit_indexed SELECT * FROM m4_audit_baseline');
    const [counts]=await db.query<RowDataPacket[]>('SELECT COUNT(*) AS amount FROM m4_audit_baseline');assert.equal(Number(counts[0]!.amount),10000);
    const params=[bookId(0),'2026-12-28 12:00:00.000','ffffffff-ffff-4fff-8fff-ffffffffffff'];const evidence:unknown[]=[];let baseline:unknown;
    for(const table of ['m4_audit_baseline','m4_audit_indexed']){
      const sql=`SELECT id,bookId,createdAt FROM ${table} WHERE bookId=? AND (createdAt,id)<(?,?) ORDER BY createdAt DESC,id DESC LIMIT 20`;
      const [rows]=await db.execute(sql,params);if(table==='m4_audit_baseline')baseline=rows;else assert.deepEqual(rows,baseline);
      const [estimate]=await db.query('EXPLAIN FORMAT=JSON '+sql,params),actual=[];
      for(let round=0;round<5;round++){const start=performance.now();const [plan]=await db.query('EXPLAIN ANALYZE '+sql,params);actual.push({round:round+1,elapsedMs:performance.now()-start,plan})}
      evidence.push({table,sql,params,estimate,actual});
    }
    const file=new URL('../../docs/development/evidence/m4-sql-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',import.meta.url);
    await writeFile(file,JSON.stringify({environment:await environment(pool),rows:10000,returned:20,identicalResults:true,evidence},null,2),{encoding:'utf8',flag:'wx'});
    console.log('索引实验已记录：相同1万条、相同20行结果、两组计划及各5轮实际执行。');
  }finally{db.release();await pool.end()}
}
