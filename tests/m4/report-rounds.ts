import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseRoundRunId, expectedRoundFiles, summarizeRound, createRoundReport, type RoundSource } from './round-report.ts';

// 只读分轮证据，不导入数据库、应用入口、整体报告或本地环境配置。
const runId=parseRoundRunId(process.argv.slice(2));
const directory=new URL('../../docs/development/evidence/',import.meta.url);
const existing=await readdir(directory),filenames=expectedRoundFiles(runId,existing);
const reportName=`m4-performance-round-summary-${runId}.json`;
if(existing.includes(reportName))throw new Error('该run已有逐轮摘要，拒绝覆盖');

async function loadRound(filename:string):Promise<RoundSource>{
  // 此函数返回后，Buffer、解析对象和样本数组均不再被后续轮次引用。
  const bytes=await readFile(new URL(filename,directory));
  return {filename,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),round:summarizeRound(JSON.parse(bytes.toString('utf8')))};
}
const sources:RoundSource[]=[];
for(const filename of filenames)sources.push(await loadRound(filename));
const report={...createRoundReport(runId,sources),createdAt:new Date().toISOString()};
await writeFile(new URL(reportName,directory),JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
console.log(`已生成 docs/development/evidence/${reportName}；12组正式分轮证据；首起点为实测，终点仅为推算，未查询数据库。`);
