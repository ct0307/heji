<script setup lang="ts">
import { computed,ref } from 'vue';
import { parseYuan,splitEqual,formatYuan } from '../../../../packages/domain/src/ledger.ts';
const amount=ref('100.01'),count=ref(3);
const preview=computed(()=>{try{return {shares:splitEqual(parseYuan(amount.value),Array.from({length:count.value},(_,i)=>String(i).padStart(2,'0'))),error:''}}catch(error){return {shares:[],error:error instanceof Error?error.message:'无法计算'}}});
</script>
<template><section class="panel split-panel"><h1>分摊规则验证</h1><p class="muted">此页不保存账目。</p><div class="fields"><label>金额（元）<input v-model="amount" inputmode="decimal" maxlength="16"></label><label>人数<select v-model.number="count"><option v-for="n in 30" :key="n" :value="n">{{ n }}</option></select></label></div><p v-if="preview.error" class="error" role="alert">{{ preview.error }}</p><ul v-else class="member-list"><li v-for="(share,index) in preview.shares" :key="share.memberId"><span>成员 {{ index+1 }}</span><strong>¥{{ formatYuan(share.amountFen) }}</strong></li></ul></section></template>
