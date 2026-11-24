"""邀请页换链接回归：接口全部模拟，不连接或写入数据库。"""
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/development/evidence/m4-invitation-refresh-ui-2026-11-19.json'
ORIGIN = 'http://127.0.0.1:5174'


async def main():
    evidence = {'scope': '仅真实Vue页面/模拟接口，无数据库写入', 'passed': [], 'status': 'incomplete'}
    async with async_playwright() as playwright:
        driver = await playwright.chromium.launch(headless=True)
        context = await driver.new_context()
        page = await context.new_page()
        slow_started = asyncio.Event()
        accept_started = asyncio.Event()

        async def mock(route):
            path = route.request.url.split('/api/v1', 1)[1]
            status, payload = 200, {'data': {}}
            if path == '/auth/csrf':
                payload = {'data': {'csrfToken': 'mock-csrf-only'}}
            elif path == '/auth/me':
                payload = {'data': {'id': '00000000-0000-4000-8000-000000000001', 'displayName': '模拟邀请用户'}}
            elif path == '/invitations/preview':
                token = route.request.post_data_json['token']
                if token == 'C' * 43:
                    slow_started.set()
                    await asyncio.sleep(.6)
                if token in ('A' * 43, 'C' * 43):
                    status, payload = 410, {'error': {'code': 'INVITATION_EXPIRED', 'message': '旧邀请已失效'}}
                else:
                    payload = {'data': {'bookName': '模拟新邀请' + token[0], 'alreadyJoined': False, 'rejoining': False}}
            elif path == '/invitations/accept':
                accept_started.set()
                await asyncio.sleep(.6)
                payload = {'data': {'id': '00000000-0000-4000-8000-000000000002', 'name': '模拟旧账本'}}
            else:
                status, payload = 404, {'error': {'code': 'MOCK_ONLY', 'message': '本测试不执行该操作'}}
            await route.fulfill(status=status, json=payload)

        await context.route('**/api/v1/**', mock)
        try:
            await page.goto(ORIGIN + '/join#' + 'A' * 43)
            await expect(page.get_by_role('alert')).to_have_text('旧邀请已失效')
            await page.goto(ORIGIN + '/join#' + 'B' * 43)
            await expect(page.get_by_role('heading', name='模拟新邀请B', exact=True)).to_be_visible(timeout=2500)
            await expect(page.get_by_role('alert')).to_have_count(0)
            evidence['passed'].append('同页新邀请替换旧错误及预览')
            await page.goto(ORIGIN + '/join#' + 'C' * 43)
            await asyncio.wait_for(slow_started.wait(), timeout=3)
            await page.goto(ORIGIN + '/join#' + 'D' * 43)
            await expect(page.get_by_role('heading', name='模拟新邀请D', exact=True)).to_be_visible()
            await page.wait_for_timeout(800)
            await expect(page.get_by_role('heading', name='模拟新邀请D', exact=True)).to_be_visible()
            await expect(page.get_by_role('alert')).to_have_count(0)
            evidence['passed'].append('旧410延迟响应不覆盖新预览或清除新邀请')
            await page.reload()
            await expect(page.get_by_role('heading', name='模拟新邀请D', exact=True)).to_be_visible()
            assert '#' not in page.url
            evidence['passed'].append('刷新保留当前邀请且地址栏无token')
            await page.get_by_role('button', name='确认加入账本', exact=True).click()
            await asyncio.wait_for(accept_started.wait(), timeout=3)
            await page.goto(ORIGIN + '/join#' + 'E' * 43)
            await expect(page.get_by_role('heading', name='模拟新邀请E', exact=True)).to_be_visible()
            await page.wait_for_timeout(800)
            await expect(page.get_by_role('heading', name='模拟新邀请E', exact=True)).to_be_visible()
            await expect(page.get_by_role('button', name='确认加入账本', exact=True)).to_be_enabled()
            await page.reload()
            await expect(page.get_by_role('heading', name='模拟新邀请E', exact=True)).to_be_visible()
            evidence['passed'].append('旧加入响应不清新邀请或跳转旧账本')
            await page.set_viewport_size({'width': 390, 'height': 844})
            assert await page.evaluate('document.documentElement.clientWidth===document.documentElement.scrollWidth')
            evidence['mobileWidth'] = 390
            evidence['status'] = 'passed'
        except Exception as error:
            evidence['errorType'] = type(error).__name__
            raise
        finally:
            OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(evidence, ensure_ascii=True))
            await context.close()
            await driver.close()


if __name__ == '__main__':
    asyncio.run(main())
