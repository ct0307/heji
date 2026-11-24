"""将已验收的正式页面截图拼成对比图，源文件使用 UTF-8 保存中文标题。"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    evidence = root / "docs/development/evidence/ui-appearance-2026-11-19"
    font_path = "C:/Windows/Fonts/msyh.ttc"
    title_font = ImageFont.truetype(font_path, 24)
    caption_font = ImageFont.truetype(font_path, 14)
    canvas = Image.new("RGB", (1528, 640), "#eef1f2")
    draw = ImageDraw.Draw(canvas)

    panels = (
        (24, "A 雾青工作台 · 默认", "#235b4c", "a-expenses-1440.png"),
        (776, "B 墨蓝账页 · 可切换", "#485a91", "b-expenses-1440.png"),
    )
    for left, title, color, filename in panels:
        draw.text((left, 20), title, font=title_font, fill=color)
        draw.text(
            (left, 61),
            "正式 Vue 页面 / 隔离模拟账目",
            font=caption_font,
            fill="#596777",
        )
        with Image.open(evidence / filename) as source:
            thumbnail = ImageOps.contain(
                source.convert("RGB"), (728, 508), Image.Resampling.LANCZOS
            )
            canvas.paste(thumbnail, (left, 103))

    output = evidence / "appearance-comparison.png"
    canvas.save(output)
    print(output.as_posix())


if __name__ == "__main__":
    main()
