# M3 产品完成实施计划

> 按writing-plans拆分、executing-plans执行；已批准的设计v1.0第9.7及15.4节为基线。本项目无Git仓库，不自动初始化、提交或创建worktree。常规实现顺序执行，完成后按证据复核。

**目标：** 完成期间统计、SQL筛选分页、同源WebSocket账本失效通知及前端断线补查，保留输入与确认前核对。

**架构：** 数据库仍为唯一权威。统计在现有一致性读及成员授权后，用CTE和DENSE_RANK计算当前有效支出承担排行。单进程WebSocket在事务提交后发送最小变更元数据，订阅及出站验证会话与成员；页面经HTTP重取，不从通知累加金额。

**技术：** 已有Vue3/Express5/MySQL8/Node24；ws与类型包须先获独立安装审计许可。使用已有表，不改已执行迁移；不部署。

## 任务1：期间统计与查询（先红后绿）

- [x] tests/mysql/m3-reports.test.ts创建虚构账本，当前支出、旧版本、作废、转账、不均分及历史成员覆盖期间汇总、并列与零消费；先红后绿。
- [x] finance/report-query.ts解析from/to（结束日包含当天，SQL使用安全日期条件），拒绝多值、未知参数、倒置/非法日期；DTO金额始终字符串。
- [x] finance/mysql-reports.ts用当前版本JOIN、CTE汇总、LEFT JOIN全部成员、DENSE_RANK返回排行；授权及RR快照内调用，转账不进入消费。
- [x] finance/mysql-store.ts将明细筛选、排序和limit+1放入SQL，只读取本页分摊；游标绑定账本及筛选条件。
- [x] ReportPanel.vue提供日期筛选、全量恢复、期间标识和成员承担排行；余额与结算保持全量口径。

## 任务2：服务端通知（依赖获批后，先红后绿）

- [x] tests/mysql/m3-realtime.test.ts以真实会话和WS验证Origin/匿名拒绝、授权、通知隔离、备注变更、事务回滚、注销/移除/退出失效。
- [x] realtime模块挂载Node HTTP /ws；同源登录校验、拒绝URL凭据、消息白名单/限长/限频与连接/订阅上限。
- [x] 事务提交后广播最小元数据，不含金额/备注；回滚和幂等重放不发通知，出站重验会话和成员。
- [x] 30秒Ping、10秒Pong期限、关闭清理和服务关闭；崩溃恢复由HTTP补查兜底。
- [x] server.ts接入通知，Vite配置/ws代理；Nginx/WSS运行验收归M4。

## 任务3：前端同步及保留输入

- [x] tests/integration/m3-sync.test.ts验证单轮退避重连、事件去重、30秒与可见性补查、卸载及认证停止。
- [x] realtime-client.ts管理单连接、抖动指数退避、HTTP权威补查、页面可见期间同步；事件不传递金额。
- [x] BookView.vue保持面板挂载；远端更新刷新数据且保留表单，加载第二页后只提示更新。
- [x] 断线显示状态并自动补查；认证失效清理会话并引导登录。

## 任务4：验证与收尾

- [x] `npm test` 32/32、`npm run test:db` 50/50、`npm run build`及typecheck通过。
- [x] 双标签验证新增/备注更新、API重启后补查、草稿保持、SQL翻页和更新提示；期间日期/空/倒置结果通过。
- [x] 360/390/768/1440四个入口无横向溢出；记录EXPLAIN证据并更新README、计划和验收文档。规模性能、Nginx/HTTPS、备份恢复归M4。
