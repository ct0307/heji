import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { databaseConfig } from '../../apps/api/src/shared/database.ts';

const directory=new URL('../migrations/',import.meta.url);
const files=(await readdir(directory)).filter(name=>/^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
const migrations=await Promise.all(files.map(async name=>{const sql=await readFile(new URL(name,directory),'utf8');return {name,sql,checksum:createHash('sha256').update(sql).digest('hex')}}));
if(process.argv.includes('--plan')){
  for(const migration of migrations)console.log(`${migration.name} ${migration.checksum}`);
  console.log('仅显示计划；没有连接数据库或执行SQL。');
}else if(!process.argv.includes('--apply')||process.env.HEJI_ALLOW_MIGRATION!=='yes'){
  console.error('执行迁移前须取得用户确认，并显式提供 --apply 与 HEJI_ALLOW_MIGRATION=yes。');process.exitCode=1;
}else{
  let db: mysql.Connection|undefined;
  try{
    const config=databaseConfig();
    if(!config||config.database!=='heji_dev')throw new Error('迁移仅允许明确指定的heji_dev数据库');
    const {database,...connection}=config;
    db=await mysql.createConnection({...connection,multipleStatements:false});
    const [existing]=await db.execute<RowDataPacket[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[database]);
    if(existing.length){
      const [tables]=await db.execute<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',[database]);
      if(tables.length&&!tables.some(row=>row.TABLE_NAME==='schema_migrations'))throw new Error('目标数据库含非本项目数据，已停止');
    }
    await db.query('CREATE DATABASE IF NOT EXISTS `heji_dev` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    await db.query('USE `heji_dev`');
    const [locks]=await db.query<RowDataPacket[]>("SELECT GET_LOCK('heji_dev_migration',10) AS acquired");
    if(Number(locks[0]?.acquired)!==1)throw new Error('迁移锁不可用');
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations(name VARCHAR(100) PRIMARY KEY,checksum CHAR(64) NOT NULL,appliedAt DATETIME(3) NOT NULL) ENGINE=InnoDB');
    for(const migration of migrations){
      const [applied]=await db.execute<RowDataPacket[]>('SELECT checksum FROM schema_migrations WHERE name=?',[migration.name]);
      if(applied.length){if(applied[0]!.checksum!==migration.checksum)throw new Error('已执行迁移的校验和发生变化');continue}
      for(const statement of migration.sql.split(/;\s*(?:\r?\n|$)/).map(x=>x.trim()).filter(Boolean))await db.query(statement);
      await db.execute('INSERT INTO schema_migrations(name,checksum,appliedAt) VALUES(?,?,UTC_TIMESTAMP(3))',[migration.name,migration.checksum]);
      console.log(`迁移完成：${migration.name}`);
    }
    await db.query("SELECT RELEASE_LOCK('heji_dev_migration')");
  }catch(error){
    const code=(error as {code?:string}).code;
    console.error(code?`迁移失败，数据库错误码：${code}`:'迁移停止，请核对目标库、显式许可与迁移校验。');process.exitCode=1;
  }finally{await db?.end()}
}
