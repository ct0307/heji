import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RowDataPacket } from 'mysql2/promise';
import { m4Pool,migrations,requireFixture } from './database.ts';
import { windowRestoreDatabase } from './policy.ts';
import { checkBalances,memberBalancesSql,balanceConservationSql } from './balance-verification.ts';

// 只输出执行计划结构/计数/摘要/耗时，不输出业务行、条件文本或连接配置。
const planKeys=['select_id','table_name','access_type','key','rows_examined_per_scan','rows_produced_per_join','dependent','cacheable','using_temporary_table','using_filesort'];
function planMetadata(value:unknown,path='root',output:Record<string,unknown>[]=[]){
  if(value&&typeof value==='object'){
    const object=value as Record<string,unknown>,entry:Record<string,unknown>={path};
    for(const key of planKeys)if(Object.hasOwn(object,key))entry[key]=object[key];
    if(Object.hasOwn(object,'cost_info'))entry.cost_info=object.cost_info;
    if(Object.keys(entry).length>1)output.push(entry);
    for(const [key,child] of Object.entries(object))if(child&&typeof child==='object')planMetadata(child,path+'.'+key,output);
  }
  return output;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function main(){
  const args=process.argv.slice(2);
  if(!args.length||args.length===1&&args[0]==='--plan'){
    console.log('只读余额查询验证计划：仅既有heji_m4_restore_004；默认不连接、不写文件。');
    console.log('--read-only：只读一致快照、120秒单查询上限、共用完整余额核验、300成员对003账本汇总；输出脱敏新证据。');
    return;
  }
  if(args.length!==1||args[0]!=='--read-only')throw new Error('只接受--plan或--read-only');
  const root=new URL('../../docs/development/evidence/',import.meta.url);
  const reference=JSON.parse(await readFile(new URL('m4-restore-004-postcommit-2026-11-19T10-46-12-717Z.json',root),'utf8'));
  const pool=m4Pool(windowRestoreDatabase);
  try{
    await requireFixture(pool);
    const db=await pool.getConnection();
    try{
      await db.query('SET SESSION max_execution_time=120000');
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const [environment]=await db.query<RowDataPacket[]>('SELECT VERSION() version,@@sql_mode sqlMode,@@transaction_isolation isolationLevel,@@max_execution_time maxExecutionTimeMs');
      const [tables]=await db.query<RowDataPacket[]>('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE=\'BASE TABLE\' ORDER BY TABLE_NAME');
      const counts:Record<string,string>={};
      for(const {name} of tables){
        if(!/^[a-z][a-z0-9_]*$/.test(String(name)))throw new Error('意外表名');
        const [rows]=await db.query<RowDataPacket[]>('SELECT COUNT(*) count FROM `'+String(name)+'`');counts[String(name)]=String(rows[0]!.count);
      }
      if(!isDeepStrictEqual(counts,reference.counts))throw new Error('目标计数与既有恢复证据不符');
      const [versions]=await db.query<RowDataPacket[]>('SELECT id,financialVersion FROM books ORDER BY id');
      const versionHash=digest(versions);
      if(versionHash!==reference.financialVersionHash)throw new Error('目标财务版本与既有证据不符');
      const [markers]=await db.query<RowDataPacket[]>('SELECT name,checksum FROM schema_migrations ORDER BY name');
      const sourceMigrations=(await migrations(true,true)).map(({name,checksum})=>({name,checksum}));
      if(!isDeepStrictEqual(markers.map(row=>({name:String(row.name),checksum:String(row.checksum)})),sourceMigrations))throw new Error('源迁移摘要不符');
      const [explained]=await db.query<RowDataPacket[]>('EXPLAIN FORMAT=JSON '+balanceConservationSql);
      const plan=planMetadata(JSON.parse(String(explained[0]!.EXPLAIN)));
      if(plan.some(entry=>entry.dependent===true))throw new Error('优化计划仍有相关子查询');
      const timings:Array<{stage:string;elapsedMs:number;returnedRows:number}>=[];
      const stages=['historical_share_conservation','current_revision_present','balance_conservation'];
      const observed=new Proxy(db,{get(target,property){
        if(property!=='query')return Reflect.get(target,property);
        return async(sql:string)=>{
          const start=performance.now(),result=await target.query<RowDataPacket[]>(sql);
          const stage=stages[timings.length];if(!stage)throw new Error('核验步骤意外增加');
          timings.push({stage,elapsedMs:performance.now()-start,returnedRows:result[0].length});
          console.log(JSON.stringify({stage,elapsedMs:timings.at(-1)!.elapsedMs,returnedRows:result[0].length}));
          return result;
        };
      }});
      await checkBalances(observed);
      const memberStarted=performance.now();
      const [members]=await db.query<RowDataPacket[]>(memberBalancesSql+' ORDER BY bookId,memberId');
      const memberQueryMs=performance.now()-memberStarted;
      const [derived]=await db.query<RowDataPacket[]>(`SELECT m.bookId,m.id memberId,
        COALESCE(t.paidFen,0)-COALESCE(t.shareFen,0)+COALESCE(t.outgoingFen,0)-COALESCE(t.incomingFen,0) balanceFen
        FROM book_members m LEFT JOIN finance_member_totals t ON t.bookId=m.bookId AND t.memberId=m.id ORDER BY m.bookId,m.id`);
      const canonical=(rows:RowDataPacket[])=>rows.map(row=>({bookId:String(row.bookId),memberId:String(row.memberId),balanceFen:BigInt(row.balanceFen).toString()}));
      const actual=canonical(members),expected=canonical(derived);
      if(!isDeepStrictEqual(actual,expected)||members.length!==Number(counts.book_members))throw new Error('逐成员原始余额与003汇总不符');
      const [endVersions]=await db.query<RowDataPacket[]>('SELECT id,financialVersion FROM books ORDER BY id');
      if(digest(endVersions)!==versionHash)throw new Error('财务版本变化');
      await db.rollback();
      const at=new Date().toISOString();
      const sources=['tests/m4/backup.ts','tests/m4/balance-verification.ts','tests/m4/verify-balance-query.ts','tests/integration/m4-balance-verification.test.ts'];
      const sourceHashes=await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex')})));
      const evidence={format:'heji-m4-balance-query-readonly-v1',at,target:windowRestoreDatabase,
        scope:'只读查询验证，不是恢复/迁移/负载或30分钟恢复重测',transaction:'WITH CONSISTENT SNAPSHOT, READ ONLY; ROLLBACK',
        environment:environment[0],counts,financialVersionHash:versionHash,migrations:sourceMigrations,sourceHashes,
        plan,timings,memberComparison:{rows:members.length,books:versions.length,elapsedMs:memberQueryMs,matched:true,sha256:digest(actual)},
        historicalRestore:{elapsedMs:2480515.1644,within30Minutes:false},
        limitations:['未重跑原慢查询；仅比较原执行计划/已记录耗时下界','未重跑完整恢复，不能据单查询结果认定30分钟目标通过','SQLite离线语义不代替MySQL；本证据单独记录MySQL实测']};
      const file='m4-balance-query-readonly-'+at.replace(/[:.]/g,'-')+'.json';
      await writeFile(new URL(file,root),JSON.stringify(evidence,null,2)+'\n',{encoding:'utf8',flag:'wx'});
      console.log(JSON.stringify({evidence:file,timings,memberRows:members.length,memberQueryMs,matched:true,dependentSubqueries:0}));
    }finally{await db.rollback().catch(()=>{});db.release()}
  }finally{await pool.end()}
}
try{await main()}catch(error){
  const code=(error as {code?:unknown}).code;
  console.error(typeof code==='string'&&/^[A-Z0-9_]+$/.test(code)?code:'只读余额查询验证失败；未输出连接参数或业务行');process.exitCode=1;
}
