import { prepare } from './seed.ts';
import { benchmark } from './benchmark.ts';
import { sqlExperiment } from './sql-experiment.ts';
import { createBackup,restoreBackup } from './backup.ts';
import { parseRestoreArgs,parseBenchmarkArgs } from './policy.ts';
import { windowBenchmark } from './window-benchmark.ts';
import { parseWindowBenchmarkArgs,windowBenchmarkOptions } from './window-benchmark-policy.ts';

const [action,...args]=process.argv.slice(2),apply=args.includes('--apply');
if(!action||action==='--plan'){
  console.log('M4计划模式：没有连接数据库或写文件。');
  console.log('目标仅限heji_m4_bench、heji_m4_restore、heji_m4_restore_003、heji_m4_restore_004和heji_m4_restore_004_timed；已有库拒绝覆盖。');
  console.log('seed：新建10账本固定虚构基准；benchmark：20用户、30秒预热、180秒、3轮；benchmark --participant-study：同账本30/4/8人、9轮敏感性实验；window-benchmark：20用户、5/15/25秒、60次/档的新独立窗口负载；sql：主键/联合索引对照。');
  console.log('backup：一致快照压缩备份并写SHA-256；004使用v2且拒绝活动窗口。restore的004备份必须显式指定--target=heji_m4_restore_004或--target=heji_m4_restore_004_timed。');
  console.log('所有实际动作还需独立明确许可，之后设置HEJI_ALLOW_M4=yes并传--apply。');
}else if(action==='window-benchmark'&&!apply){
  parseWindowBenchmarkArgs(args);const options=windowBenchmarkOptions([]);
  console.log('窗口负载计划：没有连接数据库或写入数据。');
  console.log(`目标heji_m4_bench；${options.users}用户；等待${options.waitMs.map(ms=>ms/1000).join('/')}秒；每档${options.attemptsPerTier}次；每档至少${options.successMinimum}/60次成功；保留全部虚构事实。`);
  console.log('真实运行前只读校验已完成的bench 004 checksum；本负载/数据写入仍须另行取得许可，并使用--apply和HEJI_ALLOW_M4=yes。');
}else if(!apply||process.env.HEJI_ALLOW_M4!=='yes'){
  console.error('已停止：本操作需要针对M4隔离实验的明确许可及--apply/HEJI_ALLOW_M4=yes。');process.exitCode=1;
}else try{
  if(action==='benchmark')await benchmark(parseBenchmarkArgs(args));
  else if(action==='window-benchmark')await windowBenchmark(args);
  else if(action==='seed'&&args.length===1)await prepare();
  else if(action==='sql'&&args.length===1)await sqlExperiment();
  else if(action==='backup'&&args.length===1)await createBackup();
  else if(action==='restore'){const {database,file}=parseRestoreArgs(args.filter(x=>x!=='--apply'));await restoreBackup(file,database)}
  else throw new Error('M4子命令或参数无效');
}catch(error){
  const code=(error as {code?:unknown})?.code;
  console.error(typeof code==='string'?`M4已停止，错误码：${code}；未输出连接信息。`:error instanceof Error?error.message:'M4命令失败，请查看错误并保留隔离数据');process.exitCode=1;
}
