"""Builds device mockups (browser window / phone / card) around real prototype screenshots."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "screens"
OUT = ROOT / "assets" / "mockups"
OUT.mkdir(parents=True, exist_ok=True)
FONT = "/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf"


def rounded(img, r):
    img = img.convert("RGBA")
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.width - 1, img.height - 1], r, fill=255)
    img.putalpha(mask)
    return img


def with_shadow(img, radius, pad=70, offset=(0, 26), blur=34, alpha=70):
    base = Image.new("RGBA", (img.width + 2 * pad, img.height + 2 * pad), (0, 0, 0, 0))
    sh = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([pad + offset[0], pad + offset[1], pad + offset[0] + img.width, pad + offset[1] + img.height], radius, fill=(15, 23, 42, alpha))
    base.alpha_composite(sh.filter(ImageFilter.GaussianBlur(blur)))
    base.alpha_composite(img, (pad, pad))
    return base


def fit_width(img, w):
    return img if img.width <= w else img.resize((w, round(img.height * w / img.width)), Image.LANCZOS)


def browser(name, out, crop=None, width=2000, label="Smart Pharmacy · live prototype (demo data)"):
    shot = Image.open(SRC / name).convert("RGB")
    if crop:
        shot = shot.crop(crop)
    shot = fit_width(shot, width)
    bar = 64
    win = Image.new("RGBA", (shot.width, shot.height + bar), (255, 255, 255, 255))
    d = ImageDraw.Draw(win)
    d.rectangle([0, 0, shot.width, bar], fill=(241, 245, 249, 255))
    for i, c in enumerate([(239, 68, 68), (245, 158, 11), (34, 197, 94)]):
        d.ellipse([26 + i * 34, 22, 46 + i * 34, 42], fill=c + (255,))
    pill = [150, 14, min(shot.width - 40, 150 + 900), bar - 14]
    d.rounded_rectangle(pill, 18, fill=(255, 255, 255, 255), outline=(226, 232, 240, 255), width=2)
    d.text((pill[0] + 26, 21), "🔒  " + label if False else label, fill=(71, 85, 105, 255), font=ImageFont.truetype(FONT, 26))
    d.line([0, bar, shot.width, bar], fill=(226, 232, 240, 255), width=2)
    win.paste(shot, (0, bar))
    win = with_shadow(rounded(win, 22), 22)
    win.save(OUT / out, optimize=True)
    return out


def phone(name, out, top=0, height=None):
    shot = Image.open(SRC / name).convert("RGB")
    h = height or shot.height
    shot = shot.crop((0, top, shot.width, min(shot.height, top + h)))
    screen_w = 1000
    shot = shot.resize((screen_w, round(shot.height * screen_w / shot.width)), Image.LANCZOS)
    screen_h = round(screen_w * 2.165)
    if shot.height < screen_h:
        canvas = Image.new("RGB", (screen_w, screen_h), (248, 250, 252))
        canvas.paste(shot, (0, 0))
        shot = canvas
    shot = shot.crop((0, 0, screen_w, screen_h))
    bezel = 34
    body = Image.new("RGBA", (screen_w + 2 * bezel, screen_h + 2 * bezel), (0, 0, 0, 0))
    d = ImageDraw.Draw(body)
    d.rounded_rectangle([0, 0, body.width - 1, body.height - 1], 150, fill=(17, 24, 39, 255))
    d.rounded_rectangle([6, 6, body.width - 7, body.height - 7], 146, outline=(55, 65, 81, 255), width=4)
    body.alpha_composite(rounded(shot, 118), (bezel, bezel))
    d = ImageDraw.Draw(body)
    cx = body.width // 2
    d.rounded_rectangle([cx - 150, bezel + 22, cx + 150, bezel + 98], 38, fill=(10, 10, 12, 255))
    body = with_shadow(body, 150, pad=80, offset=(0, 30), blur=40, alpha=80)
    body.save(OUT / out, optimize=True)
    return out


def card(name, out, width=1800):
    shot = fit_width(Image.open(SRC / name).convert("RGB"), width)
    img = with_shadow(rounded(shot, 26), 26, pad=60, offset=(0, 20), blur=28, alpha=60)
    img.save(OUT / out, optimize=True)
    return out


made = [
    browser("d-en-results-viewport.png", "browser-finder-en.png", crop=(300, 380, 2580, 1800)),
    browser("d-en-map.png", "browser-map.png"),
    browser("d-pharmacy-inventory.png", "browser-pharmacy-inventory.png"),
    browser("d-pharmacy-incoming.png", "browser-pharmacy-incoming.png"),
    browser("d-pharmacy-requests.png", "browser-pharmacy-requests.png"),
    browser("d-warehouse-orders.png", "browser-warehouse-orders.png"),
    browser("d-admin-overview.png", "browser-admin-overview.png"),
    browser("d-admin-analytics.png", "browser-admin-analytics.png"),
    phone("m-ar-results.png", "phone-ar-results.png"),
    phone("m-ar-picker.png", "phone-ar-picker.png"),
    phone("m-ar-home.png", "phone-ar-home.png"),
    phone("m-ar-account.png", "phone-ar-account.png"),
    card("d-pharmacy-ledger.png", "card-ledger.png"),
    card("d-warehouse-po.png", "card-warehouse-po.png"),
    card("d-warehouse-shipment.png", "card-warehouse-shipment.png"),
    card("d-pharmacy-inventory-table.png", "card-inventory-table.png"),
    card("d-pharmacy-incoming-table.png", "card-incoming-table.png"),
]
for m in made:
    im = Image.open(OUT / m)
    print(f"{m:34s} {im.width}x{im.height}  {(OUT / m).stat().st_size // 1024} KB")
