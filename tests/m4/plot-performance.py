"""仅绘制已完成的正式基准，不连接数据库、不读取本地配置。"""
import json
from pathlib import Path
from reportlab.graphics.shapes import Drawing, String, Line
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics import renderPDF, renderSVG
import pypdfium2 as pdfium
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors

root = Path(__file__).resolve().parents[2]
directory = root / "docs/development/evidence"
files = sorted(directory.glob("m4-performance-summary-*.json"))
if not files:
    raise SystemExit("尚无完整正式报告，拒绝绘图")
source = json.loads(files[-1].read_text(encoding="utf-8"))
if not source.get("complete") or len(source["groups"]) != 12:
    raise SystemExit("正式12组数据不完整")
pdfmetrics.registerFont(TTFont("M4Chinese", "C:/Windows/Fonts/msyh.ttc", subfontIndex=0))
font = "M4Chinese"
drawing = Drawing(1000, 480)
def label(x, y, value, size=11, color="#273846"):
    drawing.add(String(x, y, value, fontName=font, fontSize=size, fillColor=colors.HexColor(color)))
label(28, 445, "合记 · 本机20用户正式基准", 22)
label(28, 416, "P95延迟（毫秒） · 同一热点账本与分散账本对照", 12)
for index, (mode, title, target) in enumerate([("read", "读取工作流", 500), ("write", "写入工作流", 800)]):
    chart = VerticalBarChart()
    chart.x, chart.y, chart.width, chart.height = 70 + index * 485, 120, 390, 220
    chart.data = [tuple(row["workflows"]["p95"] for row in sorted(source["groups"], key=lambda row: row["round"]) if row["mode"] == mode and row["distribution"] == distribution) for distribution in ["same-book", "spread-books"]]
    chart.categoryAxis.categoryNames = ["第1轮", "第2轮", "第3轮"]
    chart.categoryAxis.labels.fontName = font
    chart.categoryAxis.labels.fontSize = 10
    chart.valueAxis.valueMin = 0
    maximum = max(max(series) for series in chart.data)
    chart.valueAxis.valueMax = max(target, maximum) * 1.25
    chart.valueAxis.labels.fontName = font
    chart.valueAxis.labels.fontSize = 9
    chart.bars[0].fillColor = colors.HexColor("#285C74")
    chart.bars[1].fillColor = colors.HexColor("#B06D34")
    chart.bars.strokeColor = None
    chart.barLabels.fontName = font
    chart.barLabels.fontSize = 9
    chart.barLabelFormat = "%.0f"
    chart.barLabels.nudge = 8
    drawing.add(chart)
    y = chart.y + target / chart.valueAxis.valueMax * chart.height
    drawing.add(Line(chart.x, y, chart.x + chart.width, y, strokeColor=colors.HexColor("#B3483C"), strokeDashArray=[5, 3]))
    label(chart.x, 368, title, 15)
    label(chart.x, 346, f"设计目标 ≤ {target} ms", 10, "#B3483C")
label(70, 82, "蓝：同一热点账本       棕：分散至10账本", 11)
label(28, 48, "每组30秒预热 + 180秒采样，3轮；写入工作流含登记、预览与确认。", 10)
label(28, 27, "Ryzen 9 7940HX / 约16GB / MySQL缓冲池128MiB；不含Nginx、TLS及WS扇出，不外推2核4GB。", 10)
target_file = directory / (files[-1].stem + ".png")
renderSVG.drawToFile(drawing, str(target_file.with_suffix(".svg")))
pdf_file = target_file.with_suffix(".pdf")
renderPDF.drawToFile(drawing, str(pdf_file))
pdf = pdfium.PdfDocument(str(pdf_file))
page = pdf[0]
bitmap = page.render(scale=150/72)
bitmap.to_pil().save(target_file)
bitmap.close(); page.close(); pdf.close()
print(target_file)
