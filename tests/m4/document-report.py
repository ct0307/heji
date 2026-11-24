"""使用完整正式性能/独立恢复证据生成Word报告，不接触数据库和凭据。"""
import json
from pathlib import Path
from datetime import datetime
from docx import Document
from docx.shared import Inches, Pt, RGBColor, Twips
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT

root = Path(__file__).resolve().parents[2]
evidence = root / "docs/development/evidence"
performance_files = sorted(evidence.glob("m4-performance-round-summary-*.json"))
restore_files = sorted((root / ".local/m4").glob("restore-*.json"))
participant_path = evidence / "m4-participant-study-summary-2026-11-18T11-27-06-199Z.json"
if not performance_files or not restore_files or not participant_path.exists():
    raise SystemExit("正式性能、参与范围研究或独立恢复证据未齐，拒绝生成验收报告")
perf = json.loads(performance_files[-1].read_text(encoding="utf-8"))
participant = json.loads(participant_path.read_text(encoding="utf-8"))
restore_path = max(restore_files, key=lambda path: json.loads(path.read_text(encoding="utf-8")).get("restoredAt", ""))
restore = json.loads(restore_path.read_text(encoding="utf-8"))
if not perf.get("complete") or not participant.get("complete") or len(participant.get("groups", [])) != 9 or restore.get("format") != "heji-m4-restore-verification-v1":
    raise SystemExit("证据不完整")
if restore.get("restoredDatabase") != "heji_m4_restore_003" or len(restore.get("report", {}).get("migrationChecksums", [])) != 3:
    raise SystemExit("最新独立恢复证据不是003后结构，拒绝生成")

# standard_business_brief；命名覆盖：东亚字体微软雅黑，表格文字9pt，标题23pt。
doc = Document()
section = doc.sections[0]
section.page_width, section.page_height = Inches(8.5), Inches(11)
section.top_margin = section.bottom_margin = Inches(0.8)
section.left_margin = section.right_margin = Inches(0.85)
section.header_distance = section.footer_distance = Inches(0.492)
def font(style, size, color="202B33", bold=False):
    style.font.name = "Calibri"
    style.font.size = Pt(size)
    style.font.color.rgb = RGBColor.from_string(color)
    style.font.bold = bold
    style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "微软雅黑")
for name, size, before, after, color in [("Normal", 10.5, 0, 4, "202B33"), ("Title", 23, 0, 5, "000000"), ("Subtitle", 10.5, 0, 5, "52616B"), ("Heading 1", 15, 12, 6, "2E74B5"), ("Heading 2", 13, 10, 5, "2E74B5"), ("Heading 3", 12, 7, 3, "1F4D78")]:
    style = doc.styles[name]
    font(style, size, color, name.startswith("Heading"))
    style.paragraph_format.space_before = Pt(before)
    style.paragraph_format.space_after = Pt(after)
    style.paragraph_format.line_spacing = 1.05
    style.paragraph_format.widow_control = True
    if name.startswith("Heading"):
        style.paragraph_format.keep_with_next = True
for name in ["Header", "Footer"]:
    font(doc.styles[name], 9, "52616B")
    doc.styles[name].paragraph_format.space_before = Pt(0)
    doc.styles[name].paragraph_format.space_after = Pt(0)
    doc.styles[name].paragraph_format.line_spacing = 1.10
section.header.paragraphs[0].text = "合记  |  M4 本机隔离验收"
footer = section.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
footer.add_run("第 ")
field = OxmlElement("w:fldSimple"); field.set(qn("w:instr"), "PAGE"); footer._p.append(field)
footer.add_run(" 页")
doc.core_properties.title = "合记 M4 隔离实验验收报告"
doc.core_properties.author = "合记项目"
doc.core_properties.subject = "正式HTTP性能、SQL索引与独立恢复真实证据"

def paragraph(text, style=None):
    return doc.add_paragraph(text, style)
def heading(text):
    doc.add_heading(text, 1)
