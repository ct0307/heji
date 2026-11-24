<script setup lang="ts">
import { ref } from 'vue';
import { saveAppearance,type Appearance } from '../appearance.ts';

const dialog=ref<HTMLDialogElement|null>(null),trigger=ref<HTMLButtonElement|null>(null);
const selected=ref<Appearance>(document.documentElement.dataset.interface==='b'?'b':'a'),notice=ref('');
function open(){notice.value='';selected.value=document.documentElement.dataset.interface==='b'?'b':'a';dialog.value?.showModal()}
function close(){dialog.value?.close()}
function restoreFocus(){trigger.value?.focus({preventScroll:true})}
function choose(value:Appearance){
  selected.value=value;
  document.documentElement.dataset.interface=value;
  let saved=false;
  try{saved=saveAppearance(value,window.localStorage)}catch{/* 浏览器禁止访问存储时，本次界面仍可切换。 */}
  notice.value=saved?'已保存界面选择。':'本次已切换，当前浏览器无法保存界面选择，刷新后可能恢复默认。';
}
function backdrop(event:MouseEvent){
  if(event.target!==dialog.value||!dialog.value)return;
  const bounds=dialog.value.getBoundingClientRect();
  if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)close();
}
</script>
<template>
  <button ref="trigger" type="button" class="appearance-trigger" aria-haspopup="dialog" @click="open"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 4v16M8 9h13"/></svg><span>界面设置</span></button>
  <dialog ref="dialog" class="appearance-dialog" aria-labelledby="appearance-title" @close="restoreFocus" @click="backdrop">
    <div class="appearance-heading"><div><p class="eyebrow">按你的习惯记账</p><h2 id="appearance-title">界面设置</h2></div><button type="button" class="appearance-close" aria-label="关闭界面设置" @click="close">×</button></div>
    <p class="appearance-intro">选一种喜欢的界面，当前账目和已填写内容会保留。</p>
    <fieldset class="appearance-options"><legend class="sr-only">选择界面</legend>
      <label class="appearance-option" :class="{selected:selected==='a'}">
        <input type="radio" name="appearance" value="a" :checked="selected==='a'" @change="choose('a')">
        <span class="appearance-preview preview-a" aria-hidden="true"><span class="preview-navigation"><i></i><i></i></span><span class="preview-page"><i class="preview-title"></i><i class="preview-balance"></i><i class="preview-row"></i><i class="preview-row"></i></span></span>
        <span class="appearance-option-copy"><span class="appearance-option-title"><strong>A 雾青工作台</strong><span class="appearance-default">默认</span></span><span>侧栏导航 · 收付一目了然</span></span>
      </label>
      <label class="appearance-option" :class="{selected:selected==='b'}">
        <input type="radio" name="appearance" value="b" :checked="selected==='b'" @change="choose('b')">
        <span class="appearance-preview preview-b" aria-hidden="true"><span class="preview-navigation"><i></i><i></i></span><span class="preview-page"><i class="preview-title"></i><i class="preview-row"></i><i class="preview-row"></i></span><span class="preview-aside"><i></i><i></i></span></span>
        <span class="appearance-option-copy"><span class="appearance-option-title"><strong>B 墨蓝账页</strong></span><span>账页布局 · 专注每笔明细</span></span>
      </label>
    </fieldset>
    <p class="appearance-note">选择会保存在当前浏览器，下次打开时继续使用。</p><p v-if="notice" class="appearance-notice" role="status">{{ notice }}</p>
    <div class="appearance-actions"><button type="button" class="primary" @click="close">完成</button></div>
  </dialog>
