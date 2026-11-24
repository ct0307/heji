# M3 依赖说明

设计v1.0第9.7节要求同源WebSocket账本通知，Node 24内置WebSocket仅提供客户端，现有依赖没有服务器实现。避免手写协议与心跳帧，新增成熟服务器实现ws及TypeScript声明。

| 依赖 | 用途 | 来源/维护 |
|---|---|---|
| ws@8.23.0 | 服务端WebSocket握手、帧校验、限长、Ping/Pong | npm官方registry；websockets/ws；元数据最近更新2026-11-12 |
| @types/ws@8.18.2 | 编译期类型声明 | npm官方registry；DefinitelyTyped；元数据最近更新2026-10-04 |

官方元数据未声明install/postinstall。ws有可选原生加速peer，本轮不主动安装；协议实现采用纯JS路径即可。安装统一禁用脚本，随后运行npm audit，检查锁文件来源和实际依赖树，不使用自动强制修复。没有已有可直接替代的服务端实现。查询元数据不代表安全审计已通过，需安装后确认。

已按用户许可从npm官方registry安装ws@8.23.0与@types/ws@8.18.2，执行时禁用安装脚本；未主动安装可选原生加速peer。随后npm audit报告0项已知漏洞（0 low/moderate/high/critical）。许可未包含迁移或部署，M3也未新增迁移。
