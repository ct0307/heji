"""用最终正式页面截图生成本轮精修对比，保留上轮预览。"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    evidence = root / "docs/development/evidence/ui-refinement-2026-11-19"
    title_font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 26)
    caption_font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 15)
    canvas = Image.new("RGB", (1680, 660), "#edf1f2")
    draw = ImageDraw.Draw(canvas)

    for left, title, color, filename, caption in (
        (24, "A 雾青工作台 · 默认", "#284e40", "a-expenses-1440.png", "侧栏导航 / 收付概览 / 明细工作区"),
        (852, "B 墨蓝账页 · 可切换", "#40566e", "b-expenses-1440.png", "顶部导航 / 时间账页 / 独立收付摘要"),
    ):
        draw.text((left, 18), title, font=title_font, fill=color)
        draw.text((left, 59), caption, font=caption_font, fill="#5c6b79")
        with Image.open(evidence / filename) as source:
            # 展示900px桌面视口，避免整页缩放使正文变得过小。
            viewport = source.convert("RGB").crop((0, 0, 1440, 900))
            canvas.paste(viewport.resize((804, 503), Image.Resampling.LANCZOS), (left, 95))

    draw.text((24, 622), "正式 Vue 页面实测截图 · 演示账目与接口均为隔离模拟", font=caption_font, fill="#5c6b79")
    canvas.save(evidence / "appearance-refined-comparison.png")
    print("appearance-refined-comparison.png")


if __name__ == "__main__":
    main()
