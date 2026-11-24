"""短时结算窗口本机浏览器验收；只在明确授权后运行，保留虚构数据。"""
import json
import os
import re
from pathlib import Path
import secrets
import sys
import time
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright, expect

ORIGIN = 'http://127.0.0.1:5174'
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/development/evidence'
PANEL = 'section[aria-label="转账确认预览"]'
result = {'date': '2026-11-19', 'scope': '本机heji_dev，3个新虚构账号、3本账本及关联事实',
          'tool': '现有Python Playwright / Chromium，内置浏览器检查匿名入口',
          'cases': [], 'screenshots': [], 'requests': [], 'pageErrors': [],
          'newLoadExecuted': False, 'cleanupExecuted': False}
state = {}


def save():
    if 'completedAt' in result:
        latest = {x['name']: x for x in result['cases']}
        result['finalCases'] = list(latest.values())
        required = {'bootstrap', 'normal_confirmation', 'empty_responsive', 'blocked_drafts_and_owner_close',
                    'expiry_network_and_refresh', 'lost_responses', 'retry_intents', 'final_state'}
        result['status'] = 'passed' if required.issubset(latest) and all(x['status'] == 'passed' for x in latest.values()) and not result['pageErrors'] else 'incomplete'
    OUT.mkdir(exist_ok=True)
    (OUT / 'm4-window-browser-ui-2026-11-19.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def check(name, action):
    """只记录场景及状态，异常正文可能含请求数据，不输出。"""
    try:
        detail = action()
        result['cases'].append({'name': name, 'status': 'passed', 'detail': detail})
        print(json.dumps({'case': name, 'status': 'passed', 'detail': detail}, ensure_ascii=True), flush=True)
    except Exception as error:
        import traceback
        frames = [{'function': frame.name, 'line': frame.lineno} for frame in traceback.extract_tb(error.__traceback__)]
        result['cases'].append({'name': name, 'status': 'failed', 'errorType': type(error).__name__, 'frames': frames})
        print(json.dumps({'case': name, 'status': 'failed', 'errorType': type(error).__name__, 'frames': frames}), flush=True)
        save()
        raise
    save()


def api(page, path, method='GET', body=None, key=None, expected=200):
    data = page.evaluate("""async ({path,method,body,key}) => {
      const csrf = await (await fetch('/api/v1/auth/csrf')).json();
      const response = await fetch('/api/v1'+path, {method,
        headers: method==='GET'?{}:{'Content-Type':'application/json',
          'X-CSRF-Token':csrf.data.csrfToken,'Idempotency-Key':key??crypto.randomUUID()},
        ...(method==='GET'?{}:{body:JSON.stringify(body??{})})});
      const payload=response.status===204?{}:await response.json();
      return {status:response.status,data:payload.data,code:payload.error?.code};
    }""", {'path': path, 'method': method, 'body': body, 'key': key})
    if expected is not None:
        assert data['status'] == expected or (expected == 200 and data['status'] == 201), 'API状态不符'
    return data


def data(page, path, method='GET', body=None):
    return api(page, path, method, body).get('data')


def capture(page, label):
    def observed(req):
        from urllib.parse import urlparse
        path = urlparse(req.url).path
        if '/api/v1/books/' in path:
            result['requests'].append({'actor': label, 'path': path, 'method': req.method})
    page.on('request', observed)
    def responded(response):
        from urllib.parse import urlparse
        path = urlparse(response.url).path
        if '/api/v1/books/' in path or path == '/api/v1/invitations/accept':
            result.setdefault('responses', []).append({'actor': label, 'path': path,
                                                       'method': response.request.method, 'status': response.status})
    page.on('response', responded)
    page.on('pageerror', lambda _: result['pageErrors'].append({'actor': label, 'kind': 'pageerror'}))


def shot(page, name):
    filename = 'm4-window-ui-' + name + '-2026-11-19.png'
    page.screenshot(path=str(OUT / filename), full_page=True)
    result['screenshots'].append(filename)


def go(page, book, tab='settlement'):
    page.goto(ORIGIN + book['path'] + '?tab=' + tab)
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('heading', name=book['name'], exact=True)).to_be_visible()