</template>
<style scoped>
.appearance-trigger{display:inline-flex;align-items:center;gap:10px;min-height:44px;padding:10px 12px;background:transparent;color:var(--muted);font-size:14px;border:1px solid transparent;text-align:left;white-space:nowrap}
.appearance-trigger:hover{background:var(--accent-soft);color:var(--accent)}
.appearance-trigger svg{width:19px;height:19px;flex:none}
.appearance-dialog{width:min(640px,calc(100% - 32px));max-height:calc(100dvh - 32px);overflow-y:auto;padding:32px;border:1px solid var(--line);border-radius:16px;background:var(--surface);color:var(--ink);box-shadow:0 24px 100px #172a2529}
.appearance-dialog::backdrop{background:#17252c66;backdrop-filter:blur(3px)}
.appearance-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}
.appearance-heading h2{font-size:26px;line-height:1.4;font-weight:600;letter-spacing:-.025em}
.appearance-heading .eyebrow{font-size:12px;margin-bottom:6px;color:var(--muted)}
.appearance-close{display:grid;place-items:center;width:44px;height:44px;flex:none;padding:0;border:1px solid var(--line);border-radius:50%;background:var(--surface);color:var(--muted);font-size:25px}
.appearance-close:hover{color:var(--ink);background:var(--page)}
.appearance-intro{font-size:14px;line-height:1.8;color:var(--muted);margin:16px 0 24px}
.appearance-options{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:0;padding:0;border:0}
.appearance-option{position:relative;display:flex;flex-direction:column;gap:16px;align-items:stretch;padding:14px;min-width:0;border:1px solid var(--line);border-radius:10px;cursor:pointer;background:var(--surface)}
.appearance-option:hover{border-color:var(--field-border)}
.appearance-option.selected{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.appearance-option input{position:absolute;right:23px;top:23px;z-index:1;width:18px;height:18px;min-height:18px;margin:0;padding:0;accent-color:var(--accent)}
.appearance-option:has(input:focus-visible){outline:3px solid var(--accent);outline-offset:4px}
.appearance-option-copy{display:grid;gap:7px;min-width:0}
.appearance-option-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.appearance-option-copy strong{font-family:inherit;font-size:15px;font-weight:600;line-height:1.6;color:var(--ink)}
.appearance-option-copy>span:last-child{color:var(--muted);font-size:13px;line-height:1.7}
.appearance-default{font-size:12px;display:inline-block;padding:0 6px;border-radius:4px;background:var(--accent-soft);color:var(--accent);font-weight:400}
/* 只示意真实布局，不展示虚构的金额或统计。 */
.appearance-preview{height:116px;display:grid;overflow:hidden;border:1px solid #e0e6e1;border-radius:5px;pointer-events:none}
.appearance-preview i{display:block;border-radius:1px}
.preview-a{grid-template-columns:22% 1fr;background:#f3f6f3}
.preview-navigation{padding:12px 8px;display:flex;flex-direction:column;gap:12px}
.preview-a .preview-navigation{background:#e5ede6;border-right:1px solid #dae4dc}
.preview-navigation i:first-child{width:12px;height:12px;background:#284e40;border-radius:4px}
.preview-navigation i:last-child{height:5px;background:#c0d2c4}
.preview-page{display:flex;flex-direction:column;gap:9px;padding:16px 12px;min-width:0}
.preview-title{height:5px;width:43%;background:#91a49a}
.preview-balance{height:27px;background:#284e40}
.preview-row{height:8px;background:white;border-bottom:1px solid #dfe6e0}
.preview-b{grid-template-columns:1fr 30%;grid-template-rows:25px 1fr;gap:0 8px;padding:0 10px 10px;background:#f3f5f7;border-color:#dfe4ea}
.preview-b .preview-navigation{grid-column:1/-1;padding:8px 0;flex-direction:row;gap:8px;border-bottom:1px solid #dfe4ea}
.preview-b .preview-navigation i:first-child{width:9px;height:9px;border-radius:3px;background:#40566e}
.preview-b .preview-navigation i:last-child{width:30px;height:3px;margin-top:3px;background:#9ba8b6}
.preview-b .preview-page{padding:13px 0 0;gap:12px}
.preview-b .preview-title{background:#8191a3}
.preview-b .preview-row{border-bottom-color:#dde4eb}
.preview-aside{margin-top:12px;padding:10px 6px;background:white;border-top:2px solid #40566e;display:flex;flex-direction:column;gap:13px}
.preview-aside i{height:4px;background:#9ba8b6}
.preview-aside i:first-child{width:75%;height:9px;background:#40566e}
.appearance-note{color:var(--muted);font-size:12px;line-height:1.8;margin-top:20px}
.appearance-notice{font-size:13px;line-height:1.8;color:var(--ink);background:var(--accent-soft);padding:11px 13px;border-radius:7px;margin-top:14px;overflow-wrap:anywhere}
.appearance-actions{display:flex;justify-content:flex-end;margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}
.appearance-actions .primary{min-width:104px;min-height:44px}
@media(max-width:500px){
  .appearance-dialog{padding:24px 20px}
  .appearance-options{grid-template-columns:1fr;gap:12px}
  .appearance-option{display:grid;grid-template-columns:86px minmax(0,1fr);gap:14px;padding:14px;align-items:center}
  .appearance-preview{height:78px}
  .appearance-option input{right:13px;top:14px;width:16px;height:16px;min-height:16px}
  .appearance-option-title{padding-right:13px;gap:4px}
  .appearance-option-copy{gap:5px}
  .appearance-option-copy strong{font-size:14px}
  .appearance-option-copy>span:last-child{font-size:12px}
  .preview-navigation{padding:8px 3px;gap:9px}
  .preview-navigation i:first-child{width:8px;height:8px;border-radius:2px}
  .preview-page{padding:11px 5px;gap:7px}
  .preview-title{height:3px}
  .preview-balance{height:16px}
  .preview-row{height:5px}
  .preview-b{padding:0 5px 5px;grid-template-rows:18px 1fr;gap:0 4px}
  .preview-b .preview-navigation{padding:5px 0;gap:5px}
  .preview-b .preview-navigation i:first-child{width:7px;height:7px}
  .preview-b .preview-navigation i:last-child{width:22px;height:2px}
  .preview-b .preview-page{padding:9px 0 0;gap:9px}
  .preview-aside{padding:7px 3px;margin-top:8px;gap:9px}
  .preview-aside i:first-child{height:6px}
  .appearance-heading h2{font-size:23px}
  .appearance-intro{margin:14px 0 20px}
}
@media(max-width:360px){
  .appearance-option{grid-template-columns:70px minmax(0,1fr);gap:10px;padding:12px}
  .appearance-option input{right:11px;top:12px}
}
</style>
