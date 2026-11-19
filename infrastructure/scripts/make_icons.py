"""Regenerates the Android and iOS launcher icons from apps/mobile/assets/brand/bank_logo.png (needs Pillow).

    python infrastructure/scripts/make_icons.py

Android: legacy square icons plus an adaptive icon (navy background colour + the mark on a transparent foreground).
iOS: every size in AppIcon.appiconset; the 1024 marketing icon is opaque, as the App Store requires.
"""
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2] / "apps" / "mobile"
LOGO = Image.open(ROOT / "assets" / "brand" / "bank_logo.png").convert("RGBA")
NAVY = (11, 27, 61, 255)  # matches the dark brand surface


def mark(size: int, scale: float) -> Image.Image:
    """The logo scaled to `scale` of the canvas height, centred on a transparent square."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    h = int(size * scale)
    w = int(LOGO.width * h / LOGO.height)
    m = LOGO.resize((w, h), Image.LANCZOS)
    canvas.alpha_composite(m, ((size - w) // 2, (size - h) // 2))
    return canvas


def on_navy(size: int, scale: float) -> Image.Image:
    bg = Image.new("RGBA", (size, size), NAVY)
    bg.alpha_composite(mark(size, scale))
    return bg


res = ROOT / "android" / "app" / "src" / "main" / "res"
for folder, px in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
    on_navy(px, 0.62).convert("RGB").save(res / f"mipmap-{folder}" / "ic_launcher.png")
for folder, px in {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}.items():
    mark(px, 0.40).save(res / f"mipmap-{folder}" / "ic_launcher_foreground.png")  # safe zone: the mark stays inside the inner 66%
(res / "mipmap-anydpi-v26").mkdir(exist_ok=True)
(res / "mipmap-anydpi-v26" / "ic_launcher.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
    '    <background android:drawable="@color/ic_launcher_background"/>\n'
    '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n', encoding="utf-8")
(res / "values" / "ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0B1B3D</color>\n</resources>\n', encoding="utf-8")

ios = ROOT / "ios" / "Runner" / "Assets.xcassets" / "AppIcon.appiconset"
contents = json.loads((ios / "Contents.json").read_text(encoding="utf-8"))
for img in contents["images"]:
    px = round(float(img["size"].split("x")[0]) * int(img["scale"].rstrip("x")))
    on_navy(px, 0.62).convert("RGB").save(ios / img["filename"])  # opaque: iOS rounds the corners itself
print("icons written")