def panel(page):
    return page.locator(PANEL)


def open_review(page):
    page.get_by_role('button', name='核对并预览', exact=True).first.click()
    expect(panel(page)).to_be_visible()
    expect(panel(page).get_by_role('button', name='申请短时结算窗口', exact=True)).to_be_enabled()


def acquire(page):
    panel(page).get_by_role('button', name='申请短时结算窗口', exact=True).click()
    expect(panel(page).get_by_text('已取得短时窗口。以下是最新预览，请重新核对并勾选。', exact=True)).to_be_visible()
    expect(panel(page).locator('input[type=checkbox]')).not_to_be_checked()
    expect(panel(page).get_by_role('button', name='确认收到款项', exact=True)).to_be_disabled()


def create_request(book, amount='5000', note='窗口浏览器虚构登记'):
    request = data(a, book['path'] + '/transfer-requests', 'POST', {
        'toMemberId': book['bMember'], 'amountFen': amount, 'occurredOn': '2026-11-19', 'note': note})
    return request


def wait_ready(book):
    current = data(a, book['path'] + '/settlement-window')
    while current['state'] == 'ACTIVE' or (current.get('cooldownUntil') and datetime.fromisoformat(current['cooldownUntil'].replace('Z', '+00:00')) > datetime.now(timezone.utc)):
        time.sleep(1)
        current = data(a, book['path'] + '/settlement-window')
    return current


def reload_helpers():
    """交互验收时更新辅助函数，保留进程内账号和本轮数据。"""
    import ast
    source = Path(__file__).read_text(encoding='utf-8')
    tree = ast.parse(source)
    for item in tree.body:
        if isinstance(item, ast.FunctionDef):
            exec(compile(ast.Module(body=[item], type_ignores=[]), __file__, 'exec'), globals())


def bootstrap():
    """只执行一次；账号密码与邀请仅在当前进程内流转。"""
    users = []
    for index, page in enumerate((a, b, c)):
        page.goto(ORIGIN + '/register')
        page.wait_for_load_state('networkidle')
        page.get_by_label('昵称', exact=True).fill('窗口演示' + ('甲', '乙', '丙')[index])
        page.get_by_label('邮箱', exact=True).fill('window-ui-' + secrets.token_hex(10) + '@example.com')
        page.get_by_label('密码', exact=True).fill('Window-UI-' + secrets.token_urlsafe(28) + '!1aA')
        page.get_by_role('button', name='注册并登录', exact=True).click()
        page.wait_for_url(ORIGIN + '/books')
        page.wait_for_load_state('networkidle')
        users.append(data(page, '/auth/me'))
    for name in ('正常核对', '到期及故障', '空账本'):
        book = data(a, '/books', 'POST', {'name': '窗口浏览器虚构验收·' + name})
        book['path'] = '/books/' + book['id']
        if name != '空账本':
            invitation = data(a, book['path'] + '/invitations', 'POST', {})
            data(b, '/invitations/accept', 'POST', {'token': invitation['token']})
            members = data(a, book['path'] + '/members')
            book['aMember'] = next(m['id'] for m in members if m['userId'] == users[0]['id'])
            book['bMember'] = next(m['id'] for m in members if m['userId'] == users[1]['id'])
            data(b, book['path'] + '/expenses', 'POST', {
                'paidByMemberId': book['bMember'], 'amountFen': '10000', 'splitMode': 'EQUAL',
                'participantMemberIds': [book['aMember'], book['bMember']], 'category': 'FOOD',
                'occurredOn': '2026-11-19', 'note': '本轮虚构开销100元'})
            book['request'] = create_request(book)
        state[name] = book
    result['accountsCreated'] = 3
    result['booksCreated'] = [{'id': x['id'], 'name': x['name']} for x in state.values()]
    result['startedAt'] = datetime.now(timezone.utc).isoformat()
    return {'accounts': 3, 'books': 3, 'sessions': 3}


