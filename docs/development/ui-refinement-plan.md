# 双界面视觉精修实施计划

目标：落实 ui-refinement-design.md，在保留 A 默认/B 可选与财务行为的前提下改善首屏比例、排版、操作层级及可辨识性。

架构：保留现有 Vue 业务组件树，原生 details 承载筛选，根 data-interface 控制两套布局；品牌图形抽成小型纯展示组件。技术栈沿用 Vue3/TypeScript/CSS、Node 测试与已有 Python Playwright。

- [x] 读取正式页面、样式、已有验收和约束；比较处理方式，写出本轮具体设计。用户已要求设计并落实，继续执行已授权范围。
- [x] 模板：BookView/ExpensePanel 增加展示类，移除重复新建入口，以 `<details class="expense-filter-disclosure"><summary>筛选明细</summary><form class="expense-filters">...</form></details>` 保留筛选行为；新建时 nextTick 聚焦金额。不得更改业务请求、key或v-show。
- [x] 样式首轮：appearance.css 内修改原规则，统一色彩/字体/间距；处理新增筛选类与 A/B 不同布局、公共页、结算、成员和统计。避免末尾叠加大批互相覆盖规则。截图后继续校准手机概览及B桌面行距。
- [x] 品牌与设置：新增 BrandMark.vue、接入App，AppearanceSettings.vue 改用两种可辨识布局小预览并保持radio/dialog/存储和焦点行为。
- [x] 隔离UI回归：新增 appearance-refinement-ui.py，沿用旧模拟契约并保留旧证据；新增主入口/筛选/聚焦/首屏断言，丰富符合实际语义的演示账目。证据另存 ui-refinement-2026-11-19.json，最终39项/36布局/38图通过。
- [x] 集成检查：npm test134/134、最终npm run build退出0；正式Vue模拟浏览器正常/空/错/手机和桌面通过，长昵称P2复现并修复后完整重验。
- [x] 规格复核与代码质量复核；复现的长名P2已修复并关闭。更新README、接续及验收说明，最终图片另存，不覆盖旧证据。

职责：模板代理拥有BookView/ExpensePanel；样式代理仅appearance.css；测试代理仅新的隔离脚本及证据；主代理负责品牌/设置、集成、文档及最终复核。所有代码在当前项目中完成，无Git元数据，不初始化仓库或创建提交。

财务规则没有变化，无需新增镜像领域测试；本轮交互由浏览器行为断言验证。失败按实际原因记录、修正后重验，不声明未做的真实登录/并发验收。

首轮验证：npm test134/134、build退出0；隔离UI31项/32布局/36图通过。第一轮截图促成手机概览压缩、B桌面详情同排和长昵称/金额边界检查，最终验收在该补丁后重跑。中间脚本label定位与关闭模拟WS造成的补查干扰按真实根因修正，旧证据不修改。
