import { createRouter, createWebHistory } from 'vue-router';
import { initializeSession, session } from './api.ts';
import { rememberInvitation } from './pending-invitation.ts';
import AuthView from './views/AuthView.vue';
import BooksView from './views/BooksView.vue';
import BookView from './views/BookView.vue';
import JoinView from './views/JoinView.vue';
import SplitPreview from './views/SplitPreview.vue';

export const router=createRouter({history:createWebHistory(),routes:[
  {path:'/',redirect:'/books'},
  {path:'/login',component:AuthView},
  {path:'/register',component:AuthView},
  {path:'/books',component:BooksView,meta:{auth:true}},
  {path:'/books/:bookId',component:BookView,meta:{auth:true}},
  {path:'/join',component:JoinView},
  {path:'/dev/split',component:SplitPreview},
  {path:'/:pathMatch(.*)*',redirect:'/books'},
]});
router.beforeEach(async to=>{
  if(to.path==='/join'&&to.hash){
    const token=to.hash.slice(1);
    if(/^[A-Za-z0-9_-]{43}$/.test(token))rememberInvitation(token);
    return {path:'/join',replace:true};
  }
  await initializeSession();
  if(to.meta.auth&&!session.user)return '/login';
  if((to.path==='/login'||to.path==='/register')&&session.user)return sessionStorage.getItem('heji.pendingInvitation')?'/join':'/books';
});
