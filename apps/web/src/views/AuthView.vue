<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { authenticate, retrySession, session } from '../api.ts';
const route=useRoute(),router=useRouter();
const registering=computed(()=>route.path==='/register');
const email=ref(''),password=ref(''),displayName=ref(''),busy=ref(false),error=ref('');
async function submit(){
  if(busy.value)return;busy.value=true;error.value='';
  try {await authenticate({email:email.value,password:password.value,...(registering.value?{displayName:displayName.value}:{})},registering.value);await router.replace(sessionStorage.getItem('heji.pendingInvitation')?'/join':'/books')}
  catch(cause){error.value=cause instanceof Error?cause.message:'暂时无法登录'}finally{password.value='';busy.value=false}
}
</script>
<template>
  <section class="auth-layout">
    <div class="auth-intro"><p class="eyebrow">一起花的钱，一起记清楚</p><h1>每笔共同开销，<br>都有清楚的来处。</h1><p>与朋友共享一本账。记下谁垫付、各自承担多少，让收付有据可查。</p><div class="principle"><strong>垫付 · 分摊 · 确认</strong><span>三件事，分别记清楚。</span></div></div>
    <div class="panel auth-panel">
      <h2>{{ registering?'创建你的账号':'欢迎回来' }}</h2><p class="muted">{{ registering?'每个人使用独立账号，共同维护账本。':'登录后查看你的共享账本。' }}</p>
      <div v-if="session.issue" class="notice" role="alert"><p>{{ session.issue }}</p><button type="button" class="text-button" @click="retrySession">重试连接</button></div>
      <form @submit.prevent="submit">
        <label v-if="registering">昵称<input v-model="displayName" autocomplete="nickname" maxlength="40" required></label>
        <label>邮箱<input v-model="email" type="email" autocomplete="username" maxlength="254" required></label>
        <label>密码<input v-model="password" type="password" :autocomplete="registering?'new-password':'current-password'" :minlength="registering?10:1" maxlength="128" required></label>
        <p v-if="registering" class="muted small">密码至少10个字符，建议使用独立的长密码。</p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button class="primary full" :disabled="busy">{{ busy?'正在处理…':registering?'注册并登录':'登录' }}</button>
      </form>
      <p class="auth-switch">{{ registering?'已经有账号？':'还没有账号？' }}<RouterLink :to="registering?'/login':'/register'">{{ registering?'去登录':'创建账号' }}</RouterLink></p>
    </div>
  </section>
</template>
