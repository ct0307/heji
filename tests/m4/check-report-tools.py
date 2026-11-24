"""离线检查字体与图像输出能力；产物仅工具诊断，不是性能数据。"""
from pathlib import Path
from reportlab.graphics.shapes import Drawing, String
from reportlab.graphics import renderPDF
import pypdfium2 as pdfium
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
root = Path(__file__).resolve().parents[2] / ".local/m4-report-tools"
root.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(TTFont("M4Chinese", "C:/Windows/Fonts/msyh.ttc", subfontIndex=0))
drawing = Drawing(300, 60)
drawing.add(String(15, 25, "工具输出检查，非性能数据", fontName="M4Chinese", fontSize=14))
renderPDF.drawToFile(drawing, str(root / "tool-check.pdf"))
pdf = pdfium.PdfDocument(str(root / "tool-check.pdf"))
page = pdf[0]; bitmap = page.render(scale=100/72)
bitmap.to_pil().save(root / "tool-check.png")
bitmap.close(); page.close(); pdf.close()
print("离线字体和PNG输出通过；未连接数据库。")
