# M4 热点账本参与范围敏感性测试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给现有M4基准增加一个独立的同账本参与范围敏感性实验，比较每笔支出包含4、8、30名成员时的确认冲突与时延，同时保持全账本财务版本保护和旧正式证据不变。

**Architecture:** 在现有纯策略模块增加固定参与人数与确定性成员选择；基准器通过显式`--participant-study`分支运行9个写入轮次，并将每轮原始证据保存到独立命名空间。新增只读汇总器逐轮校验这9份证据并生成小型报告，不拼接庞大的全量样本报告；普通12组正式基准与其resume/finalize路径保持不变。

**Tech Stack:** Node.js 24、TypeScript、`node:test`、现有M4 HTTP/MySQL隔离基准与JSON证据格式；不增加依赖，不增加DDL或迁移。

---

## 文件分工

| 文件 | 职责 |
|---|---|
| `tests/m4/policy.ts` | 解析独立敏感性模式；选择可复现且稳定排序的支出参与成员索引。 |
| `tests/integration/m4-benchmark.test.ts` | 覆盖参与选择边界、覆盖度、确定性与模式参数互斥。 |
| `tests/m4/benchmark.ts` | 仅在明确的敏感性模式下运行30/4/8成员场景，写每轮独立原始证据；普通正式路径不变。 |
| `tests/m4/participant-report.ts` | 校验并汇总9份敏感性轮次；不连接数据库、不加载`.env`、不保留原始样本数组。 |
| `tests/m4/evidence.ts` | 按参与人数推算份额增量，独立于全员30份额的原正式路径。 |
| `tests/m4/report-participants.ts` | 只读CLI，按runId读取独立证据并生成新摘要及源文件SHA-256。 |
| `tests/integration/m4-participant-report.test.ts` | 使用合成样本验证轮次完整性、统计重算、连续计数与证据摘要校验。 |
| `tests/m4/cli.ts` | 只允许敏感性模式透过现有隔离M4授权门禁进入基准器。 |
| `package.json` | 增加只读敏感性报告命令；不增加或更新依赖。 |

不得修改财务服务、迁移、`.env`、数据库内容、既有正式证据或恢复目标。

## Task 1：纯参与成员选择与参数门禁

**Files:** `tests/m4/policy.ts`、`tests/integration/m4-benchmark.test.ts`

- [x] **Step 1: 写参与成员选择失败测试**

新增测试导入`participantIndexes`并验证：

```ts
test('参与集合固定大小、包含付款人、按成员索引排序且随序号可复现轮换',()=>{
  const narrow=participantIndexes(7,0,4);
  assert.equal(narrow.length,4);
  assert.ok(narrow.includes(7));
  assert.deepEqual(narrow,[...narrow].sort((a,b)=>a-b));
  assert.equal(new Set(narrow).size,4);
  assert.deepEqual(participantIndexes(7,0,4),narrow);
  assert.notDeepEqual(participantIndexes(7,0,4),participantIndexes(7,1,4));
  assert.deepEqual(participantIndexes(7,0,30),Array.from({length:30},(_,i)=>i));
});
```

- [x] **Step 2: 运行定向测试确认红灯**

运行：`node --test tests/integration/m4-benchmark.test.ts`  
预期：失败，提示`participantIndexes`尚未导出。

- [x] **Step 3: 实现纯确定性选择函数和敏感性参数解析**

`participantIndexes(actor,sequence,count,memberCount=30)`须检查所有值为整数，`memberCount>=2`，`0<=actor<memberCount`，`2<=count<=memberCount`，`sequence>=0`。保留付款人，再从其余成员中按`sequence`作环形轮换取足`count-1`名，最后按数字ID排序。

`benchmarkOptions(['--participant-study'])`返回固定20用户、30秒预热、180秒测量、3轮和`participantCounts:[30,4,8]`。拒绝与`--smoke`、`--resume`、未知参数组合；普通空参数和既有resume结果必须保持原样。

- [x] **Step 4: 补参数失败测试并确认转绿**

覆盖默认参数不变、敏感性人数固定为`[30,4,8]`、以及`--participant-study --smoke`、`--participant-study --resume=<id>`、未知人数参数均被拒绝。再次运行：`node --test tests/integration/m4-benchmark.test.ts`，预期全部通过。

## Task 2：隔离敏感性轮次生成

**Files:** `tests/m4/benchmark.ts`、`tests/m4/cli.ts`、`tests/integration/m4-benchmark.test.ts`

- [x] **Step 1: 先测试CLI仅接受显式研究参数**

扩展纯策略测试确认`--participant-study`被保留到benchmark handler；`--apply`仍由现有CLI消费，`HEJI_ALLOW_M4=yes`与目标库`heji_m4_bench`门禁保持必需。没有该显式选项时，既有12组路径不得出现参与人数元数据。

- [x] **Step 2: 按run/profile/round生成全新文件名**

敏感性每轮文件使用`m4-round-participant-study-<runId>-p<participantCount>-<round>.json`；写入使用`flag:'wx'`。开跑前检查该runId下任何同前缀文件，如存在则拒绝整组启动，敏感性模式不支持resume。

- [x] **Step 3: 接入确定性参与成员**

