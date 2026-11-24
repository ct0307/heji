import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { backupIncludesSummaries } from '../m4/backup-format.ts';
import { migrations } from '../m4/database.ts';

const table=(name:string)=>({name,columns:[],primary:[]});
test('旧备份保持001/002，新备份仅在三类汇总表齐全时选择003，残缺拒绝',()=>{
  assert.equal(backupIncludesSummaries([table('users')]),false);
  assert.equal(backupIncludesSummaries(['users','finance_member_totals','finance_daily_members','finance_daily_categories'].map(table)),true);
  for(const name of ['finance_member_totals','finance_daily_members','finance_daily_categories'])assert.throws(()=>backupIncludesSummaries([table(name)]),/完整/);
});
test('离线迁移目录默认仍只有001/002，003和004仅由显式恢复结构参数追加',async()=>{
  const original=await migrations(),withSummaries=await migrations(true),withWindows=await migrations(true,true);
  assert.deepEqual(original.map(x=>x.name),['001_m1.sql','002_m2.sql']);
  assert.deepEqual(withSummaries.slice(0,2),original);assert.equal(withSummaries[2]!.name,'003_finance_summaries.sql');
  const sql003=await readFile(new URL('../../docs/development/proposals/003_finance_summaries.sql',import.meta.url),'utf8');
  const sql004=await readFile(new URL('../../docs/development/proposals/004_settlement_windows.sql',import.meta.url),'utf8');
  assert.equal(withSummaries[2]!.sql,sql003);
  assert.deepEqual(withWindows.map(x=>x.name),['001_m1.sql','002_m2.sql','003_finance_summaries.sql','004_settlement_windows.sql']);
  assert.equal(withWindows[2]!.sql,sql003);assert.equal(withWindows[3]!.sql,sql004);
  assert.equal(withWindows[3]!.checksum,createHash('sha256').update(sql004).digest('hex'));
  await assert.rejects(()=>migrations(false,true));
});
