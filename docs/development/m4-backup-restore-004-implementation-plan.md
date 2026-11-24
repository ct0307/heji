# M4 004 备份与恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 按任务顺序实施，先测试后实现；每项核验通过后再继续。项目没有 Git 元数据，不执行提交。

**Goal:** 在不改变现有 v1 备份与恢复行为的前提下，增加含 004 结构的 v2 M4 隔离备份格式和 `heji_m4_restore_004` 固定恢复目标，并用离线测试验证所有拒绝条件。

**Architecture:** 备份版本由精确迁移标记和 schema 共同决定。v1 继续表示 001/002 与可选 003；v2 必须有 001–004 的完整迁移清单和 `settlement_windows` 表。恢复先完整验证压缩文件、头部、迁移清单和逐表摘要，再按版本创建固定空 schema 并核验导入结果；不运行备份携带的 SQL。

**Tech Stack:** Node.js 24、TypeScript、`node:test`、MySQL 8 隔离 M4 工具；不增加依赖。

**阶段说明：** 本计划为已完成的离线实施记录。后续bench 004、新v2备份和独立恢复已分别获准并单次执行，完整性通过、恢复41分20.52秒超出30分钟目标，见[真实验收](m4-backup-restore-004-real-verification.md)。下文“真实操作仍待授权/未执行”是当时边界，不是当前状态或重复操作许可。

---

## 文件分工

| 文件 | 变更职责 |
|---|---|
| `tests/m4/policy.ts` | 增加 `heji_m4_restore_004` 白名单，保持旧目标解析兼容。 |
| `tests/m4/backup-format.ts` | 定义 v1/v2 头部、迁移清单校验、schema 版本判定及活动窗口纯策略。 |
| `tests/m4/database.ts` | 通过显式参数决定创建 003/004 恢复结构；004 SQL 仍从固定提案文件读取并计算校验和。 |
| `tests/m4/backup.ts` | 在一致快照中识别精确版本、拒绝活动窗口、保存 v2；恢复时预先验证并按版本重建与核验。 |
| `tests/m4/backup-preflight.ts` | 正式恢复共用的流式记录预检，无文件/数据库副作用；验证摘要、迁移事实和快照窗口状态。 |
| `tests/m4/cli.ts` | 更新离线计划提示，解释固定目标，不新增操作许可或隐式执行。 |
| `tests/integration/m4-backup-format.test.ts` | 覆盖头部、迁移清单、格式版本和拒绝边界。 |
| `tests/integration/m4-summary-backup.test.ts` | 保持旧 001/002 与 003 行为并验证其不被 004 路径误判。 |
| `tests/integration/m4-window-migration.test.ts` | 更新“004 不支持备份”的历史断言为 v1 仍拒绝、v2 有条件接受。 |
| `tests/integration/m4-backup-restore-004.test.ts` | 新增合成备份/恢复策略和建库前拒绝回归，不连接数据库。 |
| `tests/integration/m4-benchmark.test.ts` | 扩展旧固定目标断言，接受004并继续拒绝其他名称。 |
| `database/scripts/migrate-windows.ts` | 仅修正离线提示，独立迁移行为不变。 |
| `docs/development/m4-backup-restore-004-design.md` | 实施后标注代码/离线状态，保留真实迁移、备份、恢复待授权。 |
| `docs/development/m4-settlement-window-verification.md`、`m4-delivery-checklist.md`、`next-session.md` | 同步准确状态与真实操作边界。 |

## Task 1：目标库策略与格式类型

**Files:** `tests/m4/policy.ts`、`tests/integration/m4-backup-format.test.ts`

- [x] **Step 1: 先写目标解析失败测试**

覆盖旧恢复目标默认行为不变，显式 `--target=heji_m4_restore_004` 可解析；未知目标、重复目标和目标缺值必须拒绝。

运行：`node --test tests/integration/m4-backup-format.test.ts`

预期：新目标用例因当前固定白名单不含该库而失败，旧用例保持通过。