def table(labels, rows, widths):
    assert sum(widths) == 9360
    t = doc.add_table(rows=1, cols=len(labels)); t.autofit = False
    props = t._tbl.tblPr
    props.find(qn("w:tblW")).set(qn("w:w"), "9360"); props.find(qn("w:tblW")).set(qn("w:type"), "dxa")
    indent = OxmlElement("w:tblInd"); indent.set(qn("w:w"), "120"); indent.set(qn("w:type"), "dxa")
    borders = OxmlElement("w:tblBorders")
    for edge in ["top", "start", "left", "bottom", "end", "right", "insideH", "insideV"]:
        element = OxmlElement("w:" + edge); element.set(qn("w:val"), "single"); element.set(qn("w:sz"), "4"); element.set(qn("w:color"), "D4DCE2"); borders.append(element)
    layout = props.find(qn("w:tblLayout")); look = props.find(qn("w:tblLook"))
    if layout is not None: props.remove(layout)
    if look is not None: props.remove(look)
    props.append(indent); props.append(borders)
    if layout is not None: props.append(layout)
    if look is not None: props.append(look)
    for column, width in zip(t.columns, widths): column.width = Twips(width)
    for index, data in enumerate([labels] + rows):
        cells = t.rows[0].cells if index == 0 else t.add_row().cells
        for cell, value, width in zip(cells, data, widths):
            cell.width = Twips(width)
            margins = OxmlElement("w:tcMar")
            for side, amount in [("top", 45), ("start", 120), ("bottom", 45), ("end", 120)]:
                element = OxmlElement("w:" + side); element.set(qn("w:w"), str(amount)); element.set(qn("w:type"), "dxa"); margins.append(element)
            tc_pr = cell._tc.get_or_add_tcPr()
            if index == 0:
                shading = OxmlElement("w:shd"); shading.set(qn("w:val"), "clear"); shading.set(qn("w:fill"), "F2F4F7"); tc_pr.append(shading)
            tc_pr.append(margins)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            p = cell.paragraphs[0]; p.paragraph_format.space_before = Pt(0); p.paragraph_format.space_after = Pt(1); p.paragraph_format.line_spacing = 1.05
            run = p.add_run(str(value)); run.font.size = Pt(9); run.font.bold = index == 0
        if index == 0:
            repeat = OxmlElement("w:tblHeader"); t.rows[0]._tr.get_or_add_trPr().append(repeat)
        prevent = OxmlElement("w:cantSplit"); t.rows[index]._tr.get_or_add_trPr().append(prevent)
    paragraph("")
    return t

paragraph("合记 M4 隔离实验验收报告", "Title")
paragraph("真实证据 · 性能差距 · 独立恢复", "Subtitle")
paragraph("日期：2026-11-19　范围：本机虚构隔离库；不代表生产部署或完整项目验收。")
paragraph("当前结论：003后增量汇总、独立恢复、本机Nginx HTTPS/WSS及Edge HTTPS浏览器UI验收均已通过；12组正式HTTP工作流P95和系统故障率达到本机目标。同账本正式确认0/3364成功，全部因PREVIEW_STALE；参与范围研究中4人0/3501、8人1/3058、30人0/2700，确认可用性仍未达要求。交互会刷新预览并等待用户重新确认，不改变服务端版本保护。公网/生产部署未验收，所有原P1继续保留。")
paragraph("文档状态：本版本由已保存的正式逐轮汇总、参与范围研究、恢复核验摘要和本机HTTPS/WSS/浏览器验收记录生成。")
paragraph(f"正式run：{perf['runId']}；UTC {perf['startedAt']}至{perf['completedAt']}；20用户、30秒预热、12组×180秒。")
start, end = perf["actualScaleAtStart"], perf["inferredScaleAtEnd"]
paragraph(f"实际规模：起点{start['expenses']}笔支出；终点{end['expenses']}笔支出、{end['versions']}版本、{end['shares']}份额、{end['confirmed']}笔已确认转账。末端规模由相邻轮起点与各阶段写入量推算，并由独立只读证据核对。写入保留累积，后续轮次负载随之变化。")
heading("实验环境与固定方法")
env = perf["environment"]
table(["项目", "实际值与边界"], [
    ["应用与数据库", f"Node {env['node']} / MySQL {env['mysql']['version']} / REPEATABLE READ；连接池8"],
    ["硬件", "Ryzen 9 7940HX，16核32逻辑CPU，约16GB内存；非设计建议2核4GB"],
    ["MySQL缓冲池", "128MiB；本轮未修改全局配置"],
    ["种子规模", "10账本，每本30成员；目标10000当前支出+2000历史，其余各1000+200；每笔30份额"],
    ["正式参数", "20用户、30秒预热、180秒采样、每组3轮；读/写×同账本/分散，共12组"],
    ["负载口径", "读：50%明细/30%余额/20%报表；写：60%均分/30%指定/10%确认；写入累计保留"],
    ["测量边界", "正式基准为回环HTTP真实应用/数据库；不含Nginx、TLS和WS扇出。预热单列，失败耗时保留。"]
], [2450, 6910])
heading("正式性能结果")
rows = []
for group in perf["groups"]:
    workflow = group["workflows"]
    rows.append(["读" if group["mode"] == "read" else "写", "同账本" if group["distribution"] == "same-book" else "分散", str(group["round"]), str(workflow["total"]), f"{workflow['p95']:.1f}", f"{workflow['failureRate']:.2%}", str(workflow["expectedConflicts"]), "通过" if group["workflowLatencyPass"] else "未达标"])
