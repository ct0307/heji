# 恢复分阶段计时设计与实施计划

日期：2026-11-19。本轮范围来自用户确认的“先完成分阶段计时，再形成新独立恢复验收方案”。采用当前会话顺序实施；不创建代理或Git提交，不执行数据库操作。

目标：在原恢复流程中附加可核对的阶段耗时、状态与失败位置，保留全部财务核验、目标限制、SQL及原总耗时口径。

## 设计

使用Node内置performance.now单调时钟；每个阶段记录序号、父序号、名称、起止偏移、耗时、状态。逐表只记录已校验的表名，逐账本只记录顺序号；不记录SQL、成员/账本ID、行内容或异常消息。阶段开始/结束输出结构化进度，结束生成计时快照。

一级阶段互不重叠，二级项归入父阶段；unmeasuredMs为总时长减一级阶段时长，不能再将嵌套阶段累加到总额。总耗时保持从恢复入口到成功commit返回；报告写入和连接收尾不计入30分钟目标，与原结果保持可比。within30Minutes仅在全部核验及commit成功后计算，边界<=1800000ms。

失败必须重新抛出原异常，阶段标记failed；后续阶段不继续、不自动重试；DDL残留保留。阶段进度记录失败位置，成功报告只在commit后生成。本轮不改变原异常与回滚流程，不增加自动清理。

对比方案：仅文本起止日志难以自动对账；数据库profile需要真实运行且可能涉及环境权限。选择内存阶段记录与附加JSON，开销限制在阶段/表/账本级，不逐行或逐批打日志。

## 文件与实施顺序

| 顺序 | 文件 | 实施/验证 |
|---|---|---|
| 1 | tests/integration/m4-restore-timing.test.ts | 假时钟验证成功、失败、嵌套、零耗时、快照独立；失败时保留原异常且不输出消息 |
| 2 | tests/m4/restore-timing.ts | 实现RestoreTimer.measure(stage,action,detail?)与snapshot，默认performance.now，观察回调不得改变原业务结果 |
| 3 | tests/m4/balance-verification.ts | 可选计时器，历史份额/当前版本/账本守恒分别覆盖查询与断言；无观察者时保持旧调用兼容 |
| 4 | tests/m4/backup.ts | 附加计时，保留原SQL及顺序；metadata、外键、余额和派生对账计入commit前 |
| 5 | tests/m4/restore-timing-fixture.ts 与 tests/integration/m4-restore-timing.test.ts | 使用临时合成gzip和Node模块模拟执行真实恢复入口，覆盖v1/v2成功和16类失败；全部数据库工厂替换，不访问真实.local/m4、.env或MySQL |
| 6 | docs/development/m4-restore-timed-acceptance.md | 固定已有备份摘要、候选新目标、停止条件、完整财务矩阵、成功/超时/失败证据与许可边界 |

先执行`node --test tests/integration/m4-restore-timing.test.ts`观察失败，再实现并复验。最终执行`npm test`、`npm run build`及无env的`node tests/m4/cli.ts --plan`、`node database/scripts/migrate-windows.ts --plan`。不运行任何--apply命令。

## 阶段清单

文件权限/路径/长度/SHA256；迁移源/流式记录预检；创建空schema；数据库连接；实际列和主键核对；事务/导入；逐表摘要（子项表名）；迁移清单/checksum/夹具标记；全部外键；历史份额/当前版本/账本守恒；003派生余额和期间报表（子项账本序号）；确认/冲正/窗口计数；commit。未启用003的旧v1没有派生对账阶段，禁止补造成功记录。

## 本轮退出条件

离线回归、完整测试和构建通过；方案与交接已复读、链接/编码检查通过；旧001–004源摘要、目标白名单和历史证据不改。原41分20.52秒/within30Minutes=false继续保留。真实新恢复尚未获准且不得执行。
