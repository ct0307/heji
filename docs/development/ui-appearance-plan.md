# 双界面实施计划

目标：按用户已确认的A默认、B墨蓝灰无衬线设计，提供可保存的界面选择。

架构：单一业务组件树，data-interface切换展示；独立浏览器偏好，不增加后端接口。

技术：现有Vue3/TypeScript/CSS、Node测试、已有Playwright，无新依赖。当前目录无Git提交，不创建工作树或提交。

- [x] 偏好行为：`ui-appearance.test.ts`先因缺失模块失败，实现`appearance.ts`后4/4通过；默认A、恢复B、非法值和读写失败均覆盖。
- [x] 设置入口：原生dialog/radio立即切换，状态提示、Escape及焦点恢复；main首次渲染前恢复偏好，组件直接更新根属性，无需watchEffect。
- [x] 两种展示：独立appearance.css覆盖A侧栏/绿色余额、B横向导航/账页及收据。保留业务实例与v-show，只为BookView加外层容器，未修改SettlementPanel或财务脚本。
- [x] 浏览器回归：先运行smoke，最终22项、24条布局、32截图通过，全部API/WS隔离模拟；浏览器无失败红期，不重复或伪造偏好模块之外的红测试。
- [x] 验证与复核：npm test134/134、最终build及两阶段审查通过；修复B字体P2并重新跑浏览器与build。开发接续及README同步，本轮Vite验收后关闭，不动无关5173/3000。

设置行为关键片段：`const mode=ref(loadAppearance(storage)); function choose(value:Appearance){mode.value=value;const saved=saveAppearance(value,storage);notice.value=saved?'已保存界面选择':'本次已切换，当前浏览器无法保存界面选择。';}`。根主题只改data属性，不能用`:key="mode"`重建页面。

测试命令输出与最终范围记录在`ui-appearance-verification.md`；财务/数据库原证据不纳入本次模拟UI结果。
