"""双界面视觉精修回归：本地正式 Vue 页面，API/WS 全部隔离模拟。

运行前由调用者准备前端服务；不启动 API、不创建账号、不写数据库。
复用上轮隔离回归工具，独立保存本轮证据和截图，不覆盖旧验收结果。
"""
import asyncio
import copy
import importlib.util
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.async_api import expect


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("appearance_baseline", Path(__file__).with_name("appearance-ui.py"))
baseline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(baseline)
baseline.OUT = ROOT / "docs/development/evidence/ui-refinement-2026-11-19.json"
baseline.SHOTS = baseline.OUT.with_suffix("")
baseline.__doc__ = __doc__
BASE_FIXTURES = baseline.fixtures
BASE_LAYOUTS = baseline.layouts
BASE_NEW_PAGE = baseline.new_page
BASE_STATES = baseline.states


def refined_fixtures(empty=False):
    """同一组五笔均分消费，列表、统计、余额和确认预览保持守恒。"""
    data = BASE_FIXTURES(empty)
    data["book"]["name"] = "合租日常"
    data["members"][0]["displayName"] = "林清"
    data["members"][1]["displayName"] = "许宁"
    rows = []
    definitions = (
        ("dinner", 12000, baseline.OWN, "FOOD", "2026-11-18", "周末一起做晚餐"),
        ("transport", 5200, baseline.OTHER, "TRANSPORT", "2026-11-17", "采购往返车费"),
        ("housing", 34800, baseline.OWN, "HOUSING", "2026-11-16", "本月公共水电费"),
        ("supplies", 8600, baseline.OWN, "OTHER", "2026-11-15", "厨房清洁与日常用品"),
        ("groceries", 22400, baseline.OTHER, "FOOD", "2026-11-14", "一周的蔬菜与水果"),
    )
    template = BASE_FIXTURES(False)["expenses"][0]
    for identifier, amount, payer, category, date, note in definitions:
        rows.append(dict(template, id=identifier, amountFen=str(amount), paidByMemberId=payer,
                         createdByMemberId=payer, changedByMemberId=payer, category=category,
                         occurredOn=date, note=note,
                         shares=[dict(memberId=member, amountFen=str(amount // 2))
                                 for member in (baseline.OWN, baseline.OTHER)]))
    balances = [
        dict(memberId=baseline.OWN, paidFen="55400", shareFen="41500", incomingFen="0", outgoingFen="0", balanceFen="13900"),
        dict(memberId=baseline.OTHER, paidFen="27600", shareFen="41500", incomingFen="0", outgoingFen="0", balanceFen="-13900"),
    ]
    if empty:
        rows = []
        balances = [dict(item, paidFen="0", shareFen="0", balanceFen="0") for item in balances]
    data["expenses"] = rows
    data["snapshot"].update(balances=balances, expenseTotalFen="0" if empty else "83000",
                            suggestions=[] if empty else [dict(fromMemberId=baseline.OTHER,
                                                               toMemberId=baseline.OWN, amountFen="13900")])
    data["report"].update(
        expenseTotalFen=data["snapshot"]["expenseTotalFen"],
        categories=[] if empty else [dict(category=category, amountFen=amount) for category, amount in
                                     (("FOOD", "34400"), ("TRANSPORT", "5200"), ("HOUSING", "34800"), ("OTHER", "8600"))],
        members=[dict(memberId=item["memberId"], paidFen=item["paidFen"], shareFen=item["shareFen"]) for item in balances],
        ranking=[dict(memberId=item["memberId"], rankNo=1, amountFen=item["shareFen"]) for item in balances],
    )
    request = dict(data["preview"]["request"], amountFen="13900", note="共同开销的线下转账")
    after = [dict(item) if empty else
             dict(item, incomingFen="13900" if item["memberId"] == baseline.OWN else "0",
                  outgoingFen="13900" if item["memberId"] == baseline.OTHER else "0", balanceFen="0")
             for item in balances]
    data["requests"] = [] if empty else [request]
    data["preview"].update(request=request, beforeBalances=balances, afterBalances=after)
    assert sum(int(row["amountFen"]) for row in rows) == int(data["snapshot"]["expenseTotalFen"])
    assert sum(int(item["balanceFen"]) for item in balances) == 0
    if not empty:
        assert sum(int(item["paidFen"]) for item in balances) == 83000
        assert sum(int(item["shareFen"]) for item in balances) == 83000
    return data


class RefinedMockApi(baseline.MockApi):
    """分类和日期只在内存中筛选，不让任何真实 API 穿透。"""
    def __init__(self, origin, mode="normal"):
        super().__init__(origin, mode)
        self.filter_queries = []

    async def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        if request.method == "GET" and parsed.path == "/api/v1/auth/me":
            self.requests.append(dict(method="GET", path="/auth/me"))
            await route.fulfill(json={"data": dict(id=baseline.USER, email="mock@example.invalid", displayName="林清")})
            return
        if request.method == "GET" and parsed.path == "/api/v1/books/" + baseline.BOOK + "/expenses":
            query = parse_qs(parsed.query)
            self.filter_queries.append(query)
            self.requests.append(dict(method="GET", path="/books/" + baseline.BOOK + "/expenses"))
            rows = self.data["expenses"]
            if query.get("category"):
                rows = [row for row in rows if row["category"] == query["category"][0]]
            if query.get("from"):
                rows = [row for row in rows if row["occurredOn"] >= query["from"][0]]
            if query.get("to"):
                rows = [row for row in rows if row["occurredOn"] <= query["to"][0]]
            await route.fulfill(json={"data": dict(items=copy.deepcopy(rows), nextCursor=None)})
            return
        await super().route(route)


async def refined_new_page(browser, origin, **options):
    context, page, api = await BASE_NEW_PAGE(browser, origin, **options)

    def live_socket(socket):
        def message(raw):
            payload = json.loads(raw)
            if payload.get("type") == "SUBSCRIBE":
                socket.send(json.dumps(dict(type="SUBSCRIBED", bookId=payload["bookId"])))
        socket.on_message(message)

    # 保持模拟订阅在线，避免旧脚本的主动关连接引发定时重连补查干扰主题断言。
    await context.route_web_socket("**/*", live_socket)
    return context, page, api


async def visit_book(page, origin, tab="expenses"):
    await page.goto(origin + "/books/" + baseline.BOOK + "?tab=" + tab, wait_until="networkidle", timeout=10000)
    await expect(page.get_by_role("heading", name="合租日常", exact=True)).to_be_visible()
    await expect(page.locator(".sync-status")).to_have_attribute("data-state", "live")
    await page.wait_for_load_state("networkidle")


async def refined_smoke(browser, origin, evidence):
    context, page, api = await baseline.new_page(browser, origin)
    try:
        await visit_book(page, origin)
        await expect(page.locator("html")).to_have_attribute("data-interface", "a")
        dialog = await baseline.open_settings(page)
        await expect(dialog.get_by_role("radio", name=re.compile("A 雾青工作台"))).to_be_checked()
        await dialog.get_by_role("button", name="关闭界面设置", exact=True).click()
        baseline.passed(evidence, "新浏览器默认A且设置入口可用")
        await baseline.choose(page, "b")
        await page.reload(wait_until="networkidle")
        await expect(page.locator("html")).to_have_attribute("data-interface", "b")
        await baseline.choose(page, "a")
        await page.reload(wait_until="networkidle")
        await expect(page.locator("html")).to_have_attribute("data-interface", "a")
        baseline.passed(evidence, "A/B即时切换且刷新恢复当前浏览器选择")
        await expect(page.get_by_role("button", name=re.compile("记一笔"))).to_have_count(1)
        await expect(page.get_by_role("button", name="新增开销", exact=True)).to_have_count(0)
        await page.get_by_role("button", name=re.compile("记一笔")).click()
        amount = page.get_by_role("textbox", name="开销金额（元）", exact=True)
        note = page.get_by_role("textbox", name="备注", exact=True)
        await expect(amount).to_be_focused()
        baseline.passed(evidence, "唯一记账主入口且新建表单自动聚焦金额")
        await amount.fill("123.45")
        await note.fill("切换界面保留这份草稿，不提交")
        before = list(api.requests)
        for interface in ("b", "a"):
            await baseline.choose(page, interface)
            await expect(amount).to_have_value("123.45")
            await expect(note).to_have_value("切换界面保留这份草稿，不提交")
        assert api.requests == before, f"主题切换触发业务请求: {api.requests[len(before):]}"
        baseline.assert_isolated(api, page)
        baseline.passed(evidence, "金额与备注草稿跨主题保留且没有额外业务请求")
        dialog = await baseline.open_settings(page)
        await page.keyboard.press("Escape")
        await expect(dialog).not_to_be_visible()
        await expect(page.get_by_role("button", name="界面设置", exact=True)).to_be_focused()
        baseline.passed(evidence, "Escape关闭设置并恢复入口焦点")
    finally:
        evidence["requests"].extend(api.requests)
        await context.close()
    await filters(browser, origin, evidence)
    await settings_keyboard(browser, origin, evidence)


async def settings_keyboard(browser, origin, evidence):
    context, page, api = await baseline.new_page(browser, origin)
    try:
        await visit_book(page, origin)
        for width in (390, 1440):
            await page.set_viewport_size(dict(width=width, height=844))
            dialog = await baseline.open_settings(page)
            label = dialog.locator(".appearance-option:has(input[value='b'])")
            label_box = await label.bounding_box()
            preview_box = await label.locator(".appearance-preview").bounding_box()
            before = list(api.requests)
            await label.click(position=dict(x=preview_box["x"] - label_box["x"] + 5,
                                           y=preview_box["y"] - label_box["y"] + preview_box["height"] - 5))
            await expect(page.locator("html")).to_have_attribute("data-interface", "b")
            a = dialog.get_by_role("radio", name=re.compile("A 雾青工作台"))
            b = dialog.get_by_role("radio", name=re.compile("B 墨蓝账页"))
            await a.focus()
            await page.keyboard.press("ArrowRight")
            await expect(b).to_be_checked()
            await expect(b).to_be_focused()
            await page.keyboard.press("ArrowLeft")
            await expect(a).to_be_checked()
            await expect(page.locator("html")).to_have_attribute("data-interface", "a")
            assert api.requests == before, "设置卡片/箭头切换发起业务请求"
            await page.keyboard.press("Escape")
            await expect(page.get_by_role("button", name="界面设置", exact=True)).to_be_focused()
            baseline.passed(evidence, f"{width}px设置卡片预览区域可点、单选项箭头键切换及Escape焦点恢复")
        baseline.assert_isolated(api, page)
    finally:
        evidence["requests"].extend(api.requests)
        await context.close()


async def filters(browser, origin, evidence):
    context, page, api = await baseline.new_page(browser, origin)
    try:
        for interface in ("a", "b"):
            await visit_book(page, origin)
            await baseline.choose(page, interface)
            await page.set_viewport_size(dict(width=1440, height=900))
            disclosure = page.locator("details.expense-filter-disclosure")
            form = disclosure.locator("form.expense-filters")
            await expect(form).not_to_be_visible()
            summary = disclosure.locator("summary")
            await expect(summary).to_contain_text("筛选明细")
            await summary.focus()
            await page.keyboard.press("Enter")
            await expect(form).to_be_visible()
            start = form.get_by_label("开始日期", exact=True)
            end = form.get_by_label("结束日期", exact=True)
            category = form.get_by_role("combobox", name="分类筛选", exact=True)
            start_box, end_box = await start.bounding_box(), await end.bounding_box()
            assert abs(start_box["y"] - end_box["y"]) < 2, f"{interface}桌面起止日期未同排"
            await category.select_option("TRANSPORT")
            await start.fill("2026-11-17")
            await end.fill("2026-11-17")
            await form.get_by_role("button", name="筛选", exact=True).click()
            await expect(page.locator(".expense-rows > li")).to_have_count(1)
            await expect(page.locator(".expense-rows")).to_contain_text("采购往返车费")
            await expect(disclosure.get_by_text("已应用筛选", exact=True)).to_be_visible()
            assert api.filter_queries[-1]["category"] == ["TRANSPORT"]
            baseline.passed(evidence, f"界面{interface.upper()}筛选默认收起、键盘展开、桌面日期同排且按实际条件筛选")
            before = list(api.requests)
            for target in (("b" if interface == "a" else "a"), interface):
                await baseline.choose(page, target)
                await expect(form).to_be_visible()
                await expect(category).to_have_value("TRANSPORT")
                await expect(start).to_have_value("2026-11-17")
                await expect(end).to_have_value("2026-11-17")
                await expect(page.locator(".expense-rows > li")).to_have_count(1)
                await expect(disclosure.get_by_text("已应用筛选", exact=True)).to_be_visible()
            assert api.requests == before, f"主题切换重新提交或读取筛选结果: {api.requests[len(before):]}"
            baseline.passed(evidence, f"界面{interface.upper()}已展开筛选、输入及应用结果跨主题保留")
            await baseline.screenshot(page, evidence, f"{interface}-filters-1440")
            await start.fill("2026-11-19")
            before_filters = len(api.filter_queries)
            await form.get_by_role("button", name="筛选", exact=True).click()
            await expect(page.get_by_role("alert")).to_contain_text("开始日期不能晚于结束日期，输入已保留")
            await expect(start).to_have_value("2026-11-19")
            assert len(api.filter_queries) == before_filters, "非法日期发起请求"
            baseline.passed(evidence, f"界面{interface.upper()}非法日期保留输入并阻止请求")
            await category.select_option("")
            await start.fill("")
            await end.fill("")
            await form.get_by_role("button", name="筛选", exact=True).click()
            await expect(page.locator(".expense-rows > li")).to_have_count(5)
            await expect(disclosure.get_by_text("已应用筛选", exact=True)).not_to_be_visible()
            await summary.click()
            await expect(form).not_to_be_visible()
        baseline.assert_isolated(api, page)
    finally:
        evidence["requests"].extend(api.requests)
        await context.close()


async def refined_layouts(browser, origin, evidence):
    await BASE_LAYOUTS(browser, origin, evidence)
    context, page, api = await baseline.new_page(browser, origin)
    try:
        for interface in ("a", "b"):
            await visit_book(page, origin)
            await baseline.choose(page, interface)
            await page.set_viewport_size(dict(width=1440, height=900))
            await page.evaluate("scrollTo(0, 0)")
            first = page.locator(".expense-rows > li").first
            first_box = await first.bounding_box()
            assert first_box and first_box["y"] + first_box["height"] <= 900, f"{interface}桌面首屏看不到完整首条账目: {first_box}"
            await expect(page.get_by_role("button", name=re.compile("记一笔"))).to_have_count(1)
            await expect(page.locator(".expense-filters")).not_to_be_visible()
            primary = page.get_by_role("button", name=re.compile("记一笔"))
            primary_box = await primary.bounding_box()
            assert primary_box["height"] >= 44, f"{interface}主操作点击区域不足44px"
            evidence.setdefault("visualChecks", []).append(dict(interface=interface, viewport=1440,
                                                                  firstExpense=first_box, primaryAction=primary_box))
            baseline.passed(evidence, f"界面{interface.upper()}桌面首屏完整显示首条账目、主CTA唯一且触控区域至少44px")
            await page.set_viewport_size(dict(width=390, height=844))
            await page.evaluate("scrollTo(0, 0)")
            first_date = page.locator(".expense-rows > li .expense-date").first
            date_box = await first_date.bounding_box()
            usable_height = 779 if interface == "a" else 844
            assert date_box["y"] < usable_height, f"{interface}手机首条日期仍低于可视区域: {date_box} / {usable_height}"
            evidence["visualChecks"].append(dict(interface=interface, viewport=390,
                                                 firstDate=date_box, usableHeight=usable_height))
            baseline.passed(evidence, f"界面{interface.upper()}390px手机首条日期进入首屏有效区域")
            for width in (360, 390, 768, 1440):
                await page.set_viewport_size(dict(width=width, height=900 if width >= 768 else 844))
                disclosure = page.locator("details.expense-filter-disclosure")
                await disclosure.locator("summary").click()
                await expect(disclosure.locator("form")).to_be_visible()
                dimensions = await baseline.no_overflow(page, f"{interface}/{width}/expanded-filters")
                evidence["layouts"].append(dict(interface=interface, viewport=width,
                                                page="expanded-filters", **dimensions))
                if width == 390:
                    await baseline.screenshot(page, evidence, f"{interface}-filters-390")
                await disclosure.locator("summary").click()
        baseline.assert_isolated(api, page)
    finally:
        evidence["requests"].extend(api.requests)
        await context.close()


async def boundary_cases(browser, origin, evidence):
    context, page, api = await baseline.new_page(browser, origin)
    data = api.data
    data["members"][0]["displayName"] = "W" * 40
    data["members"][1]["displayName"] = "V" * 40
    for row in data["expenses"]:
        row["amountFen"] = "100000000"
        row["shares"] = [dict(memberId=member, amountFen="50000000") for member in (baseline.OWN, baseline.OTHER)]
    balances = [dict(data["snapshot"]["balances"][0], paidFen="300000000", shareFen="250000000", balanceFen="50000000"),
                dict(data["snapshot"]["balances"][1], paidFen="200000000", shareFen="250000000", balanceFen="-50000000")]
    data["snapshot"].update(balances=balances, expenseTotalFen="500000000",
                            suggestions=[dict(fromMemberId=baseline.OTHER, toMemberId=baseline.OWN, amountFen="50000000")])
    request = dict(data["preview"]["request"], amountFen="50000000")
    data["requests"] = [request]
    data["preview"].update(request=request, beforeBalances=balances,
        afterBalances=[dict(item, incomingFen="50000000" if item["memberId"] == baseline.OWN else "0",
                            outgoingFen="50000000" if item["memberId"] == baseline.OTHER else "0", balanceFen="0") for item in balances])
    data["report"].update(expenseTotalFen="500000000",
        categories=[dict(category=category, amountFen=value) for category, value in
                    (("FOOD", "200000000"), ("TRANSPORT", "100000000"), ("HOUSING", "100000000"), ("OTHER", "100000000"))],
        members=[dict(memberId=item["memberId"], paidFen=item["paidFen"], shareFen=item["shareFen"]) for item in balances],
        ranking=[dict(memberId=item["memberId"], rankNo=1, amountFen="250000000") for item in balances])
    try:
        for interface in ("a", "b"):
            for width in (360, 390):
                await visit_book(page, origin)
                await baseline.choose(page, interface)
                await page.set_viewport_size(dict(width=width, height=844))
                dimensions = await baseline.no_overflow(page, f"{interface}/{width}/long-names-max-amount")
                overlap = await page.locator(".expense-rows > li").first.evaluate("""row => {
                    const description=row.querySelector('.expense-description').getBoundingClientRect();
                    const amount=row.querySelector('.row-amount').getBoundingClientRect();
                    return Math.max(0,Math.min(description.right,amount.right)-Math.max(description.left,amount.left))*
                      Math.max(0,Math.min(description.bottom,amount.bottom)-Math.max(description.top,amount.top));
                }""")
                assert overlap < 1, f"{interface}/{width}长姓名与金额重叠: {overlap}"
                await expect(page.locator(".expense-rows .row-amount").first).to_have_text("¥1000000.00")
                number_lines = await text_line_counts(page.locator(".personal-balance .hero-number"), numeric=True)
                label_lines = await text_line_counts(page.locator(".overview-detail:not(.pending-shortcut) > .overview-label"))
                assert number_lines == [1], f"{interface}/{width}个人金额数字被拆行: {number_lines}"
                assert label_lines == [1], f"{interface}/{width}共同消费标签被挤成竖排: {label_lines}"
                await page.locator(".heading-actions .primary").click()
                await page.locator(".amount-input").fill("1000000")
                await expect(page.locator(".split-preview li")).to_have_count(2)
                await baseline.no_overflow(page, f"{interface}/{width}/long-names-split")
                assert await page.locator(".split-preview").evaluate("e=>e.scrollWidth<=e.clientWidth+1"), "分摊预览长姓名溢出"
                await page.get_by_role("button", name="关闭表单", exact=True).click()
                await page.get_by_role("navigation", name="账本导航", exact=True).get_by_role("button", name=re.compile("^结算")).click()
                await page.get_by_role("button", name="核对并预览", exact=True).click()
                await expect(page.locator(".preview-balances")).to_be_visible()
                await baseline.no_overflow(page, f"{interface}/{width}/long-names-preview")
                assert await page.locator(".preview-balances > div").evaluate_all("items=>items.every(e=>e.scrollWidth<=e.clientWidth+1)"), "确认预览长姓名溢出"
                balance_lines = await text_line_counts(page.locator(".balance-list > li > strong:visible"), numeric=True)
                assert balance_lines and all(count == 1 for count in balance_lines), f"{interface}/{width}成员余额的小数被拆行: {balance_lines}"
                evidence.setdefault("financialReadability", []).append(dict(interface=interface, viewport=width,
                    personalAmountNumericLines=number_lines, expenseTotalLabelLines=label_lines, memberBalanceNumericLines=balance_lines))
                evidence["layouts"].append(dict(interface=interface, viewport=width, page="long-names-max-amount", **dimensions))
                if width == 390:
                    await baseline.screenshot(page, evidence, f"{interface}-long-names-preview-{width}")
                baseline.passed(evidence, f"界面{interface.upper()}在{width}px的40字符昵称、单笔最高金额、累计余额与分摊/确认预览无溢出或重叠")
        baseline.assert_isolated(api, page)
    finally:
        evidence["requests"].extend(api.requests)
        await context.close()


async def text_line_counts(locator, *, numeric=False):
    return await locator.evaluate_all("""(elements,numeric) => elements.map(element => {
      const ranges=[];
      if(numeric){
        const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
        let node;
        while(node=walker.nextNode()){
          const match=node.textContent.match(/[0-9]+\\.[0-9]{2}/);
          if(match){const range=document.createRange();range.setStart(node,match.index);range.setEnd(node,match.index+match[0].length);ranges.push(range);break;}
        }
      } else {const range=document.createRange();range.selectNodeContents(element);ranges.push(range);}
      return new Set(ranges.flatMap(range=>[...range.getClientRects()].filter(rect=>rect.width>0).map(rect=>Math.round(rect.top)))).size;
    })""", numeric)


async def refined_states(browser, origin, evidence):
    await BASE_STATES(browser, origin, evidence)
    await boundary_cases(browser, origin, evidence)


baseline.fixtures = refined_fixtures
baseline.MockApi = RefinedMockApi
baseline.new_page = refined_new_page
baseline.visit_book = visit_book
baseline.smoke = refined_smoke
baseline.layouts = refined_layouts
baseline.states = refined_states


def annotate_evidence():
    evidence = json.loads(baseline.OUT.read_text(encoding="utf-8"))
    evidence["mockModel"] = dict(
        expenseCount=5, expenseTotalFen="83000", ownPaidFen="55400", otherPaidFen="27600",
        eachShareFen="41500", ownReceivableFen="13900", confirmationAmountFen="13900",
        confirmedBalancesFen=["0", "0"], subscription="SUBSCRIBE → SUBSCRIBED，保持隔离模拟连接在线",
    )
    evidence["harnessCorrections"] = [
        dict(failure="分类筛选定位超时", cause="嵌套选择项参与get_by_label文本匹配",
             correction="先读取实际aria_snapshot，改用combobox精确可访问名称定位；产品标签保持"),
        dict(failure="两轮主题切换无额外请求断言失败", cause="旧模拟WS主动关闭触发生产实时同步的重连补查",
             correction="改为模拟真实订阅握手并保持连接，等待live及networkidle后基线；无额外请求断言保持"),
        dict(failure="新增设置预览区域定位超时", cause="has内部定位器包含dialog作用域，无法相对于候选label匹配",
             correction="改为在选项内按input[value=b]定位，卡片真实点击与键盘检查保留"),
    ]
    evidence["productCorrections"] = [
        dict(failure="40字符连续拉丁昵称使手机明细横向溢出", observedScrollWidths={"a360": 523, "a390": 529, "b360": 545, "b390": 551},
             correction="姓名与分摊/确认预览子元素允许收缩和断行；最终同轮边界检查无溢出或金额重叠"),
        dict(failure="手机大金额完整保留但小数分行，共同消费标签被挤成竖排",
             correction="手机概览按空间整块换行，并用Range行数检查金额数字和标签保持单行"),
    ]
    evidence["boundaryModel"] = dict(memberNicknameLength=40, expenseCount=5,
        eachExpenseFen="100000000", expenseTotalFen="500000000", ownPaidFen="300000000",
        otherPaidFen="200000000", eachShareFen="250000000", ownReceivableFen="50000000")
    evidence["sourceModifiedAtUtc"] = {
        path: baseline.datetime.fromtimestamp((ROOT / path).stat().st_mtime, baseline.timezone.utc).isoformat()
        for path in ("apps/web/src/appearance.css", "apps/web/src/App.vue",
                     "apps/web/src/components/AppearanceSettings.vue", "apps/web/src/views/BookView.vue",
                     "apps/web/src/components/ExpensePanel.vue")
    }
    baseline.OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


async def main():
    previous_success = None
    earlier_successes = []
    if baseline.OUT.exists():
        previous = json.loads(baseline.OUT.read_text(encoding="utf-8"))
        earlier_successes = previous.get("earlierSuccessfulRuns", [])
        if previous.get("previousSuccessfulRun"):
            earlier_successes.append(previous["previousSuccessfulRun"])
        if previous.get("status") == "passed":
            previous_success = {key: previous[key] for key in ("status", "summary", "finishedAt")}
    result = await baseline.main()
    annotate_evidence()
    if previous_success or earlier_successes:
        evidence = json.loads(baseline.OUT.read_text(encoding="utf-8"))
        if previous_success:
            earlier_successes.append(previous_success)
        evidence["earlierSuccessfulRuns"] = earlier_successes
        baseline.OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