仅敏感性写入路径调用`participantIndexes(actor,sequence,participantCount,30)`；将索引映射成当前账本成员ID，EQUAL使用该ID列表，EXACT使用`splitEqual`在同一集合生成精确份额。付款人必须位于集合。确认操作流程、请求双方、预览和`expectedFinancialVersion`提交保持现状。

- [x] **Step 4: 遍历固定九组并保存轮次元数据**

敏感性模式只遍历人数`30,4,8`和轮次`1..3`，每组仅运行`write/same-book`；沿用20并发、30秒预热、180秒测量和60/30/10操作比。每轮证据记录参与人数、运行选项、起始规模、摘要和原始HTTP/工作流样本。普通正式模式仍只运行既有12组。

- [x] **Step 5: 保持两种报告路径隔离并做静态验证**

敏感性模式不生成巨型全样本总报告，不调用原formal resume/finalize；仅保存九个逐轮文件，汇总由独立只读命令完成。执行`node --test tests/integration/m4-benchmark.test.ts`和`npm run typecheck`，不运行任何基准。

## Task 3：只读敏感性报告器

**Files:** `tests/m4/participant-report.ts`、`tests/m4/report-participants.ts`、`tests/integration/m4-participant-report.test.ts`、`package.json`

- [x] **Step 1: 用合成轮次写报告验证测试**

构造三个profile各三轮的小型样本，覆盖一次成功确认、一次`PREVIEW_STALE`、参与人数、操作分布和账本规模连续性。断言报告能重算确认成功率与版本差距，不包含`workflowSamples`或`httpSamples`。

- [x] **Step 2: 测试缺组、重复组和篡改拒绝**

分别删除一轮、复制一轮、改profile元数据、改已存摘要、改相邻起止规模、给非确认操作添加`PREVIEW_STALE`，均须拒绝报告生成。合成测试不连接MySQL。

- [x] **Step 3: 实现9组严格白名单校验和单轮摘要**

只接受一个有效UTC runId和精确九个`p30/p4/p8`轮次文件；依次读取单轮、核对run/options/profile/round和相邻规模，按各参与人数重算shares行数，重算工作流、HTTP端点、操作计数、吞吐及确认成功/版本差距摘要，并以SHA-256记录源证据。小报告不保留样本。

- [x] **Step 4: 建立无环境配置的只读报告CLI**

新增`tests/m4/report-participants.ts`，命令参数只接受`--run=<合法UTC标识>`；只读`docs/development/evidence/`，摘要以`flag:'wx'`写入`m4-participant-study-summary-<runId>.json`。在`package.json`增加`m4:report:participants`脚本。该脚本不导入数据库模块或`.env`。

- [x] **Step 5: 运行报告定向测试**

运行：`node --test tests/integration/m4-participant-report.test.ts`  
预期：全部合成样本测试通过，无数据库连接。

## Task 4：回归与执行边界文档

**Files:** `tests/integration/m4-benchmark.test.ts`、`tests/integration/m4-participant-report.test.ts`、`docs/development/m4-hot-book-realistic-load-design.md`、`docs/development/task_plan.md`

- [x] **Step 1: 运行项目无数据库验证**

运行`npm test`、`npm run test:m4`、`npm run typecheck`、`npm run build`。以上均不得设置`HEJI_ALLOW_M4`、启动数据库、API或基准负载。

- [x] **Step 2: 对照设计核验新旧模式隔离**

确认旧benchmark默认输出文件名、12组resume/finalize参数和旧报告小结形状不变；敏感性证据只使用新前缀且包含run/profile/round校验。确认financialVersion比较、PREVIEW_STALE分类和用户重新确认逻辑未改。

- [x] **Step 3: 记录实施验证但不运行敏感性负载**

更新设计稿与任务计划的代码实现状态。不得执行`npm run m4:benchmark -- --participant-study`，不得设置`HEJI_ALLOW_M4=yes`，不得连接`heji_m4_bench`。新基准执行是独立授权步骤。

**实施结果（2026-11-18）：** 独立敏感性模式、确定性参与成员选择、9轮证据清单和只读报告器已实现；普通正式12组、resume/finalize路径及全账本`financialVersion`/`PREVIEW_STALE`门禁保持不变。新代码使用合成报告测试覆盖轮次完整性、统计重算及证据摘要校验。无数据库测试、M4测试、类型检查和构建均通过。未运行数据库测试、服务或基准。

## 已授权执行结果

用户已于2026-11-18明确批准并执行一次`heji_m4_bench`敏感性研究。runId为`2026-11-18T11-27-06-199Z`，9/9轮自然完成，数据保留；结果和实际库规模见`m4-hot-book-realistic-load-design.md`及`evidence/m4-participant-study-summary-2026-11-18T11-27-06-199Z.json`。不得重跑此run或清理新增数据。

报告器发现并修复了轮次时间元数据校验与实际基准格式不一致的问题；测试现要求轮次共享清单run起始时间、完成时间严格递增，并继续校验环境、每轮规模链及最终规模。修复后普通/M4测试、类型检查和构建均通过。

## 仓库限制

项目根目录没有Git元数据。不得初始化仓库、创建分支或提交；按项目规则保留文件变更并以验证结果交接。
