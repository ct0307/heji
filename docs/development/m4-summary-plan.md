# M4 事务内增量汇总实施计划

依据：用户已于2026-11-18确认m4-summary-design.md推荐方案，随后明确批准两库003。使用writing-plans与subagent-driven-development；当前项目无Git，原目录实施，不创建工作树或提交。两库实际迁移均已提交，证据见m4-summary-verification.md。

目标：原始事实与三类派生汇总在同一账本锁/事务中更新，保持原版本、授权、幂等和回滚语义；在临时表证明正确性和查询规模改善后提交迁移审查。

## 任务1：独立汇总模块与迁移草稿
- [x] tests/integration/m4-summaries.test.ts先写失败测试：新增/修正/作废、零份额、分类日期变更、备注、已确认双向转账的delta及BigInt守恒。
- [x] apps/api/src/modules/finance/mysql-summaries.ts实现applyExpenseSummary、applyTransferSummary、summaryAmounts、summaryPeriodReport及仅空表初建的backfillSummaries。
- [x] docs/development/proposals/003_finance_summaries.sql准备三张DECIMAL(65,0)派生表；不放活动migrations目录、不执行持久DDL。
- [x] tests/m4/summary-tables.ts从同一SQL建立连接级临时表，提供临时演练；不清空或删除持久数据。
- [x] 先测试红再绿，逐项规格审查后作质量审查；无需外部依赖。

## 任务2：财务读写接入（先失败回归）
- [x] tests/m4/summaries.test.ts通过固定隔离夹具和回滚事务演练：回填对账、授权、支出新增/修改/作废、日期/分类、确认/冲正、重复键/确认、失败回滚和报表零值。
- [x] MysqlFinanceStore增加显式summary模式；默认在授权及账本锁后读取003标记，未迁移环境自动保持旧路径；model/periodReport按模式选择汇总SQL。
- [x] writeExpense回读新版本后应用前后贡献delta；actRequest确认事实后更新入账汇总；所有调用都位于原事务内。
- [x] 确认新模式失败不降级继续写入，幂等路径不重复增量，commit前事件不发布。

## 任务3：性能演练与迁移审查
- [x] 现有隔离库单连接临时表回填，逐账本与原始事实对账；比较新旧快照/期间查询结果和耗时。首次profile计划采集为空，已修正采集器；不声称该证据含新计划。
- [x] 新普通回归、隔离临时表回归、类型及构建；保持所有旧M4证据，不追加原formal运行。
- [x] 准备固定heji_dev/heji_m4_bench的迁移执行入口（默认plan），核对实际连接库名、001/002校验和和003表冲突；不修改heji_m4_restore。
- [x] 更新seed/备份恢复兼容方案：旧备份按原001/002恢复，不把新迁移强加旧备份；新种子必须回填汇总后再走汇总写入。代码与演练齐备，实际迁移待明确许可。
- [x] 两库003明确获批并顺序完成，事实计数/版本不变、全账本/月份对账通过；开发库新模式真实MySQL51/51通过。
- [ ] 更新接续/验收与证据矩阵，执行新模式HTTP短冒烟和正式达标测量；Nginx/TLS部署仍另行确认。
