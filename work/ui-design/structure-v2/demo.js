(() => {
  'use strict';
  const members=[{key:'ning',name:'阿宁 · 你'},{key:'yue',name:'林悦'},{key:'yu',name:'周屿'}];
  const expenses={stay:{title:'民宿两晚',amount:126000n,payer:'阿宁',recorder:'阿宁',date:'2026年11月8日',method:'三人均分',shares:[42000n,42000n,42000n]},dinner:{title:'周六晚餐',amount:36800n,payer:'林悦',recorder:'阿宁',date:'2026年11月8日',method:'指定金额',shares:[12800n,12000n,12000n]},taxi:{title:'夜间打车',amount:9600n,payer:'周屿',recorder:'周屿',date:'2026年11月9日',method:'三人均分',shares:[3200n,3200n,3200n]}};
  let transferConfirmed=false;
  let toastTimeout;
  const dialog=document.createElement('dialog');
  dialog.className='demo-dialog';
  dialog.setAttribute('aria-labelledby','demo-title');
  document.body.append(dialog);
  const toast=document.createElement('div');
  toast.className='demo-toast';toast.hidden=true;toast.setAttribute('role','status');
  document.body.append(toast);
  function decimal(fen){const abs=fen<0n?-fen:fen;return(fen<0n?'-':'')+(abs/100n).toString()+'.'+(abs%100n).toString().padStart(2,'0')}
  function money(fen){const [whole,fraction]=decimal(fen).split('.');return '¥'+whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+fraction}
  function parseMoney(text,allowZero=false){if(!/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text))throw new Error('请输入最多两位小数的金额，例如 100.01。');const [whole,fraction='']=text.split('.');const fen=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));if(fen<(allowZero?0n:1n)||fen>100000000n)throw new Error(allowZero?'分摊金额需在 0 至 1,000,000.00 元之间。':'金额需在 0.01 至 1,000,000.00 元之间。');return fen}
  function showToast(message){clearTimeout(toastTimeout);toast.textContent=message;toast.hidden=false;toastTimeout=setTimeout(()=>{toast.hidden=true},4000)}
  function openDialog(title,body){if(dialog.open)dialog.close();dialog.innerHTML=`<div class="demo-head"><h2 id="demo-title">${title}</h2><button type="button" class="demo-close" data-close-demo>关闭</button></div><div class="demo-body">${body}</div>`;dialog.showModal()}
  function showExpense(key){const expense=expenses[key];if(!expense)return;openDialog(expense.title,`<p class="demo-note">共同开销 · 详情预览</p><strong class="demo-large">${money(expense.amount)}</strong><dl class="demo-meta"><dt>发生日期</dt><dd>${expense.date}</dd><dt>实际付款人</dt><dd>${expense.payer}</dd><dt>录入人</dt><dd>${expense.recorder}</dd><dt>分摊方式</dt><dd>${expense.method}</dd></dl><p class="demo-note">付款人是实际垫付的人，录入人是提交这条记录的人。</p><div class="demo-members">${members.map((member,index)=>`<p><span>${member.name}</span><strong class="demo-money">${money(expense.shares[index])}</strong></p>`).join('')}</div>`)}
  function showEntry(){
    openDialog('记一笔',`<p class="demo-note">输入仅用于分摊预览，本草图不保存账目。</p><form id="demo-entry"><label class="demo-field" for="demo-expense-name">开销名称</label><input class="demo-input" id="demo-expense-name" maxlength="40" placeholder="例如：周日早餐"><label class="demo-field" for="demo-amount">金额（元）</label><input class="demo-input demo-money" id="demo-amount" inputmode="decimal" value="100.01" autocomplete="off"><div class="demo-methods" role="group" aria-label="分摊方式"><label><input type="radio" name="demo-method" value="equal" checked>均分</label><label><input type="radio" name="demo-method" value="custom">指定金额</label></div><p class="demo-note">参与分摊的人</p>${members.map(member=>`<div class="demo-share"><label><input type="checkbox" data-member-check="${member.key}" checked>${member.name}</label><span class="demo-money" data-preview-share="${member.key}"></span><input hidden inputmode="decimal" data-share-input="${member.key}" aria-label="${member.name}分摊金额（元）"></div>`).join('')}<p class="demo-result" id="demo-entry-result" role="status"></p><div class="demo-actions"><button class="demo-primary" type="submit">核对分摊</button></div></form>`);
    const form=dialog.querySelector('form');
    const result=dialog.querySelector('#demo-entry-result');
    function update(){const custom=form.elements['demo-method'].value==='custom';const selected=members.filter(member=>dialog.querySelector(`[data-member-check="${member.key}"]`).checked);for(const member of members){const selectedMember=selected.includes(member);const input=dialog.querySelector(`[data-share-input="${member.key}"]`);input.hidden=!custom;input.disabled=!selectedMember;dialog.querySelector(`[data-preview-share="${member.key}"]`).hidden=custom}try{const total=parseMoney(dialog.querySelector('#demo-amount').value);if(!selected.length)throw new Error('请至少选择一位分摊成员。');const count=BigInt(selected.length);let sum=0n;for(const member of members){const position=selected.indexOf(member);const active=position!==-1;const even=active?total/count+(BigInt(position)<total%count?1n:0n):0n;const input=dialog.querySelector(`[data-share-input="${member.key}"]`);if(!custom)input.value=decimal(even);const share=custom?(active?parseMoney(input.value,true):0n):even;sum+=share;dialog.querySelector(`[data-preview-share="${member.key}"]`).textContent=active?money(share):'不参与'}if(sum!==total)throw new Error(`已分摊 ${money(sum)}，需与总额 ${money(total)} 一致。`);result.textContent=`${selected.length} 人承担合计 ${money(total)}，金额一致。`;result.classList.remove('error');return true}catch(error){result.textContent=error.message;result.classList.add('error');return false}}
    form.addEventListener('input',update);form.addEventListener('change',update);form.addEventListener('submit',event=>{event.preventDefault();if(update())result.textContent='分摊金额已核对。此处为交互预览，未保存账目。'});update();
  }
  function showTransfer(){
    if(transferConfirmed){openDialog('转账已模拟确认','<p>林悦向阿宁转账 ¥204.00 的示例已确认。</p><p class="demo-note" style="margin-top:12px">阿宁当前应收 ¥476.00；本次操作仅改变草图中的演示状态。</p>');return}
    openDialog('核对这笔转账',`<p class="demo-note">林悦登记向你转账</p><strong class="demo-large">¥204.00</strong><p>请核对线下实际收到的金额。</p><p class="demo-note">待确认登记尚未抵减余额。</p><table class="demo-preview"><thead><tr><th>成员</th><th>当前净额</th><th>确认后净额</th></tr></thead><tbody><tr><td>阿宁 · 你</td><td>+680.00</td><td>+476.00</td></tr><tr><td>林悦</td><td>−204.00</td><td>0.00</td></tr><tr><td>周屿</td><td>−476.00</td><td>−476.00</td></tr></tbody></table><p class="demo-note">以下为模拟确认，不涉及实际支付或真实账目。</p><label class="demo-check"><input type="checkbox" id="demo-received">我已核对收到林悦的 204.00 元（模拟）</label><div class="demo-actions"><button type="button" class="demo-primary" id="demo-confirm" disabled>模拟确认收款</button></div>`);
    const confirmButton=dialog.querySelector('#demo-confirm');
    dialog.querySelector('#demo-received').addEventListener('change',event=>{confirmButton.disabled=!event.target.checked});
    confirmButton.addEventListener('click',()=>{
      if(confirmButton.disabled||transferConfirmed)return;
      transferConfirmed=true;
      for(const element of document.querySelectorAll('[data-my-balance]'))element.textContent='¥476.00';
      const values={ning:'+476.00',yue:'0.00',yu:'−476.00'};
      for(const element of document.querySelectorAll('[data-balance]'))element.textContent=values[element.dataset.balance];
      for(const element of document.querySelectorAll('[data-transfer-in="ning"],[data-transfer-out="yue"]'))element.textContent='204.00';
      for(const element of document.querySelectorAll('[data-pending-state]'))element.textContent='已确认';
      for(const element of document.querySelectorAll('[data-pending-count]'))element.textContent='0';
      for(const element of document.querySelectorAll('[data-pending-copy]'))element.textContent='已模拟确认，当前应收已抵减 204.00 元。';
      for(const element of document.querySelectorAll('[data-pending-action]')){element.disabled=true;element.textContent='已模拟确认'}
      dialog.close();
      showToast('已模拟确认：你的当前应收为 ¥476.00。');
    });
  }
  document.addEventListener('click',event=>{const close=event.target.closest('[data-close-demo]');if(close){dialog.close();return}const action=event.target.closest('[data-open]');if(action){if(action.dataset.open==='entry')showEntry();else if(action.dataset.open==='transfer')showTransfer();return}const expense=event.target.closest('[data-expense]');if(expense)showExpense(expense.dataset.expense)});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)dialog.close()}});
})();
