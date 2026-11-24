<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { session,logout } from './api.ts';
import AppearanceSettings from './components/AppearanceSettings.vue';
import BrandMark from './components/BrandMark.vue';
const router=useRouter(),error=ref(''),busy=ref(false);
async function signOut(){if(busy.value)return;busy.value=true;error.value='';try{await logout();await router.replace('/login')}catch(cause){error.value=cause instanceof Error?cause.message:'无法退出，请重试'}finally{busy.value=false}}
</script>
<template>
  <a class="skip-link" href="#content">跳到主要内容</a>
  <div :class="session.user?'app-shell':'public-shell'">
    <aside v-if="session.user" class="sidebar">
      <RouterLink class="brand" to="/books"><BrandMark /><span>合记</span></RouterLink>
      <p class="brand-note">共同开销，清楚记下</p>
      <nav aria-label="主要导航"><RouterLink to="/books"><svg class="nav-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 3v18M11 8h5M11 12h5"/></svg><span>我的账本</span></RouterLink></nav>
      <div class="sidebar-tools"><AppearanceSettings /><div class="account"><span class="account-avatar" aria-hidden="true">{{ session.user.displayName.slice(0,1) }}</span><strong>{{ session.user.displayName }}</strong><button class="text-button" :disabled="busy" @click="signOut">退出登录</button></div></div>
    </aside>
    <header v-else class="public-header"><RouterLink class="brand" to="/"><BrandMark /><span>合记</span></RouterLink><span class="muted small public-tagline">共同开销，清楚记下</span><AppearanceSettings /></header>
    <main id="content" tabindex="-1"><p v-if="error" class="error" role="alert">{{ error }}</p><RouterView /></main>
  </div>
</template>
