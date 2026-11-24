# M1 新增依赖

`@node-rs/argon2@2.2.2`：为设计要求的 Argon2id 密码哈希提供 Rust/Node-API 实现；来源为 npm 官方 registry 的 napi-rs/node-rs 项目包。已只读查询包元数据，支持 Node 10+；声明开发/发布脚本，没有声明 install/postinstall，平台原生二进制由可选依赖提供。项目实际维护状态和已知公告以安装时审计为准，不把有维护者等同绝对安全。

当前已安装依赖没有 Argon2id 密码库。保持设计选择，不自行改为其他密码算法；只增加这一个包，继续禁用安装脚本，并检查锁文件和 npm audit。原生二进制运行时会执行，建议安全审计。

申请命令：`npm install --ignore-scripts --no-audit --registry=https://registry.npmjs.org`，随后 `npm audit`。首次依赖许可仅覆盖上一轮包清单，本次新增包需要单独确认。不包含数据库迁移、数据库凭据读取或部署。

执行结果：用户明确批准本次安装和审计后，已按上述命令安装@node-rs/argon2@2.2.2及平台可选包。禁用安装脚本，npm audit结果为0项已知漏洞；Argon2id真实哈希/校验测试通过。后续数据库迁移取得了独立许可，不将安装许可作为迁移许可。
