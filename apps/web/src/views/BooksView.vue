<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.ts';
import type { BookDto } from '../../../../packages/contracts/src/index.ts';
const router=useRouter(),books=ref<BookDto[]>([]),loading=ref(true),busy=ref(false),error=ref(''),name=ref('');
async function load(){loading.value=true;error.value='';try{books.value=await api<BookDto[]>('/books')}catch(cause){error.value=cause instanceof Error?cause.message:'无法加载账本'}finally{loading.value=false}}
async function create(){if(busy.value)return;busy.value=true;error.value='';try{const book=await api<BookDto>('/books','POST',{name:name.value});await router.push('/books/'+book.id)}catch(cause){error.value=cause instanceof Error?cause.message:'无法创建账本'}finally{busy.value=false}}
onMounted(load);
</script>
<template>
  <header class="page-heading"><div><p class="eyebrow">共同记账</p><h1>我的账本</h1><p class="muted">聚餐、旅行、合租，各有一本清楚的账。</p></div></header>
  <p v-if="error" class="error" role="alert">{{ error }} <button class="text-button" @click="load">重新加载</button></p>
  <p v-if="loading" role="status">正在加载账本…</p>
  <template v-else>
    <div v-if="books.length" class="book-grid"><RouterLink v-for="book in books" :key="book.id" class="panel book-card" :to="'/books/'+book.id"><span class="book-initial">{{ book.name.slice(0,1) }}</span><h2>{{ book.name }}</h2><p class="muted">{{ book.isArchived?'已归档':'共享账本' }}</p><span class="text-button">进入账本 →</span></RouterLink></div>
    <section v-else-if="!error" class="panel empty"><h2>一起记下第一笔共同开销</h2><p class="muted">先创建账本，再邀请朋友加入。收到邀请时，直接打开邀请链接。</p></section>
    <section class="panel create-book"><h2>创建新账本</h2><form class="inline-form" @submit.prevent="create"><label>账本名称<input v-model="name" maxlength="80" placeholder="例如：杭州周末、合租日常" required></label><button class="primary" :disabled="busy">{{ busy?'创建中…':'创建账本' }}</button></form></section>
  </template>
</template>
