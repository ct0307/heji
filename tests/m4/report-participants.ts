import { readdir,readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createParticipantStudyReport,expectedParticipantRoundFiles,parseParticipantRunId } from './participant-report.ts';

// 只读逐轮JSON和run清单，不加载数据库模块或本地配置。
const runId=parseParticipantRunId(process.argv.slice(2));
const directory=new URL('../../docs/development/evidence/',import.meta.url),existing=await readdir(directory);
const reportName=`m4-participant-study-summary-${runId}.json`,manifestName=`m4-participant-study-run-${runId}.json`;
if(existing.includes(reportName))throw new Error('该敏感性研究已有摘要，拒绝覆盖');
if(!existing.includes(manifestName))throw new Error('缺少完整敏感性研究清单');
const manifest=JSON.parse(await readFile(new URL(manifestName,directory),'utf8'));
const filenames=expectedParticipantRoundFiles(runId,existing);
if(JSON.stringify(manifest.roundFiles)!==JSON.stringify(filenames))throw new Error('研究清单的轮次文件清单不匹配');
const sources=[];
for(const filename of filenames){
  const bytes=await readFile(new URL(filename,directory));
  sources.push({filename,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),round:JSON.parse(bytes.toString('utf8'))});
}
const report={...createParticipantStudyReport(manifest,sources),createdAt:new Date().toISOString()};
await writeFile(new URL(reportName,directory),JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
console.log(`已生成 docs/development/evidence/${reportName}；9轮证据逐轮校验通过，未查询数据库。`);
