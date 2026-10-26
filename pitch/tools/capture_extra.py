"""Extra element-level captures (pharmacy inventory table + incoming stock table)."""
import re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
OUT = Path(__file__).resolve().parent.parent / "assets" / "screens"
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2, timezone_id="Africa/Cairo")
    ctx.add_cookies([{"name": "sp_locale", "value": "en", "url": BASE}])
    page = ctx.new_page()
    page.goto(f"{BASE}/login", wait_until="networkidle")
    page.fill('input[type="email"]', "ph1@demo.local"); page.fill('input[type="password"]', "DemoPass#2026")
    page.click('button[type="submit"]'); page.wait_for_url(re.compile(r".*/org/.*")); page.wait_for_load_state("networkidle")
    page.get_by_role("tab", name="Inventory").click(); page.wait_for_load_state("networkidle"); page.wait_for_timeout(800)
    page.locator("main section").last.screenshot(path=str(OUT / "d-pharmacy-inventory-table.png"))
    page.get_by_role("tab", name="Incoming stock").click(); page.wait_for_load_state("networkidle"); page.wait_for_timeout(800)
    page.locator("main section").last.screenshot(path=str(OUT / "d-pharmacy-incoming-table.png"))
    b.close()
print("ok")
