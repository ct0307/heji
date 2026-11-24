"""双界面浏览器回归：仅访问本地 Vue，所有 API/WS 均隔离模拟。

运行前由调用者准备前端服务；本脚本不启动服务、不创建账号、不写数据库。
使用 --smoke 可运行默认界面、切换、刷新及开销草稿的最小门禁。
"""
import argparse
import asyncio
import copy
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import async_playwright, expect


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/development/evidence/ui-appearance-2026-11-19.json'
SHOTS = OUT.with_suffix('')
BOOK = '00000000-0000-4000-8000-000000000010'
USER = '00000000-0000-4000-8000-000000000001'
OWN = '00000000-0000-4000-8000-000000000101'
OTHER = '00000000-0000-4000-8000-000000000102'
REQUEST = '00000000-0000-4000-8000-000000000201'
TIMEOUT = 3500


def fixtures(empty=False):
    book = dict(id=BOOK, name='模拟合租账本', createdByUserId=USER,
                isArchived=False, financialVersion='7')
    members = [dict(id=OWN, userId=USER, displayName='林清（模拟）', status='ACTIVE'),
               dict(id=OTHER, userId='mock-other', displayName='许宁（模拟）', status='ACTIVE')]
    balances = [dict(memberId=OWN, paidFen='12000', shareFen='6000', incomingFen='0', outgoingFen='0', balanceFen='6000'),
                dict(memberId=OTHER, paidFen='0', shareFen='6000', incomingFen='0', outgoingFen='0', balanceFen='-6000')]
    after = [dict(item, incomingFen='6000' if item['memberId'] == OWN else '0',
                  outgoingFen='6000' if item['memberId'] == OTHER else '0', balanceFen='0') for item in balances]
    request = dict(id=REQUEST, bookId=BOOK, kind='NORMAL', fromMemberId=OTHER, toMemberId=OWN,
                   amountFen='6000', occurredOn='2026-11-18', note='模拟线下转账，仅供界面核对',
                   initiatorMemberId=OTHER, counterpartyMemberId=OWN, status='PENDING', revision='1',
                   reversalOfTransferId=None, confirmedTransferId=None, createdAt='2026-11-18T12:00:00Z')
    expense = dict(id='mock-expense', bookId=BOOK, createdByMemberId=OWN, paidByMemberId=OWN,
                   amountFen='12000', splitMode='EQUAL', shares=[dict(memberId=OWN, amountFen='6000'), dict(memberId=OTHER, amountFen='6000')],
                   category='FOOD', occurredOn='2026-11-18', note='周末晚餐（模拟）', revision='1', etag='mock-etag',
                   isVoided=False, changedByMemberId=OWN, createdAt='2026-11-18T12:00:00Z')
    if empty:
        balances = [dict(item, paidFen='0', shareFen='0', balanceFen='0') for item in balances]
    snapshot = dict(financialVersion='7', memberId=OWN, balances=balances,
                    suggestions=[] if empty else [dict(fromMemberId=OTHER, toMemberId=OWN, amountFen='6000')],
                    expenseTotalFen='0' if empty else '12000', pendingCount=0 if empty else 1, isSettled=empty)
    report = dict(expenseTotalFen=snapshot['expenseTotalFen'], categories=[] if empty else [dict(category='FOOD', amountFen='12000')],
                  members=[dict(memberId=item['memberId'], paidFen=item['paidFen'], shareFen=item['shareFen']) for item in balances],
                  period={'from': None, 'to': None}, ranking=[])
    return dict(book=book, members=members, snapshot=snapshot, expenses=[] if empty else [expense],
                requests=[] if empty else [request], report=report,
                preview=dict(request=request, expectedFinancialVersion='7', expectedRequestRevision='1',
                             beforeBalances=balances, afterBalances=after, warnings=[]))


