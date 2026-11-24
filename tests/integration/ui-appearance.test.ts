import test from 'node:test';
import assert from 'node:assert/strict';
import { APPEARANCE_STORAGE_KEY,loadAppearance,saveAppearance,type AppearanceStorage } from '../../apps/web/src/appearance.ts';

function memory(value:string|null=null):AppearanceStorage{
  return {getItem:()=>value,setItem:(key,next)=>{assert.equal(key,APPEARANCE_STORAGE_KEY);value=next}};
}
test('没有界面偏好时默认A，非法或旧偏好也回退A',()=>{
  for(const value of [null,'','dark','A','invalid'])assert.equal(loadAppearance(memory(value)),'a');
  assert.equal(loadAppearance(),'a');
});
test('选择B后重新读取恢复B，也能切回A',()=>{
  const storage=memory();
  assert.equal(saveAppearance('b',storage),true);
  assert.equal(loadAppearance(storage),'b');
  assert.equal(saveAppearance('a',storage),true);
  assert.equal(loadAppearance(storage),'a');
});
test('浏览器禁止读取偏好时仍可使用默认界面',()=>{
  const storage:AppearanceStorage={getItem(){throw new Error('不可读取')},setItem(){}};
  assert.equal(loadAppearance(storage),'a');
});
test('无法保存时返回失败供界面提示，不能让切换抛出异常',()=>{
  const storage:AppearanceStorage={getItem:()=>null,setItem(){throw new Error('不可保存')}};
  assert.equal(saveAppearance('b',storage),false);
  assert.equal(saveAppearance('b'),false);
});
