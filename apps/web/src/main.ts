import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router.ts';
import { loadAppearance } from './appearance.ts';
import './m1.css';
import './m2.css';
import './m3.css';
import './appearance.css';
try{document.documentElement.dataset.interface=loadAppearance(window.localStorage)}
catch{document.documentElement.dataset.interface='a'}
createApp(App).use(router).mount('#app');
