const selection={concept:'a',page:'overview',state:'normal',device:'desktop'};
const frame=document.querySelector('#concept-frame');
function update(){
  const title=selection.concept==='a'?'A · 雾青工作台':'B · 蓝墨账页';
  const url=selection.concept+'.html?'+new URLSearchParams({page:selection.page,state:selection.state});
  if(frame.getAttribute('src')!==url)frame.src=url;
  frame.title=title+'交互预览';
  document.querySelector('#preview-title').textContent=title;
  document.querySelector('#open-page').href=url;
  document.querySelector('.frame-surround').classList.toggle('mobile',selection.device==='mobile');
  for(const kind of ['concept','page','device'])document.querySelectorAll('[data-'+kind+']').forEach(button=>{
    const active=button.dataset[kind]===selection[kind];button.classList.toggle(kind==='concept'?'selected':'active',active);button.setAttribute('aria-pressed',String(active));
  });
}
document.querySelectorAll('[data-concept],[data-page],[data-device]').forEach(button=>button.addEventListener('click',()=>{
  for(const kind of ['concept','page','device'])if(button.dataset[kind])selection[kind]=button.dataset[kind];update();
  if(button.dataset.concept)document.querySelector('#preview').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
}));
document.querySelector('#state').addEventListener('change',event=>{selection.state=event.target.value;update()});