- [x] **Step 2: 最小扩展目标白名单**

在 `policy.ts` 新增 `windowRestoreDatabase='heji_m4_restore_004'`，将其加到 `restoreDatabases`。`parseRestoreArgs` 继续默认 `heji_m4_restore`，只接受一个 `--target=` 且目标必须在白名单内；`assertM4Target` 沿用原 `HEJI_ALLOW_M4=yes` 门禁。

- [x] **Step 3: 定义格式版本与迁移记录**

在 `backup-format.ts` 新增 `MigrationRecord {name:string;checksum:string}`、`HeaderV1` 与 `HeaderV2`，联合类型 `Header=HeaderV1|HeaderV2`。V1 头部字段保持现有形状；V2 使用 `format:'heji-m4-backup-v2'` 并包含 `migrations:MigrationRecord[]`。迁移清单必须按 `001_m1.sql`、`002_m2.sql`、`003_finance_summaries.sql`、`004_settlement_windows.sql` 顺序且每项校验和为 64 位小写十六进制。

类型边界固定为：

```ts
interface MigrationRecord { name: string; checksum: string }
interface HeaderV1 { format: 'heji-m4-backup-v1'; database: string; version: string; schema: Table[]; createdAt: string; seed: string }
interface HeaderV2 extends Omit<HeaderV1, 'format'> { format: 'heji-m4-backup-v2'; migrations: MigrationRecord[] }
type Header = HeaderV1 | HeaderV2
```

- [x] **Step 4: 跑定向测试与类型检查**

运行 `node --test tests/integration/m4-backup-format.test.ts` 和 `npm run typecheck`。预期新增目标解析与迁移清单校验通过，既有恢复参数仍不变。

## Task 2：纯格式识别与头部验证

**Files:** `tests/m4/backup-format.ts`、`tests/integration/m4-backup-format.test.ts`、`tests/integration/m4-summary-backup.test.ts`、`tests/integration/m4-window-migration.test.ts`

- [x] **Step 1: 增加版本识别失败测试**

合成表清单覆盖：无窗口表且无汇总表选择旧结构；完整三张汇总表选择 003；含窗口表但不完整汇总集合拒绝；v2 缺窗口表拒绝；v1 含窗口表拒绝；未知表/非法标识符拒绝。迁移清单测试覆盖缺项、重排、重复、未知项和错误摘要。

- [x] **Step 2: 实现 schema 版本纯函数**

提供 `backupSchemaVersion(schema)`，检查汇总表集合完整性：无窗口表返回 `v1` 与 `includeSummaries` 标志；有窗口表仅在三张汇总表齐全时返回 `v2`；部分组合一律报错。`backupIncludesSummaries` 如保留则只服务 v1，不允许单独推断 v2。

版本选择返回值使用明确判别联合，避免用布尔值混淆 003 与 004：

```ts
type BackupSchemaVersion =
  | { format: 'heji-m4-backup-v1'; includeSummaries: boolean }
  | { format: 'heji-m4-backup-v2'; includeSummaries: true; includeWindows: true }
```

- [x] **Step 3: 实现 V1/V2 头部验证**

`validateHeader(header,current)` 按 discriminator 分支：V1 精确保持旧 fixture/source/schema 检查且拒绝 `settlement_windows`；V2 检查固定 fixture/source、完整迁移名次序/校验和形状、v2 schema 版本及当前 schema 完全一致。迁移摘要与当前源的比对由调用方将固定迁移 manifest 传入验证函数完成，不能从备份内容执行 SQL。

- [x] **Step 4: 更新保护性断言与运行定向测试**

`m4-window-migration.test.ts` 改为断言旧 v1 仍拒绝窗口表，完整 v2 schema 才能通过纯版本判定。运行三份相关定向测试；预期 v1 历史结构和用户备份兼容行为无回归。

## Task 3：显式创建 004 空恢复结构

