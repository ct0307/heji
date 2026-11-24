import { ref } from 'vue';

/** 同一路径的新邀请也需通知已挂载页面；链接明文仍仅留在会话存储。 */
export const pendingInvitationVersion=ref(0);
export function rememberInvitation(token:string){
  sessionStorage.setItem('heji.pendingInvitation',token);
  pendingInvitationVersion.value++;
}
