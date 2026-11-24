export type Scale={expenses:string;versions:string;shares:string;confirmed:string;requests:string};
export type MutationCounts={expenses:number;requests:number;confirmed:number};
export type ParticipantMutationCounts=MutationCounts&{shares:number};
import type { Sample,RunGroup } from './policy.ts';
export type WorkflowRecord=RunGroup&{phase:string;sample:Sample};
export function mutationCounts(records:WorkflowRecord[]):MutationCounts{
  let expenses=0,requests=0,confirmed=0;
  for(const row of records){
    if(row.mode!=='write')continue;
    if((row.sample.operation==='equal'||row.sample.operation==='exact')&&row.sample.status===201)expenses++;
    if(row.sample.operation==='confirm'){
      if(row.sample.status===200)requests++,confirmed++;
      else if(row.sample.status===409&&row.sample.code==='PREVIEW_STALE')requests++;
      else throw new Error('正式续跑证据含未分类确认结果，拒绝改动隔离库');
    }
  }
  return {expenses,requests,confirmed};
}
export function adjustScale(scale:Scale,counts:MutationCounts,sign:1|-1):Scale{
  const result={...scale};
  for(const key of ['expenses','versions','shares','confirmed','requests'] as const){
    const amount=key==='expenses'||key==='versions'?counts.expenses:key==='shares'?counts.expenses*30:key==='confirmed'?counts.confirmed:counts.requests;
    const value=Number(result[key])+sign*amount;
    if(!Number.isSafeInteger(value)||value<0)throw new Error('M4隔离行数与原始样本不匹配，拒绝续跑');
    result[key]=String(value);
  }
  return result;
}
export function participantStudyCounts(records:WorkflowRecord[],participantCount:number):ParticipantMutationCounts{
  if(![4,8,30].includes(participantCount))throw new Error('参与人数不在敏感性研究范围');
  let expenses=0,requests=0,confirmed=0;
  for(const row of records){
    if((row.sample.operation==='equal'||row.sample.operation==='exact')&&row.sample.status===201)expenses++;
    if(row.sample.operation==='confirm'){
      if(row.sample.status===200)requests++,confirmed++;
      else if(row.sample.status===409&&row.sample.code==='PREVIEW_STALE')requests++;
      else throw new Error('敏感性研究含未分类确认结果，拒绝生成报告');
    }
  }
  return {expenses,requests,confirmed,shares:expenses*participantCount};
}
export function adjustParticipantScale(scale:Scale,counts:ParticipantMutationCounts,sign:1|-1):Scale{
  const result={...scale};
  for(const key of ['expenses','versions','shares','confirmed','requests'] as const){
    const amount=key==='expenses'||key==='versions'?counts.expenses:key==='shares'?counts.shares:key==='confirmed'?counts.confirmed:counts.requests;
    const value=Number(result[key])+sign*amount;
    if(!Number.isSafeInteger(value)||value<0)throw new Error('敏感性研究的数据库行数与原始样本不匹配');
    result[key]=String(value);
  }
  return result;
}
export function reconcileCompletedRun(start:Scale,resumeStart:Scale,end:Scale,prior:MutationCounts,last:MutationCounts,residue:MutationCounts):Scale{
  const expectedResume=adjustScale(adjustScale(start,prior,1),residue,1),expectedEnd=adjustScale(resumeStart,last,1);
  for(const key of Object.keys(start) as Array<keyof Scale>){
    if(expectedResume[key]!==resumeStart[key]||expectedEnd[key]!==end[key])throw new Error('已落盘正式轮次与数据库起止计数不匹配，拒绝生成报告');
  }
  return {...start};
}
