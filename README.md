# 合记

多人共享账本与费用分摊系统，Web服务器课程期末项目。用来记录一起花的钱，计算每个人该承担多少，再由双方确认转账。

前端使用 Vue 3、TypeScript 和 Vite，后端使用 Express 5，数据存储在 MySQL 8。

## 功能

- 注册、登录，创建账本，通过邀请加入。账本内区分成员权限。
- 记录、修改和作废支出，保留历史版本。费用可均分，也可指定每个人承担的金额。
- 查看应收应付余额和结清建议。转账登记经另一方确认后入账；误登记可通过双方确认冲正。
- 按期间查看消费统计、成员承担排行和分页明细。
- 多人操作时接收实时通知，断线后补查更新，保留未提交的草稿。
- 支持手机布局，可在设置中切换两套界面。

金额按整数分计算，接口使用十进制字符串传递。均分产生的尾差按固定成员ID分配。待确认转账不改变余额，转账和冲正也不计入消费统计。

## 本地运行

需要 Node.js 24.14 及以上的24.x版本，以及 MySQL 8。

### 安装依赖

依赖来自npm，版本记录在package-lock.json中。安装时禁用依赖脚本，再检查审计结果：

```powershell
npm install --ignore-scripts --no-audit
npm audit
```

### 配置数据库

首次运行时复制配置模板，已有.env时直接修改原文件：

```powershell
Copy-Item .env.example .env
```

在.env中填写本机MySQL连接信息。开发库名称为heji_dev，数据库账号需有对应的建库建表权限。

| 配置项 | 用途 |
| --- | --- |
| APP_ORIGIN | 前端来源，默认http://127.0.0.1:5174 |
| PORT | API端口，默认3001 |
| DB_HOST、DB_PORT | MySQL地址和端口 |
| DB_NAME | 开发库名称heji_dev |
| DB_USER、DB_PASSWORD | 本机数据库账号和密码 |
| HEJI_ALLOW_MIGRATION | 执行迁移时临时设为yes |

先查看迁移计划，这些命令不会修改数据库：

```powershell
npm run db:plan
npm run db:summary:plan
npm run db:window:plan
```

首次初始化空库时，按顺序执行基础表、增量汇总和结算窗口迁移。已有数据库需先核对迁移记录，不能直接重跑：

```powershell
$env:HEJI_ALLOW_MIGRATION='yes'
npm run db:migrate
npm run db:summary:migrate -- --apply --database=heji_dev --maintenance
npm run db:window:migrate -- --apply --database=heji_dev --maintenance
$env:HEJI_ALLOW_MIGRATION='no'
```

MySQL的DDL会隐式提交。迁移失败后应先检查已创建的表和迁移记录，脚本不会自动清库或覆盖已有结构。

### 启动服务

分别在两个终端运行：

```powershell
npm run dev:api
```

```powershell
npm run dev:web
```

打开http://127.0.0.1:5174。前端将/api/v1代理到本机3001端口，API只监听回环地址。端口被占用时会报错，需要自行调整对应配置。修改.env后重启API。

## 检查与测试

```powershell
npm test
npm run typecheck
npm run build
```

纯领域测试可单独运行npm run test:domain，不需要数据库。npm test包含领域和HTTP测试，也不连接真实数据库。

需要真实MySQL的测试单独执行：

```powershell
npm run test:db
npm run test:db:windows
```

数据库测试会写入并保留虚构数据，请使用已迁移的heji_dev。工程目前没有配置lint。

## 目录

| 目录 | 内容 |
| --- | --- |
| apps/web | Vue页面、组件和样式 |
| apps/api | 账户、账本、财务接口和实时通知 |
| packages/domain | 分摊、余额等纯领域算法 |
| packages/contracts | 前后端共用的数据类型 |
| database | 基础迁移及迁移脚本 |
| deploy/nginx | Nginx配置示例 |
| tests | HTTP、数据库和性能测试工具 |
| docs | 接口文档、设计说明和测试记录 |
| work | 开发前的界面原型 |

## 测试记录与限制

2026年11月24日提交前，普通测试172/172通过，前后端类型检查和生产构建通过。详细接口见[HTTP与实时协议](docs/api/README.md)。

本机负载测试中，短时结算窗口等待5、15、25秒的三档各完成60次确认，全部成功。此前连续并发写同一账本时，确认曾出现0/3364成功的结果：预览版本持续过期。两种负载模型的结果分别记录在测试文档中。

备份恢复测试导入20张表、6,609,958行，用时8分23.96秒，逐表摘要、外键和财务核验通过。测试在本机隔离环境完成，项目目前没有部署。详见[M4测试记录](docs/development/m4-verification.md)和[恢复测试](docs/development/m4-restore-timed-real-verification.md)。

原始压力样本体积较大，仅保留在本地。仓库中有摘要报告和[原始文件索引](docs/development/evidence/local-evidence-manifest.json)，历史文档中指向原始样本的链接需要对应的本地文件。.env、密钥、数据库备份、依赖目录和构建产物不入库。
