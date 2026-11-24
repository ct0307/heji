import { readFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createDatabasePool,databaseConfig } from '../../apps/api/src/shared/database.ts';
import { assertM4Target,sourceDatabase,isRestoreDatabase,fixtureVersion } from './policy.ts';
import type { Pool,RowDataPacket } from 'mysql2/promise';

/** 只在--apply之后调用；本地连接由Node入口加载，绝不返回或输出凭据。 */
export function m4Pool(database=sourceDatabase){
  assertM4Target(database,isRestoreDatabase(database)?'restore':'bench',process.env.HEJI_ALLOW_M4);
  const config=databaseConfig();if(!config)throw new Error('请在本机配置MySQL连接');
  if(!['127.0.0.1','localhost','::1'].includes(config.host))throw new Error('M4只允许本机MySQL');
  return createDatabasePool({...config,database});
}
export async function migrations(includeSummaries=false,includeWindows=false){
  if(includeWindows&&!includeSummaries)throw new Error('004恢复结构必须包含003汇总结构');
  const directory=new URL('../../database/migrations/',import.meta.url);
  const found=await Promise.all((await readdir(directory)).filter(x=>/^\d{3}_[a-z0-9_]+\.sql$/.test(x)).sort().map(async name=>{
    const sql=await readFile(new URL(name,directory),'utf8');return {name,sql,checksum:createHash('sha256').update(sql).digest('hex')};
  }));
  if(includeSummaries){const sql=await readFile(new URL('../../docs/development/proposals/003_finance_summaries.sql',import.meta.url),'utf8');found.push({name:'003_finance_summaries.sql',sql,checksum:createHash('sha256').update(sql).digest('hex')})}
  if(includeWindows){const sql=await readFile(new URL('../../docs/development/proposals/004_settlement_windows.sql',import.meta.url),'utf8');found.push({name:'004_settlement_windows.sql',sql,checksum:createHash('sha256').update(sql).digest('hex')})}
  return found;
}
export async function createEmptySchema(database:string,recordMetadata=true,includeSummaries=false,includeWindows=false){
  assertM4Target(database,isRestoreDatabase(database)?'restore':'bench',process.env.HEJI_ALLOW_M4);
  const selectedMigrations=await migrations(includeSummaries,includeWindows);
  // 先连接服务器，不选择开发库；数据库名来自上面的固定白名单。
  const config=databaseConfig();if(!config||!['127.0.0.1','localhost','::1'].includes(config.host))throw new Error('M4需要本机连接');
  const pool=createDatabasePool({...config,database:'information_schema'}),db=await pool.getConnection();
  try{
    const [existing]=await db.execute<RowDataPacket[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[database]);
    if(existing.length)throw new Error('目标库已存在，拒绝覆盖；请检查已有实验记录');
    await db.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await db.query(`USE \`${database}\``);
    await db.query('CREATE TABLE schema_migrations(name VARCHAR(100) PRIMARY KEY,checksum CHAR(64) NOT NULL,appliedAt DATETIME(3) NOT NULL) ENGINE=InnoDB');
    for(const migration of selectedMigrations){
      for(const statement of migration.sql.split(/;\s*(?:\r?\n|$)/).map(x=>x.trim()).filter(Boolean))await db.query(statement);
      if(recordMetadata)await db.execute('INSERT INTO schema_migrations VALUES(?,?,UTC_TIMESTAMP(3))',[migration.name,migration.checksum]);
    }
    await db.query('CREATE TABLE m4_fixture_meta(id INT PRIMARY KEY,version VARCHAR(80) NOT NULL,state VARCHAR(20) NOT NULL,createdAt DATETIME(3) NOT NULL) ENGINE=InnoDB');
    if(recordMetadata)await db.execute("INSERT INTO m4_fixture_meta VALUES(1,?,'schema',UTC_TIMESTAMP(3))",[fixtureVersion]);
  }finally{db.release();await pool.end()}
}
export async function requireFixture(pool:Pool){
  const [rows]=await pool.execute<RowDataPacket[]>('SELECT version,state FROM m4_fixture_meta WHERE id=1');
  if(rows[0]?.version!==fixtureVersion||rows[0]?.state!=='ready')throw new Error('隔离库不是已完成的M4虚构夹具，停止运行');
}
export async function fixturePool(){
  const pool=m4Pool();try{await requireFixture(pool);return pool}catch(error){await pool.end();throw error}
}
export async function environment(pool:Pool){
  const [rows]=await pool.query<RowDataPacket[]>('SELECT VERSION() AS version,@@sql_mode AS sqlMode,@@transaction_isolation AS isolationLevel');
  return rows[0];
}
