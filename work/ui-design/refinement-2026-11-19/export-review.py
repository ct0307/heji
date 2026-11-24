"""将本轮真实截图拼为对比图，不生成或替代页面内容。"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

BASE = Path(__file__).resolve().parent
canvas = Image.new('RGB', (1504, 680), '#eef1ef')
draw = ImageDraw.Draw(canvas)
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 23)
small = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 15)
for column, (concept, title, detail, color) in enumerate((
        ('a', 'A · 雾青工作台', '侧栏导航 / 余额与核对待办并排', '#235a4a'),
        ('b', 'B · 蓝墨账页', '顶部导航 / 账页清单与独立收据', '#3155a6'))):
    left = 24 + column * 752
    draw.text((left, 18), title, fill=color, font=font)
    draw.text((left, 55), detail, fill='#58675e', font=small)
    screenshot = Image.open(BASE / 'previews' / f'{concept}-overview-desktop.png').convert('RGB')
    screenshot.thumbnail((728, 560), Image.Resampling.LANCZOS)
    canvas.paste(screenshot, (left, 90))
canvas.save(BASE / 'previews' / 'comparison-overview.png')
print('已导出首页实际截图对比图。')