class MockApi:
    """只允许明确定义的模拟接口，其他 API 永不放行。"""
    def __init__(self, origin, mode='normal'):
        self.origin = origin.rstrip('/')
        self.mode = mode
        self.data = fixtures(mode == 'empty')
        self.requests = []
        self.unhandled = []
        self.external = []
        self.window_started = None

    def window(self):
        now = datetime.now(timezone.utc)
        active = self.window_started is not None
        stamp = lambda value: value.isoformat().replace('+00:00', 'Z') if value else None
        return dict(supported=True, state='ACTIVE' if active else 'NONE', serverTime=stamp(now),
                    windowId='mock-window' if active else None, requestId=REQUEST if active else None,
                    createdAt=stamp(self.window_started), expiresAt=stamp(self.window_started + timedelta(seconds=30)) if active else None,
                    closedAt=None, cooldownUntil=None, mine=active, canClose=active)

    async def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        if parsed.path.startswith('/api/'):
            path = parsed.path.removeprefix('/api/v1')
            method = request.method
            self.requests.append(dict(method=method, path=path))
            status, data = 200, None
            known = True
            base = '/books/' + BOOK
            if method == 'GET' and path == '/auth/csrf':
                data = dict(csrfToken='mock-csrf-only')
            elif method == 'GET' and path == '/auth/me':
                data = dict(id=USER, email='mock@example.invalid', displayName='模拟界面用户')
            elif method == 'GET' and path == '/books':
                data = [] if self.mode == 'empty' else [self.data['book']]
            elif method == 'GET' and path == base:
                data = self.data['book']
            elif method == 'GET' and path == base + '/members':
                data = self.data['members']
            elif method == 'GET' and path == base + '/balances':
                data = self.data['snapshot']
            elif method == 'GET' and path == base + '/expenses':
                data = dict(items=self.data['expenses'], nextCursor=None)
            elif method == 'GET' and path == base + '/transfer-requests':
                data = self.data['requests']
            elif method == 'GET' and path == base + '/transfers':
                data = []
            elif method == 'GET' and path == base + '/reports':
                data = self.data['report']
            elif method == 'GET' and path == base + '/audit-events':
                data = []
            elif method == 'GET' and path == base + '/settlement-window':
                data = self.window()
            elif method == 'GET' and path == base + '/transfer-requests/' + REQUEST + '/preview':
                data = self.data['preview']
            elif method == 'POST' and path == base + '/transfer-requests/' + REQUEST + '/settlement-window':
                self.window_started = datetime.now(timezone.utc)
                data = dict(window=self.window(), preview=self.data['preview'])
            else:
                known = False
                self.unhandled.append(dict(method=method, path=path))
            if not known:
                await route.fulfill(status=404, json={'error': {'code': 'MOCK_ONLY', 'message': '模拟测试禁止该操作'}})
                return
            if self.mode == 'error' and method == 'GET' and path in (base, '/books'):
                await route.fulfill(status=503, json={'error': {'code': 'MOCK_UNAVAILABLE', 'message': '模拟账本暂不可用，请稍后重试'}})
                return
            await route.fulfill(status=status, json={'data': copy.deepcopy(data)})
        elif request.url.startswith(self.origin + '/'):
            await route.continue_()
        else:
            self.external.append(parsed.scheme + '://' + parsed.netloc + parsed.path)
            await route.abort('blockedbyclient')

    def mutations(self):
        return [item for item in self.requests if item['method'] not in ('GET', 'HEAD', 'OPTIONS')]


async def new_page(browser, origin, *, mode='normal', storage=None):
    context = await browser.new_context(viewport=dict(width=1440, height=1000), service_workers='block')
    context.set_default_timeout(TIMEOUT)
    api = MockApi(origin, mode)
    await context.route('**/*', api.route)
    await context.route_web_socket('**/*', lambda socket: socket.close())
    if storage == 'invalid':
        await context.add_init_script("localStorage.setItem('heji.interface', 'invalid-interface');")
    elif storage in ('read-denied', 'write-denied', 'denied'):
        await context.add_init_script("""(() => {
          const originalGet = Storage.prototype.getItem;
          const originalSet = Storage.prototype.setItem;
          const denyRead = DENY_READ;
          const denyWrite = DENY_WRITE;
          Storage.prototype.getItem = function(key) {
            if (key === 'heji.interface' && denyRead) throw new DOMException('模拟偏好读取禁止', 'SecurityError');
            return originalGet.call(this, key);
          };
          Storage.prototype.setItem = function(key, value) {
            if (key === 'heji.interface' && denyWrite) throw new DOMException('模拟偏好保存禁止', 'SecurityError');
            return originalSet.call(this, key, value);
          };
        })();""".replace('DENY_READ', str(storage in ('read-denied', 'denied')).lower())
             .replace('DENY_WRITE', str(storage in ('write-denied', 'denied')).lower()))
    page = await context.new_page()
    page.ui_errors = []
    page.on('pageerror', lambda error: page.ui_errors.append(str(error)))
    return context, page, api


async def visit_book(page, origin, tab='expenses'):
    await page.goto(origin + '/books/' + BOOK + '?tab=' + tab, wait_until='networkidle', timeout=10000)
    await expect(page.get_by_role('heading', name='模拟合租账本', exact=True)).to_be_visible()