def normal():
    book = state['正常核对']
    go(b, book)
    before = sum(x['method'] == 'POST' and x['path'].endswith('/settlement-window') for x in result['requests'])
    open_review(b)
    assert data(b, book['path'] + '/settlement-window')['state'] == 'NONE'
    assert before == sum(x['method'] == 'POST' and x['path'].endswith('/settlement-window') for x in result['requests'])
    panel(b).locator('input[type=checkbox]').check()
    acquire(b)
    state['normalWindow'] = data(b, book['path'] + '/settlement-window')
    shot(b, 'active-desktop')
    panel(b).locator('input[type=checkbox]').check()
    with b.expect_request('**/transfer-requests/*/confirm') as sent:
        panel(b).get_by_role('button', name='确认收到款项', exact=True).click()
    body = sent.value.post_data_json
    assert body['expectedWindowId'] == state['normalWindow']['windowId']
    assert isinstance(body['expectedFinancialVersion'], int) or isinstance(body['expectedFinancialVersion'], str)
    assert 'expectedRequestRevision' in body
    expect(b.get_by_text('双方确认已保存，当前余额已重新计算。', exact=True)).to_be_visible()
    transfers = data(b, book['path'] + '/transfers')
    assert len(transfers) == 1
    assert data(b, book['path'] + '/balances')['isSettled']
    assert data(b, book['path'] + '/settlement-window')['state'] != 'ACTIVE'
    shot(b, 'confirmed')
    return {'confirmPosts': 1, 'transfers': 1, 'settled': True, 'bothVersionsAndWindowId': True}


def layout():
    book = state['空账本']
    go(a, book)
    expect(a.get_by_text('没有待确认的转账或冲正请求。', exact=True)).to_be_visible()
    assert data(a, book['path'] + '/settlement-window')['state'] == 'NONE'
    sizes = []
    for width in (360, 390, 768, 1440):
        a.set_viewport_size({'width': width, 'height': 900})
        dimensions = a.evaluate('({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})')
        assert dimensions['client'] == dimensions['scroll'] == width
        assert not a.locator('vite-error-overlay').count()
        sizes.append(dimensions)
        shot(a, 'empty-' + str(width))
    a.set_viewport_size({'width': 1440, 'height': 1000})
    return {'emptyState': True, 'noAutomaticWindow': True, 'widths': sizes}


