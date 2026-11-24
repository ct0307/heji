# M4运行与恢复手册

2026-11-19计时恢复已完成：用户批准固定v2向heji_m4_restore_004_timed一次恢复及提交后独立核对，结果20表/6609958行完整性通过，8分23.96秒，30分钟目标通过。见[真实计时验收](m4-restore-timed-real-verification.md)。新旧库、备份和证据均保留，许可已落实，禁止按下文命令重复执行。

历史增量：bench 004、新v2备份及heji_m4_restore_004完整性通过但41分20.52秒超时；该结果保留。v1仍拒绝两个004目标；本轮没有重跑迁移、备份、旧恢复或负载，没有清理。历史结果见[原004验收](m4-backup-restore-004-real-verification.md)。

窗口代码、heji_dev的004与真实多连接5/5（含父测试）完成；独立3账号/3账本浏览器8组最终检查通过，虚构数据保留，不重复执行。[窗口记录](m4-settlement-window-verification.md)及[浏览器结果/限制](m4-settlement-window-ui-plan.md)保留。真实桌面前后台切换/重新加入未另做UI实测；新负载、热点P1、现场串演和公网/生产仍开放，恢复耗时本次已通过。

2026-11-19最新状态：heji_dev/heji_m4_bench的003、固定12组正式测量、本机HTTPS/WSS 32/32、PREVIEW_STALE HTTP/HTTPS双账号浏览器流程、Edge HTTPS UI及003后独立恢复均已完成。4/8/30名成员参与范围研究9轮也已完成，热点确认仍分别为0/3501、1/3058、0/2700。新恢复库`heji_m4_restore_003`导入4,802,850行并通过完整对账，见`m4-summary-restore-003-design.md`。旧`heji_m4_restore`不得覆盖，也不要对已恢复的新目标重跑。下文阶段性“未执行”内容是历史记录，不据此重复已完成迁移、种子、正式基准、参与范围研究及恢复。

已授权的本机M4隔离实验及恢复均已完成。正式12组结果为非连续运行，同账本确认0/3364成功；参与范围研究按4/8/30人各3轮，确认分别0/3501、1/3058、0/2700，仍需保留热点确认P1。旧结构恢复16表/1,858,851行和003后结构恢复19表/4,802,850行均通过，后者耗时807.15秒。Nginx本机回环HTTPS/WSS 32/32、Edge HTTPS页面UI与PREVIEW_STALE双账号回归均通过；自签证书临时信任已按指纹回滚。公网/生产部署未验收。已完成的隔离库许可不应重复使用或与其他新操作混同。

## 1. 本机隔离实验

当前交付清单和现场演示步骤见[m4-delivery-checklist.md](m4-delivery-checklist.md)。以下命令解释已有工具，已完成实验禁止据此重跑。

现有MySQL连接只由Node入口加载，不读取或显示.env内容。操作仅接受本机数据库地址和固定heji_m4_bench/heji_m4_restore/heji_m4_restore_003；不会连接开发库业务表。`heji_m4_restore`保留001/002旧结构，`heji_m4_restore_003`仅用于本次003后恢复。夹具含10账本、每本30成员，目标1万当前支出/2000历史版本，另外9本各1000/200；每笔30份额。所有实验账号和开销为虚构。为避免与演示开发库混用，凭据相同但数据库名由脚本严格覆盖为隔离名称。

只读计划：`npm run m4:plan`。离线保护测试：`npm run test:m4`。以下命令只有在明确获准隔离建库、造数、写入及备份恢复后执行：

```powershell
$env:HEJI_ALLOW_M4='yes'
npm run m4:seed -- --apply
npm run m4:benchmark -- --apply --smoke
npm run m4:sql -- --apply
npm run m4:backup -- --apply
```

从备份命令给出的**虚构备份文件名**选择目标，例如heji-m4-加UUID的.jsonl.gz；只传文件名，不传路径。不要将真实密钥或备份内容发到聊天。

```powershell
npm run m4:restore -- --apply heji-m4-实际UUID.jsonl.gz
# 003后结构显式选择空目标；不得指向已经存在的旧heji_m4_restore
npm run m4:restore -- --apply --target=heji_m4_restore_003 heji-m4-实际UUID.jsonl.gz
```

恢复前校验压缩文件SHA-256、格式、源库、固定种子/版本、表列、逐表行数及内容摘要；仅创建所选的全新固定隔离目标，已有目标库就拒绝。003目标额外核对汇总余额和期间报表与原始事实一致。写入结束重新核对逐表摘要、迁移校验和、所有复合外键、当前版本、逐版本分摊合计和转账/冲正数量、每本余额守恒，记录校验与恢复总耗时。GENERATED ALWAYS列不导出，由MySQL重新计算。备份是本课程隔离实验的逻辑快照JSONL，不替代MySQL通用SQL转储；不接受备份自带SQL。`.local/m4/`被忽略，不进入交付，Windows文件权限继承当前用户目录ACL，不声称POSIX mode能设置Windows ACL。任一失败保留可能存在的部分schema，不自动DROP、清理或重试。当前备份已在`heji_m4_restore_003`成功恢复并完整验收；本节仅描述复现机制，不能据此再次执行、覆盖或清理目标库。

若建库/种子失败，保留错误与未完成隔离库，不自动DROP或清空。再次执行会拒绝覆盖；需确认问题并单独授权后再处理残留，不把失败库冒充完整种子。

## 2. 正式性能基准

```powershell
npm run m4:benchmark -- --apply
```

默认20虚拟用户、预热30秒、正式180秒，每组3轮；读取与写入、热点与分散共12组，约42分钟加请求收尾。冒烟只有2用户/1秒预热/3秒统计，不作正式达标结果。

