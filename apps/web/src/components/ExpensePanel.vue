<script setup lang="ts">
import { computed,nextTick,onMounted,ref,watch } from 'vue';
import type { BookDto,MemberDto,FinanceSnapshotDto,ExpenseDto,ExpensePageDto,ShareDto } from '../../../../packages/contracts/src/index.ts';
import { parseYuan,splitEqual } from '../../../../packages/domain/src/ledger.ts';
import { api,ClientFault } from '../api.ts';
import { categoryNames,createIntent,money,shareYuan,today } from '../finance.ts';
const props=defineProps<{book:BookDto;members:MemberDto[];snapshot:FinanceSnapshotDto;refreshNumber:number}>(),emit=defineEmits<{changed:[]}>();
const rows=ref<ExpenseDto[]>([]),nextCursor=ref<string|null>(null),loading=ref(true),busy=ref(false),error=ref(''),notice=ref('');
const hasMorePages=ref(false),newerAvailable=ref(false);let sequence=0;
const categoryFilter=ref(''),from=ref(''),to=ref('');let applied={category:'',from:'',to:''};
const showForm=ref(false),editing=ref<ExpenseDto|null>(null),history=ref<ExpenseDto[]>([]),conflicted=ref(false);
const amountInput=ref<HTMLInputElement|null>(null);
const amount=ref(''),paidBy=ref(''),splitMode=ref<'EQUAL'|'EXACT'>('EQUAL'),participants=ref<string[]>([]),exact=ref<Record<string,string>>({}),category=ref('FOOD'),date=ref(today()),note=ref(''),voidReason=ref('');
const intent=createIntent(),active=computed(()=>props.members.filter(x=>x.status==='ACTIVE'));
const isRecorder=computed(()=>!editing.value||editing.value.createdByMemberId===props.snapshot.memberId);
const frozen=computed(()=>!!editing.value&&[editing.value.paidByMemberId,...editing.value.shares.map(x=>x.memberId)].some(id=>props.members.find(m=>m.id===id)?.status!=='ACTIVE'));
const editable=computed(()=>isRecorder.value&&!props.book.isArchived&&!editing.value?.isVoided);
const name=(id:string)=>props.members.find(x=>x.id===id)?.displayName??'历史成员';
const path=computed(()=>'/books/'+props.book.id+'/expenses');
const preview=computed<{shares:ShareDto[];difference:string;issue:string}>(()=>{
  try{const total=parseYuan(amount.value);let shares:ShareDto[];
    if(splitMode.value==='EQUAL')shares=splitEqual(total,participants.value).map(x=>({...x,amountFen:x.amountFen.toString()}));
    else shares=participants.value.map(memberId=>({memberId,amountFen:shareYuan(exact.value[memberId]??'0')}));
    const difference=total-shares.reduce((sum,x)=>sum+BigInt(x.amountFen),0n);return {shares,difference:difference.toString(),issue:participants.value.length?'':'请至少选择一位分摊成员'};
  }catch(cause){return {shares:[],difference:'0',issue:amount.value?(cause instanceof Error?cause.message:'金额无效'):'输入金额后查看分摊预览'}}
});
async function load(append=false){const current=++sequence;loading.value=true;error.value='';try{const params=new URLSearchParams({limit:'20'});if(applied.category)params.set('category',applied.category);if(applied.from)params.set('from',applied.from);if(applied.to)params.set('to',applied.to);if(append&&nextCursor.value)params.set('cursor',nextCursor.value);const result=await api<ExpensePageDto>(path.value+'?'+params);if(current===sequence){rows.value=append?[...rows.value,...result.items]:result.items;nextCursor.value=result.nextCursor;if(append)hasMorePages.value=true;else{hasMorePages.value=false;newerAvailable.value=false}}}catch(cause){if(current===sequence)error.value=cause instanceof Error?cause.message:'无法加载明细'}finally{if(current===sequence)loading.value=false}}
function filter(){if(from.value&&to.value&&from.value>to.value){error.value='开始日期不能晚于结束日期，输入已保留';return}applied={category:categoryFilter.value,from:from.value,to:to.value};void load()}
function openNew(){editing.value=null;history.value=[];amount.value='';paidBy.value=props.snapshot.memberId;splitMode.value='EQUAL';participants.value=active.value.map(x=>x.id);exact.value={};category.value='FOOD';date.value=today();note.value='';showForm.value=true;error.value='';notice.value='';conflicted.value=false;intent.reset();void nextTick(()=>amountInput.value?.focus())}
async function open(row:ExpenseDto){busy.value=true;error.value='';try{editing.value=await api<ExpenseDto>(path.value+'/'+row.id);const item=editing.value;amount.value=money(item.amountFen);paidBy.value=item.paidByMemberId;splitMode.value=item.splitMode;participants.value=item.shares.map(x=>x.memberId);exact.value=Object.fromEntries(item.shares.map(x=>[x.memberId,money(x.amountFen)]));category.value=item.category;date.value=item.occurredOn;note.value=item.note;voidReason.value='';history.value=await api<ExpenseDto[]>(path.value+'/'+row.id+'/history');showForm.value=true;conflicted.value=false;intent.reset()}catch(cause){error.value=cause instanceof Error?cause.message:'无法打开支出'}finally{busy.value=false}}
async function refreshVersion(){if(!editing.value)return;try{editing.value=await api<ExpenseDto>(path.value+'/'+editing.value.id);history.value=await api<ExpenseDto[]>(path.value+'/'+editing.value.id+'/history');conflicted.value=false;notice.value='已读取最新记录，输入已保留。请对照最新金额后再保存。';intent.reset()}catch(cause){error.value=cause instanceof Error?cause.message:'无法读取最新版本'}}
async function save(){if(busy.value)return;busy.value=true;error.value='';try{
  let body:Record<string,unknown>;
  if(frozen.value)body={note:note.value};
  else {if(preview.value.issue)throw new Error(preview.value.issue);if(preview.value.difference!=='0')throw new Error('指定分摊合计须等于支出金额');body={paidByMemberId:paidBy.value,amountFen:parseYuan(amount.value).toString(),splitMode:splitMode.value,...(splitMode.value==='EQUAL'?{participantMemberIds:[...participants.value].sort()}:{shares:preview.value.shares}),category:category.value,occurredOn:date.value,note:note.value}}
  const target=editing.value?path.value+'/'+editing.value.id:path.value;await api<ExpenseDto>(target,editing.value?'PATCH':'POST',body,intent.headers(target,body,editing.value?.etag));intent.reset();showForm.value=false;notice.value='支出已保存';await load();emit('changed');
}catch(cause){error.value=cause instanceof Error?cause.message:'保存失败，输入已保留';conflicted.value=cause instanceof ClientFault&&cause.status===412}finally{busy.value=false}}
async function voidExpense(){if(!editing.value||busy.value)return;busy.value=true;error.value='';try{if(!voidReason.value.trim())throw new Error('请填写作废原因');const target=path.value+'/'+editing.value.id+'/void',body={note:voidReason.value};await api(target,'POST',body,intent.headers(target,body,editing.value.etag));intent.reset();showForm.value=false;notice.value='支出已作废，历史已保留';await load();emit('changed')}catch(cause){error.value=cause instanceof Error?cause.message:'无法作废';conflicted.value=cause instanceof ClientFault&&cause.status===412}finally{busy.value=false}}
onMounted(()=>load());watch(()=>props.refreshNumber,()=>{if(hasMorePages.value)newerAvailable.value=true;else void load()});defineExpose({openNew});
</script>
<template>
  <p v-if="error" class="error" role="alert">{{ error }} <button type="button" class="text-button" @click="load()">重新加载明细</button></p><p v-if="notice" class="success-note" role="status">{{ notice }}</p>
  <section v-if="showForm" class="panel expense-editor" aria-label="开销录入表单">
    <div class="section-title"><div><p class="eyebrow">{{ editing?'核对与修正':'记一笔共同开销' }}</p><h2>{{ editing?'开销详情':'谁垫付，谁承担' }}</h2></div><button type="button" class="text-button" :disabled="busy" @click="showForm=false">关闭表单</button></div>
    <p v-if="frozen" class="notice">涉及已退出成员，财务信息已冻结；有效录入者仍可补充备注。</p><p v-if="editing?.isVoided" class="notice">这笔开销已作废，仅保留历史。</p><p v-if="editing&&!isRecorder" class="notice">由{{ name(editing.createdByMemberId) }}录入，只有录入人可以修改。</p>
    <p v-if="conflicted" class="error" role="alert">记录已被更新，当前输入已保留。<button type="button" class="text-button" @click="refreshVersion">保留输入，读取最新版本</button></p>
    <p v-if="editing" class="muted small">最新记录：¥{{ money(editing.amountFen) }} · {{ editing.occurredOn }} · {{ name(editing.paidByMemberId) }}垫付</p>
    <form @submit.prevent="save">
      <fieldset :disabled="!editable||frozen||busy"><legend class="sr-only">开销信息</legend>
        <label class="amount-label">金额（元）<input ref="amountInput" v-model="amount" class="amount-input" inputmode="decimal" placeholder="0.00" required aria-label="开销金额（元）"></label>
        <div class="form-pair"><label>实际付款人<select v-model="paidBy"><option v-for="member in members" :key="member.id" :value="member.id" :disabled="member.status!=='ACTIVE'">{{ member.displayName }}{{ member.status==='LEFT'?'（已退出）':'' }}</option></select></label><label>发生日期<input v-model="date" type="date" required></label></div>
        <div class="form-pair"><label>分类<select v-model="category"><option v-for="(title,code) in categoryNames" :key="code" :value="code">{{ title }}</option></select></label><label>分摊方式<select v-model="splitMode"><option value="EQUAL">均分</option><option value="EXACT">指定金额</option></select></label></div>
        <div class="participants"><p class="field-label">参与分摊的成员</p><div v-for="member in members.filter(m=>m.status==='ACTIVE'||participants.includes(m.id))" :key="member.id" class="participant-row"><label class="check-label"><input v-model="participants" type="checkbox" :value="member.id"><span>{{ member.displayName }}</span></label><label v-if="splitMode==='EXACT'&&participants.includes(member.id)" class="share-entry"><span class="sr-only">{{ member.displayName }}承担金额（元）</span><input v-model="exact[member.id]" inputmode="decimal" placeholder="0.00"></label></div></div>
      </fieldset>
      <section class="split-preview" aria-label="分摊预览"><strong>提交前核对</strong><p v-if="preview.issue" class="muted small">{{ preview.issue }}</p><template v-else><p class="small">{{ name(paidBy) }}垫付 ¥{{ amount }}，{{ participants.length }}人承担。</p><ul><li v-for="share in preview.shares" :key="share.memberId"><span>{{ name(share.memberId) }}</span><strong>¥{{ money(share.amountFen) }}</strong></li></ul><p v-if="preview.difference!=='0'" class="error">{{ BigInt(preview.difference)>0n?'还差':'超出' }} ¥{{ money((BigInt(preview.difference)<0n?-BigInt(preview.difference):BigInt(preview.difference)).toString()) }}</p></template></section>
      <label>备注<textarea v-model="note" maxlength="1000" :disabled="!editable||busy" rows="3" placeholder="记下用途，便于大家核对"></textarea></label>
      <div v-if="editable" class="actions"><button class="primary" :disabled="busy||conflicted">{{ busy?'正在保存…':editing?'保存修改':'保存开销' }}</button><span class="muted small">录入人：{{ name(snapshot.memberId) }}</span></div>
    </form>
    <details v-if="editing" class="history-section"><summary>查看 {{ history.length }} 个历史版本</summary><ol><li v-for="item in history" :key="item.revision"><strong>{{ item.isVoided?'已作废':'¥'+money(item.amountFen) }}</strong> · {{ item.occurredOn }} · {{ name(item.changedByMemberId) }}修改<p class="muted small">{{ item.note||'无备注' }}</p></li></ol></details>
    <details v-if="editing&&editable&&!frozen" class="history-section"><summary>作废这笔开销</summary><p class="muted small">作废后不计入消费与分摊，历史及已有转账继续保留。</p><label>作废原因<input v-model="voidReason" maxlength="1000"></label><button type="button" class="danger-button" :disabled="busy||conflicted" @click="voidExpense">确认作废</button></details>
  </section>
  <section class="panel expense-list"><div class="section-title"><div><p class="eyebrow">按发生日期查看</p><h2>共同开销</h2></div></div>
    <details class="expense-filter-disclosure">
      <summary><svg class="filter-icon" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg><span class="filter-label">筛选明细</span><span v-if="applied.category||applied.from||applied.to" class="filter-applied">已应用筛选</span><svg class="filter-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m7 10 5 5 5-5"/></svg></summary>
      <form class="expense-filters" @submit.prevent="filter"><label>分类筛选<select v-model="categoryFilter"><option value="">全部分类</option><option v-for="(title,code) in categoryNames" :key="code" :value="code">{{ title }}</option></select></label><label>开始日期<input v-model="from" type="date"></label><label>结束日期<input v-model="to" type="date"></label><button class="secondary" :disabled="loading">筛选</button></form>
    </details>
    <p v-if="newerAvailable" class="refresh-notice" role="status">账本可能有更新，当前阅读位置已保留。<button class="text-button" type="button" @click="load()">读取最新明细</button></p>
    <p v-if="loading" class="muted" role="status">正在读取开销…</p><div v-else-if="!rows.length" class="empty-inline"><template v-if="applied.category||applied.from||applied.to"><strong>当前筛选下没有开销</strong><p class="muted">可调整分类或日期后再次筛选。</p></template><template v-else><strong>还没有共同开销</strong><p class="muted">先记一笔晚餐、车费或房租，余额会随实际分摊生成。</p></template></div>
    <ul class="expense-rows"><li v-for="row in rows" :key="row.id"><time class="expense-date" :datetime="row.occurredOn">{{ row.occurredOn }}</time><div class="expense-description"><strong>{{ row.note||categoryNames[row.category] }}</strong><p class="expense-byline"><span v-if="row.note" class="expense-category">{{ categoryNames[row.category] }}</span><span>{{ name(row.paidByMemberId) }}垫付 · {{ name(row.createdByMemberId) }}录入</span></p><span v-if="row.isVoided" class="status-pill">已作废</span></div><strong class="row-amount" :class="{voided:row.isVoided}">¥{{ money(row.amountFen) }}</strong><button type="button" class="text-button" :disabled="busy" @click="open(row)">查看详情</button></li></ul>
    <button v-if="nextCursor" type="button" class="secondary full" :disabled="loading" @click="load(true)">加载更多</button>
  </section>
</template>