def blocked_drafts_and_owner_close():
    book = state['到期及故障']
    invitation = data(a, book['path'] + '/invitations', 'POST', {})
    c.goto(ORIGIN + '/books')
    c.goto(ORIGIN + '/join#' + invitation['token'])
    c.wait_for_load_state('networkidle')
    expect(c.get_by_role('button', name='确认加入账本', exact=True)).to_be_visible()
    go(a, book)
    a.get_by_label('收款人').select_option(book['bMember'])
    a.get_by_label('转账金额（元）', exact=True).fill('1.23')
    a.get_by_label('转账说明', exact=True).fill('受阻转账草稿保留')
    go(b, book)
    open_review(b)
    acquire(b)
    state['closedByOwnerWindow'] = data(b, book['path'] + '/settlement-window')
    panel(b).locator('input[type=checkbox]').check()
    with a.expect_response('**/transfer-requests') as blocked:
        a.get_by_role('button', name='提交转账登记', exact=True).click()
    assert blocked.value.status == 409
    expect(a.get_by_label('转账金额（元）', exact=True)).to_have_value('1.23')
    expect(a.get_by_label('转账说明', exact=True)).to_have_value('受阻转账草稿保留')
    a.get_by_role('button', name='明细', exact=True).click()
    a.get_by_role('button', name='新增开销', exact=True).click()
    editor = a.locator('section[aria-label="开销录入表单"]')
    editor.get_by_label('开销金额（元）', exact=True).fill('2.34')
    editor.get_by_label('备注', exact=True).fill('受阻开销草稿保留')
    with a.expect_response('**/expenses') as expense_blocked:
        editor.get_by_role('button', name='保存开销', exact=True).click()
    assert expense_blocked.value.status == 409
    expect(editor.get_by_label('开销金额（元）', exact=True)).to_have_value('2.34')
    expect(editor.get_by_label('备注', exact=True)).to_have_value('受阻开销草稿保留')
    expect(a.get_by_role('alert').filter(has_text='核对')).to_be_visible()
    shot(a, 'blocked-draft')
    with c.expect_response('**/invitations/accept') as join_blocked:
        c.get_by_role('button', name='确认加入账本', exact=True).click()
    assert join_blocked.value.status == 409
    expect(c.get_by_role('alert')).to_contain_text('核对')
    a.get_by_role('button', name=re.compile('^结算')).click()
    expect(a.get_by_role('button', name='关闭当前结算窗口', exact=True)).to_be_visible()
    a.get_by_role('button', name='关闭当前结算窗口', exact=True).click()
    expect(a.locator('section[aria-label="账本结算窗口"]')).not_to_be_visible()
    b.get_by_role('button', name='明细', exact=True).click()
    b.get_by_role('button', name=re.compile('^结算')).click()
    expect(panel(b).locator('input[type=checkbox]')).not_to_be_checked()
    expect(panel(b).get_by_role('button', name='确认收到款项', exact=True)).to_be_disabled()
    expect(panel(b).get_by_text('结算窗口已结束或被关闭，请重新打开预览并核对。', exact=True)).to_be_visible()
    a.get_by_role('button', name='明细', exact=True).click()
    expect(editor.get_by_label('开销金额（元）', exact=True)).to_have_value('2.34')
    with a.expect_request('**/expenses') as retried:
        editor.get_by_role('button', name='保存开销', exact=True).click()
    expect(a.get_by_text('支出已保存', exact=True)).to_be_visible()
    state['afterReleaseExpenseKey'] = retried.value.header_value('idempotency-key')
    return {'expenseBlocked': 409, 'requestBlocked': 409, 'joinBlocked': 409,
            'draftsRetained': True, 'ownerClosedOthersWindow': True, 'tabReturnInvalidated': True,
            'explicitExpenseRetrySucceeded': True}