读取配比：分页50%、余额30%、期间报表20%。写入配比：均分60%、指定金额30%、确认10%；确认工作流先登记、由对方取当前预览再确认。PREVIEW_STALE冲突单列，其他409/4xx/5xx/网络错误记故障，失败时延仍参与分位数。HTTP端点时延与完整确认工作流时延分别保存；每个HTTP记录SQL query/execute数量，不含连接池协议事务命令。测试器只运行本机临时API，不依赖或停止3001服务，不把未启用WS广播和Nginx/TLS算进结果。

每轮写入保留数据，后续轮数据量会增加，报告注明实际起止规模与原始样本，不把轮次当作全新相同状态。当前机器Ryzen9 7940HX、32逻辑CPU、约16GB内存，MySQL缓冲池128MiB，连接池8，与设计2核4GB建议不同；即使达到P95读500ms/写800ms/故障<1%，也只能作当前机器结果。正式执行前先冒烟定位问题；本轮已修复全量份额传输，但延迟仍未达标，正式基准用于量化剩余差距，不预先承诺通过。

每轮独立JSON先落盘，12组全完成后才生成完整formal文件。`node tests/m4/report.ts`只读取已有完整正式证据，分别归纳端点时延、工作流及确认成功数；缺轮次拒绝给正式结论。读取与写入长测期间不并行备份/恢复/其他数据库实验，避免负载混杂。

本次中断后只补测最后分散账本写入轮，12个原始轮次现已全部落盘，不要再次执行续跑。续跑严格核对环境、种子、冒烟、已保存轮次及已验证的1079笔支出/119请求/102确认/17待确认中断残留；残留不计入性能样本。计数或时间窗不符即停止。

若12轮均落盘但总报告生成失败，可在同一M4许可内设置`HEJI_ALLOW_M4=yes`，执行`node --env-file-if-exists=.env tests/m4/finalize.ts 2026-11-17T16-14-30-235Z --apply`。该入口仅以只读事务核对12轮参数/样本摘要、输入文件SHA-256、中断实体审计及当前库起止行数，不写会话或业务数据；只新建总报告文件，已有文件拒绝覆盖。本次已执行成功，不需重复。报告明确非连续运行；未持久化的精确续跑启动时刻不推造。

索引实验使用连接内临时表，不改原审计表。相同10000行、相同条件、排序、20条结果，比较仅主键与(bookId,createdAt,id)的EXPLAIN/EXPLAIN ANALYZE，分别5轮；先确认两组结果一致，再解释实际计划与耗时。

## 3. Nginx运行检查

配置文件：heji-dev.conf、heji-prod.conf及proxy-headers.conf。开发HTTP示例8088，正式HTTPS域名ledger.example是占位符，部署前换为实际域名/静态目录/证书路径。include路径按Nginx prefix解析，必须换为实际项目绝对路径或将项目路径作为prefix。两个主配置只能选一个纳入http上下文，避免重复map/zone/log_format。

```powershell
powershell -NoProfile -File deploy/nginx/check-local.ps1
powershell -NoProfile -File deploy/nginx/check-local.ps1 -RunSyntaxCheck
```

工具检测/语法检查不会启动或重载Nginx。本机便携Nginx1.31.8已按历史许可运行过真实nginx -t及HTTPS/WSS验收，具体路径和结果见m4-local-https-plan.md；本轮不再次安装、生成私钥或部署。正式配置使用支持http2 on的Nginx版本；示例不代表公网部署已启用。

经部署许可后：构建静态文件，API APP_ORIGIN设为实际https来源、NODE_ENV=production、PORT=3001；API只监听回环并只信任回环单跳。Nginx覆盖X-Forwarded-For为客户端remote_addr、X-Forwarded-Proto为scheme，禁止把用户传来的链直接转发。禁止直接开放API端口。

验收顺序：深路由刷新200页面；未知/api JSON404；登录限流JSON429；HTTPS登录设置__Host-前缀、Secure/HttpOnly/SameSite=Lax Cookie；刷新保持身份；WSS101、订阅隔离、注销/移除撤销；API断线后重连补查。日志记录requestId/路径/状态/请求与上游耗时，不记录Cookie、Referer、查询串或邀请fragment。Nginx requestId和API X-Request-Id目前不同，关联以响应头及时间完成，不声称端到端统一ID。

## 4. 发布与回退

发布前保存测试/构建、锁文件、应用版本及数据库备份，检查迁移校验。迁移账号与运行账号分离，运行账号不授DROP/CREATE；具体账号创建属于需确认的全局权限操作。确认后部署，ready检查成功，再由两账号完成最小闭环。失败先切回上一个应用版本；数据库结构不得自动倒退，按兼容迁移及独立恢复方案处理。

## 5. 正式备份建议

每日一份、最近7份，备份与应用目录分离并限制ACL。生产使用已安装MySQL官方mysqldump的--single-transaction、--quick、--hex-blob、--no-tablespaces、--set-gtid-purged=OFF等审查参数；凭据通过本机受限login-path提供，禁止在命令行或报告出现密码。建login-path和备份真实库均需先确认。先备份至全新文件，核对退出码、压缩文件校验和、恢复成功后才计为成功备份；没有成功记录就不能承诺RPO。

旧备份轮换属于删除动作，当前不实现自动清理或Windows计划任务。附件未启用，无附件恢复声明。每次恢复都在独立新库进行，确认用户/账本/当前支出/历史版本/确认与冲正数量及全部余额守恒；最近一次成功备份为恢复点，实际演练时间与30分钟目标分开记录。
