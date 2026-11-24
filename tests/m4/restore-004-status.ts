import { createDatabasePool,databaseConfig } from '../../apps/api/src/shared/database.ts';
import { assertM4Target,windowRestoreDatabase } from './policy.ts';
import type { RowDataPacket } from 'mysql2/promise';

/** 只观察本次恢复进度元数据，不读SQL文本、凭据或业务行。 */
async function main(){
  assertM4Target(windowRestoreDatabase,'restore',process.env.HEJI_ALLOW_M4);
  const config=databaseConfig();if(!config||!['localhost','127.0.0.1','::1'].includes(config.host))throw new Error('本机状态门禁未满足');
  const pool=createDatabasePool({...config,database:'information_schema'});
  try{
    const [schemas]=await pool.execute<RowDataPacket[]>('SELECT COUNT(*) count FROM SCHEMATA WHERE SCHEMA_NAME=?',[windowRestoreDatabase]);
    const [tables]=await pool.execute<RowDataPacket[]>('SELECT COUNT(*) count FROM TABLES WHERE TABLE_SCHEMA=?',[windowRestoreDatabase]);
    const [transactions]=await pool.execute<RowDataPacket[]>('SELECT t.trx_state state,t.trx_rows_modified modifiedRows FROM INNODB_TRX t JOIN PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE p.DB=?',[windowRestoreDatabase]);
    const [connections]=await pool.execute<RowDataPacket[]>('SELECT COMMAND command,TIME elapsedSeconds,STATE state FROM PROCESSLIST WHERE DB=?',[windowRestoreDatabase]);
    console.log(JSON.stringify({at:new Date().toISOString(),targetExists:Number(schemas[0]?.count)===1,tables:Number(tables[0]?.count),transactions,connections}));
  }finally{await pool.end()}
}
try{await main()}catch(error){const code=(error as {code?:string}).code;console.error(code&&/^ER_[A-Z0-9_]+$/.test(code)?code:'只读恢复状态采集失败，未输出连接信息');process.exitCode=1}