async def open_settings(page):
    await page.get_by_role('button', name='界面设置', exact=True).click()
    dialog = page.get_by_role('dialog', name='界面设置', exact=True)
    await expect(dialog).to_be_visible()
    return dialog


async def choose(page, interface, *, close=True):
    dialog = await open_settings(page)
    title = 'A 雾青工作台' if interface == 'a' else 'B 墨蓝账页'
    await dialog.get_by_role('radio', name=re.compile(re.escape(title))).check()
    await expect(page.locator('html')).to_have_attribute('data-interface', interface)
    await expect(dialog.get_by_role('radio', name=re.compile(re.escape(title)))).to_be_checked()
    if close:
        await dialog.get_by_role('button', name='完成', exact=True).click()
        await expect(dialog).not_to_be_visible()
    return dialog


async def no_overflow(page, label):
    dimensions = await page.evaluate('''() => ({width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth})''')
    assert dimensions['scroll'] <= dimensions['width'] + 1, f'{label} 页面横向溢出: {dimensions}'
    dialog = page.get_by_role('dialog', name='界面设置', exact=True)
    if await dialog.is_visible():
        box = await dialog.bounding_box()
        assert box and box['x'] >= -1 and box['x'] + box['width'] <= dimensions['width'] + 1, f'{label} 设置弹层超出视口'
        height = await page.evaluate('innerHeight')
        assert box['y'] >= -1 and box['y'] + box['height'] <= height + 1, f'{label} 设置弹层超出视口高度'
        assert await dialog.evaluate('(element) => element.scrollWidth <= element.clientWidth + 1'), f'{label} 设置内容横向溢出'
    return dimensions


async def screenshot(page, evidence, name):
    # 整页截图统一从页顶合成，避免将视口外的固定定位跳转链接画入页面中段。
    await page.evaluate('scrollTo(0, 0)')
    # 原生 dialog 的遮罩对应真实视口，截取视口能保留其实际覆盖范围。
    modal_open = await page.get_by_role('dialog', name='界面设置', exact=True).is_visible()
    await page.screenshot(path=str(SHOTS / (name + '.png')), full_page=not modal_open, animations='disabled')
    evidence['screenshots'].append(str((SHOTS / (name + '.png')).relative_to(ROOT)).replace('\\', '/'))


def passed(evidence, name):
    evidence['passed'].append(name)
    print('PASS ' + name, flush=True)


def assert_isolated(api, page, *, mutations=0):
    assert not api.unhandled, f'未实现模拟接口: {api.unhandled}'
    assert not api.external, f'出现外部网络请求: {api.external}'
    assert len(api.mutations()) == mutations, f'意外业务写请求: {api.mutations()}'
    assert not page.ui_errors, f'页面运行错误: {page.ui_errors}'


async def smoke(browser, origin, evidence):
    context, page, api = await new_page(browser, origin)
    try:
        await visit_book(page, origin)
        await expect(page.locator('html')).to_have_attribute('data-interface', 'a')
        dialog = await open_settings(page)
        await expect(dialog.get_by_role('radio', name=re.compile('A 雾青工作台'))).to_be_checked()
        await dialog.get_by_role('button', name='关闭界面设置', exact=True).click()
        passed(evidence, '新浏览器默认A且设置入口可用')
        await choose(page, 'b')
        await page.reload(wait_until='networkidle')
        await expect(page.locator('html')).to_have_attribute('data-interface', 'b')
        await choose(page, 'a')
        await page.reload(wait_until='networkidle')
        await expect(page.locator('html')).to_have_attribute('data-interface', 'a')
        passed(evidence, '入口切换立即生效且刷新记住B和A')
        await page.get_by_role('button', name='新增开销', exact=True).click()
        amount = page.get_by_role('textbox', name='开销金额（元）', exact=True)
        note = page.get_by_role('textbox', name='备注', exact=True)
        await amount.fill('123.45')
        await note.fill('仅模拟：切换界面保留草稿，不提交')
        await choose(page, 'b')
        await expect(amount).to_have_value('123.45')
        await expect(note).to_have_value('仅模拟：切换界面保留草稿，不提交')
        await choose(page, 'a')
        await expect(amount).to_have_value('123.45')
        await expect(note).to_have_value('仅模拟：切换界面保留草稿，不提交')
        assert_isolated(api, page)
        passed(evidence, '开销金额与备注切换后保留且没有业务写请求')
        dialog = await open_settings(page)
        await page.keyboard.press('Escape')
        await expect(dialog).not_to_be_visible()
        await expect(page.get_by_role('button', name='界面设置', exact=True)).to_be_focused()
        passed(evidence, 'Escape关闭设置并恢复入口焦点')
    finally:
        evidence['requests'].extend(api.requests)
        await context.close()


