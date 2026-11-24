<script setup lang="ts">
import { computed,nextTick,ref,watch,onBeforeUnmount } from 'vue';
import { useRoute,useRouter } from 'vue-router';
import { api,ClientFault,expireSession } from '../api.ts';
import { browserSocket,createRealtimeSync,type SyncState } from '../realtime-client.ts';
import { money } from '../finance.ts';
import type { BookDto,MemberDto,FinanceSnapshotDto } from '../../../../packages/contracts/src/index.ts';
import ExpensePanel from '../components/ExpensePanel.vue';
import SettlementPanel from '../components/SettlementPanel.vue';
import ReportPanel from '../components/ReportPanel.vue';
import MembersPanel from '../components/MembersPanel.vue';
const route=useRoute(),router=useRouter(),book=ref<BookDto|null>(null),members=ref<MemberDto[]>([]),snapshot=ref<FinanceSnapshotDto|null>(null),loading=ref(true),error=ref(''),refreshNumber=ref(0);
const expensePanel=ref<InstanceType<typeof ExpensePanel>|null>(null);
const syncState=ref<SyncState>('connecting');let sync:ReturnType<typeof createRealtimeSync>|undefined;let sequence=0;
const syncLabel=computed(()=>syncState.value==='live'?'正在接收账本更新 · 每30秒自动核对':syncState.value==='offline'?'实时连接中断 · 将自动重连并定时核对':syncState.value==='stopped'?'同步已停止，请重新打开账本或登录':'正在连接账本更新…');
const tabs=[{id:'expenses',title:'明细'},{id:'settlement',title:'结算'},{id:'reports',title:'统计'},{id:'members',title:'成员'}];
const activeTab=computed(()=>tabs.some(x=>x.id===route.query.tab)?String(route.query.tab):'expenses');
const ownBalance=computed(()=>snapshot.value?.balances.find(x=>x.memberId===snapshot.value?.memberId)?.balanceFen??'0');
const balanceTitle=computed(()=>BigInt(ownBalance.value)>0n?'你当前应收':BigInt(ownBalance.value)<0n?'你当前应付':'你当前净额已平');
async function load(background=false){const current=++sequence,id=String(route.params.bookId);loading.value=true;error.value='';try{const result=await Promise.all([api<BookDto>('/books/'+id),api<MemberDto[]>('/books/'+id+'/members'),api<FinanceSnapshotDto>('/books/'+id+'/balances')]);if(current===sequence){[book.value,members.value,snapshot.value]=result;refreshNumber.value++}}catch(cause){if(current===sequence){if(cause instanceof ClientFault&&[401,404].includes(cause.status)){book.value=null;snapshot.value=null}error.value=cause instanceof Error?cause.message:'无法加载账本'}if(background)throw cause}finally{if(current===sequence)loading.value=false}}
function reload(){void load()}
async function selectTab(tab:string){await router.replace({query:{...route.query,tab}})}
async function addExpense(){await selectTab('expenses');await nextTick();expensePanel.value?.openNew()}
function visibility(){sync?.visible(document.visibilityState==='visible')}
watch(()=>route.params.bookId,id=>{sync?.stop();book.value=null;snapshot.value=null;void load();sync=createRealtimeSync({bookId:String(id),connect:()=>browserSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`),sync:()=>load(true),state:value=>{syncState.value=value},authRequired:()=>{expireSession();void router.replace('/login')},revoked:()=>{book.value=null;snapshot.value=null;error.value='你已不在这个账本中，请返回我的账本。'}});sync.start();visibility()},{immediate:true});
document.addEventListener('visibilitychange',visibility);onBeforeUnmount(()=>{sequence++;sync?.stop();document.removeEventListener('visibilitychange',visibility)});
</script>
<template>
  <section class="book-workspace">
  <RouterLink class="text-button book-back" to="/books">← 我的账本</RouterLink><p v-if="loading&&!book" role="status">正在核对账本与余额…</p><p v-if="error" class="error" role="alert">{{ error }} <button class="text-button" @click="reload">重新加载</button></p>
  <template v-if="book&&snapshot">
    <header class="page-heading book-heading"><div class="book-heading-copy"><p class="eyebrow">共享账本 · 人民币</p><h1>{{ book.name }}</h1><p class="muted book-meta">{{ members.filter(m=>m.status==='ACTIVE').length }}位成员 · {{ book.isArchived?'已归档，仅可查看':'共同维护，收付有据' }}</p></div><div class="heading-actions"><button class="text-button" :disabled="loading" @click="reload">刷新账本</button><button v-if="!book.isArchived" class="primary record-expense" @click="addExpense">＋ 记一笔</button></div></header>
    <p class="sync-status" :data-state="syncState" role="status">{{ syncLabel }}</p>
    <section class="ledger-overview" aria-label="当前账本概览"><div class="personal-balance" :data-direction="BigInt(ownBalance)>0n?'receivable':BigInt(ownBalance)<0n?'payable':'settled'"><p class="overview-label">{{ balanceTitle }}</p><strong class="hero-number"><span class="overview-currency">¥</span>{{ money((BigInt(ownBalance)<0n?-BigInt(ownBalance):BigInt(ownBalance)).toString()) }}</strong><span class="small overview-caption">{{ snapshot.isSettled?'当前账本已结清':snapshot.pendingCount?'还有登记等待双方核对':'仅已确认转账计入余额' }}</span></div><div class="overview-detail"><p class="overview-label">共同消费</p><strong>¥{{ money(snapshot.expenseTotalFen) }}</strong><span class="small muted overview-caption">当前有效开销</span></div><button class="overview-detail pending-shortcut" @click="selectTab('settlement')"><p class="overview-label">待确认登记</p><strong>{{ snapshot.pendingCount }} <span class="small">笔</span></strong><span class="small muted overview-caption">点击前往核对 →</span></button></section>
    <nav class="book-tabs" aria-label="账本导航"><button v-for="tab in tabs" :key="tab.id" :class="{active:activeTab===tab.id}" :aria-current="activeTab===tab.id?'page':undefined" @click="selectTab(tab.id)">{{ tab.title }}<span v-if="tab.id==='settlement'&&snapshot.pendingCount" class="count-badge">{{ snapshot.pendingCount }}</span></button></nav>
    <div :key="book.id" class="book-content"><div v-show="activeTab==='expenses'"><ExpensePanel ref="expensePanel" :book="book" :members="members" :snapshot="snapshot" :refresh-number="refreshNumber" @changed="reload" /></div><div v-show="activeTab==='settlement'"><SettlementPanel :book="book" :members="members" :snapshot="snapshot" :refresh-number="refreshNumber" :visible="activeTab==='settlement'" @changed="reload" /></div><div v-show="activeTab==='reports'"><ReportPanel :book-id="book.id" :members="members" :refresh-number="refreshNumber" /></div><div v-show="activeTab==='members'"><MembersPanel :book="book" :members="members" :snapshot="snapshot" :refresh-number="refreshNumber" @changed="reload" /></div></div>
  </template>
  </section>
</template>
