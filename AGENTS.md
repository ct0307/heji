# 项目开发说明

始终使用简体中文。正式开发位于 apps/ 和 packages/，保留 work/ 中的设计原型。设计文档 v1.0 为功能基线，综合 UI 推荐为界面基线。所有原 P1 均保留。

## 技术和命令
- Node.js 24.14+，npm workspaces，Vue 3/TypeScript/Vite，Express 5，MySQL 8。
- `npm run test:domain`：领域测试，无外部依赖；`npm test`：领域与 HTTP 测试，后者需要 Express。
- `npm run dev:api` / `npm run dev:web`：安装获批后分别启动。
- `npm run typecheck` / `npm run build`：安装获批后检查与构建。
- `npm run db:plan` 只检查迁移文件；`npm run db:migrate` 须取得明确许可并临时设置HEJI_ALLOW_MIGRATION=yes。
- `npm run test:db` 使用真实heji_dev数据库，保留本轮虚构数据，不清库；默认npm test不依赖数据库。
- 环境变量见.env.example：APP_ORIGIN、PORT、DB_HOST、DB_PORT、DB_NAME、DB_USER、DB_PASSWORD、HEJI_ALLOW_MIGRATION。仅由应用入口加载本地配置，不读取打印敏感值；修改后重启API。
- apps/web为Vue页面，apps/api为后端，database为迁移，deploy/nginx为尚未启用的配置。当前本地端口5174/3001，禁止停止5173/3000上的无关服务。

## 领域约束
金额使用 BigInt 整数分；HTTP传十进制字符串。均分按固定成员ID排序；建议不是付款；只有已确认转账影响余额。领域代码不得依赖框架或数据库。正式授权必须在服务端完成。

## 开始和完成
先判断任务、核对技能与要求；写入前说明范围。财务规则先写测试再实现。完成前运行相应测试和类型检查；前端尽量浏览器验证正常/空/错/手机，无法验证明确说明。

## 必须确认的操作
安装、升级或降级依赖，删除/移动/批量覆盖，Git重置或强推，清理工作区，数据库迁移，CI/CD变更，部署，系统或全局配置，密钥处理必须先得到明确确认。依赖安装前列出用途、来源和脚本风险，建议安全审计。不要读取或打印 .env、密码、token、Cookie。不要运行自动强制依赖修复。安装和迁移的许可不能互相替代。