def expiry_network_and_refresh():
    book = state['到期及故障']
    wait_ready(book)
    go(b, book)
    open_review(b)
    acquire(b)
    current = data(b, book['path'] + '/settlement-window')
    state['expiryWindow'] = current
    panel(b).locator('input[type=checkbox]').check()
    for width in (360, 390, 768, 1440):
        b.set_viewport_size({'width': width, 'height': 1000})
        assert b.evaluate('document.documentElement.clientWidth===document.documentElement.scrollWidth')
        shot(b, 'active-' + str(width))
    # 仅拦截窗口GET；账本会话、财务写入不作伪造。
    b.route('**/settlement-window', lambda route: route.abort() if route.request.method == 'GET' else route.continue_())
    panel(b).get_by_role('button', name='检查窗口状态', exact=True).click()
    expect(panel(b).get_by_text('连接中断，请检查网络后重试', exact=True)).to_be_visible()
    expect(panel(b).locator('input[type=checkbox]')).not_to_be_checked()
    expect(panel(b).get_by_role('button', name='确认收到款项', exact=True)).to_be_disabled()
    shot(b, 'state-network-error')
    b.unroute('**/settlement-window')
    panel(b).get_by_role('button', name='检查窗口状态', exact=True).click()
    expect(panel(b).locator('input[type=checkbox]')).to_be_enabled()
    expect(panel(b).locator('input[type=checkbox]')).not_to_be_checked()
    panel(b).locator('input[type=checkbox]').check()
    # 同一登录的另一标签显式补查，不申请或续期。
    sibling = contexts[1].new_page()
    capture(sibling, '乙-第二标签')
    go(sibling, book)
    expect(sibling.get_by_text('你正在核对结算，本账本其他财务写入暂时暂停。窗口到期自动解除。', exact=True)).to_be_visible()
    assert data(sibling, book['path'] + '/settlement-window')['windowId'] == current['windowId']
    sibling.close()
    panel(b).locator('input[type=checkbox]').check()
    remaining = (datetime.fromisoformat(current['expiresAt'].replace('Z', '+00:00')) - datetime.now(timezone.utc)).total_seconds()
    if remaining > 0:
        b.wait_for_timeout((remaining + .6) * 1000)
    expect(panel(b).locator('input[type=checkbox]')).not_to_be_checked()
    expect(panel(b).get_by_role('button', name='确认收到款项', exact=True)).to_be_disabled()
    shot(b, 'expired')
    panel(b).get_by_role('button', name='重新打开预览', exact=True).click()
    with b.expect_response('**/transfer-requests/*/settlement-window') as cooldown:
        panel(b).get_by_role('button', name='申请短时结算窗口', exact=True).click()
    assert cooldown.value.status == 409
    expect(b.get_by_role('alert').filter(has_text='冷却')).to_be_visible()
    resumed = data(a, book['path'] + '/expenses', 'POST', {
        'paidByMemberId': book['aMember'], 'amountFen': '100', 'splitMode': 'EQUAL',
        'participantMemberIds': [book['aMember'], book['bMember']], 'category': 'FOOD',
        'occurredOn': '2026-11-19', 'note': '到期后普通写入恢复'})
    b.reload()
    b.wait_for_load_state('networkidle')
    assert not panel(b).count()
    assert data(b, book['path'] + '/settlement-window')['windowId'] == current['windowId']
    return {'stateFailureDisabled': True, 'recoveryDidNotAcknowledge': True,
            'crossTabNoRenewal': True, 'naturalExpiryDisabled': True,
            'cooldownStatus': 409, 'ordinaryWriteResumed': bool(resumed['id']), 'refreshNoAutomaticPreview': True}


