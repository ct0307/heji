# 本机Nginx、HTTPS与WSS运行验收方案

日期：2026-11-18。用户已明确回复“允许按方案执行”，本方案范围已授权并完成，不重复索要许可。便携版Nginx、7天自签测试证书及回环HTTPS/WSS验收已运行；Node验收客户端32/32通过。浏览器UI未实测：自签证书不受浏览器信任，本轮未绕过警告或改系统信任库。证据：`evidence/m4-local-https-2026-11-18T05-56-01-296Z.json`、`evidence/m4-nginx-download-2026-11-18T05-17-33-497Z.json`、`evidence/m4-nginx-preflight-2026-11-18T05-21-23-238Z.json`。

验收覆盖TLS1.2/1.3及SAN校验、HTTP308、SPA与静态资源MIME/缓存、JSON错误及requestId、Secure Cookie及会话轮换、双账号账本与余额/报表、待确认不影响余额、WSS授权/跨账本隔离/断线补查/成员移除与注销撤销、请求限额和登录限流。证书为自签名，仅有效至2026-11-25 05:14:51Z。WSS跨账本隔离的无通知断言使用固定400ms观察窗口；该证据只证明有限观察窗口。此验收不代表生产部署、受信CA、公网性能或浏览器兼容性。

## 目标与选择

使用官方Windows Nginx便携版，加现有Git附带OpenSSL，在本项目完成回环HTTPS/WSS功能验收。当前官方Windows说明推荐主线版，选定1.31.8。稳定版1.30.6也是可选项；本轮按官方Windows建议使用主线。Docker/WSL需要额外安装或系统设置，本轮不选。Windows Nginx被官方列为beta且实际仅一worker工作，本轮结果只证明本机功能，不宣称Linux生产部署或性能。

