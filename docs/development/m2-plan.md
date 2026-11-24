# M2 财务闭环实施计划

> 使用subagent-driven-development按任务实现及审查；延续用户已确认的设计基线，不重复设计审批。当前目录未初始化Git，不自动创建仓库或提交。

目标：将真实支出、余额、双方确认和错误登记冲正接入现有账本，覆盖设计T-03至T-14。

架构：保留M1身份与权限入口；财务仓储继承MySQL基础仓储，所有写操作先锁books行，再验证成员/对象权限、幂等和版本，提交审计及业务数据。读取在同一快照获取financialVersion与金额。Vue使用共享DTO，不在客户端判定最终余额。

技术：现有Vue3、TypeScript、Express5、mysql2与Node内置测试器；不新增依赖。

## 任务1：契约、验证与结构（主agent）
- [x] 新建tests/integration/m2-contracts.test.ts，先验证缺失模块失败；覆盖整数分、分摊、日期、字段白名单、强ETag条件列表和规范化摘要。
- [x] packages/contracts/src/index.ts增加ExpenseDto、FinanceSnapshotDto、TransferRequestDto、TransferPreviewDto、ConfirmedTransferDto及ReportDto（服务端另有FinanceResult）。
- [x] apps/api/src/modules/finance/contracts.ts声明read/execute服务契约；validation.ts负责normalizeExpense、条件头、幂等键及摘要。
- [x] database/migrations/002_m2.sql新增支出、版本、分摊、请求、确认和幂等表，所有成员引用绑定bookId；不删除或修改原业务数据。
- [x] 运行node --test tests/integration/m2-contracts.test.ts，期望全部通过；npm run db:plan只审阅，不执行新迁移。

## 任务2：真实仓储与HTTP（实现agent，主agent集成）
- [x] 新建finance/mysql-store.ts及必要职责文件，实现read/execute接口；所有写操作顺序为账本锁、授权、幂等重放、状态/版本检查、金额计算、写入、审计、幂等响应。
- [x] 支出新增/merge-patch/作废/历史；If-Match缺失428、错误412；只录入者可修改；备注修改不递增financialVersion，财务变动递增。
- [x] 快照使用当前有效版本和已确认转账；建议保持确定性；待确认不计余额；报告不含转账与冲正。
- [x] 请求登记/预览/确认/拒绝/取消、双方冲正；预览过期409且不消费请求；已确认请求合法重试返回原确认记录；唯一请求和唯一冲正数据库兜底。
- [x] 实现退出/移除/归档/恢复，检查零余额与待确认；退出成员旧账仅允许备注修改，重加复用身份并解冻。
- [x] finance/routes.ts注册独立资源端点，复用M1认证/CSRF，严格条件头和幂等；server.ts启用财务仓储。

## 任务3：页面与集成测试（主agent）
- [x] api.ts增加带自定义头、响应ETag的调用，保留现有M1兼容；每次意图维护一个幂等键，网络失败复用，输入改变生成新键。
- [x] 账本详情提供明细、结算、统计、成员入口；新增/编辑表单金额优先、默认本人付款、全体有效成员均分；精确预览和指定金额差额。
- [x] 结算分别显示建议、待确认和已确认；收款人必须明确打开最新预览后确认；冲正文案说明不是退款；冲突保留输入。
- [x] tests/mysql/m2.test.ts以虚构独立会话覆盖T-03至T-14，含100次并发确认、取消竞争、幂等冲突、外键约束和回滚，不清库。

## 任务4：迁移、验证与审查
- [x] 生成完整002_m2.sql后向用户申请独立迁移和虚构验收许可；旧001许可不扩大为002许可。
- [x] 执行许可到达后迁移、真实MySQL测试；未获许可只完成不依赖数据库的工作，不谎称验收。
- [x] 规范审查后代码质量审查，修正所有P1/P2问题再复查。
- [x] npm test、npm run test:db、npm run build；浏览器验证正常/空/错误及360/390/768/1440布局，保存无敏感值证据。
- [x] 更新task_plan、findings、progress及m2-verification，明确未验收的Nginx/WS等后续边界。

## 本轮验收结果
2026-11-17：002迁移已获独立许可并执行；普通25项、真实DB34项通过，类型检查与构建通过。双账号收款/冲正、空错状态及四尺寸布局已验收，截图已保存并实看。完整证据及M3/M4边界见m2-verification.md。
