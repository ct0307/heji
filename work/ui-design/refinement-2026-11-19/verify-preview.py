"""本机视觉原型验证；不连接业务API，不写数据库。"""
import json
from pathlib import Path
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright

BASE = Path(__file__).resolve().parent
ORIGIN = 'http://127.0.0.1:5174'
report = {'scope': '独立静态视觉预览', 'startedAt': datetime.now(timezone.utc).isoformat(),
          'layouts': [], 'comparisonLayouts': [], 'pageErrors': [], 'apiRequests': [], 'screenshots': []}


def layouts():
    (BASE / 'previews').mkdir(exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
        page.on('request', lambda request: report['apiRequests'].append(request.url)
                if '/api/' in request.url or '/ws' in request.url else None)
        for concept in ('a', 'b'):
            for route in ('overview', 'settlement'):
                for state in ('normal', 'empty', 'error'):
                    for width in (360, 390, 600, 760, 768, 1440):
                        page.set_viewport_size({'width': width, 'height': 1000 if width > 700 else 844})
                        page.goto(f'{ORIGIN}/{concept}.html?page={route}&state={state}')
                        page.wait_for_load_state('networkidle')
                        size = page.evaluate('({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})')
                        assert size['client'] == size['scroll'] == width, f'页面溢出: {concept}/{route}/{state}/{width} {size}'
                        assert page.title().strip() and len(page.locator('body').inner_text().strip()) > 30
                        targets = page.locator('.button,.attention-link,.preview-states button,.reset-preview').evaluate_all(
                            '(nodes) => nodes.filter(n => n.getClientRects().length).map(n => ({text:n.textContent.trim(),height:n.getBoundingClientRect().height}))')
                        assert all(target['height'] >= 44 for target in targets), f'主要点击区域不足44px: {concept}/{route}/{state}/{width} {targets}'
                        report['layouts'].append({'concept': concept, 'page': route, 'state': state, 'width': width, 'passed': True})
                        if state == 'normal' and width in (390, 1440):
                            name = f'{concept}-{route}-' + ('mobile' if width == 390 else 'desktop') + '.png'
                            page.screenshot(path=str(BASE / 'previews' / name), full_page=True)
                            report['screenshots'].append('previews/' + name)
        for width in (360, 390, 768, 1440):
            page.set_viewport_size({'width': width, 'height': 1000})
            page.goto(ORIGIN)
            page.wait_for_load_state('networkidle')
            size = page.evaluate('({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})')
            assert size['client'] == size['scroll'] == width, f'对比入口溢出: {width} {size}'
            report['comparisonLayouts'].append({'width': width, 'passed': True})
        assert not report['pageErrors'], '页面存在未处理异常'
        assert not report['apiRequests'], '静态预览不应请求业务API'
        context.close()
        browser.close()


if __name__ == '__main__':
    try:
        layouts()
        report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'failed'
        report['error'] = str(error)
        raise
    finally:
        report['completedAt'] = datetime.now(timezone.utc).isoformat()
        (BASE / 'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'status': report['status'], 'layouts': len(report['layouts']), 'pageErrors': len(report['pageErrors']),
                          'comparisonLayouts': len(report['comparisonLayouts']), 'apiRequests': len(report['apiRequests']), 'screenshots': len(report['screenshots'])}))