table(["类型", "分布", "轮", "工作流", "P95/ms", "故障率", "预期冲突", "时延"], rows, [650, 950, 450, 1300, 1650, 1350, 1600, 1410])
paragraph("判定：读≤500ms、写≤800ms、系统故障率<1%。上表是完整工作流时延，HTTP端点分组与确认工作流原始样本保存在JSON。PREVIEW_STALE单列为预期冲突，须重新预览并由用户确认，不视为确认成功。")
paragraph(f"全组工作流时延目标：{'通过' if perf['allWorkflowLatencyTargetsPassed'] else '未通过'}；全组HTTP时延目标：{'通过' if perf['allHttpLatencyTargetsPassed'] else '未通过'}；全组故障率目标：{'通过' if perf['allFailureRateTargetsPassed'] else '未通过'}。")
for distribution, name in [("same-book", "热点同账本"), ("spread-books", "分散账本")]:
    operations = [row["operations"].get("confirm", {}) for row in perf["groups"] if row["mode"] == "write" and row["distribution"] == distribution]
    attempts = sum(row.get("total", 0) for row in operations)
    successes = sum(row.get("successes", 0) for row in operations)
    conflicts = sum(row.get("expectedConflicts", 0) for row in operations)
    paragraph(f"{name}确认工作流：{attempts}次尝试，{successes}次成功，{conflicts}次预览过期冲突；成功率{successes/attempts:.2%}。预期冲突是版本保护生效的证据，同时也是高写入频率下需改进的用户体验，不能计为已确认付款。")
image = performance_files[-1].with_suffix(".png")
if image.exists(): doc.add_picture(str(image), width=Inches(6.5))
heading("瓶颈证据与修复")
paragraph("003前的热点余额快照曾需扫描数十万当前/历史份额，旧执行计划与HTTP样本显示聚合成本占主导；原始测试中，均分写入也逐份额插入。先将份额写入改为一次参数化多行INSERT，再在独立003迁移中增加成员、日期及分类汇总表，并与原账务事实保持同事务更新。普通汇总模式短测和正式HTTP报告分别记录其自身范围；旧数据仅作为历史诊断，不与新正式run直接作同条件因果比较。")
paragraph("003迁移后，开发库真实MySQL51/51通过（含100并发确认只入账一次），基准库10账本/130期间回填对账通过。热点同账本正式确认仍为0/3364，表明较快读写不能消除高频并发的版本竞争。HTTP冲突后客户端只刷新一次最新预览、清除旧勾选并等用户重新勾选确认；刷新失败会清除旧预览。" )
heading("参与范围敏感性研究")
participant_groups = [entry["group"] for entry in participant["groups"]]
participant_rows = []
for count in (4, 8, 30):
    runs = sorted((group for group in participant_groups if group["participantCount"] == count), key=lambda group: group["round"])
    attempts = sum(group["confirmationSuccess"]["total"] for group in runs)
    successes = sum(group["confirmationSuccess"]["successes"] for group in runs)
    stale = sum(group["confirmationSuccess"]["stale"] for group in runs)
    p95 = [group["workflows"]["p95"] for group in runs]
    participant_rows.append([str(count), " / ".join(f"{value:.1f}" for value in p95), f"{successes}/{attempts}", str(stale)])
