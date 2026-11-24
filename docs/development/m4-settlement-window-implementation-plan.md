# 短时结算窗口实施计划

用户已于2026-11-19审核规格并授权本轮代码实现。使用 executing-plans 在当前会话顺序实施，不建立新工作树、不提交Git。

**目标：** 保留完整财务版本门禁，为指定确认者提供数据库持久化的30秒核对窗口和30秒冷却。

**架构：** 共享窗口模块负责数据库当前读、到期规则及写入保护；财务事务和邀请加入均先锁账本、授权成员，再锁窗口和业务对象。HTTP只增加显式申请、查询和关闭；前端不自动重试写请求。

**技术：** 既有Vue3、TypeScript、Express5、MySQL8、node:test，不增加依赖。

## 1. 共享规则和测试
- [x] 新建 `tests/integration/m4-settlement-window.test.ts`，先验证未实现失败。
- [x] 新建 `apps/api/src/shared/settlement-window.ts`：30秒边界、冷却、绑定确认、过期ID、取消/拒绝、故障关闭、004缺失兼容。
- [x] 运行 `node --test tests/integration/m4-settlement-window.test.ts`，验证规则及SQL适配。

## 2. 后端所有写入口
- [x] 修改 `finance/mysql-store.ts`、`contracts.ts`、`validation.ts`、`routes.ts`：窗口行在业务对象前加锁，授权和成功重放在拒绝之前；确认变更前重读数据库时间；申请与新预览、关闭与业务结果均同事务。
- [x] 修改 `m1/mysql-store.ts`：新增/重新加入被暂停，已成功加入重放正常返回。
- [x] 增加事务模拟回归，验证回滚、幂等、授权、顺序和原版本门禁。

## 3. 独立迁移与协议
- [x] 新建 `docs/development/proposals/004_settlement_windows.sql`、`database/scripts/window-migration.ts`、`migrate-windows.ts`；沿用003独立提案惯例，只新增一表，复合外键及UTC期限；默认离线计划，独立许可与维护门禁。
- [x] 更新 `package.json`、共享契约、OpenAPI生成源和JSON；原迁移入口不自动执行004。
- [x] 迁移门禁离线测试；检查备份入口遇到004必须拒绝无声漏表。

## 4. 结算面板
- [x] 修改 `apps/web/src/components/SettlementPanel.vue`、`finance.ts`及`views/BookView.vue`：显式申请，替换预览并清勾选，倒计时、关闭、到期禁用和重新可见补查。审计面板新增中文生命周期名称。
- [x] 离线测试期限与幂等意图、复核网络/状态失败禁用路径；Vue类型检查与构建通过。实际窗口UI网络/状态交互尚未验收。

## 5. 验收与接续
- [x] 运行 `npm test`130/130、`npm run build`、普通迁移和004离线计划；未运行 `test:db`、迁移或新负载。
- [x] 同步设计状态、task_plan、findings、progress、next-session及运行说明；真实DB、多连接、窗口UI及新负载尚未验收，见`m4-settlement-window-verification.md`。
- [x] 热点P1保持开放；实际迁移和开发库写入需后续明确许可。已准备`tests/windows/mysql.test.ts`，仅类型检查通过。