官方来源：[下载页](https://nginx.org/en/download.html)、[Windows说明](https://nginx.org/en/docs/windows.html)、[选定ZIP](https://nginx.org/download/nginx-1.31.8.zip)。下载是外部原生二进制，有供应链及执行风险；ZIP没有npm postinstall，但启动nginx.exe会执行其原生代码。仅从官方HTTPS下载，记录下载URL、SHA-256、归档清单和nginx -V，不把自行计算的摘要称作官方签名认证。建议审计来源与可执行文件；本轮不新增npm依赖。

## 具体文件和权限范围

| 优先级 | 操作 | 限定范围 |
|---|---|---|
| P3 | 下载并展开官方ZIP | 仅项目.local/tools/，拒绝覆盖已有版本目录；展开前拒绝越界归档路径 |
| P3 | 生成测试私钥和自签名证书 | 使用现有C:/Program Files/Git/usr/bin/openssl.exe（已只读验证3.5.6），仅新建.local/tls/heji-local-key.pem、heji-local-cert.pem；有效期7天，SAN含IP:127.0.0.1与DNS:localhost。私钥不打印、不提交、不上传；目录权限限当前用户及系统管理账户 |
| P3 | 本机运行Nginx与API | 新建.local/nginx-runtime/包装配置、PID与日志；启动仅回环8088/8443和API3001；不安装Windows服务，不改PATH、hosts、证书信任库、防火墙或系统配置 |
| P2 | 本机虚构验收数据 | 使用已获准的heji_dev新建专用虚构账号/账本，保留验收数据，不删除/清库；不连接或改变heji_m4_restore |
| P2 | 公开证据 | docs/development/evidence/新文件，仅状态、耗时、版本、证书公开元数据、断言和计数，不包含密码、Cookie、CSRF、邀请明文或私钥 |

配置片段为deploy/nginx/heji-local-https.conf。包装脚本deploy/nginx/prepare-local-https.ps1默认仅计划；获准后传入-Prepare及-NginxDirectory，检查便携程序位于本项目.local/tools，拒绝覆盖已有配置，统一Windows正斜杠路径并加载MIME表。包装配置使用项目根目录为prefix，设置独立PID文件和默认日志路径。由于Nginx相对include按主配置目录解析，脚本将片段include、代理头include以及证书/私钥路径全部生成成带引号的绝对路径，分别新建.local/nginx-runtime/nginx.conf及heji-local.conf；不读取证书/私钥内容。两个server均显式使用隔离访问及错误日志，避免8088落入默认combined日志。API仅通过本次子进程环境覆盖NODE_ENV=production、APP_ORIGIN=https://127.0.0.1:8443和PORT=3001，不改.env、不显示其值。

8088只将请求308跳转到8443。HTTPS同源提供已构建的Vue静态文件、/api/与/ws；Secure Cookie使用__Host-heji_sid，代理覆盖转发头且API仅信任回环上一跳。包装配置显式将client_body、proxy、fastcgi、uwsgi与scgi临时目录限制到.local/nginx-runtime，避免默认临时文件落在项目根目录；以选定二进制的nginx -V/-t核验模块支持。测试证书不加系统信任，不在回环测试域设置长效HSTS。Node验收客户端通过显式ca信任本证书并验证SAN，不全局关闭TLS验证。浏览器如不信任自签名证书，会单独记录该限制。

## 顺序与验收证据

1. 等固定12组HTTP正式基准自然结束；期间不运行API数据库验收，避免污染性能负载。确认3001/8088/8443空闲；如被占用先核对归属，不停止无关进程。
2. 核验官方ZIP来源与归档清单后展开。先新建.local/tls并限制ACL，再生成测试证书，避免私钥短暂继承宽权限；已有TLS目录、私钥或版本目录就停止，不覆盖、不顺带修改整个.local权限。私钥仅由OpenSSL和Nginx读入，工具输出不回显内容。
3. 生成包装配置并执行真实nginx -t。当前中文目录实测：将中文绝对路径传入Windows Nginx的-p/-c命令行会报1113编码错误；由PowerShell设置项目工作目录、使用ASCII相对参数`-p ./ -c .local/nginx-runtime/nginx.conf -e .local/nginx-runtime/bootstrap.log -t`后退出0。配置文件内UTF-8绝对include和证书路径正常，不移动项目、不修改系统编码。通过后以隐藏进程启动API和Nginx，记录本轮PID/启动时间，停止时仅操作本轮实例。
4. 检查HTTP308保持路径、TLS1.2/1.3与SAN、SPA深链回退、JS/CSS MIME与缓存、未知静态404、API JSON、32KiB正文413 JSON、登录突发429 JSON及requestId；访问日志格式不含Cookie/正文/原始查询参数。error_log可能附请求上下文，验收请求不含秘密，日志只输出脱敏断言。Nginx与API的requestId分别生成，按时间/路径关联，不声称统一ID。
5. 双账号同源注册/登录/CSRF与一次虚构财务闭环。只在客户端内存持有会话，确认Cookie的Secure/HttpOnly/SameSite/Path及无Domain，不打印Cookie头。
6. 真实wss握手101，错误Origin403、匿名401、URL查询400；订阅授权、跨账本隔离、提交后最小通知、退出/移除撤销、注销4401与旧会话拒绝。断线后通过HTTP补查并核对数据，不能以只收到WS事件替代权威读取。
7. 新增证据并更新验收矩阵。测试结束保留配置、证书与数据，关闭本轮Nginx/API实例；不自动删除文件，不触碰5173/3000或其他服务。公开自签证书有效性可记录，私钥不读出到日志。

## 明确尚未覆盖

公网域名、受信CA证书、真实服务器发布、Linux服务管理、生产备份调度、两核4GB性能与公网WSS扇出均不在此次本机验收范围。它们仍需要目标环境与具体授权。本机验收通过后也要据此区分课程演示与生产部署。

## 已获确认的内容

允许从上述官方URL下载并展开Nginx1.31.8到项目.local/tools，使用已有OpenSSL在.local/tls新建7天本机测试私钥/证书并限制该目录权限，随后仅在回环8088/8443及API3001运行本方案、保留虚构开发库验收数据与脱敏证据。安装和私钥/部署许可只覆盖本方案，不包含系统或公网改动。

依据：根AGENTS.md明确要求安装、密钥处理、部署等必须先得到确认；此前两库003许可仅覆盖迁移和随后验证，不能代替该许可。
