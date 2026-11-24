<script setup lang="ts">
import { computed,onMounted,onUnmounted,ref,watch } from 'vue';
import type { BookDto,MemberDto,FinanceSnapshotDto,TransferRequestDto,TransferPreviewDto,ConfirmedTransferDto,SettlementWindowDto,SettlementWindowPreviewDto } from '../../../../packages/contracts/src/index.ts';
import { parseYuan } from '../../../../packages/domain/src/ledger.ts';
import { api,ClientFault } from '../api.ts';
import { createIntentStore,money,refreshStalePreview,statusNames,today,windowReviewDeadline,windowReviewValid } from '../finance.ts';
const props=defineProps<{book:BookDto;members:MemberDto[];snapshot:FinanceSnapshotDto;refreshNumber:number;visible:boolean}>(),emit=defineEmits<{changed:[]}>();
const items=ref<TransferRequestDto[]>([]),confirmed=ref<ConfirmedTransferDto[]>([]),loading=ref(true),busy=ref(false),error=ref(''),notice=ref(''),previewNotice=ref('');
const toMember=ref(''),amount=ref(''),date=ref(today()),note=ref(''),preview=ref<TransferPreviewDto|null>(null),acknowledged=ref(false);
const reversal=ref<ConfirmedTransferDto|null>(null),reversalNote=ref(''),reversalDate=ref(today()),intents=createIntentStore();
const windowStatus=ref<SettlementWindowDto|null>(null),reviewWindow=ref<SettlementWindowDto|null>(null),windowMode=ref(false),windowChecked=ref(false),windowIssue=ref('');
const deadline=ref(0),tick=ref(performance.now());let timer:ReturnType<typeof setInterval>|undefined,windowRead=0;
const remaining=computed(()=>Math.max(0,Math.ceil((deadline.value-tick.value)/1000)));
const reviewValid=computed(()=>props.visible&&(!windowMode.value||(windowChecked.value&&windowReviewValid(reviewWindow.value,reviewWindow.value?.windowId??'',preview.value?.request.id??'',deadline.value,tick.value))));
const path=computed(()=>'/books/'+props.book.id),pending=computed(()=>items.value.filter(x=>x.status==='PENDING'));
const recipients=computed(()=>props.members.filter(x=>x.status==='ACTIVE'&&x.id!==props.snapshot.memberId));
const name=(id:string)=>props.members.find(x=>x.id===id)?.displayName??'历史成员';
const balanceLabel=(fen:string)=>BigInt(fen)>0n?'应收 ¥'+money(fen):BigInt(fen)<0n?'应付 ¥'+money((-BigInt(fen)).toString()):'当前净额已平';
const own=computed(()=>props.snapshot.memberId);
function involved(item:ConfirmedTransferDto){return [item.fromMemberId,item.toMemberId].includes(own.value)&&[item.fromMemberId,item.toMemberId].every(id=>props.members.find(m=>m.id===id)?.status==='ACTIVE')}
function canReverse(item:ConfirmedTransferDto){return item.kind==='NORMAL'&&!confirmed.value.some(x=>x.reversalOfTransferId===item.id)&&!pending.value.some(x=>x.reversalOfTransferId===item.id)&&involved(item)&&!props.book.isArchived}
async function load(){loading.value=true;try{[items.value,confirmed.value]=await Promise.all([api<TransferRequestDto[]>(path.value+'/transfer-requests'),api<ConfirmedTransferDto[]>(path.value+'/transfers')])}catch(cause){error.value=cause instanceof Error?cause.message:'无法加载转账'}finally{loading.value=false}}
async function mutate(target:string,body:unknown){const result=await api(target,'POST',body,intents.headers(target,body));intents.reset(target);return result}
async function register(){if(busy.value)return;busy.value=true;error.value='';try{if(!toMember.value)throw new Error('请选择收款人');await mutate(path.value+'/transfer-requests',{toMemberId:toMember.value,amountFen:parseYuan(amount.value).toString(),occurredOn:date.value,note:note.value});amount.value='';note.value='';notice.value='已登记，等待对方确认；当前余额尚未改变。';await load();emit('changed')}catch(cause){error.value=cause instanceof Error?cause.message:'登记失败，输入已保留'}finally{busy.value=false}}
function useSuggestion(item:{toMemberId:string;amountFen:string}){toMember.value=item.toMemberId;amount.value=money(item.amountFen);notice.value='已填入建议金额。请在线下实际付款后再登记。'}
async function syncWindow(){
  const read=++windowRead,started=performance.now();
  try{
    const current=await api<SettlementWindowDto>(path.value+'/settlement-window');if(read!==windowRead)return;
    windowStatus.value=current;windowIssue.value='';
    if(windowMode.value&&reviewWindow.value){
      windowChecked.value=current.windowId===reviewWindow.value.windowId&&current.state==='ACTIVE'&&current.mine&&current.requestId===preview.value?.request.id;
      if(current.windowId===reviewWindow.value.windowId)reviewWindow.value=current;
      if(windowChecked.value){reviewWindow.value=current;deadline.value=windowReviewDeadline(current,started)}
      else{acknowledged.value=false;previewNotice.value='结算窗口已结束或被关闭，请重新打开预览并核对。'}
    }
  }catch(cause){
    if(read!==windowRead)return;
    windowIssue.value=cause instanceof ClientFault&&cause.code==='SETTLEMENT_WINDOW_UNAVAILABLE'?'短时结算窗口尚不可用，普通预览仍可使用。':cause instanceof Error?cause.message:'无法检查窗口状态';
    if(windowMode.value){windowChecked.value=false;acknowledged.value=false}
  }
}
async function acquireWindow(){
  if(!preview.value||busy.value)return;
  busy.value=true;error.value='';acknowledged.value=false;windowMode.value=true;windowChecked.value=false;++windowRead;
  const current=preview.value,started=performance.now(),target=path.value+`/transfer-requests/${current.request.id}/settlement-window`;
  try{
    const body={} ,result=await api<SettlementWindowPreviewDto>(target,'POST',body,intents.headers(target,body));
    // 申请重放沿用原键，不续期。只有用户明确重新打开预览后才建立新申请意图。
    reviewWindow.value=result.window;windowStatus.value=result.window;preview.value=result.preview;deadline.value=windowReviewDeadline(result.window,started);tick.value=performance.now();
    windowChecked.value=windowReviewValid(result.window,result.window.windowId??'',current.request.id,deadline.value,tick.value);
    previewNotice.value=windowChecked.value?'已取得短时窗口。以下是最新预览，请重新核对并勾选。':'原申请的窗口已结束，请重新打开预览后再操作。';
  }catch(cause){error.value=cause instanceof Error?cause.message:'申请失败';previewNotice.value='申请结果尚未确认，可重试原申请或检查窗口状态；暂不能确认入账。';await syncWindow()}
  finally{busy.value=false}
}
async function releaseWindow(current=reviewWindow.value){
  if(!current?.windowId||busy.value)return false;
  busy.value=true;error.value='';acknowledged.value=false;windowChecked.value=false;++windowRead;
  try{
    const result=await mutate(path.value+`/settlement-windows/${current.windowId}/close`,{}) as SettlementWindowDto;
    windowStatus.value=result;if(reviewWindow.value?.windowId===current.windowId)reviewWindow.value=result;
    previewNotice.value='结算窗口已结束。请重新打开预览后再核对确认。';return true;
  }catch(cause){error.value=cause instanceof Error?cause.message:'关闭失败；窗口仍会自动到期';return false}
  finally{busy.value=false}
}
async function dismissPreview(){
  if(reviewWindow.value?.state==='ACTIVE'&&reviewWindow.value.mine&&!await releaseWindow())return;
  preview.value=null;previewNotice.value='';acknowledged.value=false;reviewWindow.value=null;windowMode.value=false;
}
async function openPreview(item:TransferRequestDto){
  if(busy.value)return;
  if(reviewWindow.value?.state==='ACTIVE'&&remaining.value>0){error.value='请先关闭当前结算窗口，再重新打开预览。';return}
  error.value='';previewNotice.value='';busy.value=true;acknowledged.value=false;preview.value=null;reviewWindow.value=null;windowMode.value=false;
  intents.reset(path.value+`/transfer-requests/${item.id}/settlement-window`);
  try{preview.value=await api<TransferPreviewDto>(path.value+`/transfer-requests/${item.id}/preview`);await syncWindow()}catch(cause){error.value=cause instanceof Error?cause.message:'无法获取预览'}finally{busy.value=false}
}
async function confirm(){
  tick.value=performance.now();
  if(!preview.value||!acknowledged.value||busy.value||!reviewValid.value)return;
  busy.value=true;error.value='';const current=preview.value;
  try{
    await mutate(path.value+`/transfer-requests/${current.request.id}/confirm`,{expectedRequestRevision:current.expectedRequestRevision,expectedFinancialVersion:current.expectedFinancialVersion,...(windowMode.value?{expectedWindowId:reviewWindow.value!.windowId!}:{})});
    preview.value=null;acknowledged.value=false;reviewWindow.value=null;windowMode.value=false;notice.value='双方确认已保存，当前余额已重新计算。';await load();await syncWindow();emit('changed');
  }catch(cause){
    if(windowMode.value){acknowledged.value=false;error.value=cause instanceof Error?cause.message:'确认失败';await syncWindow();return}
    const recovery=await refreshStalePreview(cause,()=>{acknowledged.value=false},()=>api<TransferPreviewDto>(path.value+`/transfer-requests/${current.request.id}/preview`));
    if(recovery.kind==='fresh'){
      acknowledged.value=false;preview.value=recovery.preview;previewNotice.value='账本在核对期间已有变化，以下是最新预览，请重新核对后确认。';await load();emit('changed');
    }else if(recovery.kind==='failed'){
      preview.value=null;error.value='无法获取最新预览，请刷新登记后重新核对。';await load();emit('changed');
    }else{
      error.value=cause instanceof Error?cause.message:'确认失败';
      if(cause instanceof ClientFault&&cause.status===409){preview.value=null;acknowledged.value=false;error.value+='。请重新打开确认预览，核对后再确认。';await load();emit('changed')}
    }
  }finally{busy.value=false}
}
async function act(item:TransferRequestDto,action:'reject'|'cancel'){if(busy.value)return;busy.value=true;error.value='';try{await mutate(path.value+`/transfer-requests/${item.id}/${action}`,{expectedRequestRevision:item.revision});preview.value=null;notice.value=action==='cancel'?'登记已取消':'登记已拒绝';await load();emit('changed')}catch(cause){error.value=cause instanceof Error?cause.message:'操作失败'}finally{busy.value=false}}
async function submitReversal(){if(!reversal.value||busy.value)return;busy.value=true;error.value='';try{if(!reversalNote.value.trim())throw new Error('请说明原登记为什么有误');await mutate(path.value+`/transfers/${reversal.value.id}/reversals`,{occurredOn:reversalDate.value,note:reversalNote.value});reversal.value=null;reversalNote.value='';notice.value='撤销错误登记的请求已提交，等待另一方确认。';await load();emit('changed')}catch(cause){error.value=cause instanceof Error?cause.message:'冲正请求失败'}finally{busy.value=false}}
function onVisibility(){if(props.visible&&document.visibilityState==='visible'){acknowledged.value=false;windowChecked.value=false;void syncWindow()}}
watch(()=>props.visible,visible=>{acknowledged.value=false;windowChecked.value=false;if(visible&&document.visibilityState==='visible')void syncWindow()},{flush:'sync'});
watch(()=>props.refreshNumber,()=>{void load();void syncWindow()});
onMounted(()=>{void load();void syncWindow();document.addEventListener('visibilitychange',onVisibility);timer=setInterval(()=>{tick.value=performance.now();if(windowMode.value&&remaining.value===0){acknowledged.value=false;windowChecked.value=false}},250)});
onUnmounted(()=>{++windowRead;if(timer)clearInterval(timer);document.removeEventListener('visibilitychange',onVisibility)});
</script>
<template>
  <p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="notice" class="success-note" role="status">{{ notice }}</p>
  <section v-if="windowStatus?.state==='ACTIVE'" class="panel" aria-label="账本结算窗口"><p class="notice" role="status">{{ windowStatus.mine?'你正在核对结算':'有人正在核对结算' }}，本账本其他财务写入暂时暂停。窗口到期自动解除。</p><div class="actions"><button v-if="windowStatus.canClose" class="text-button" type="button" :disabled="busy" @click="releaseWindow(windowStatus)">关闭当前结算窗口</button><button class="text-button" type="button" :disabled="busy" @click="syncWindow">检查窗口状态</button></div></section>
  <section class="panel"><div class="section-title"><div><p class="eyebrow">当前全量账目</p><h2>每个人的净余额</h2></div><span class="status-pill">{{ snapshot.isSettled?'当前已结清':'仍有待核对的收付' }}</span></div><ul class="balance-list"><li v-for="row in snapshot.balances" :key="row.memberId"><span>{{ name(row.memberId) }}{{ row.memberId===own?' · 你':'' }}</span><strong :class="BigInt(row.balanceFen)<0n?'payable':'receivable'">{{ balanceLabel(row.balanceFen) }}</strong></li></ul><p class="muted small">余额基于全部有效开销和已确认转账。待确认登记不计入余额。</p></section>
  <div class="finance-columns">
    <section class="panel"><p class="eyebrow">建议，尚未登记付款</p><h2>可以这样结清</h2><p v-if="!snapshot.suggestions.length" class="empty-inline muted">当前净余额已平。{{ snapshot.pendingCount?'仍有待确认登记，请继续核对。':'没有需要结清的金额。' }}</p><ul class="suggestion-list"><li v-for="(item,index) in snapshot.suggestions" :key="index"><p><strong>{{ name(item.fromMemberId) }}</strong> → {{ name(item.toMemberId) }}</p><strong class="row-amount">¥{{ money(item.amountFen) }}</strong><button v-if="item.fromMemberId===own&&!book.isArchived" class="text-button" type="button" @click="useSuggestion(item)">填入登记表</button></li></ul></section>
    <section v-if="!book.isArchived" class="panel"><p class="eyebrow">实际付款后再填写</p><h2>登记我已转出的款项</h2><p class="muted small section-copy">这里记录线下收付款事实，双方确认不代表平台验证支付成功。</p><form @submit.prevent="register"><label>收款人<select v-model="toMember" required><option disabled value="">请选择收款人</option><option v-for="member in recipients" :key="member.id" :value="member.id">{{ member.displayName }}</option></select></label><div class="form-pair"><label>转账金额（元）<input v-model="amount" inputmode="decimal" placeholder="0.00" required></label><label>转账日期<input v-model="date" type="date" required></label></div><label>转账说明<textarea v-model="note" rows="2" maxlength="1000" placeholder="说明线下付款的用途"></textarea></label><button class="primary" :disabled="busy||!recipients.length">{{ busy?'正在处理…':'提交转账登记' }}</button></form></section>
  </div>
  <section v-if="preview" class="panel confirmation-panel" aria-label="转账确认预览">
    <p class="eyebrow">确认前，重新核对</p><h2>{{ preview.request.kind==='REVERSAL'?'撤销错误登记':'确认收到款项' }}</h2>
    <p v-if="previewNotice" class="notice" role="status" aria-live="polite">{{ previewNotice }}</p>
    <div class="window-controls">
      <p class="muted small">短时结算窗口会暂停本账本其他财务写入30秒，供你核对；结束后冷却30秒。窗口不会自动续期。</p>
      <p v-if="windowIssue" class="notice" role="status">{{ windowIssue }}</p>
      <p v-if="windowMode" role="status">{{ reviewValid?'窗口剩余 '+remaining+' 秒':'窗口确认暂不可用，请检查状态或重新打开预览。' }}</p>
      <div class="actions">
        <button class="text-button" type="button" :disabled="busy||!windowStatus?.supported||reviewValid&&windowMode" @click="acquireWindow">{{ windowMode?'重试原窗口申请':'申请短时结算窗口' }}</button>
        <button class="text-button" type="button" :disabled="busy" @click="syncWindow">检查窗口状态</button>
        <button v-if="reviewWindow?.state==='ACTIVE'" class="text-button" type="button" :disabled="busy" @click="releaseWindow()">关闭窗口</button>
        <button v-if="windowMode&&!reviewValid" class="text-button" type="button" :disabled="busy" @click="openPreview(preview.request)">重新打开预览</button>
      </div>
    </div>
    <p class="confirmation-amount">¥{{ money(preview.request.amountFen) }}</p><p>{{ name(preview.request.fromMemberId) }} → {{ name(preview.request.toMemberId) }} · {{ preview.request.occurredOn }}</p><p class="muted">{{ preview.request.note||'无转账说明' }}</p><p v-for="warning in preview.warnings" :key="warning" class="notice">{{ warning }}</p>
    <div class="preview-balances"><div v-for="id in [preview.request.fromMemberId,preview.request.toMemberId]" :key="id"><strong>{{ name(id) }}</strong><p>现在：{{ balanceLabel(preview.beforeBalances.find(x=>x.memberId===id)!.balanceFen) }}</p><p>确认后：{{ balanceLabel(preview.afterBalances.find(x=>x.memberId===id)!.balanceFen) }}</p></div></div>
    <label class="check-label"><input v-model="acknowledged" type="checkbox" :disabled="busy||!reviewValid"><span>我已核对{{ preview.request.kind==='REVERSAL'?'原登记确实有误':'线下收付款事实' }}及确认后的余额</span></label>
    <div class="actions"><button class="primary" type="button" :disabled="busy||!acknowledged||!reviewValid" @click="confirm">{{ preview.request.kind==='REVERSAL'?'确认撤销错误登记':'确认收到款项' }}</button><button class="text-button" type="button" :disabled="busy" @click="dismissPreview">暂不确认</button></div>
  </section>
  <section class="panel"><div class="section-title"><div><p class="eyebrow">未计入当前余额</p><h2>待确认登记 <span class="count-badge">{{ pending.length }}</span></h2></div><button class="text-button" type="button" :disabled="loading" @click="load">刷新登记</button></div><p v-if="loading" class="muted" role="status">正在读取登记…</p><p v-else-if="!pending.length" class="empty-inline muted">没有待确认的转账或冲正请求。</p><ul class="transfer-list"><li v-for="item in pending" :key="item.id"><div><span class="status-pill">{{ item.kind==='REVERSAL'?'撤销错误登记':'等待对方核对' }}</span><h3>{{ name(item.fromMemberId) }} → {{ name(item.toMemberId) }}</h3><p class="muted small">{{ item.occurredOn }} · {{ item.note||'无说明' }}</p></div><strong class="row-amount">¥{{ money(item.amountFen) }}</strong><div v-if="!book.isArchived" class="actions"><template v-if="item.counterpartyMemberId===own"><button class="primary" type="button" :disabled="busy" @click="openPreview(item)">核对并预览</button><button class="text-button" type="button" :disabled="busy" @click="act(item,'reject')">拒绝登记</button></template><button v-if="item.initiatorMemberId===own" class="text-button" type="button" :disabled="busy" @click="act(item,'cancel')">取消登记</button></div></li></ul></section>
  <section v-if="reversal" class="panel confirmation-panel"><p class="eyebrow">只用于撤销误确认</p><h2>撤销错误登记</h2><p class="notice">这会在另一方确认后生成等额反向记录，保留原转账。它不代表实际退款；实际退钱请新增普通转账。</p><p>{{ name(reversal.toMemberId) }} → {{ name(reversal.fromMemberId) }} · ¥{{ money(reversal.amountFen) }}</p><form @submit.prevent="submitReversal"><label>冲正日期<input v-model="reversalDate" type="date" required></label><label>错误登记说明<textarea v-model="reversalNote" maxlength="1000" rows="2" required></textarea></label><div class="actions"><button class="primary" :disabled="busy">请求对方确认撤销</button><button class="text-button" type="button" :disabled="busy" @click="reversal=null">取消操作</button></div></form></section>
  <section class="panel"><p class="eyebrow">双方认可的记录</p><h2>已确认转账</h2><p v-if="!confirmed.length" class="empty-inline muted">双方确认后，记录会出现在这里。</p><ul class="transfer-list"><li v-for="item in confirmed" :key="item.id"><div><span class="status-pill">{{ item.kind==='REVERSAL'?'错误登记冲正':confirmed.some(x=>x.reversalOfTransferId===item.id)?'已由反向记录冲正':'已确认' }}</span><h3>{{ name(item.fromMemberId) }} → {{ name(item.toMemberId) }}</h3><p class="muted small">{{ item.occurredOn }} · {{ name(item.confirmedByMemberId) }}确认</p></div><strong class="row-amount">¥{{ money(item.amountFen) }}</strong><button v-if="canReverse(item)" class="text-button" type="button" :disabled="busy" @click="reversal=item;reversalNote='';reversalDate=today()">撤销错误登记</button></li></ul><details v-if="items.some(x=>['CANCELLED','REJECTED'].includes(x.status))" class="history-section"><summary>已取消与已拒绝的登记</summary><ul><li v-for="item in items.filter(x=>['CANCELLED','REJECTED'].includes(x.status))" :key="item.id">{{ statusNames[item.status] }} · {{ name(item.fromMemberId) }} → {{ name(item.toMemberId) }} · ¥{{ money(item.amountFen) }}</li></ul></details></section>
</template>
