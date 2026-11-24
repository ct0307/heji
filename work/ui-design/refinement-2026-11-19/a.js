/* 独立交互预览：仅在内存中展示示例，不连接服务或保存数据。 */
(() => {
  'use strict';

  const paths = {
    brand: '<path d="M5 8.5 12 4l7 4.5M7 10h10v9H7zM10 14h4"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
    settlement: '<path d="M5 7h14l-3-3M19 17H5l3 3M19 7l-3 3M5 17l3-3"/>',
    book: '<path d="M6 4h12v16H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM7 4v16M11 8h4M11 12h4"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    down: '<path d="m7 10 5 5 5-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M4 12h16m-5-5 5 5-5 5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.5"/>',
    home: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>',
    meal: '<path d="M5 3v6c0 3 5 3 5 0V3M7.5 3v18M19 21V3c-5 3-5 10 0 10"/>',
    taxi: '<path d="m5 10 2-5h10l2 5M3 10h18v8H3zM5 18v3M19 18v3M6 14h1M17 14h1M10 5V3h4v2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    retry: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/>',
    cloud: '<path d="M7 17H6a4 4 0 0 1-.5-8A7 7 0 0 1 18 7a5 5 0 0 1 1 10h-2M12 12v5M12 20v.2"/>',
  };
  const icon = (name, size = 18) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.info}</svg>`;
  const avatar = (person, extra = '') => `<span class="avatar avatar-${person} ${extra}" aria-hidden="true">${{ an: '宁', lin: '悦', zhou: '然' }[person]}</span>`;
  const params = new URLSearchParams(location.search);
  let page = params.get('page') === 'settlement' ? 'settlement' : 'overview';
  let viewState = ['empty', 'error'].includes(params.get('state')) ? params.get('state') : 'normal';
  let confirmed = false;
  let expenseFilter = 'all';
  let toastTimer;
  const app = document.querySelector('#app');
  const expenseDialog = document.querySelector('#expense-dialog');
  const reviewDialog = document.querySelector('#review-dialog');
  const currentBalance = () => confirmed ? '476' : '680';
  const pageUrl = (nextPage) => {
    const next = new URLSearchParams(location.search);
    next.set('page', nextPage);
    next.set('state', viewState);
    return `${location.pathname}?${next}`;
  };

  const sidebar = () => `<aside class="sidebar" aria-label="账本导航">
    <a href="${pageUrl('overview')}" class="brand" data-page="overview" aria-label="合记，返回账本总览"><span class="brand-mark">${icon('brand', 26)}</span><span><span class="brand-word">合记</span><span class="brand-note">把生活，记在一起</span></span></a>
    <div class="book-switch"><span class="book-symbol">${icon('book', 18)}</span><div><strong>杭州周末</strong><small>共享账本 · 3 位成员</small></div></div>
    <div class="nav-label">这本账</div>
    <nav class="main-nav"><a class="nav-item ${page === 'overview' ? 'active' : ''}" href="${pageUrl('overview')}" data-page="overview" ${page === 'overview' ? 'aria-current="page"' : ''}>${icon('grid')}<span>账本总览</span></a><a class="nav-item ${page === 'settlement' ? 'active' : ''}" href="${pageUrl('settlement')}" data-page="settlement" ${page === 'settlement' ? 'aria-current="page"' : ''}>${icon('settlement')}<span>结算核对</span>${!confirmed && viewState === 'normal' ? '<span class="nav-badge" aria-label="1 笔待核对">1</span>' : ''}</a></nav>
    <div class="side-members"><div class="side-members-title"><span>一起记账的人</span><span>3</span></div><div class="side-person">${avatar('an')}<span>阿宁</span><span class="person-role">我 · 创建者</span></div><div class="side-person">${avatar('lin')}<span>林悦</span><span class="person-role">成员</span></div><div class="side-person">${avatar('zhou')}<span>周然</span><span class="person-role">成员</span></div></div>
    <div class="side-bottom"><p class="sidebar-motto">每一笔清楚，<br />每一次相聚轻松。</p><div class="profile">${avatar('an')}<div><strong>阿宁</strong><small>当前记账身份</small></div><span class="profile-tag">个人</span></div></div>
  </aside>`;

  const heading = () => `<div class="topbar"><div class="breadcrumb"><span>我的账本</span>${icon('chevron', 11)}<span>杭州周末</span></div><div class="collaboration"><div class="avatar-stack">${avatar('an')}${avatar('lin')}${avatar('zhou')}</div><span>3 位成员共同记账</span></div></div>
    <header class="page-heading"><div><div class="heading-kicker"><i class="dot"></i>和朋友的第 2 天</div><h1>${page === 'overview' ? '杭州周末' : '结算核对'}</h1><p class="heading-meta">${page === 'overview' ? '11 月 14 日 — 11 月 15 日<span class="separator">/</span>人民币' : '杭州周末<span class="separator">/</span>先核对到账，再更新余额'}</p></div>${page === 'overview' ? `<button type="button" class="button primary" data-action="add-expense">${icon('plus', 17)}记一笔</button>` : `<a href="${pageUrl('overview')}" class="button secondary" data-page="overview">返回账本</a>`}</header>`;

  const taskBand = () => `<section class="task-band" aria-label="个人余额及核对待办">
    <div class="balance-panel"><div class="balance-label"><span><i class="dot"></i>我应收</span><span>阿宁</span></div><div class="balance-amount"><span class="currency">¥</span><strong class="number" data-current-balance>${currentBalance()}</strong><span class="decimals number">.00</span></div><p class="balance-description">${confirmed ? '林悦的收款已核对，还差周然这一笔。' : '这趟出行，你替大家多垫了一些。'}</p><div class="balance-track"><span class="track-item"><i class="mini-avatar">悦</i>林悦<span class="number">${confirmed ? '0' : '204'}</span></span><i class="track-divider"></i><span class="track-item"><i class="mini-avatar">然</i>周然<span class="number">476</span></span></div></div>
    <div class="pending-panel"><div class="pending-heading"><span>${confirmed ? '这笔收款已核对' : '有一笔收款等你核对'}</span><span class="status-tag ${confirmed ? 'success' : ''}"><i class="dot"></i>${confirmed ? '已确认' : '待确认'}</span></div><div class="pending-transfer">${avatar('lin')}<div><strong>林悦 → 你</strong><p>${confirmed ? '已计入结算余额' : '11 月 15 日登记'}</p></div><strong class="number"><span class="small-currency">¥</span>204</strong></div><button type="button" class="button secondary" data-action="${confirmed ? 'view-settlement' : 'review-payment'}">${confirmed ? '查看核对结果' : '核对收款'}${icon(confirmed ? 'check' : 'arrow', 15)}</button><p class="pending-footnote">${confirmed ? '消费总额不变，只有结算余额更新。' : '待确认转账尚未计入余额。'}</p></div>
  </section>`;

  const expenses = [
    { title: '湖边民宿', amount: '1,260', icon: 'home', className: '', category: '住宿', payer: '阿宁', recorder: '阿宁', date: '11 月 15 日', day: '周日', time: '09:12' },
    { title: '一起吃的杭帮菜', amount: '368', icon: 'meal', className: 'meal', category: '餐饮', payer: '林悦', recorder: '阿宁', date: '11 月 15 日', day: '周日', time: '19:46' },
    { title: '车站到民宿', amount: '96', icon: 'taxi', className: 'taxi', category: '交通', payer: '周然', recorder: '周然', date: '11 月 14 日', day: '周六', time: '14:08' },
  ];
  const expenseRows = () => {
    const selected = expenses.filter((expense) => expenseFilter === 'all' || expense.payer === '阿宁');
    let lastDate = '';
    return selected.map((expense) => {
      let date = '';
      if (lastDate !== expense.date) {
        lastDate = expense.date;
        date = `<div class="expense-date"><span>${expense.date}<span class="separator"> · </span>${expense.day}</span><span class="date-total">${expense.date === '11 月 15 日' ? (expenseFilter === 'all' ? '2 笔 · ¥ 1,628' : '1 笔 · ¥ 1,260') : '1 笔 · ¥ 96'}</span></div>`;
      }
      return `${date}<article class="expense-row"><div class="expense-icon ${expense.className}">${icon(expense.icon, 19)}</div><div class="expense-detail"><strong>${expense.title}</strong><p><span>${expense.payer}垫付</span> · ${expense.recorder}录入</p></div><div class="expense-money"><strong class="number"><small>¥</small>${expense.amount}</strong><p>${expense.category} · ${expense.time}</p></div></article>`;
    }).join('');
  };

  const membersSummary = () => `<aside class="summary-aside" aria-label="账本摘要"><div class="section-head"><h2>账本概况</h2><span class="count">人民币</span></div><div class="summary-total"><p class="summary-total-label">这次一共花了</p><div class="summary-total-amount"><small>¥</small><strong class="number" data-total-expense>1,724<span style="font-size:20px;color:#829083">.00</span></strong><span>3 笔消费</span></div></div><div class="aside-members"><div class="member-section-title"><span>大家的结算余额</span><small>已确认收付款后</small></div><div class="member-balance">${avatar('an')}<div><div class="member-balance-name">阿宁<small>我</small></div><p>垫付 1,260 · 承担 580</p></div><strong class="number positive" data-member-an>+${currentBalance()}</strong></div><div class="member-balance">${avatar('lin')}<div><div class="member-balance-name">林悦</div><p>垫付 368 · 承担 572</p></div><strong class="number ${confirmed ? '' : 'negative'}" data-member-lin>${confirmed ? '0' : '−204'}</strong></div><div class="member-balance">${avatar('zhou')}<div><div class="member-balance-name">周然</div><p>垫付 96 · 承担 572</p></div><strong class="number negative" data-member-zhou>−476</strong></div><div class="member-legend"><span><i class="positive">＋</i> 应收</span><span><i class="negative">−</i> 应付</span><span>余额合计为 0</span></div></div></aside>`;

  const overview = () => `${taskBand()}<div class="content-grid"><section class="expense-section" aria-labelledby="expense-list-title"><div class="section-head"><div class="section-title"><h2 id="expense-list-title">最近开销</h2><span class="count">${expenseFilter === 'all' ? '3' : '1'} 笔</span></div><div class="filter-tabs" role="group" aria-label="筛选开销"><button type="button" class="${expenseFilter === 'all' ? 'active' : ''}" data-filter="all" aria-pressed="${expenseFilter === 'all'}">全部</button><button type="button" class="${expenseFilter === 'mine' ? 'active' : ''}" data-filter="mine" aria-pressed="${expenseFilter === 'mine'}">我垫付</button></div></div><div id="expense-rows">${expenseRows()}</div><p class="list-end">${expenseFilter === 'all' ? '这趟旅程的开销都在这里了' : '以上是你垫付的开销'}</p></section>${membersSummary()}</div>`;

  const receipt = (context) => {
    if (confirmed) return `<div class="review-body"><div class="confirmed-receipt"><div class="confirmed-icon">${icon('check', 27)}</div><h3>这笔收款核对好了</h3><p>林悦 → 阿宁<span class="number"> · ¥ 204.00</span></p><div class="confirmed-summary"><div><span>你的应收余额</span><strong class="number">¥ 476.00</strong></div><div><span>林悦的结算余额</span><strong class="number">¥ 0.00</strong></div></div><p style="margin-bottom:24px">消费总额仍为 <span class="number">¥ 1,724.00</span></p><a class="button secondary full" href="${pageUrl('overview')}" data-page="overview">回到账本总览${icon('arrow', 15)}</a><p class="confirmation-note">仅本页模拟确认，未执行支付。</p></div></div>`;
    return `<div class="review-body"><div class="receipt-parties"><div class="receipt-person">${avatar('lin')}<span>林悦 · 付款方</span></div><span class="receipt-arrow">${icon('chevron', 14)}</span><div class="receipt-person">${avatar('an')}<span>阿宁 · 收款方</span></div></div><div class="receipt-amount number"><small>¥</small>204.00</div><div class="receipt-status"><span class="status-tag"><i class="dot"></i>待你确认到账</span></div><dl class="receipt-data"><div><dt>转账登记</dt><dd>林悦 · 11 月 15 日 21:36</dd></div><div><dt>所属账本</dt><dd>杭州周末</dd></div><div><dt>对余额的影响</dt><dd>确认后，你的应收减少 ¥ 204</dd></div></dl><div class="receipt-warning">${icon('info', 14)}<p>先去微信、支付宝或银行卡核对实际到账。<br />这条登记本身不代表已经付款。</p></div><label class="confirmation-check" for="confirmed-${context}"><input type="checkbox" id="confirmed-${context}" data-confirmation-check /><span><strong>我已核对，实际收到林悦的 ¥ 204.00</strong><small>请确认付款人和金额均与实际到账一致。</small></span></label><button type="button" class="button primary full" data-action="confirm-payment" disabled>模拟确认收款${icon('check', 16)}</button><p class="confirmation-note">仅本页模拟确认，未执行支付。</p></div>`;
  };

  const settlement = () => `<section class="settlement-balance" aria-label="结算摘要"><div><div class="settlement-balance-label">${avatar('an')}我的应收</div><div class="settlement-balance-amount number"><small>¥</small><span data-current-balance>${currentBalance()}.00</span></div></div><i class="settlement-divider"></i><div class="settlement-stat"><p>待我核对</p><strong class="number">${confirmed ? '0' : '1'} <small style="font:10px 'Microsoft YaHei'">笔</small></strong></div><div class="settlement-stat"><p>已确认收款</p><strong class="number">${confirmed ? '204' : '0'}<small>.00</small></strong></div><p class="settlement-balance-note">${icon('shield', 15)}只有已确认的收付款影响余额</p></section><div class="settlement-grid"><section class="queue-section" aria-label="转账登记队列"><div class="queue-header"><div class="queue-tabs"><span class="queue-tab ${confirmed ? '' : 'active'}">待核对 <span class="count">${confirmed ? '0' : '1'}</span></span><span class="queue-tab ${confirmed ? 'active' : ''}">已确认 <span class="count">${confirmed ? '1' : '0'}</span></span></div></div><button type="button" class="queue-entry" data-action="focus-review" aria-label="查看林悦向阿宁登记的 204 元收款"><div class="queue-entry-top"><span class="queue-entry-person">${avatar('lin')}林悦 → 我</span><span class="status-tag ${confirmed ? 'success' : ''}">${confirmed ? '已确认' : '待确认'}</span></div><div class="queue-entry-money"><span>¥</span><strong class="number">204.00</strong></div><div class="queue-entry-meta"><span>11 月 15 日 21:36</span>${icon('arrow', 15)}</div></button>${confirmed ? `<p class="queue-completed-note">${icon('check', 15)}待办已处理，账目更清楚了。</p>` : '<p class="queue-explainer">对方登记后，仍需要收款人核对。<br />核对之前，这笔金额不会抵扣应收。</p>'}</section><section id="focused-review" class="review-panel" tabindex="-1" aria-label="收款核对"><div class="review-panel-head"><h2>${confirmed ? '核对结果' : '收款核对'}</h2><small>杭州周末</small></div>${receipt('panel')}</section></div>`;

  const ledgerArt = (error) => `<svg class="empty-illustration" viewBox="0 0 160 120" fill="none" aria-hidden="true"><path d="M34 22h73l16 17v60H34V22Z" fill="#E3EDE3"/><path d="M29 17h73l16 17v60H29V17Z" fill="#fff" stroke="#B7CCBA" stroke-width="1.5"/><path d="M102 17v17h16M43 40h42M43 54h22M43 68h36M43 82h14" stroke="#B7CCBA" stroke-width="1.5" stroke-linecap="round"/><circle cx="112" cy="83" r="23" fill="${error ? '#F2EADF' : '#D9E7DB'}" stroke="${error ? '#CAB898' : '#9EBEA5'}" stroke-width="1.5"/>${error ? '<path d="M112 72v13M112 92v.2" stroke="#9A6B2F" stroke-width="2.5" stroke-linecap="round"/>' : '<path d="M112 73v20M102 83h20" stroke="#527A5A" stroke-width="2" stroke-linecap="round"/>'}<path d="M17 104h126" stroke="#CDD9CA" stroke-width="1.5" stroke-linecap="round"/></svg>`;

  const alternateState = () => viewState === 'error' ? `<section class="empty-state" role="alert">${ledgerArt(true)}<span class="error-label">${icon('cloud', 13)}连接暂时中断</span><h2>这页账目还没加载出来</h2><p>请稍后重试。已有的账目不会因为这次连接中断而改变。</p><div class="empty-actions"><button type="button" class="button primary" data-action="restore">${icon('retry', 16)}重新加载</button></div></section>` : `<section class="empty-state">${ledgerArt(false)}<h2>${page === 'overview' ? '好时光，从第一笔开始' : '还没有需要核对的收款'}</h2><p>${page === 'overview' ? '住宿、聚餐、路上的小开销，都可以和朋友记在这一本里。' : '朋友登记转账后，你可以在这里核对付款人和实际到账金额。'}</p><div class="empty-actions">${page === 'overview' ? '<button type="button" class="button primary" data-action="add-expense">记下第一笔</button>' : ''}<button type="button" class="button secondary" data-action="restore">查看样例账本</button></div></section>`;

  function render() {
    document.title = `${page === 'overview' ? '杭州周末' : '结算核对'} · 合记`;
    app.innerHTML = `<div class="app-shell">${sidebar()}<main id="main-content" class="main"><div class="main-inner">${heading()}${viewState === 'normal' ? (page === 'overview' ? overview() : settlement()) : alternateState()}<footer class="page-footer"><span>合记 · 把生活，记在一起</span><label class="state-picker"><span>交互预览 · 示例数据</span><select data-state-picker aria-label="预览账本状态"><option value="normal" ${viewState === 'normal' ? 'selected' : ''}>正常账本</option><option value="empty" ${viewState === 'empty' ? 'selected' : ''}>空账本</option><option value="error" ${viewState === 'error' ? 'selected' : ''}>加载异常</option></select></label></footer></div></main></div>`;
  }

  function navigate(nextPage, nextState = viewState) {
    page = nextPage;
    viewState = nextState;
    history.pushState({}, '', pageUrl(page));
    if (reviewDialog.open) reviewDialog.close();
    render();
    window.scrollTo({ top: 0, behavior: 'auto' });
    const headingElement = app.querySelector('h1');
    headingElement.setAttribute('tabindex', '-1');
    headingElement.focus({ preventScroll: true });
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    const toast = document.querySelector('#toast');
    toast.textContent = message;
    toast.classList.add('visible');
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 4200);
  }

  document.addEventListener('click', (event) => {
    const pageLink = event.target.closest('[data-page]');
    if (pageLink) {
      event.preventDefault();
      navigate(pageLink.dataset.page);
      return;
    }
    const close = event.target.closest('[data-close-dialog]');
    if (close) { close.closest('dialog').close(); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'add-expense') {
      document.querySelector('#expense-form').reset();
      expenseDialog.showModal();
    } else if (action === 'review-payment') {
      document.querySelector('#review-dialog-content').innerHTML = receipt('dialog');
      reviewDialog.showModal();
    } else if (action === 'view-settlement') {
      navigate('settlement');
    } else if (action === 'confirm-payment') {
      const root = event.target.closest('.review-body');
      if (!root?.querySelector('[data-confirmation-check]')?.checked) return;
      confirmed = true;
      if (reviewDialog.open) reviewDialog.close();
      render();
      app.querySelector(page === 'settlement' ? '#focused-review' : '[data-action="view-settlement"]').focus({ preventScroll: true });
      showToast('已模拟确认收到 ¥ 204.00，余额已更新。');
    } else if (action === 'focus-review') {
      const review = document.querySelector('#focused-review');
      review.focus({ preventScroll: true });
      review.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
    } else if (action === 'restore') {
      confirmed = false;
      expenseFilter = 'all';
      navigate(page, 'normal');
      showToast('样例账本已恢复。');
    }
    const filter = event.target.closest('[data-filter]');
    if (filter) {
      expenseFilter = filter.dataset.filter;
      render();
      document.querySelector(`[data-filter="${expenseFilter}"]`).focus({ preventScroll: true });
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.matches('[data-confirmation-check]')) {
      event.target.closest('.review-body').querySelector('[data-action="confirm-payment"]').disabled = !event.target.checked;
    }
    if (event.target.matches('[data-state-picker]')) navigate(page, event.target.value);
  });

  document.querySelector('#expense-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    expenseDialog.close();
    showToast('记账流程已体验完毕，预览内容未保存。');
  });

  for (const dialog of [expenseDialog, reviewDialog]) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  }

  window.addEventListener('popstate', () => {
    const next = new URLSearchParams(location.search);
    page = next.get('page') === 'settlement' ? 'settlement' : 'overview';
    viewState = ['empty', 'error'].includes(next.get('state')) ? next.get('state') : 'normal';
    if (reviewDialog.open) reviewDialog.close();
    render();
  });
  render();
})();
