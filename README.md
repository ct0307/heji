# 合记

## 当前交付范围（2026-11-24）

源码仓库：[ct0307/heji](https://github.com/ct0307/heji)（私有），默认分支为`master`。

本次交付目标为GitHub源码仓库。用户明确不需要答辩、暂时不需要部署，因此现场串演、录屏及公网/生产部署不作为本次源码提交的验收门槛；下文相关待办属于历史阶段记录，不代表本次仍需执行。

基础账户与账本、财务闭环、统计与实时同步及A/B界面已有本机验收记录。2026-11-20短时结算窗口负载的5/15/25秒等待档各60/60确认成功，独立财务核验通过；20表/6,609,958行恢复耗时8分23.96秒，完整性与30分钟目标通过。旧连续并发压力结果继续保留，结论不外推生产。最新事实以[交接入口](docs/development/next-session.md)和[M4当前验收状态](docs/development/m4-verification.md)为准。

2026-11-24提交前复验：`npm test`为172/172通过，0失败/取消/跳过；`npm run build`包含前后端类型检查及Vite构建，退出0。本轮没有重跑真实数据库、浏览器或压力测试；工程没有lint配置。

仓库包含正式源码、测试、迁移脚本、配置模板、设计原型、设计文档及摘要验收证据。大体积原始负载JSON/JSONL仅保留本地，路径、大小和SHA-256见[原始证据索引](docs/development/evidence/local-evidence-manifest.json)；历史文档中指向这些原始文件的链接仅在保留原样本的本机可用，重建原始样本报告需另行取得对应文件。`.env`、`.local/`、密钥、数据库备份、依赖目录、构建产物、工具状态和Office锁文件不提交。

## 历史实施与验收记录

2026-11-19恢复目标已通过：既有v2向heji_m4_restore_004_timed单次恢复已获准完成，20表/6,609,958行全部完整性及提交后独立核对通过；503957.8391ms（8分23.96秒），低于30分钟目标。全部财务核验保留，原41分20.52秒慢结果和新旧库均保留，不重跑。见[真实计时验收](docs/development/m4-restore-timed-real-verification.md)。热点P1、新人工等待负载、现场串演与公网/生产仍待验收。

2026-11-19余额核验优化：四类事实按账本/成员预聚合，保留全部财务检查。既有004恢复库只读实测余额守恒10.45秒，300成员与003汇总逐项一致；新计划无相关子查询。原离线测试153/153、build通过。见[优化验收与证据](docs/development/m4-balance-query-optimization.md)。这是独立只读查询证据，不能代替新恢复8分23.96秒的完整恢复实测。

历史004恢复：bench 004、新v2备份及heji_m4_restore_004完整性通过，41分20.52秒超过30分钟；该历史结论保留。后续新目标8分23.96秒结果见首段。普通163/163及build是计时目标代码准备阶段的记录，本次未修改源程序或重复这些检查。见[历史验收](docs/development/m4-backup-restore-004-real-verification.md)和[新目标离线验收](docs/development/m4-restore-timed-target-verification.md)。

2026-11-19界面视觉精修：A「雾青工作台」仍为默认，B「墨蓝账页」可在「界面设置」选择。统一账页品牌、配色和字号；明细筛选默认收起，保留唯一「记一笔」入口；手机金额整行显示。最新npm test134/134、build通过，隔离模拟Vue浏览器39项/36布局/38截图通过。查看[设计与验收](docs/development/ui-refinement-verification.md)及[A/B效果图](docs/development/evidence/ui-refinement-2026-11-19/appearance-refined-comparison.png)。

2026-11-19界面更新：正式前端支持A「雾青工作台」与B「墨蓝账页」，默认A。公共页和登录后的导航均可打开「界面设置」，选择保存在当前浏览器。B采用墨蓝灰、无衬线字体及账页/收据布局；切换保留草稿和核对状态。最新普通测试134/134、build通过，模拟接口的真实Vue浏览器22项通过；没有新增数据库写入或迁移。详见[双界面验收](docs/development/ui-appearance-verification.md)。

2026-11-19窗口增量：短时结算窗口已实现，窗口30秒、冷却30秒，保持全账本版本门禁；该阶段普通测试130/130、类型及构建通过。heji_dev完成004迁移及真实多连接5/5（含父测试），又按许可完成3账号/3账本浏览器8组最终检查，虚构数据保留、活跃窗口0。覆盖正常/空/错/手机、到期、原键重试与丢失响应，具体限制见[浏览器记录](docs/development/m4-settlement-window-ui-plan.md)。后续bench 004与v2恢复结果见首节；v1仍拒绝004，新v2支持固定独立目标。新负载与热点P1仍开放，不重复迁移或已完成测试。

2026-11-19最新进度：heji_dev与heji_m4_bench的003迁移、回填对账及新模式回归均已完成。正式20用户12组HTTP测量的读写延迟目标和系统故障率目标通过；同账本转账确认0/3364成功（全部因`PREVIEW_STALE`），分散账本4259/4259成功。参与范围研究4/8/30名成员确认分别为0/3501、1/3058、0/2700，热点确认可用性仍未达要求。本机Nginx HTTPS/WSS验收32/32及Edge HTTPS浏览器UI通过；临时证书信任已按指纹回滚。公网/生产未验收，M4及完整项目仍未完成。详见[M4验收记录](docs/development/m4-verification.md)、[增量汇总验收](docs/development/m4-summary-verification.md)和[本机HTTPS/WSS验收](docs/development/m4-local-https-plan.md)。普通`db:migrate`仍只001/002，不重复执行003。

基于 Vue 3、TypeScript、Express 和 MySQL 的多人共享账本。正式设计依据为根目录 Word 文档，界面依据为 `work/ui-design/final-proposal/`。

## 当前实现

已实现 M1 的注册登录、Argon2id、Session/CSRF、账本及成员权限、一次性邀请，以及 M2 的支出录入/版本历史/作废、均分与指定金额、余额和结清建议、双方确认转账、错误登记冲正、成员退出/移除及归档恢复。已执行本机 `heji_dev` 的001、002迁移及真实数据库验收。M3已增加期间统计、CTE/窗口排行、SQL明细分页及同源WebSocket通知和断线HTTP补查，未新增迁移。

账本提供明细、结算、统计、成员四个入口，延续综合UI稿，支持手机布局。统计区分垫付与承担，消费合计排除转账和冲正。待确认登记不改变余额；撤销误登记由另一方确认并保留原记录，不代表实际退款。

M4已有两轮正式12组HTTP证据：旧基准与新基准均保留。新一轮在本机16GB/32逻辑CPU、MySQL缓冲池128MiB、连接池8的条件下，12组读/写工作流P95分别低于500/800ms，系统故障率为0；这不外推到2核4GB。热点同账本确认0/3364成功，分散账本4259/4259成功。后续4/8/30名成员参与范围研究确认分别为0/3501、1/3058、0/2700成功，`PREVIEW_STALE`保护有效但热点确认体验不合格。003后结构独立恢复4,802,850行耗时807.15秒，逐表摘要、外键、三项迁移校验和、历史分摊、余额守恒及汇总快照/期间报表对账通过；旧结构恢复证据仍保留。Nginx本机回环HTTPS/WSS验收32/32及Edge HTTPS浏览器UI通过；临时证书信任已按指纹回滚。公网和生产环境未验收。M4及完整期末项目仍未达到交付条件。领域算法和独立分摊验证页继续保留。

`npm run m4:plan` 只读显示操作计划，`npm run test:m4` 验证范围/格式/配置保护；本机Nginx、七天自签证书及回环验收已按单独授权完成，不代表公网部署。最新结果见[M4验收记录](docs/development/m4-verification.md)与[M4本机验收Word报告](docs/development/合记_M4隔离实验验收报告_更新_2026-11-19-版式复核.docx)；运行边界见[M4运行手册](docs/development/m4-runbook.md)和[M4实施计划](docs/development/m4-plan.md)。报告不代表M4生产或完整项目已验收。

## 运行

最终交付文件、复验结果、10分钟双账号演示与仍开放的P1见[M4交付清单](docs/development/m4-delivery-checklist.md)。清单齐全不代表热点确认、现场串演或生产部署已经验收。

Node.js 要求 24.14 及以上的24.x版本。纯领域测试 `npm run test:domain` 使用 Node 内置测试器，不需要安装依赖；完整 `npm test` 还会加载 Express 执行真实 HTTP 测试，需要先安装依赖。

首次安装必须按 `docs/development/dependencies.md` 得到确认，再运行 `npm install --ignore-scripts --no-audit` 及 `npm audit`。

依赖已获批准并安装。先在本机 `.env` 配置连接，再在两个终端分别运行：

```powershell
npm run dev:api
npm run dev:web
```

前端地址 `http://127.0.0.1:5174`，API 存活检查 `/api/v1/health/live` 通过 Vite 代理到3001端口。API当前只监听回环地址。存活不代表数据库就绪。采用这两个端口是因为本机5173和3000已有其他服务；若端口占用，启动会明确报错，不会自动停止其他服务。

```powershell
npm test
npm run test:db
npm run typecheck
npm run build
```

`build` 先检查前后端类型，再构建前端；API由 Node 24 原生运行可擦除的 TypeScript，不生成服务端编译产物。当前没有 lint 配置，不声称 lint 已执行。

## 目录

`apps/web` 为Vue前端（`src/components`含四个账本面板）；`apps/api/src/modules` 为身份、M1和finance财务后端；`packages/domain` 纯账务算法；`packages/contracts` HTTP DTO；`database` 迁移及脚本；`deploy/nginx` 未启用的配置示例；`docs/development` 实施和验证记录；`work` 保留设计过程。

## 配置与安全

配置模板为 `.env.example`，本地 `.env` 已被忽略。API、迁移和真实数据库测试由 Node 加载该文件，不在日志显示连接参数。不要把真实配置、密码、Cookie 或邀请明文写进源码、聊天、截图或测试报告。

| 参数 | 用途 |
|---|---|
| APP_ORIGIN | 浏览器页面的精确来源，默认 `http://127.0.0.1:5174`，写请求必须匹配 |
| PORT | API 端口，默认3001；修改时同步 Vite 代理 |
| DB_HOST / DB_PORT | 本机 MySQL 地址和端口，模板为127.0.0.1:3306 |
| DB_NAME | 本轮迁移与数据库测试仅允许 `heji_dev` |
| DB_USER / DB_PASSWORD | 用户只在本机填写，不提交或打印 |
| HEJI_ALLOW_MIGRATION | 默认no，取得迁移许可后在当前进程临时设置yes |

迁移命令先检查计划，执行前须有明确许可：

```powershell
npm run db:plan
$env:HEJI_ALLOW_MIGRATION='yes'
npm run db:migrate
```

迁移只在 `heji_dev` 建库建表并记录校验和，不清库。MySQL DDL 会隐式提交，迁移并非完整事务。`npm test` 无需数据库；`npm run test:db` 需要已经迁移的真实数据库，会保留本次虚构验收数据，不自动删除。修改 `.env` 后需重启 API。

本次Argon2id、M3 WebSocket依赖均已分别获批，禁用安装脚本，`npm audit`报告0项已知漏洞。最新M3验收：普通测试32项、真实数据库50项通过，类型检查与生产构建通过；四入口在360/390/768/1440宽度无横向溢出。实际步骤、截图和边界见 [M3验收记录](docs/development/m3-verification.md)，M2与M1记录见各自验收文件。当前没有部署或初始化 Git 仓库。
