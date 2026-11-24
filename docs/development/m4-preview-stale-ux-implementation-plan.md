# PREVIEW_STALE 重新确认实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` for inline implementation. Track each step with the checkbox syntax below.

**Goal:** 当转账确认因财务版本过期被拒绝时，自动显示最新预览，同时要求用户重新核对并确认。

**Architecture:** 在`apps/web/src/finance.ts`加入可独立测试的过期错误识别与单次预览读取结果函数；`SettlementPanel.vue`只对`409/PREVIEW_STALE`使用它，刷新成功则替换预览并清除确认勾选，失败则清除旧预览。确认POST仍只由用户操作触发。

**Tech Stack:** Vue 3、TypeScript、Node内置`node:test`、现有`ClientFault`与幂等意图存储；不增加依赖。

---

### Task 1：锁定预览恢复规则

**Files:**
- Create: `tests/integration/m4-preview-stale.test.ts`
- Modify: `apps/web/src/finance.ts`

- [x] **Step 1: 先写失败测试**

创建测试文件，内容如下。通过动态命名空间读取让RED阶段以导出存在性断言失败，不因缺少具名导出导致模块加载错误；其余断言验证成功、无关409、GET失败和幂等键轮换：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientFault } from '../../apps/web/src/api.ts';
import * as finance from '../../apps/web/src/finance.ts';

test('PREVIEW_STALE只读取一次最新预览并返回它',async()=>{
  const refresh=Reflect.get(finance,'refreshStalePreview');
  assert.equal(typeof refresh,'function');
  const latest={expectedRequestRevision:'2',expectedFinancialVersion:'9'};let reads=0;
  const result=await Reflect.apply(refresh,undefined,[new ClientFault(409,'PREVIEW_STALE','版本变化'),async()=>{reads++;return latest}]);
  assert.deepEqual(result,{kind:'fresh',preview:latest});assert.equal(reads,1);
});

test('其他409不读取预览',async()=>{
  const refresh=Reflect.get(finance,'refreshStalePreview');assert.equal(typeof refresh,'function');let reads=0;
  const result=await Reflect.apply(refresh,undefined,[new ClientFault(409,'TRANSFER_ALREADY_REVERSED','已冲正'),async()=>{reads++;return null}]);
  assert.deepEqual(result,{kind:'unrelated'});assert.equal(reads,0);
});

test('最新预览读取失败返回失败结果',async()=>{
  const refresh=Reflect.get(finance,'refreshStalePreview');assert.equal(typeof refresh,'function');const failure=new Error('网络中断');
  const result=await Reflect.apply(refresh,undefined,[new ClientFault(409,'PREVIEW_STALE','版本变化'),async()=>{throw failure}]);
  assert.deepEqual(result,{kind:'failed',error:failure});
});

test('新预览的版本字段变化会生成新的幂等键',()=>{
  const intents=finance.createIntentStore(),path='/books/example/transfer-requests/request/confirm';
  const first=intents.headers(path,{expectedRequestRevision:'1',expectedFinancialVersion:'8'})['Idempotency-Key'];
  const next=intents.headers(path,{expectedRequestRevision:'1',expectedFinancialVersion:'9'})['Idempotency-Key'];
  assert.notEqual(next,first);
});
```

- [x] **Step 2: 运行测试并确认预期失败**

运行：`node --test tests/integration/m4-preview-stale.test.ts`

结果：三项恢复行为断言因helper尚未导出而失败；幂等键随新版本变化的回归通过。失败不是语法或导入错误。

- [x] **Step 3: 添加最小过期恢复函数**

在`finance.ts`加入以下类型和函数；函数不接收或调用确认写入回调。`invalidate`必须在开始GET前同步调用，以立即撤销旧确认状态：

```ts
export type PreviewRefreshResult<T>={kind:'unrelated'}|{kind:'fresh';preview:T}|{kind:'failed';error:unknown};
export async function refreshStalePreview<T>(cause:unknown,invalidate:()=>void,loadLatest:()=>Promise<T>):Promise<PreviewRefreshResult<T>>{
  const stale=cause instanceof Error&&'status' in cause&&cause.status===409&&'code' in cause&&cause.code==='PREVIEW_STALE';
  if(!stale)return {kind:'unrelated'};
  invalidate();
  try{return {kind:'fresh',preview:await loadLatest()}}catch(error){return {kind:'failed',error}}
}
```

- [x] **Step 4: 重跑聚焦测试**

运行：`node --test tests/integration/m4-preview-stale.test.ts`

预期：所有预览分类、单次读取、失败结果和幂等键断言通过。

### Task 2：接入结算确认面板

**Files:**
- Modify: `apps/web/src/components/SettlementPanel.vue`
- Test: `tests/integration/m4-preview-stale.test.ts`

- [x] **Step 1: 在过期分支中只刷新预览**

保留现有API导入`import { api,ClientFault } from '../api.ts';`，并从`finance.ts`导入`refreshStalePreview`。在`confirm()`的catch中调用：

```ts
const recovery=await refreshStalePreview(cause,()=>{acknowledged.value=false},()=>api<TransferPreviewDto>(path.value+`/transfer-requests/${current.request.id}/preview`));
if(recovery.kind==='fresh'){
  acknowledged.value=false;preview.value=recovery.preview;previewNotice.value='账本在核对期间已有变化，以下是最新预览，请重新核对后确认。';await load();emit('changed');
}else if(recovery.kind==='failed'){
  preview.value=null;error.value='无法获取最新预览，请刷新登记后重新核对。';await load();emit('changed');
}else{
  error.value=cause instanceof Error?cause.message:'确认失败';
  if(cause instanceof ClientFault&&cause.status===409){preview.value=null;error.value+='。请重新打开确认预览，核对后再确认。';await load();emit('changed')}
}
```

确认复选框绑定`:disabled="busy"`，使确认POST与最新预览GET期间不可操作。`fresh`保持原确认面板；`failed`绝不保留旧预览。此分支只执行GET，不再次调用`mutate`或确认POST。

- [x] **Step 2: 针对状态行为补回归断言**

验证恢复结果只返回最新DTO供界面显示，不触发确认写入；版本字段不同产生新幂等键，重复冲突必须重新经过用户的下一次显式点击。刷新失败不能留下可提交的旧版本。真实浏览器测试还验证版本变化提示位于确认面板内。

- [x] **Step 3: 运行定向与完整验证**

运行：`node --test tests/integration/m4-preview-stale.test.ts`、`npm test`、`npm run typecheck`、`npm run build`。

预期：定向测试与完整测试通过，API与Vue类型检查通过，Vite生产构建成功。HTTP浏览器UI流程实测通过；自签证书信任下的HTTPS UI仍未测，不绕过警告。

---

## 退出条件

- 冲突只导致一次最新预览GET，确认POST没有自动重试。
- 旧勾选被清除；只有查看新预览并重新勾选、点击才可确认。
- 预览读取失败时旧预览不可提交；其他409不走过期恢复路径。
- 服务端财务版本校验与幂等保护不变。
- 定向测试、完整测试、类型检查及构建均通过；浏览器未实测时明确记录。
