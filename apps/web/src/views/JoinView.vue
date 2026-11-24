<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, session, ClientFault } from '../api.ts';
import { pendingInvitationVersion } from '../pending-invitation.ts';
import type { InvitationPreviewDto, BookDto } from '../../../../packages/contracts/src/index.ts';
const router=useRouter(),preview=ref<InvitationPreviewDto|null>(null),loading=ref(true),busy=ref(false),error=ref('');
let token='',loadNumber=0;
async function load(){
  const current=++loadNumber,currentToken=sessionStorage.getItem('heji.pendingInvitation')??'';
  loading.value=true;busy.value=false;error.value='';preview.value=null;token=currentToken;
  if(!currentToken){error.value='没有可用的邀请，请重新打开朋友发来的链接';loading.value=false;return}
  try{
    const next=await api<InvitationPreviewDto>('/invitations/preview','POST',{token:currentToken});
    if(current===loadNumber)preview.value=next;
  }catch(cause){
    if(current!==loadNumber)return;
    error.value=cause instanceof Error?cause.message:'无法加载邀请';
    if(cause instanceof ClientFault&&[404,409,410].includes(cause.status))sessionStorage.removeItem('heji.pendingInvitation');
  }finally{if(current===loadNumber)loading.value=false}
}
async function accept(){if(busy.value)return;const current=loadNumber;busy.value=true;error.value='';try{const book=await api<BookDto>('/invitations/accept','POST',{token});if(current!==loadNumber)return;sessionStorage.removeItem('heji.pendingInvitation');token='';await router.replace('/books/'+book.id)}catch(cause){if(current===loadNumber)error.value=cause instanceof Error?cause.message:'无法加入账本'}finally{if(current===loadNumber)busy.value=false}}
async function cancel(){sessionStorage.removeItem('heji.pendingInvitation');token='';await router.replace(session.user?'/books':'/login')}
watch(pendingInvitationVersion,()=>{void load()},{immediate:true,flush:'sync'});
onBeforeUnmount(()=>{loadNumber++});
</script>
<template>
  <section class="panel join-panel"><p class="eyebrow">共享账本邀请</p><h1>{{ preview?.bookName??'加入朋友的账本' }}</h1><p v-if="loading" role="status">正在核对邀请…</p><p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-if="preview&&!error"><p class="muted">{{ preview.alreadyJoined?'你已经是账本成员，可以直接进入。':'加入后，你可以与成员共同查看和记录开销。' }}</p><p v-if="preview.rejoining" class="notice">你曾加入过此账本。重新加入后，历史修正可能再次产生余额，历史身份会保留。</p><p class="small muted">查看邀请不会消费链接，需要明确确认加入。</p><button v-if="session.user" class="primary" :disabled="busy" @click="accept">{{ busy?'正在加入…':preview.alreadyJoined?'进入账本':'确认加入账本' }}</button><RouterLink v-else class="primary button-link" to="/login">登录后确认加入</RouterLink></template>
    <div class="actions"><button v-if="error" class="secondary" @click="load">重试</button><button class="text-button" :disabled="busy" @click="cancel">取消</button></div>
  </section>
</template>