async def storage_cases(browser, origin, evidence):
    for mode in ('invalid', 'read-denied', 'write-denied', 'denied'):
        context, page, api = await new_page(browser, origin, storage=mode)
        try:
            await visit_book(page, origin)
            await expect(page.locator('html')).to_have_attribute('data-interface', 'a')
            dialog = await choose(page, 'b', close=False)
            if mode in ('write-denied', 'denied'):
                await expect(dialog.get_by_text(re.compile('当前浏览器无法保存'))).to_be_visible()
            await dialog.get_by_role('button', name='完成', exact=True).click()
            await expect(page.locator('html')).to_have_attribute('data-interface', 'b')
            assert_isolated(api, page)
            passed(evidence, '偏好降级：' + mode + '默认A且仍可切换B')
        finally:
            evidence['requests'].extend(api.requests)
            await context.close()


async def settlement(browser, origin, evidence):
    context, page, api = await new_page(browser, origin)
    try:
        await visit_book(page, origin, 'settlement')
        await page.get_by_role('button', name='核对并预览', exact=True).click()
        preview = page.get_by_role('region', name='转账确认预览', exact=True)
        await expect(preview).to_be_visible()
        acknowledge = preview.get_by_role('checkbox', name=re.compile('我已核对线下收付款事实'))
        await acknowledge.check()
        before = list(api.requests)
        await choose(page, 'b')
        await expect(preview).to_be_visible()
        await expect(acknowledge).to_be_checked()
        assert len(api.requests) == len(before), '切界面重新发起预览/读取请求'
        assert_isolated(api, page)
        passed(evidence, '普通结算预览与核对勾选切换后保留且无额外请求')
        await preview.get_by_role('button', name='申请短时结算窗口', exact=True).click()
        await expect(preview.get_by_text('已取得短时窗口。以下是最新预览，请重新核对并勾选。', exact=True)).to_be_visible()
        await expect(acknowledge).not_to_be_checked()
        await acknowledge.check()
        before_posts = list(api.mutations())
        for interface in ('a', 'b'):
            await choose(page, interface)
            await expect(preview).to_be_visible()
            await expect(acknowledge).to_be_checked()
            await expect(preview.get_by_role('button', name='确认收到款项', exact=True)).to_be_enabled()
            await expect(page.get_by_role('region', name='账本结算窗口', exact=True)).to_be_visible()
        assert api.mutations() == before_posts, '切换触发窗口或财务POST'
        assert before_posts == [dict(method='POST', path='/books/' + BOOK + '/transfer-requests/' + REQUEST + '/settlement-window')]
        assert_isolated(api, page, mutations=1)
        passed(evidence, '短时窗口及核对勾选切换保留且仅一次主动模拟窗口POST')
    finally:
        evidence['requests'].extend(api.requests)
        await context.close()


async def layouts(browser, origin, evidence):
    context, page, api = await new_page(browser, origin)
    try:
        await visit_book(page, origin)
        for interface in ('a', 'b'):
            await choose(page, interface)
            for width in (360, 390, 768, 1440):
                await page.set_viewport_size(dict(width=width, height=900 if width >= 768 else 844))
                tabs = [('expenses', '明细', '共同开销'), ('settlement', re.compile('^结算'), '每个人的净余额')]
                if width in (390, 1440):
                    tabs.extend([('reports', '统计', '共同消费合计'), ('members', '成员', '一起记账的人')])
                for tab, title, heading in tabs:
                    await page.get_by_role('navigation', name='账本导航', exact=True).get_by_role('button', name=title).click()
                    await expect(page.get_by_role('heading', name=heading, exact=True)).to_be_visible()
                    if tab == 'settlement' and width in (390, 1440):
                        await page.get_by_role('button', name='核对并预览', exact=True).click()
                        await expect(page.get_by_role('region', name='转账确认预览', exact=True)).to_be_visible()
                    dimensions = await no_overflow(page, f'{interface}/{width}/{tab}')
                    evidence['layouts'].append(dict(interface=interface, viewport=width, page=tab, **dimensions))
                    if width in (390, 1440):
                        shot_page = 'settlement-preview' if tab == 'settlement' else tab
                        await screenshot(page, evidence, f'{interface}-{shot_page}-{width}')
                dialog = await open_settings(page)
                await no_overflow(page, f'{interface}/{width}/settings')
                if width in (390, 1440):
                    await screenshot(page, evidence, f'{interface}-settings-{width}')
                await dialog.get_by_role('button', name='完成', exact=True).click()
                names = '明细、结算、统计、成员、设置' if width in (390, 1440) else '明细、结算、设置'
                passed(evidence, f'界面{interface.upper()}在{width}px的{names}无横向溢出')
        assert_isolated(api, page)
    finally:
        evidence['requests'].extend(api.requests)
        await context.close()


