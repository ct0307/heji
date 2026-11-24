(() => {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const preview = {
    page: params.get("page") === "settlement" ? "settlement" : "overview",
    state: ["normal", "empty", "error"].includes(params.get("state")) ? params.get("state") : "normal",
    confirmed: false,
  };
  const content = document.querySelector("#page-content");
  const entryDialog = document.querySelector("#entry-dialog");
  const confirmDialog = document.querySelector("#confirm-dialog");
  const toast = document.querySelector("#toast");
  let toastTimer;
  const icons = {
    stay: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20V6l8-3 8 3v14M2 20h20M9 20v-5h6v5M8 8h2m4 0h2M8 11h2m4 0h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    dinner: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 3v7m3-7v7M5 7h3m-1.5 3v11M17 3c-3 3-3 8 0 9h2V3h-2Zm2 9v9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    car: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 8 2-4h10l2 4M4 9h16v9H4V9Zm2 9v3m12-3v3M7 13h2m6 0h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function notify(message) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 5000);
  }

  function updateUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set("page", preview.page);
    url.searchParams.set("state", preview.state);
    window.history.replaceState({}, "", url);
  }

  function renderSummary() {
    const empty = preview.state === "empty";
    const balance = empty ? "0.00" : preview.confirmed ? "476.00" : "680.00";
    return `<aside class="summary" aria-label="我的收支与成员余额">
      <div class="summary-heading"><h2>我的收支</h2><span class="avatar avatar-ning" aria-hidden="true">宁</span></div>
      <p class="balance-label">${empty ? "当前已结清" : "当前待收回"}</p>
      <p class="balance-number number" data-my-balance><span class="yen">¥</span>${balance}</p>
      <p class="balance-explain">${empty ? "记下支出后，这里会自动计算" : preview.confirmed ? "已计入林悦确认的 ¥204.00" : "含待确认收款，确认后才会扣减"}</p>
      <dl class="my-detail"><div><dt>我已垫付</dt><dd class="number">${empty ? "0.00" : "1,260.00"}</dd></div><div><dt>我应承担</dt><dd class="number">${empty ? "0.00" : "580.00"}</dd></div></dl>
      <section class="member-section" aria-labelledby="members-title"><h3 id="members-title">成员当前余额</h3>
        <div class="member-row"><span class="avatar avatar-ning" aria-hidden="true">宁</span><span class="member-name">阿宁<span class="self-tag">我</span></span><span class="member-balance number positive" data-member="ning">${empty ? "0.00" : `+${balance}`}<small>${empty ? "已结清" : "待收"}</small></span></div>
        <div class="member-row"><span class="avatar avatar-yue" aria-hidden="true">悦</span><span class="member-name">林悦</span><span class="member-balance number negative" data-member="yue">${empty || preview.confirmed ? "0.00" : "−204.00"}<small>${empty || preview.confirmed ? "已结清" : "待付"}</small></span></div>
        <div class="member-row"><span class="avatar avatar-ran" aria-hidden="true">然</span><span class="member-name">周然</span><span class="member-balance number negative" data-member="ran">${empty ? "0.00" : "−476.00"}<small>${empty ? "已结清" : "待付"}</small></span></div>
      </section><p class="summary-foot">正数为待收，负数为待付。<br>只有已确认的转账计入余额。</p>
    </aside>`;
  }

  function renderOverline() {
    return `<div class="page-overline"><div class="section-label">${preview.page === "overview" ? "账本总览" : "收款与结算"}</div><div class="page-overline-right"><span>账本总消费</span><span class="number" data-total-spent>${preview.state === "error" ? "—" : preview.state === "empty" ? "¥ 0.00" : "¥ 1,724.00"}</span></div></div>`;
  }

  function expense(icon, title, meta, amount, recorder = "") {
    return `<article class="expense-row"><span class="expense-icon">${icons[icon]}</span><div class="expense-description"><h3 class="expense-title">${title}</h3><p class="expense-meta">${meta}${recorder ? `<br><span class="recorder">${recorder}</span>` : ""}</p></div><p class="expense-amount number"><span class="yen">¥</span>${amount}<small>3 人分摊</small></p></article>`;
  }

  function renderOverview() {
    if (preview.state === "empty") {
      return `<div class="overview-grid"><section class="ledger empty-ledger"><div class="empty-symbol" aria-hidden="true"></div><h2>第一笔，记在这里</h2><p>住宿、晚餐或一段车程，<br>从一次共同花费开始。</p><button class="button button-primary" type="button" data-action="open-entry">＋ 记一笔</button></section>${renderSummary()}</div>`;
    }
    return `<div class="overview-grid"><section class="mobile-balance" aria-label="当前待收金额"><div><p>当前待收回</p><strong class="number"><span class="yen">¥</span>${preview.confirmed ? "476.00" : "680.00"}</strong></div><p>${preview.confirmed ? "已确认收款 ¥204.00" : "待确认 ¥204.00"}<span>${preview.confirmed ? "余额已更新" : "尚未从余额扣减"}</span></p></section><section class="ledger" aria-labelledby="ledger-title">
      <div class="attention"><span class="attention-icon" aria-hidden="true">${preview.confirmed ? "✓" : "↓"}</span><div class="attention-text">${preview.confirmed ? "林悦的这笔收款，已确认" : "有一笔收款，等你核对"}<p>${preview.confirmed ? "已收 ¥204.00 · 当前仍待收回 ¥476.00" : "林悦登记了 ¥204.00 · 待确认，不计入余额"}</p></div><a class="attention-link" href="?page=settlement&state=normal" data-page="settlement">${preview.confirmed ? "查看收款" : "去核对"}<span aria-hidden="true">→</span></a></div>
      <div class="ledger-head"><h2 id="ledger-title">共同花费<span class="count-note">3 笔</span></h2><span class="legend">每一笔，都有迹可循</span></div>
      <div class="ledger-columns"><span>账目 / 付款人</span><span>支出金额</span></div>
      <div class="ledger-list"><section class="date-group" aria-label="11月15日账目"><div class="ledger-date"><span class="date-bullet">11.15</span><small>周日 · 2 笔</small></div>${expense("car", "回程打车", "周然付款", "96.00")}${expense("dinner", "湖边晚餐", "林悦付款", "368.00", "阿宁录入")}</section><section class="date-group" aria-label="11月14日账目"><div class="ledger-date"><span class="date-bullet">11.14</span><small>周六 · 1 笔</small></div>${expense("stay", "山间民宿", "阿宁付款", "1,260.00")}</section></div>
      <div class="ledger-note"><span>已显示全部账目</span><div class="collaborator-dots"><span class="avatar avatar-ning" aria-hidden="true">宁</span><span class="avatar avatar-yue" aria-hidden="true">悦</span><span class="avatar avatar-ran" aria-hidden="true">然</span><span>3 人一起记</span></div></div>
    </section>${renderSummary()}</div>`;
  }

  function renderSettlement() {
    if (preview.state === "empty") {
      return `<p class="empty-settlement-summary">阿宁 · 当前余额 ¥0.00</p><div class="settlement-grid"><aside class="queue"><div class="queue-heading"><h2>待核对收款</h2><span class="queue-count">0 笔</span></div><div class="empty-queue">目前没有待办<p>收到转账登记后，可以在这里核对。</p></div></aside><section class="empty-receipt"><div class="empty-symbol" aria-hidden="true"></div><h2>账清，心也轻</h2><p>这里会保留需要你核对的收款。<br>先去记下这次的共同花费吧。</p><a class="button button-primary" href="?page=overview&state=empty" data-page="overview">返回账本总览</a></section></div>`;
    }
    return `<div class="settlement-summary"><p>阿宁当前待收<strong class="number" data-my-balance>¥${preview.confirmed ? "476.00" : "680.00"}</strong></p><span>核对到账后，才更新余额</span></div>
      <div class="settlement-grid"><aside class="queue" aria-label="收款登记队列"><div class="queue-heading"><h2>${preview.confirmed ? "已核对收款" : "待核对收款"}</h2><span class="queue-count">${preview.confirmed ? "待办 0" : "1 笔"}</span></div>
        <button class="queue-item" type="button" data-action="focus-receipt" aria-current="true" aria-label="查看林悦转给阿宁的204元收款"><span class="queue-status ${preview.confirmed ? "complete" : ""}">${preview.confirmed ? "已确认" : "待我确认"}</span><span class="queue-people">林悦 <span class="queue-arrow" aria-hidden="true">→</span> 阿宁</span><span class="queue-amount number"><span class="yen">¥</span>204.00</span><span class="queue-bottom"><span>11 月 15 日登记</span><span class="queue-selected">查看中</span></span></button>
        <p class="queue-tip"><strong>登记，不代表已经到账。</strong><br>只有你核对并确认后，这笔转账才会计入双方余额。</p><div class="queue-next">其他成员余额<div><span>周然待付</span><span class="number">¥476.00</span></div></div>
      </aside><div class="receipt-wrap"><section class="receipt" id="receipt" tabindex="-1" aria-labelledby="receipt-title"><div class="receipt-title"><h2 id="receipt-title">${preview.confirmed ? "收款已确认" : "收款核对单"}</h2><span class="receipt-reference">杭州周末 / 收款</span></div>
        <div class="receipt-money"><p>本次${preview.confirmed ? "已确认" : "待确认"}收款</p><p class="receipt-amount number"><span class="yen">¥</span>204.00</p><p class="pending-caption ${preview.confirmed ? "complete" : ""}">${preview.confirmed ? "已计入余额 · 核对完成" : "待确认 · 尚未计入余额"}</p></div>
        <div class="receipt-parties"><div class="receipt-party"><span class="avatar avatar-yue" aria-hidden="true">悦</span><div><small>付款人</small><strong>林悦</strong></div></div><span class="receipt-transfer" aria-hidden="true">⟶</span><div class="receipt-party"><span class="avatar avatar-ning" aria-hidden="true">宁</span><div><small>收款人</small><strong>阿宁（我）</strong></div></div></div>
        <dl class="receipt-details"><div><dt>所属账本</dt><dd>杭州周末</dd></div><div><dt>登记时间</dt><dd>11 月 15 日 20:36</dd></div><div><dt>转账方式</dt><dd>线下转账</dd></div><div><dt>登记人</dt><dd>林悦</dd></div></dl>
        ${preview.confirmed ? `<div class="completed-message"><span class="completed-icon" aria-hidden="true">✓</span><div><strong>已模拟确认收到 ¥204.00</strong><p>你的待收余额已从 ¥680.00 更新为 ¥476.00。</p></div></div><div class="receipt-actions"><a class="button button-primary" href="?page=overview&state=normal" data-page="overview">返回账本总览</a></div>` : `<p class="receipt-help">请先核对微信、支付宝或银行卡的实际到账记录，<br>再确认这笔收款。</p><label class="check-row"><input id="receipt-checked" type="checkbox" /><span>我已核对，确实收到林悦的 <strong>¥204.00</strong></span></label><div class="receipt-actions"><button id="confirm-receipt" type="button" class="button button-primary" data-action="open-confirm" disabled>确认收到 ¥204.00</button><a class="text-link" href="?page=overview&state=normal" data-page="overview">暂不确认</a></div>`}
      </section><p class="receipt-note">确认收款只更新账本余额，不会发起付款。</p></div></div>`;
  }

  function renderError() {
    return `<section class="error-state" aria-labelledby="error-title"><div class="error-code" aria-hidden="true">— / —</div><h2 id="error-title">账本暂时没能加载出来</h2><p>请重新加载，已记录的账目会保留。</p><button type="button" class="button button-primary" data-action="retry">重新加载</button></section>`;
  }

  function render() {
    content.innerHTML = renderOverline() + (preview.state === "error" ? renderError() : preview.page === "overview" ? renderOverview() : renderSettlement());
    document.querySelectorAll("[data-page]").forEach((link) => {
      if (link.closest(".main-nav")) {
        if (link.dataset.page === preview.page) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
      link.href = `?page=${link.dataset.page}&state=${preview.state}`;
    });
    document.querySelectorAll("[data-state]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.state === preview.state)));
    document.querySelector("#nav-pending").hidden = preview.confirmed || preview.state !== "normal";
    document.title = `杭州周末 · ${preview.page === "overview" ? "账本总览" : "收款与结算"} · 合记`;
    updateUrl();
  }

  function closeDialog(dialog) {
    if (dialog.open) dialog.close();
  }

  document.addEventListener("click", (event) => {
    const navigation = event.target.closest("a[data-page]");
    if (navigation && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) {
      event.preventDefault();
      preview.page = navigation.dataset.page;
      render();
      return;
    }
    const stateButton = event.target.closest("button[data-state]");
    if (stateButton) {
      preview.state = stateButton.dataset.state;
      render();
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "open-entry") {
      document.querySelector("#entry-form").reset();
      document.querySelector("#entry-result").hidden = true;
      entryDialog.showModal();
    } else if (action === "close-entry") closeDialog(entryDialog);
    else if (action === "close-confirm") closeDialog(confirmDialog);
    else if (action === "open-confirm") {
      if (document.querySelector("#receipt-checked")?.checked) confirmDialog.showModal();
    } else if (action === "complete-confirm") {
      if (preview.state !== "normal" || preview.page !== "settlement" || !document.querySelector("#receipt-checked")?.checked) return;
      preview.confirmed = true;
      closeDialog(confirmDialog);
      render();
      document.querySelector("#receipt")?.focus({ preventScroll: true });
      notify("已模拟确认 ¥204.00，当前待收 ¥476.00。");
    } else if (action === "focus-receipt") {
      const receipt = document.querySelector("#receipt");
      receipt?.focus({ preventScroll: true });
      receipt?.scrollIntoView({ block: "nearest" });
    } else if (action === "retry") {
      preview.state = "normal";
      render();
      notify("已恢复示例账本。");
    } else if (action === "reset") {
      preview.confirmed = false;
      preview.state = "normal";
      closeDialog(entryDialog);
      closeDialog(confirmDialog);
      render();
      notify("已重置示例数据。");
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target.id === "receipt-checked") {
      const confirmButton = document.querySelector("#confirm-receipt");
      if (confirmButton) confirmButton.disabled = !event.target.checked;
    }
  });

  document.querySelector("#entry-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const amount = Number(data.get("amount"));
    if (!Number.isFinite(amount) || amount <= 0) return;
    const result = document.querySelector("#entry-result");
    result.replaceChildren();
    const text = document.createElement("span");
    text.textContent = `${data.get("title")} · ¥${amount.toFixed(2)} · ${data.get("payer")}付款`;
    const note = document.createElement("small");
    note.textContent = "填写预览已生成，示例账本不添加记录。";
    result.append(text, note);
    result.hidden = false;
  });

  // 原生对话框支持 Escape；点击遮罩也可关闭，并恢复触发按钮的焦点。
  [entryDialog, confirmDialog].forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      const bounds = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeDialog(dialog);
    });
  });

  window.addEventListener("popstate", () => {
    const current = new URLSearchParams(window.location.search);
    preview.page = current.get("page") === "settlement" ? "settlement" : "overview";
    preview.state = ["normal", "empty", "error"].includes(current.get("state")) ? current.get("state") : "normal";
    render();
  });

  render();
})();