**Files:** `tests/m4/database.ts`、`tests/integration/m4-summary-backup.test.ts`、`tests/integration/m4-backup-restore-004.test.ts`

- [x] **Step 1: 添加迁移结构选择测试**

断言 `migrations()` 仍只返回 001/002，`migrations(true)` 仍只追加原 003，`migrations(true,true)` 才按顺序追加 003 和固定提案中的 004，所有 checksum 均等于源文件 SHA-256。`createEmptySchema` 默认行为必须保持原样。

- [x] **Step 2: 扩展迁移加载签名**

将迁移加载改为 `migrations(includeSummaries=false,includeWindows=false)`；`includeWindows` 为真时强制 `includeSummaries` 为真，并从 `docs/development/proposals/004_settlement_windows.sql` 读取源码。新增 `createEmptySchema(database,recordMetadata=true,includeSummaries=false,includeWindows=false)`，只在显式 v2 恢复路径调用。004 不加入 `database/migrations/`，不改变普通迁移入口。

- [x] **Step 3: 验证迁移源并跑测试**

运行上述合成测试和 `npm run typecheck`。预期既有 seed/benchmark/schema 路径仍只构建原结构，只有 v2 可构建 004。

## Task 4：一致快照 v2 备份与活动窗口拒绝

**Files:** `tests/m4/backup-format.ts`、`tests/m4/backup.ts`、`tests/integration/m4-backup-restore-004.test.ts`

- [x] **Step 1: 写活动窗口和版本来源失败测试**

纯策略测试覆盖 `closedAt IS NULL AND expiresAt > now` 拒绝，已关闭或已到期窗口接受；迁移标记缺失、额外或 checksum 不匹配时拒绝，不得仅凭表存在来判定 v2。所有测试仅使用合成参数。

- [x] **Step 2: 加载精确迁移状态**

在已有一致性只读快照内读取 `schema_migrations` 与 schema。V1 要求 schema/003 标记相符；V2 要求 001–004 完整且 checksum 与本地固定源文件匹配。读取 `UTC_TIMESTAMP(3)`，用数据库时刻判定是否存在活动窗口；活动时在创建输出文件前停止。

- [x] **Step 3: 按版本生成头部**

V1 继续调用原 `headerOf`，文件与 manifest 形状不变；V2 使用独立 `headerV2Of(schema,seed,migrations)`。表导出顺序、行编码、逐表摘要、压缩摘要、`wx` 独占创建和 `.local/m4/` 边界保持一致。禁止把行值或连接凭据写到控制台/证据中。

活动窗口纯策略签名固定为 `hasActiveSettlementWindow(rows): boolean`，活动条件为 `closedAt === null && expiresAtIsFuture === 1`；数据库用同一 SQL 的 `expiresAt>UTC_TIMESTAMP(3)` 生成 `expiresAtIsFuture`，不在 JavaScript 中转换 MySQL DATETIME 或依赖 session timezone。

- [x] **Step 4: 验证备份测试与类型**

运行备份格式、窗口迁移、summary backup 三份离线测试及 `npm run typecheck`。无数据库访问。

## Task 5：按格式恢复与 004 完整性校验

**Files:** `tests/m4/backup.ts`、`tests/m4/policy.ts`、`tests/integration/m4-backup-restore-004.test.ts`

- [x] **Step 1: 写恢复选择与活动状态合成测试**

覆盖 v1 默认/003 目标行为不变，v2 只映射 `heji_m4_restore_004`；版本与目标不配、头部 checksum 与本地迁移源不符、窗口表有活动行、清单/摘要不符时，均须在 `createEmptySchema` 前失败。测试用纯函数/依赖注入，不导入数据库配置或读取 `.env`。

- [x] **Step 2: 在任何建库动作前验证版本清单**

恢复文件预检阶段读取 v1/v2 discriminator；V2 加载固定迁移清单并与本地 001–004 源 checksum 比较，验证 schema 版本及固定恢复目标。任何不匹配都在 `createEmptySchema` 前拒绝。保持原路径校验、符号链接拒绝、整体/逐表摘要及记录类型校验。

