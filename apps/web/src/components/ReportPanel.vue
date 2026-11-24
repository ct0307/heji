<script setup lang="ts">
import { computed,onMounted,ref,watch } from 'vue';
import { api } from '../api.ts';
import { categoryNames,money } from '../finance.ts';
import type { MemberDto,ReportDto } from '../../../../packages/contracts/src/index.ts';
const props=defineProps<{bookId:string;members:MemberDto[];refreshNumber:number}>();
const report=ref<ReportDto|null>(null),error=ref(''),loading=ref(true),from=ref(''),to=ref('');
let sequence=0;let applied={from:'',to:''};
const periodLabel=computed(()=>!report.value?.period.from&&!report.value?.period.to?'全部日期':`${report.value?.period.from??'最早记录'} 至 ${report.value?.period.to??'最新记录'}`);
const name=(id:string)=>props.members.find(x=>x.id===id)?.displayName??'历史成员';
async function load(){const current=++sequence;loading.value=true;error.value='';try{const query=new URLSearchParams();if(applied.from)query.set('from',applied.from);if(applied.to)query.set('to',applied.to);const result=await api<ReportDto>('/books/'+props.bookId+'/reports?'+query);if(current===sequence)report.value=result}catch(cause){if(current===sequence)error.value=cause instanceof Error?cause.message:'无法加载统计'}finally{if(current===sequence)loading.value=false}}
function filter(){if(from.value&&to.value&&from.value>to.value){error.value='开始日期不能晚于结束日期，输入已保留';return}applied={from:from.value,to:to.value};void load()}
function reset(){from.value='';to.value='';applied={from:'',to:''};void load()}
onMounted(load);watch(()=>props.refreshNumber,()=>load());
</script>
<template>
  <section class="panel report-period"><p class="eyebrow">按消费发生日期</p><h2>查看一段时间的消费</h2><form class="period-filters" @submit.prevent="filter"><label>统计开始日期<input v-model="from" type="date"></label><label>统计结束日期<input v-model="to" type="date"></label><button class="primary" :disabled="loading">查看期间统计</button><button class="text-button" type="button" :disabled="loading" @click="reset">查看全部日期</button></form><p class="muted small">结束日包含当天。顶部余额与结算始终按全量账目计算。</p></section>
  <p v-if="error" class="error" role="alert">{{ error }} <button class="text-button" @click="load">重新加载统计</button></p><p v-if="loading" class="muted" role="status">正在核对消费统计…</p>
  <template v-if="report"><section class="panel report-total"><p class="eyebrow">{{ periodLabel }}</p><h2>共同消费合计</h2><strong class="hero-number">¥{{ money(report.expenseTotalFen) }}</strong><p class="muted small">只统计每笔支出的当前有效版本。转账和冲正不属于消费。</p></section>
  <div class="finance-columns"><section class="panel"><h2>消费花在哪里</h2><p v-if="report.expenseTotalFen==='0'" class="empty-inline muted">这段时间没有共同消费，可调整日期或录入开销。</p><ul class="balance-list"><li v-for="item in report.categories" :key="item.category"><span>{{ categoryNames[item.category] }}</span><strong>¥{{ money(item.amountFen) }}</strong></li></ul></section><section class="panel"><h2>垫付与承担，分别查看</h2><ul class="report-members"><li v-for="member in report.members" :key="member.memberId"><strong>{{ name(member.memberId) }}{{ members.find(x=>x.id===member.memberId)?.status==='LEFT'?'（已退出）':'' }}</strong><span>垫付 ¥{{ money(member.paidFen) }}</span><span>承担 ¥{{ money(member.shareFen) }}</span></li></ul><p class="muted small">垫付是实际先付的钱，承担是消费分摊；两者都不等于当前净余额。</p></section></div>
  <section class="panel"><div class="section-title"><div><p class="eyebrow">{{ periodLabel }}</p><h2>成员期间消费排行</h2></div><span class="status-pill">按承担金额</span></div><ol class="consumption-ranking"><li v-for="item in report.ranking" :key="item.memberId"><span class="rank-number">{{ item.rankNo }}</span><span>{{ name(item.memberId) }}<span v-if="members.find(x=>x.id===item.memberId)?.status==='LEFT'" class="muted small"> · 已退出</span></span><strong>¥{{ money(item.amountFen) }}</strong></li></ol><p class="muted small">相同承担金额保留并列名次，零消费和历史成员一并显示。</p></section>
  </template>
</template>
