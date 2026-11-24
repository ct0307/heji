"""拼接同一页面的两张原尺寸截图，生成完整桌面预览。"""
from pathlib import Path
from PIL import Image

output = Path('C:/Users/chentao/Documents/Codex/2026-11-10/xai/outputs')
top = Image.open(output / '合记_UI草图_桌面.jpg')
bottom = Image.open(output / '合记_UI草图_桌面账目.jpg')
print(f'截图原始尺寸：首屏{top.size}，下半页{bottom.size}')
assert top.width == bottom.width, '截图宽度不一致'
# 浏览器截图去掉了滚动条区域，实际图高712，不能假设等于视口720。
assert top.height == bottom.height == 712, '两次截图的可见内容高度不一致'
scroll_offset = 565
preview = Image.new('RGB', (top.width, scroll_offset + bottom.height), 'white')
preview.paste(top, (0, 0))
preview.paste(bottom, (0, scroll_offset))
target = output / '合记_UI草图_总览.jpg'
preview.save(target, quality=93)
assert Image.open(target).size == (1265, 1277)
print(f'预览图已保存并核验：{target.name}，{preview.width}×{preview.height}')
