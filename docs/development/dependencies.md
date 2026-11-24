# 首次依赖安装清单

来源均为 npm 官方 registry 上的对应项目包。此文件给出版本范围，实际解析版本及安全公告尚未联网核验；安装获批后提交 package-lock.json，审查实际依赖树并运行 npm audit。不能仅凭项目知名度断言安全。

| 包 | 用途 | 维护与风险说明 |
|---|---|---|
| vue 3、vue-router 4 | 正式前端和后续页面路由 | Vue 生态维护；当前只使用 Vue，路由留待账户/账本增量接入 |
| express 5、mysql2 3 | HTTP 服务和后续参数化 MySQL 查询 | 对应 Express/mysql2 项目；mysql2 未连接数据库 |
| typescript 5.9、vue-tsc 3、@types/node 24、@types/express 5 | 严格类型检查 | 编译及声明依赖，不参与资金操作 |
| vite 7、@vitejs/plugin-vue 6 | 本地开发和前端构建 | 传递依赖可能包含 esbuild 原生可执行文件与安装脚本 |

实施前项目没有 node_modules；不使用临时 CDN 或改写成其他框架。暂不安装 Element Plus、ECharts、Pinia、ws、Session 和测试框架，进入对应模块再补充清单，避免无用途依赖。

建议批准的首条命令：`npm install --ignore-scripts --no-audit`。禁用生命周期脚本降低安装时执行代码风险；构建仍会执行工具自身代码。若禁用脚本导致构建失败，先检查具体依赖，不自动重新启用脚本。随后执行 `npm audit` 审查，出现问题先评估，不自动运行 `npm audit fix --force`。

安装会联网下载包、写 node_modules 和锁文件；不会安装全局工具，不执行数据库迁移，不部署。必须先得到用户明确确认。

## 本次授权与执行

2026-11-17，用户明确回复“允许本次安装和安全审计”。已使用上述禁用脚本命令，从 registry.npmjs.org 安装140个包并生成锁文件；`npm audit` 返回0个已知漏洞。检查锁文件发现 esbuild、fsevents 声明安装脚本，本次未执行生命周期脚本，实际构建已通过。此扫描不能证明不存在未公开漏洞。

主要实际版本：Vue 3.5.45、Vue Router 4.6.5、Express 5.3.0、mysql2 3.24.6、Vite 7.3.8、TypeScript 5.9.3、vue-tsc 3.3.14。具体完整解析结果以根目录 package-lock.json 为准。后续新增或变更依赖仍遵循用户确认要求。
