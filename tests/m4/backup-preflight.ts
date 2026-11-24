import { createHash } from 'node:crypto';
import { decodeRow,validateRestorePlan,validateMigrationManifest,type Header,type MigrationRecord } from './backup-format.ts';

/** 只接收记录流和固定迁移源；全部校验通过后调用方才可创建恢复库。 */
export async function preflightRecords(records:AsyncIterable<Record<string,unknown>>,manifest:Record<string,unknown>,database:string,expected:MigrationRecord[]){
  let head:Header|undefined,restorePlan:ReturnType<typeof validateRestorePlan>|undefined;
  let total=0,tableIndex=0,tableRows=0,hash=createHash('sha256');
  const digests=manifest.tableDigests as Record<string,{rows:number;sha256:string}>|undefined;
  const migrationRows:MigrationRecord[]=[];
  for await(const record of records){
    if(!head){
      if(record.kind!=='header')throw new Error('备份缺少头部');
      restorePlan=validateRestorePlan(record.value,database,expected);head=record.value as Header;
      if(!digests||Object.keys(digests).length!==head.schema.length||head.schema.some(table=>!Object.hasOwn(digests,table.name)))throw new Error('备份缺少逐表摘要');
      if(head.format==='heji-m4-backup-v2'&&(!Number.isFinite(Date.parse(head.createdAt))||!head.createdAt.endsWith('Z')))throw new Error('v2备份快照时间无效');
      continue;
    }
    const table=head.schema[tableIndex];
    if(!table||record.table!==table.name)throw new Error('备份数据表次序无效');
    if(record.kind==='row'){
      const values=record.value as unknown[];decodeRow(values,table.columns);
      if(head.format==='heji-m4-backup-v2'){
        const value=(name:string)=>values[table.columns.findIndex(column=>column.name===name)];
        if(table.name==='schema_migrations')migrationRows.push({name:String(value('name')),checksum:String(value('checksum'))});
        if(table.name==='settlement_windows'){
          const closed=value('closedAt'),expires=value('expiresAt');
          const expiry=typeof expires==='string'?Date.parse(expires.replace(' ','T')+'Z'):NaN;
          if(closed===undefined||!Number.isFinite(expiry)||closed===null&&expiry>Date.parse(head.createdAt))throw new Error('v2备份包含活动窗口或无效窗口时间');
        }
      }
      hash.update(JSON.stringify(values)+'\n');total++;tableRows++;
    }else if(record.kind==='table-end'){
      const digest=digests![table.name];
      if(record.rows!==tableRows||digest?.rows!==tableRows||hash.digest('hex')!==digest?.sha256)throw new Error('备份逐表行数或摘要不匹配，未创建恢复库');
      tableIndex++;tableRows=0;hash=createHash('sha256');
    }else throw new Error('备份记录类型无效');
  }
  if(!head||!restorePlan||total!==manifest.rows||head.schema.length!==manifest.tables||tableIndex!==head.schema.length||tableRows!==0)throw new Error('备份不完整或记录数校验失败');
  if(head.format==='heji-m4-backup-v2')validateMigrationManifest(migrationRows,expected);
  return {head,restorePlan};
}
