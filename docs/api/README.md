# 接口与实时协议

机器可读文档见 [openapi.json](openapi.json)，OpenAPI 3.1，覆盖当前41个HTTP操作及503处内部引用。来源为 `apps/api/src/app.ts`、`modules/m1/routes.ts`、`modules/finance/routes.ts`、验证模块及共享DTO。`node docs/api/generate.mjs` 可重新生成并核对实际路由集合与内部引用；未安装外部OpenAPI规范验证器，也未上传到在线编辑器。

## HTTP约定

本机同源基址 `http://127.0.0.1:5174/api/v1`，Vite代理至回环API3001；生产基址使用实际HTTPS来源。先GET `/auth/csrf`，浏览器保存HttpOnly Cookie，正文CSRF值只保存在页面内存。POST/PATCH带精确Origin和X-CSRF-Token；注册/登录后Cookie轮换，使用返回的新CSRF。开发Cookie为heji_sid，生产为__Host-heji_sid。禁止将Cookie、密码或邀请明文放URL/截图/日志；示例只展示字段名，不记录实际会话。

成功统一 `{ "data": ... }`；注销和撤销邀请返回204、无正文。失败统一 `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`。X-Request-Id与错误正文一致；代理生成的ID可能不同，不声称全链路统一。会话相关响应禁止缓存。

财务写入带Idempotency-Key（8–128位字母/数字/下划线/横线），同一次提交的重试复用原键、原参数及条件头；参数变化409 IDEMPOTENCY_KEY_REUSED。重放仍重新验证当前成员/对象权限；新业务意图产生新键。

支出PATCH使用application/merge-patch+json；作废POST使用application/json，两者都要具体强If-Match。缺失428、过期412 ETAG_MISMATCH、通配符400；不得从ETag推导版本。金额为整数分十进制字符串，单笔1–100000000分，份额可为0；累计合计不受单笔上限限制。版本同样为字符串。

## 转账闭环

1. 发起者POST `/books/{bookId}/transfer-requests` 登记待确认；此时余额不变。
2. 对方GET `.../transfer-requests/{id}/preview`，展示before/after、warnings及两个expected版本。
3. 对方明确核对后POST `.../{id}/confirm`，提交expectedFinancialVersion、expectedRequestRevision及幂等键；只有成功确认产生转账事实。
4. PREVIEW_STALE为409，必须重读预览并让用户重新确认；不得静默改版本重试。
5. 误登记由原双方发起独立反向冲正、另一方确认；保留原记录，不代表实际退款。普通付款及冲正均不计消费报表。

## 短时结算窗口（仅heji_dev已激活004）

2026-11-19：heji_dev已迁移并通过真实多连接5/5（含父测试）；本轮独立3账号/3账本浏览器8组最终检查通过，覆盖和限制见[UI记录](../development/m4-settlement-window-ui-plan.md)。bench未迁移004，新负载和004恢复未验收。实际证据见[窗口验收记录](../development/m4-settlement-window-verification.md)，不重复迁移或已完成测试。

GET `/books/{bookId}/settlement-window` 查询状态；指定确认者显式POST `.../transfer-requests/{id}/settlement-window` 申请，返回30秒窗口与同事务新预览。持有人或创建者POST `.../settlement-windows/{id}/close` 关闭。写入需要CSRF和幂等键；申请重放不续期，旧关闭ID不影响后续窗口。

活跃窗口期间财务写入及接受邀请暂停，返回409 `SETTLEMENT_WINDOW_ACTIVE`；绑定确认必须额外携带 `expectedWindowId`，原两个版本仍必需。过期为409 `SETTLEMENT_WINDOW_EXPIRED`，不回退普通确认；冷却为409 `SETTLEMENT_WINDOW_COOLDOWN`，提示剩余秒数，普通写入开放。004缺失时窗口入口503 `SETTLEMENT_WINDOW_UNAVAILABLE`，旧财务路径兼容；已激活而查询故障时写入503。生命周期不新增WS消息类型，依赖HTTP补查。实施与实际验收边界见[窗口验收记录](../development/m4-settlement-window-verification.md)。

## WebSocket（不属于OpenAPI HTTP端点）

连接同源 `/ws`，本机ws，正式部署wss；浏览器自动携带Cookie。握手精确校验Origin，拒绝任何URL查询参数；未登录401、错误Origin403、错误路径404、超容量503、同会话超过8连接429。握手失败无JSON正文。订阅前及出站发送前重查会话和账本权限；WS鉴权不续期。

| 方向 | JSON消息 | 含义 |
|---|---|---|
| 客户端→服务端 | `{"type":"SUBSCRIBE","bookId":"账本UUID"}` | 订阅，单连接最多10个账本 |
| 客户端→服务端 | `{"type":"UNSUBSCRIBE","bookId":"账本UUID"}` | 退订 |
| 服务端→客户端 | `SUBSCRIBED` / `UNSUBSCRIBED`，带bookId | 订阅状态 |
| 服务端→客户端 | `BOOK_CHANGED`，带eventId/bookId/entityType/entityId/financialVersion/可选revision | 提交后的最小失效提示，重新HTTP读取 |
| 服务端→客户端 | `SUBSCRIPTION_REVOKED`，带bookId | 退出/移除后停止订阅 |
| 服务端→客户端 | `ERROR`，带code及可选bookId | INVALID_MESSAGE / BOOK_FORBIDDEN / SUBSCRIPTION_LIMIT |

消息最大4KiB，不接受二进制；每10秒最多30条入站消息/最多30条排队，超限1008关闭。每30秒Ping、10秒无Pong终止；用户会话失效4401，临时故障/慢接收端1013。失效通知不带金额、备注、邀请或会话，不作为余额真值；同financialVersion的备注更新也可能产生新eventId。

断线退避重连、重连后HTTP补查；页面可见时每30秒以及恢复可见时补查。eventId去重；保留未提交草稿和翻页阅读位置，翻页后提示有新明细而不强制替换。服务端为单进程尽力通知，没有持久消息重放/跨实例消息总线；Nginx回环HTTPS/WSS已有32/32运行证据，见[本机验收](../development/m4-local-https-plan.md)，不代表公网或生产验收。

## 常见错误与处理

| 状态/代码 | 页面处理 |
|---|---|
| 401 AUTH_REQUIRED / SESSION_EXPIRED | 清理页面会话并登录 |
| 403 CSRF_INVALID | 重读会话状态与CSRF，保留草稿，用户明确重试 |
| 404 BOOK_NOT_FOUND | 停止账本订阅，返回账本列表 |
| 409 PREVIEW_STALE | 重读并重新展示转账预览 |
| 412 ETAG_MISMATCH | 读取最新支出，提示比较后再提交 |
| 422 SPLIT_SUM_MISMATCH | 提示指定份额合计/成员错误 |
| 429 RATE_LIMITED | 按Retry-After及界面提示稍后重试 |
| 503 TRANSACTION_RETRY_REQUIRED | 等待后用同一幂等意图重试；仍要尊重新的业务冲突 |

全部状态与字段以运行实现为准。M1/M2/M3真实HTTP/数据库测试覆盖主要成功、授权、版本冲突和回滚；文档生成核对不替代运行测试或外部规范认证。
