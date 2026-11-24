import secrets
from playwright.sync_api import sync_playwright

ORIGIN = 'http://127.0.0.1:5174'


def api(page, path, method='GET', body=None):
    result = page.evaluate("""async ({path,method,body}) => {
      const csrfResponse = await fetch('/api/v1/auth/csrf', {credentials:'same-origin'});
      const csrfText = await csrfResponse.text();
      let csrfBody;
      try { csrfBody = JSON.parse(csrfText); }
      catch { return {status:csrfResponse.status,error:{code:'CSRF_RESPONSE_NOT_JSON'},diagnostic:{contentType:csrfResponse.headers.get('content-type'),bytes:csrfText.length,url:csrfResponse.url}}; }
      if (typeof csrfBody.data?.csrfToken !== 'string') {
        return {status:csrfResponse.status,error:{code:'CSRF_TOKEN_MISSING'},diagnostic:{contentType:csrfResponse.headers.get('content-type'),bytes:csrfText.length,url:csrfResponse.url}};
      }
      const headers = method === 'GET' ? {} : {
        'Content-Type':'application/json',
        'X-CSRF-Token':csrfBody.data.csrfToken,
        'Idempotency-Key':crypto.randomUUID()
      };
      const response = await fetch('/api/v1'+path, {
        method, credentials:'same-origin', headers,
        ...(method === 'GET' ? {} : {body:JSON.stringify(body ?? {})})
      });
      const payload = response.status === 204 ? {} : await response.json();
      return {status:response.status,data:payload.data,error:payload.error};
    }""", {'path':path,'method':method,'body':body})
    if not 200 <= result['status'] < 300:
        code = result.get('error', {}).get('code', 'UNKNOWN')
        diagnostic = result.get('diagnostic', {})
        raise AssertionError(f'API {method} {path} failed: {result["status"]} {code} {diagnostic}')
    return result.get('data')


def register(page, label):
    page.goto(ORIGIN + '/register')
    page.wait_for_load_state('networkidle')
    suffix = secrets.token_urlsafe(12).replace('-', '').replace('_', '')
    return api(page, '/auth/register', 'POST', {
        'email':f'm4-preview-{suffix}@example.com',
        'displayName':f'M4预览测试{label}',
        'password':'M4-UI-'+secrets.token_urlsafe(24)+'aA1!'
    })


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    owner_context = browser.new_context()
    reviewer_context = browser.new_context()
    owner_page = owner_context.new_page()
    reviewer_page = reviewer_context.new_page()

    owner = register(owner_page, '发起方')
    owner_page.goto(ORIGIN+'/books')
    owner_page.wait_for_load_state('networkidle')
    reviewer = register(reviewer_page, '确认方')
    reviewer_page.goto(ORIGIN+'/books')
    reviewer_page.wait_for_load_state('networkidle')
    book = api(owner_page, '/books', 'POST', {'name':'M4预览过期虚构验收'})
    book_path = '/books/' + book['id']
    invitation = api(owner_page, book_path+'/invitations', 'POST', {})
    api(reviewer_page, '/invitations/accept', 'POST', {'token':invitation['token']})
    members = api(owner_page, book_path+'/members')
    owner_member = next(x for x in members if x['userId'] == owner['user']['id'])
    reviewer_member = next(x for x in members if x['userId'] == reviewer['user']['id'])
    request = api(owner_page, book_path+'/transfer-requests', 'POST', {
        'toMemberId':reviewer_member['id'],
        'amountFen':'500',
        'occurredOn':'2026-11-18',
        'note':'M4预览过期虚构验收'
    })

    reviewer_page.goto(ORIGIN+book_path+'?tab=settlement')
    reviewer_page.wait_for_load_state('networkidle')
    reviewer_page.get_by_role('button', name='结算').click()
    reviewer_page.get_by_role('button', name='核对并预览').click()
    panel = reviewer_page.locator('section[aria-label="转账确认预览"]')
    panel.wait_for(state='visible')
    initial_balances = panel.locator('.preview-balances').inner_text()
    checkbox = panel.locator('input[type="checkbox"]')
    checkbox.check()

    api(owner_page, book_path+'/expenses', 'POST', {
        'paidByMemberId':owner_member['id'],
        'amountFen':'100',
        'splitMode':'EQUAL',
        'participantMemberIds':[owner_member['id'],reviewer_member['id']],
        'category':'FOOD',
        'occurredOn':'2026-11-18',
        'note':'M4预览过期触发支出'
    })

    observed = {'confirm_posts':[], 'preview_gets':0}
    def capture_request(req):
        if f'/transfer-requests/{request["id"]}/confirm' in req.url and req.method == 'POST':
            observed['confirm_posts'].append(req.url)
        if f'/transfer-requests/{request["id"]}/preview' in req.url and req.method == 'GET':
            observed['preview_gets'] += 1
    reviewer_page.on('request', capture_request)
    panel.get_by_role('button', name='确认收到款项').click()
    reviewer_page.get_by_text('以下是最新预览，请重新核对后确认。').wait_for()
    panel.wait_for(state='visible')
    assert panel.get_by_role('status').get_by_text('以下是最新预览，请重新核对后确认。').is_visible(), '版本变化提示未显示在确认面板内'
    assert not checkbox.is_checked(), '旧确认勾选未清除'
    assert panel.get_by_role('button', name='确认收到款项').is_disabled(), '新预览展示前确认按钮未禁用'
    assert panel.locator('.preview-balances').inner_text() != initial_balances, '预览没有反映账本最新余额'
    assert len(observed['confirm_posts']) == 1, '冲突后自动重发了确认请求'
    assert observed['preview_gets'] == 1, '冲突后未恰好执行一次预览刷新GET'

    checkbox.check()
    panel.get_by_role('button', name='确认收到款项').click()
    reviewer_page.get_by_text('双方确认已保存，当前余额已重新计算。').wait_for()
    assert len(observed['confirm_posts']) == 2, '用户重新确认没有恰好发送第二次确认请求'

    print('PREVIEW_STALE浏览器流程通过；随机虚构账号、账本和验收数据保留。')
    reviewer_context.close()
    owner_context.close()
    browser.close()