def lost_responses():
    book = state['正常核对']
    wait_ready(book)
    if 'lostRequest' not in state:
        state['lostRequest'] = create_request(book, '100', '响应丢失虚构登记')
    request = state['lostRequest']
    go(b, book)
    open_review(b)
    opened = []
    def lose_open(route):
        if route.request.method != 'POST':
            return route.continue_()
        response = route.fetch()
        opened.append({'key': route.request.header_value('idempotency-key'), 'data': response.json()['data']})
        route.abort()
    b.route('**/transfer-requests/*/settlement-window', lose_open)
    panel(b).get_by_role('button', name='申请短时结算窗口', exact=True).click()
    expect(b.get_by_role('alert').filter(has_text='连接中断')).to_be_visible()
    expect(panel(b).get_by_role('button', name='确认收到款项', exact=True)).to_be_disabled()
    b.unroute('**/transfer-requests/*/settlement-window')
    with b.expect_request('**/transfer-requests/*/settlement-window') as replay:
        panel(b).get_by_role('button', name='重试原窗口申请', exact=True).click()
    expect(panel(b).get_by_text('已取得短时窗口。以下是最新预览，请重新核对并勾选。', exact=True)).to_be_visible()
    current = data(b, book['path'] + '/settlement-window')
    assert replay.value.header_value('idempotency-key') == opened[0]['key']
    assert current['windowId'] == opened[0]['data']['window']['windowId']
    assert current['expiresAt'] == opened[0]['data']['window']['expiresAt']
    old = state['normalWindow']
    rejected = api(a, book['path'] + '/settlement-windows/' + old['windowId'] + '/close', 'POST', {}, expected=409)
    assert rejected['code'] == 'SETTLEMENT_WINDOW_EXPIRED'
    assert data(b, book['path'] + '/settlement-window')['windowId'] == current['windowId']
    assert data(b, book['path'] + '/settlement-window')['state'] == 'ACTIVE'
    confirmations = []
    def lose_confirm(route):
        response = route.fetch()
        confirmations.append({'key': route.request.header_value('idempotency-key'), 'body': route.request.post_data_json,
                              'status': response.status})
        route.abort()
    b.route('**/transfer-requests/*/confirm', lose_confirm)
    panel(b).locator('input[type=checkbox]').check()
    # 真实双击，busy保护应只发一个POST。
    panel(b).get_by_role('button', name='确认收到款项', exact=True).dblclick()
    expect(b.get_by_role('alert').filter(has_text='连接中断')).to_be_visible()
    b.wait_for_timeout(400)
    assert len(confirmations) == 1 and confirmations[0]['status'] == 200
    expect(panel(b).locator('input[type=checkbox]')).not_to_be_checked()
    expect(panel(b).get_by_role('button', name='确认收到款项', exact=True)).to_be_disabled()
    assert len(data(b, book['path'] + '/transfers')) == 2
    b.unroute('**/transfer-requests/*/confirm')
    # 用户明确核对结果后，原键及新键重放均不能重复入账。
    path = book['path'] + '/transfer-requests/' + request['id'] + '/confirm'
    assert next(r for r in data(b, book['path'] + '/transfer-requests') if r['id'] == request['id'])['status'] == 'CONFIRMED'
    api(b, path, 'POST', confirmations[0]['body'], confirmations[0]['key'])
    api(b, path, 'POST', confirmations[0]['body'])
    assert len(data(b, book['path'] + '/transfers')) == 2
    shot(b, 'confirm-response-lost')
    return {'openRetrySameKeyIdExpiry': True, 'oldCloseIdDidNotAffectNew': True,
            'doubleClickConfirmPosts': 1, 'confirmCommittedDespiteLostResponse': True,
            'automaticConfirmRetries': 0, 'originalAndNewKeyReplayAddedTransfers': 0}


def retry_intents():
    book = state['到期及故障']
    wait_ready(book)
    go(a, book)
    a.get_by_label('收款人').select_option(book['bMember'])
    a.get_by_label('转账金额（元）', exact=True).fill('0.01')
    a.get_by_label('转账说明', exact=True).fill('原意图显式重试')
    go(b, book)
    open_review(b)
    acquire(b)
    a.get_by_role('button', name='明细', exact=True).click()
    a.get_by_role('button', name='新增开销', exact=True).click()
    editor = a.locator('section[aria-label="开销录入表单"]')
    editor.get_by_label('开销金额（元）', exact=True).fill('0.02')
    editor.get_by_label('备注', exact=True).fill('原意图显式重试')
    with a.expect_request('**/expenses') as expense_first:
        editor.get_by_role('button', name='保存开销', exact=True).click()
    expect(a.get_by_role('alert').filter(has_text='核对')).to_be_visible()
    a.get_by_role('button', name=re.compile('^结算')).click()
    with a.expect_request('**/transfer-requests') as request_first:
        a.get_by_role('button', name='提交转账登记', exact=True).click()
    expect(a.get_by_role('alert').filter(has_text='核对')).to_be_visible()
    before = len([x for x in result['requests'] if x['actor'] == '甲' and x['method'] == 'POST'])
    a.wait_for_timeout(300)
    assert before == len([x for x in result['requests'] if x['actor'] == '甲' and x['method'] == 'POST'])
    panel(b).get_by_role('button', name='关闭窗口', exact=True).click()
    expect(panel(b).get_by_role('button', name='确认收到款项', exact=True)).to_be_disabled()
    expect(a.get_by_label('转账金额（元）', exact=True)).to_have_value('0.01')
    expect(a.get_by_label('转账说明', exact=True)).to_have_value('原意图显式重试')
    with a.expect_request('**/transfer-requests') as request_retry:
        a.get_by_role('button', name='提交转账登记', exact=True).click()
    expect(a.get_by_text('已登记，等待对方确认；当前余额尚未改变。', exact=True)).to_be_visible()
    assert request_first.value.header_value('idempotency-key') == request_retry.value.header_value('idempotency-key')
    a.get_by_role('button', name='明细', exact=True).click()
    expect(editor.get_by_label('开销金额（元）', exact=True)).to_have_value('0.02')
    with a.expect_request('**/expenses') as expense_retry:
        editor.get_by_role('button', name='保存开销', exact=True).click()
    expect(a.get_by_text('支出已保存', exact=True)).to_be_visible()
    assert expense_first.value.header_value('idempotency-key') == expense_retry.value.header_value('idempotency-key')
    return {'requestRetrySameKey': True, 'expenseRetrySameKey': True, 'automaticPostLoop': False,
            'bothDraftsPreserved': True, 'explicitRetriesSucceeded': True}