table(["参与成员", "三轮写工作流P95/ms", "确认成功/尝试", "PREVIEW_STALE"], participant_rows, [1600, 3900, 1900, 1960])
paragraph(f"参与范围研究run {participant['runId']}：4/8/30人各3轮，20用户、每轮30秒预热和180秒测量，合计9轮，系统故障均为0。每轮支出仍推进全账本financialVersion，保留服务端版本保护；不是生产容量结论，也没有替代旧正式12组结果。确认版本差距P50约17–20。唯一一次8人确认成功不能外推为已解决。")
heading("索引对照与独立恢复")
paragraph("同样10000条审计、相同筛选/排序/20行返回，两组结果逐行一致。仅主键方案实际扫描10000行并排序，5轮EXPLAIN ANALYZE往返3.67–3.91ms；联合索引(bookId,createdAt,id)走覆盖反向查找，0.26–0.52ms。只证明这一固定审计查询，不能外推为财务查询提速。")
counts = restore["report"]["counts"]
fmt = lambda value: f"{int(value):,}"
table(["恢复检查", "实际结果"], [
    ["独立目标", restore["restoredDatabase"] + "；新建固定白名单目标，旧结构恢复库保留"],
    ["恢复总耗时", f"{restore['elapsedMs']/1000:.2f}秒；30分钟目标：{'达到' if restore['within30Minutes'] else '未达到'}"],
    ["数据行", fmt(restore["rows"]) + "；压缩文件SHA-256及逐表摘要一致"],
    ["规模", f"{fmt(counts['books'])}账本 / {fmt(counts['members'])}成员关联 / {fmt(counts['currentExpenses'])}当前支出 / {fmt(counts['versions'])}版本"],
    ["确认与冲正", f"已确认{fmt(counts['transfers'])}条，冲正{fmt(counts['reversals'])}条；非零夹具，不以空表通过"],
    ["内容完整性", "001/002/003迁移hash、全部复合外键、逐版本份额合计、当前版本和各账本余额守恒均检查"],
    ["汇总对账", "10账本派生余额快照及期间成员/分类报表均与原始事实逐项一致"],
    ["范围", "校验文件、建新架构、导入及内容核验；不含安装，不声称恢复零丢失或生产RPO"]
], [2450, 6910])
heading("交付证据与剩余P1")
table(["优先级", "状态/后续"], [
    ["P1 热点确认", "0/3364次确认成功；PREVIEW_STALE保护有效，刷新预览后仍需用户重新确认"],
    ["P1 HTTPS浏览器UI", "Edge HTTPS登录/注册、虚构账本、375px与PREVIEW_STALE双账号回归通过；临时证书信任已按指纹回滚"],
    ["P1 完整验收", "公网/生产部署未验收；需完成剩余交付和答辩闭环，不能将本报告视为整个期末项目完成"],
    ["接口文档", "docs/api/openapi.json：38个HTTP操作、466处本地引用已核对；WS协议另附README，未用外部规范验证器"]
], [2450, 6910])
evidence_note = paragraph("证据：正式逐轮汇总、003恢复脱敏摘要、本机HTTPS/WSS记录与SQL索引测试。原始备份只存.local/m4，不进入交付；报告不含密码、Cookie或连接参数。")
evidence_note.paragraph_format.keep_together = True
zoom = doc.settings.element.find(qn("w:zoom"))
if zoom is None:
    zoom = OxmlElement("w:zoom")
    doc.settings.element.append(zoom)
zoom.set(qn("w:percent"), "100")
target = root / "docs/development/合记_M4隔离实验验收报告_更新_2026-11-19-版式复核.docx"
if target.exists():
    raise SystemExit("版式复核版报告已存在，拒绝覆盖")
doc.save(target)
# 结构验收：固定页面几何、表格宽度、必要结论及可重读性。
checked = Document(target)
assert len(checked.tables) == 5
checked_text = "".join(p.text for p in checked.paragraphs) + "".join(c.text for t in checked.tables for row in t.rows for c in row.cells)
assert "heji_m4_restore_003" in checked_text
assert "HTTPS/WSS" in checked_text
assert "2026-11-18T11-27-06-199Z" in checked_text
assert "0/3501" in checked_text and "1/3058" in checked_text and "0/2700" in checked_text
assert "Edge HTTPS" in checked_text
assert checked.sections[0].page_width.twips == 12240
for t in checked.tables:
    assert int(t._tbl.tblPr.find(qn("w:tblW")).get(qn("w:w"))) == 9360
    assert sum(int(x.get(qn("w:w"))) for x in t._tbl.tblGrid) == 9360
    for row in t.rows:
        assert sum(int(cell._tc.get_or_add_tcPr().find(qn("w:tcW")).get(qn("w:w"))) for cell in row.cells) == 9360
assert "Nginx" in "".join(p.text for p in checked.paragraphs)
print(str(target))