- [x] **Step 3: 根据 v2 创建 schema 并核验内容**

V1 继续调用当前 003/旧结构逻辑；V2 显式调用 `createEmptySchema(database,false,true,true)`。`verifyContent` 按头部完整迁移清单与 checksum 对账；继续执行逐表摘要、外键、份额与余额守恒、003 派生余额/期间报表对比，追加 `settlement_windows` 活动窗口数为 0 检查。验收证据使用新格式标记并写入固定目标名，但不包括备份行内容。

- [x] **Step 4: 运行离线恢复回归**

运行 `node --test tests/integration/m4-backup-restore-004.test.ts` 和全部相关 backup-format/summary/window-migration 测试；预期无 MySQL 连接且 v1/v2 边界均锁定。

## Task 6：CLI 与交接材料

**Files:** `tests/m4/cli.ts`、`docs/development/m4-backup-restore-004-design.md`、`docs/development/m4-settlement-window-verification.md`、`docs/development/m4-delivery-checklist.md`、`docs/development/next-session.md`

- [x] **Step 1: 更新离线帮助文字**

`m4:plan` 明列三个恢复目标并说明 v2 仅适用于已迁移 004 的隔离源、恢复目标是 `heji_m4_restore_004`；计划模式仍不连接数据库或写文件。CLI 不为真实动作添加自动许可。

- [x] **Step 2: 记录实现边界**

将设计文档状态改为“离线实现与回归通过；bench 迁移、v2 备份与真实恢复未执行”。更新验收与接续记录：真实操作许可分离，热点确认 P1、新人工等待负载、bench 004 和真实恢复保持开放，禁止重跑旧负载/恢复或清理。

- [x] **Step 3: 审核文档一致性**

检查所有相对链接、格式版本、目标名和测试命令；全文搜索 `004 尚不支持`，确认仅保留明确说明旧 v1 不支持，而不是陈述整体功能仍未实现。

## Task 7：全量离线验证与交付

**Files:** 不新增生产代码；更新本计划和接续状态。

- [x] **Step 1: 跑完整回归和构建**

运行 `npm test`、`npm run typecheck`、`npm run build`。均不得设置 `HEJI_ALLOW_M4` 或 `HEJI_ALLOW_MIGRATION`，不得执行 `test:db`、`test:db:windows`、M4 基准、seed、backup、restore 或 migration apply。

- [x] **Step 2: 核对范围与证据**

审阅 `git` 不可用（项目无 Git 元数据）的工作区现状，不进行清理；对照设计逐项确认 v1 行为、v2 manifest、活动窗口拒绝、固定目标、建库前拒绝和恢复完整性检查。测试输出中记录通过/失败/跳过数及构建退出码。

- [x] **Step 3: 标记代码阶段完成**

只将本实现计划的离线代码阶段标为完成。真实 004 bench 迁移、v2 备份、`heji_m4_restore_004` 创建/恢复与验收仍需分别明确授权，不能因离线通过关闭整个 M4 或热点 P1。

## 明确不执行

最终结果：144/144普通测试，类型检查/构建及两个离线计划入口通过；详情见`m4-backup-restore-004-verification.md`。真实操作未执行，独立授权清单为`m4-backup-restore-004-execution.md`。流式预检在建库前比较表集合、头部、迁移事实及摘要；列/主键与真实空schema的完整对比发生于建库后、导入前，失败保留空目标。

- 不运行 `npm run db:window:migrate -- --apply --database=heji_m4_bench --maintenance`。
- 不运行 `npm run m4:backup -- --apply`，不创建或覆盖任何备份。
- 不运行 `npm run m4:restore -- --apply`，不创建恢复库。
- 不连接、修改或输出 `.env`、数据库密码、token、Cookie 或备份行内容。
- 不重跑 12 组正式基准、9 组敏感性研究、旧 003 恢复，不清理 `.local/m4/` 数据。