async def states(browser, origin, evidence):
    for mode in ('empty', 'error'):
        context, page, api = await new_page(browser, origin, mode=mode)
        try:
            for interface in ('a', 'b'):
                await page.goto(origin + '/books/' + BOOK, wait_until='networkidle', timeout=10000)
                await choose(page, interface)
                for width in (390, 1440):
                    await page.set_viewport_size(dict(width=width, height=844))
                    if mode == 'empty':
                        await expect(page.get_by_text('还没有共同开销', exact=True)).to_be_visible()
                        await no_overflow(page, f'{interface}/{width}/empty-expenses')
                        await screenshot(page, evidence, f'{interface}-empty-expenses-{width}')
                        await page.get_by_role('navigation', name='账本导航', exact=True).get_by_role('button', name='结算', exact=True).click()
                        await expect(page.get_by_text('没有待确认的转账或冲正请求。', exact=True)).to_be_visible()
                        await screenshot(page, evidence, f'{interface}-empty-settlement-{width}')
                        await no_overflow(page, f'{interface}/{width}/empty-settlement')
                        await page.get_by_role('navigation', name='账本导航', exact=True).get_by_role('button', name='明细', exact=True).click()
                    else:
                        await expect(page.get_by_role('alert')).to_contain_text('模拟账本暂不可用，请稍后重试')
                        await no_overflow(page, f'{interface}/{width}/error')
                        await screenshot(page, evidence, f'{interface}-error-{width}')
                passed(evidence, f'界面{interface.upper()}的{mode}状态与手机/桌面布局')
            assert_isolated(api, page)
        finally:
            evidence['requests'].extend(api.requests)
            await context.close()


async def main():
    expect.set_options(timeout=TIMEOUT)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', default='http://127.0.0.1:5174')
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    origin = args.origin.rstrip('/')
    assert urlsplit(origin).hostname in ('127.0.0.1', 'localhost'), '只允许本地前端地址'
    OUT.parent.mkdir(parents=True, exist_ok=True)
    SHOTS.mkdir(exist_ok=True)
    history = []
    if OUT.exists():
        try:
            previous = json.loads(OUT.read_text(encoding='utf-8'))
            candidates = previous.get('history', []) + [{key: previous[key] for key in
                ('status', 'smoke', 'summary', 'failedCheck', 'errorType', 'reason', 'finishedAt') if key in previous}]
            # 保留最小门禁与真实失败，避免重复成功运行稀释最终证据。
            history = [item for item in candidates if item.get('smoke') or item.get('status') == 'failed']
        except (OSError, ValueError):
            pass
    evidence = dict(scope='真实Vue界面，全部API/WS隔离模拟；不创建账号、不写数据库',
                    status='incomplete', smoke=args.smoke, passed=[], screenshots=[], layouts=[], requests=[])
    evidence['history'] = history
    current = '浏览器启动'
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                for name, check in [('默认/切换/草稿', smoke)] + ([] if args.smoke else [
                    ('存储降级', storage_cases), ('结算预览和短时窗口', settlement),
                    ('响应式布局', layouts), ('空/错误状态', states)]):
                    current = name
                    await check(browser, origin, evidence)
                evidence['status'] = 'passed'
            finally:
                await browser.close()
    except Exception as error:
        evidence.update(status='failed', failedCheck=current, errorType=type(error).__name__, reason=str(error)[:1600])
    finally:
        evidence['finishedAt'] = datetime.now(timezone.utc).isoformat()
        evidence['summary'] = dict(passed=len(evidence['passed']), screenshots=len(evidence['screenshots']),
                                   layoutChecks=len(evidence['layouts']), apiRequests=len(evidence['requests']),
                                   businessMutations=[item for item in evidence['requests'] if item['method'] != 'GET'])
        OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(dict(status=evidence['status'], **evidence['summary']), ensure_ascii=True), flush=True)
        if evidence['status'] != 'passed':
            print(evidence.get('failedCheck', '') + ': ' + evidence.get('reason', ''), flush=True)
    return 0 if evidence['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
