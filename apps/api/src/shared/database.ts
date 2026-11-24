import mysql from 'mysql2/promise';

export interface DatabaseConfig { host: string; port: number; user: string; password: string; database: string }
/** 只由显式运行的服务/迁移入口读取配置，不记录或回传连接参数。 */
export function databaseConfig(): DatabaseConfig | undefined {
  if(!process.env.DB_NAME)return undefined;
  const port=Number(process.env.DB_PORT??'3306');
  if(!Number.isInteger(port)||port<1||port>65535||!process.env.DB_USER)throw new Error('数据库配置不完整');
  return {host:process.env.DB_HOST??'127.0.0.1',port,user:process.env.DB_USER,password:process.env.DB_PASSWORD??'',database:process.env.DB_NAME};
}
export function createDatabasePool(config: DatabaseConfig) {
  return mysql.createPool({...config,connectionLimit:8,waitForConnections:true,queueLimit:200,connectTimeout:5000,
    charset:'utf8mb4',timezone:'Z',supportBigNumbers:true,bigNumberStrings:true,multipleStatements:false});
}
