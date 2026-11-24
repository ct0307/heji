export function renderExpenses(
  { expenses, query = '', dateFilter = 'all', selectedId = null },
  { money, escapeHtml },
) {
  const safe = (value) => escapeHtml(String(value ?? ''));
  const normalizedQuery = String(query).trim().toLocaleLowerCase('zh-CN');
  const filtered = expenses
    .filter((expense) => {
      const matchesQuery = [expense.title, expense.category, expense.payer, expense.recorder]
        .some((value) => String(value ?? '').toLocaleLowerCase('zh-CN').includes(normalizedQuery));
      return matchesQuery && (dateFilter === 'all' || expense.date === dateFilter);
    })
    .sort((first, second) => second.date.localeCompare(first.date));
  const selected = filtered.find((expense) => expense.id === selectedId);
  const filteredTotal = filtered.reduce((total, expense) => total + expense.amountFen, 0n);
  const hasFilters = normalizedQuery.length > 0 || dateFilter !== 'all';
  const groups = new Map();

  for (const expense of filtered) {
    if (!groups.has(expense.date)) groups.set(expense.date, []);
    groups.get(expense.date).push(expense);
  }

  const searchIcon = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.7" cy="8.7" r="5.7" stroke="currentColor" stroke-width="1.6"/><path d="m13 13 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const arrowIcon = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m7.5 5 5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const closeIcon = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5.5 5.5 9 9m0-9-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const calendarIcon = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12.5" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M6.5 3v3m7-3v3M3 8.5h14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  const dateParts = (date) => {
    const [year, month, day] = String(date).split('-').map(Number);
    const localDate = new Date(year, month - 1, day);
    return {
      full: `${year}年${month}月${day}日`,
      short: `${month}月${day}日`,
      week: localDate.toLocaleDateString('zh-CN', { weekday: 'long' }),
    };
  };

  const renderRow = (expense) => {
    const isSelected = expense.id === selected?.id;
    const roles = expense.payer === expense.recorder
      ? `${expense.payer}付款并录入`
      : `${expense.payer}付款 · ${expense.recorder}录入`;
    return `
      <button class="expense-row${isSelected ? ' is-selected' : ''}"
        type="button" data-select-expense="${safe(expense.id)}"
        aria-pressed="${isSelected ? 'true' : 'false'}"
        aria-label="${safe(`查看${expense.title}，金额${money(expense.amountFen)}`)}">
        <span class="expense-row-content">
          <span class="expense-row-heading">
            <span class="expense-title">${safe(expense.title)}</span>
            <span class="expense-category">${safe(expense.category)}</span>
          </span>
          <span class="expense-roles">${safe(roles)}</span>
        </span>
        <span class="expense-row-amount">${safe(money(expense.amountFen))}</span>
        <span class="expense-row-arrow">${arrowIcon}</span>
      </button>`;
  };

  const renderGroup = ([date, entries]) => {
    const formatted = dateParts(date);
    const subtotal = entries.reduce((total, expense) => total + expense.amountFen, 0n);
    return `
      <section class="expense-day" aria-labelledby="expense-day-${safe(date)}">
        <header class="expense-day-header">
          <h2 id="expense-day-${safe(date)}" class="expense-day-title">
            <time datetime="${safe(date)}">${safe(formatted.short)}</time>
            <span class="expense-weekday">${safe(formatted.week)}</span>
          </h2>
          <p class="expense-day-subtotal"><span>${safe(entries.length)}笔 · 小计</span><strong>${safe(money(subtotal))}</strong></p>
        </header>
        <div class="expense-day-rows">${entries.map(renderRow).join('')}</div>
      </section>`;
  };

  const renderInspector = (expense) => {
    const formatted = dateParts(expense.date);
    return `
      <aside class="inspector" aria-labelledby="expense-inspector-title">
        <header class="expense-inspector-header">
          <p class="expense-inspector-label">开销核对</p>
          <button class="expense-icon-button" type="button" data-close-inspector aria-label="关闭开销详情">${closeIcon}</button>
        </header>
        <div class="expense-inspector-overview">
          <span class="expense-category">${safe(expense.category)}</span>
          <h2 id="expense-inspector-title">${safe(expense.title)}</h2>
          <p class="expense-inspector-amount">${safe(money(expense.amountFen))}</p>
        </div>
        <dl class="expense-inspector-facts">
          <div><dt>发生日期</dt><dd>${safe(formatted.full)}</dd></div>
          <div><dt>付款人</dt><dd>${safe(expense.payer)}</dd></div>
          <div><dt>录入人</dt><dd>${safe(expense.recorder)}</dd></div>
        </dl>
        <section class="expense-shares" aria-labelledby="expense-shares-title">
          <h3 id="expense-shares-title">分摊明细<span>${safe(expense.shares.length)}人</span></h3>
          <table>
            <caption class="expense-sr-only">${safe(`${expense.title}的成员分摊金额`)}</caption>
            <thead><tr><th scope="col">成员</th><th scope="col">应分摊</th></tr></thead>
            <tbody>${expense.shares.map((share) => `<tr><th scope="row">${safe(share.name)}</th><td>${safe(money(share.amountFen))}</td></tr>`).join('')}</tbody>
            <tfoot><tr><th scope="row">合计</th><td>${safe(money(expense.shares.reduce((total, share) => total + share.amountFen, 0n)))}</td></tr></tfoot>
          </table>
        </section>
        <button class="expense-detail-button" type="button" data-open-expense="${safe(expense.id)}">查看完整详情${arrowIcon}</button>
      </aside>`;
  };

  return `
    <section class="expenses-module" aria-label="开销明细列表">
      <div class="expense-toolbar" role="search" aria-label="筛选开销">
        <div class="expense-search-field">
          <label for="expense-search">搜索开销、付款人或录入人</label>
          <div class="expense-search-control">${searchIcon}<input id="expense-search" type="search" value="${safe(query)}" placeholder="如：晚餐、阿宁" autocomplete="off"></div>
        </div>
        <div class="expense-date-field">
          <label for="expense-date">发生日期</label>
          <div class="expense-date-control">${calendarIcon}<select id="expense-date">
            <option value="all"${dateFilter === 'all' ? ' selected' : ''}>全部日期</option>
            <option value="2026-11-08"${dateFilter === '2026-11-08' ? ' selected' : ''}>11月8日</option>
            <option value="2026-11-09"${dateFilter === '2026-11-09' ? ' selected' : ''}>11月9日</option>
          </select></div>
        </div>
        ${hasFilters ? '<button class="expense-clear-button" type="button" data-clear-expenses>清除筛选</button>' : ''}
      </div>
      <div class="expense-results-summary" role="status" aria-live="polite" aria-atomic="true">
        <p>${hasFilters ? '找到' : '全部'} <strong>${safe(filtered.length)}</strong> 笔开销</p>
        <p><span>${hasFilters ? '筛选合计' : '开销合计'}</span><strong class="expense-total">${safe(money(filteredTotal))}</strong></p>
      </div>
      <div class="expense-layout${selected ? ' has-inspector' : ''}">
        <div class="expense-list">
          ${filtered.length ? [...groups.entries()].map(renderGroup).join('') : `
            <div class="expense-empty">
              <span class="expense-empty-icon">${searchIcon}</span>
              <h2>${expenses.length ? '没有匹配的开销' : '账本还没有开销'}</h2>
              <p>${expenses.length ? '换个关键词，或清除筛选后查看全部开销。' : '记下第一笔共同开销，预览每个人的分摊。'}</p>
              ${expenses.length ? '<button class="expense-empty-clear" type="button" data-clear-expenses>清除筛选</button>' : '<button class="expense-empty-clear" type="button" data-open-entry>记一笔</button>'}
            </div>`}
        </div>
        ${selected ? renderInspector(selected) : ''}
      </div>
    </section>`;
}