def final_state():
    rows = []
    for book in state.values():
        if not isinstance(book, dict) or 'path' not in book:
            continue
        balances = data(a, book['path'] + '/balances')
        requests = data(a, book['path'] + '/transfer-requests')
        transfers = data(a, book['path'] + '/transfers')
        window = data(a, book['path'] + '/settlement-window')
        expenses = data(a, book['path'] + '/expenses?limit=100')['items']
        assert window['state'] != 'ACTIVE'
        rows.append({'bookId': book['id'], 'name': book['name'], 'members': len(data(a, book['path'] + '/members')),
                     'expenseCount': len(expenses), 'requestCount': len(requests), 'confirmedTransferCount': len(transfers),
                     'financialVersion': balances['financialVersion'], 'settled': balances['isSettled'], 'windowState': window['state']})
    assert len(rows) == 3
    assert not result['pageErrors']
    result['retainedBooks'] = rows
    result['activeWindowsInTestBooks'] = 0
    go(b, state['正常核对'])
    b.set_viewport_size({'width': 390, 'height': 844})
    b.evaluate('window.scrollTo(0,0)')
    filename = 'm4-window-ui-result-mobile-2026-11-19.png'
    b.screenshot(path=str(OUT / filename))
    result['screenshots'].append(filename)
    return {'retainedBooks': 3, 'activeWindows': 0, 'pageErrors': 0}


if __name__ == '__main__':
    if os.environ.get('HEJI_ALLOW_WINDOW_UI') != 'yes':
        raise SystemExit('须先获得本轮3账号/3账本浏览器写入授权，并设置HEJI_ALLOW_WINDOW_UI=yes')
    with sync_playwright() as playwright:
        driver = playwright.chromium.launch(headless=True)
        contexts = [driver.new_context(viewport={'width': 1440, 'height': 1000}) for _ in range(3)]
        a, b, c = [context.new_page() for context in contexts]
        for label, page in zip(('甲', '乙', '丙'), (a, b, c)):
            capture(page, label)
        print('READY:仅接受本轮验收指令，不输出凭据。', flush=True)
        try:
            if '--run-all' in sys.argv:
                for name, action in [('bootstrap', bootstrap), ('normal_confirmation', normal),
                                     ('empty_responsive', layout), ('blocked_drafts_and_owner_close', blocked_drafts_and_owner_close),
                                     ('expiry_network_and_refresh', expiry_network_and_refresh), ('lost_responses', lost_responses),
                                     ('retry_intents', retry_intents), ('final_state', final_state)]:
                    check(name, action)
                raise SystemExit(0)
            for line in sys.stdin:
                try:
                    command = json.loads(line)
                    if command == 'finish':
                        break
                    exec(command)
                    print('COMMAND_DONE', flush=True)
                except Exception as error:
                    print('COMMAND_ERROR:' + type(error).__name__, flush=True)
        finally:
            result['completedAt'] = datetime.now(timezone.utc).isoformat()
            save()
            for context in contexts:
                context.close()
            driver.close()
