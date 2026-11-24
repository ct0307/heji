import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fixturePool } from './database.ts';
import { windowMigrationPlan } from '../../database/scripts/window-migration.ts';
import type { RowDataPacket } from 'mysql2/promise';

/** 本轮获准操作的只读前后状态；不打印凭据或行内容，不执行迁移。 */
async function main(){
  const [stage,reference,...extra]=process.argv.slice(2);
  if(extra.length||!['before','after','final'].includes(stage??'')||(stage!=='before'&&!/^m4-backup-004-state-before-[\dTZ-]+\.json$/.test(reference??'')))throw new Error('状态参数无效');
  const evidenceRoot=new URL('../../docs/development/evidence/',import.meta.url);
  const offline=JSON.parse(await readFile(new URL('m4-backup-restore-004-offline-2026-11-19.json',evidenceRoot),'utf8'));
  for(const source of offline.sourceHashes){
    const content=await readFile(new URL('../../'+source.path,import.meta.url));
    if(createHash('sha256').update(content).digest('hex')!==source.sha256)throw new Error('已验收代码源摘要变化，停止操作');
  }
  const pool=await fixturePool();
  try{
    const db=await pool.getConnection();
    try{
      const [connections]=await db.query<RowDataPacket[]>("SELECT COUNT(*) otherConnections FROM information_schema.PROCESSLIST WHERE DB='heji_m4_bench' AND ID<>CONNECTION_ID()");
      if(Number(connections[0]?.otherConnections)!==0)throw new Error('bench存在其他连接，停止操作');
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const [tables]=await db.execute<RowDataPacket[]>("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA='heji_m4_bench' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
      const counts:Record<string,string>={};
      for(const table of tables){
        const name=String(table.name);if(!/^[a-z][a-z0-9_]*$/.test(name))throw new Error('意外表名');
        const [rows]=await db.query<RowDataPacket[]>('SELECT COUNT(*) count FROM `'+name+'`');counts[name]=String(rows[0]!.count);
      }
      const [markers]=await db.query<RowDataPacket[]>('SELECT name,checksum FROM schema_migrations ORDER BY name');
      const [versions]=await db.query<RowDataPacket[]>('SELECT id,financialVersion FROM books ORDER BY id');
      const financialVersionHash=createHash('sha256').update(JSON.stringify(versions)).digest('hex');
      const financialVersionTotal=versions.reduce((sum,row)=>sum+BigInt(row.financialVersion),0n).toString();
      const [targets]=await db.query<RowDataPacket[]>("SELECT SCHEMA_NAME name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN ('heji_m4_restore','heji_m4_restore_003','heji_m4_restore_004') ORDER BY SCHEMA_NAME");
      const [constraints]=await db.query<RowDataPacket[]>("SELECT CONSTRAINT_TYPE type,COUNT(*) count FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA='heji_m4_bench' AND TABLE_NAME='settlement_windows' GROUP BY CONSTRAINT_TYPE ORDER BY CONSTRAINT_TYPE");
      let activeWindows:string|null=null;
      if(Object.hasOwn(counts,'settlement_windows')){
        const [active]=await db.query<RowDataPacket[]>('SELECT COUNT(*) count FROM settlement_windows WHERE closedAt IS NULL AND expiresAt>UTC_TIMESTAMP(3)');activeWindows=String(active[0]!.count);
      }
      const plan=await windowMigrationPlan(),targetNames=targets.map(row=>String(row.name));
      if(stage==='before'){
        if(counts.settlement_windows!==undefined||markers.length!==3||!isDeepStrictEqual(markers.map(row=>({name:String(row.name),checksum:String(row.checksum)})),plan.baseline)||targetNames.includes('heji_m4_restore_004'))throw new Error('迁移前状态不符，禁止重复迁移或覆盖');
      }else{
        const before=JSON.parse(await readFile(new URL(reference!,evidenceRoot),'utf8'));
        const oldCounts={...counts};delete oldCounts.settlement_windows;delete oldCounts.schema_migrations;
        const baselineCounts={...before.counts};delete baselineCounts.schema_migrations;
        if(!isDeepStrictEqual(oldCounts,baselineCounts)||financialVersionHash!==before.financialVersionHash||financialVersionTotal!==before.financialVersionTotal||counts.settlement_windows!=='0'||Number(counts.schema_migrations)!==4||activeWindows!=='0')throw new Error('迁移后事实/财务版本或窗口状态异常');
        if(!isDeepStrictEqual(markers.map(row=>({name:String(row.name),checksum:String(row.checksum)})),[...plan.baseline,{name:plan.name,checksum:plan.checksum}]))throw new Error('迁移清单或校验和异常');
        if(!constraints.some(row=>row.type==='FOREIGN KEY'&&Number(row.count)===4)||!constraints.some(row=>row.type==='CHECK'&&Number(row.count)===3))throw new Error('004约束不完整');
        if(stage==='after'&&targetNames.includes('heji_m4_restore_004'))throw new Error('独立恢复目标意外存在');
        if(stage==='final'&&!targetNames.includes('heji_m4_restore_004'))throw new Error('独立恢复目标尚不存在');
      }
      await db.commit();
      const evidence={format:'heji-m4-backup-004-state-v1',stage,at:new Date().toISOString(),database:'heji_m4_bench',counts,financialVersionHash,financialVersionTotal,migrations:markers,restoreTargets:targetNames,constraints,activeWindows,otherConnections:0,reference:reference??null};
      const filename='m4-backup-004-state-'+stage+'-'+evidence.at.replace(/[:.]/g,'-')+'.json';
      await writeFile(new URL(filename,evidenceRoot),JSON.stringify(evidence,null,2)+'\n',{encoding:'utf8',flag:'wx'});
      console.log(JSON.stringify({evidence:filename,stage,tables:tables.length,counts,financialVersionTotal,restoreTargets:targetNames,constraints,activeWindows}));
    }finally{db.release()}
  }finally{await pool.end()}
}
try{await main()}catch(error){
  const code=(error as {code?:string}).code;
  console.error(code&&/^ER_[A-Z0-9_]+$/.test(code)?code:error instanceof Error&&!code?error.message:'只读状态检查失败，未输出连接信息');process.exitCode=1;
}
