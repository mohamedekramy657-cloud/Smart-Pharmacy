"""Captures real screenshots of the running Smart Pharmacy prototype (demo data) for the pitch deck.

Usage: python capture_screens.py [base_url]   (default http://localhost:3000)
Requires the API + web app running with the demo/showcase data loaded.
"""
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
OUT = Path(__file__).resolve().parent.parent / "assets" / "screens"
OUT.mkdir(parents=True, exist_ok=True)
PASSWORD = "DemoPass#2026"
results = []


def new_context(browser, locale, mobile=False):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844} if mobile else {"width": 1440, "height": 900},
        device_scale_factor=3 if mobile else 2,
        is_mobile=mobile, has_touch=mobile,
        locale="ar-EG" if locale == "ar" else "en-US",
        timezone_id="Africa/Cairo",
    )
    ctx.add_cookies([{"name": "sp_locale", "value": locale, "url": BASE}])
    return ctx


def shot(name, fn):
    try:
        fn()
        results.append(f"OK   {name}")
    except Exception as exc:  # keep going; report at the end
        results.append(f"FAIL {name}: {str(exc).splitlines()[0][:160]}")


def login(page, email):
    page.goto(f"{BASE}/login", wait_until="networkidle")
    page.fill('input[type="email"]', email)
    page.fill('input[type="password"]', PASSWORD)
    page.click('button[type="submit"]')
    page.wait_for_url(re.compile(r".*/(org/|admin|$|account).*"), timeout=15000)
    page.wait_for_load_state("networkidle")


def settle(page, ms=600):
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(ms)


def finder_search(page, query, option_regex, locale):
    page.goto(f"{BASE}/", wait_until="networkidle")
    page.fill('input[role="combobox"]', query)
    page.wait_for_selector('ul[role="listbox"] li button', timeout=10000)
    settle(page, 300)
    return page.locator('ul[role="listbox"] li button').filter(has_text=re.compile(option_regex))


def run_finder_search(page, query, option_regex, locale):
    opt = finder_search(page, query, option_regex, locale)
    opt.first.click()
    page.locator("select").first.select_option(label="الإسماعيلية" if locale == "ar" else "Ismailia")
    page.click('button[type="submit"]')
    page.wait_for_selector('[aria-live="polite"] h2', timeout=15000)
    settle(page, 800)


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---------- Patient (Arabic, mobile) ----------
    ctx = new_context(browser, "ar", mobile=True)
    page = ctx.new_page()

    def picker_ar():
        finder_search(page, "كونكور", r"mg", "ar")
        page.screenshot(path=str(OUT / "m-ar-picker.png"))
    shot("m-ar-picker", picker_ar)

    def results_ar():
        run_finder_search(page, "كونكور", r"(?<![\d.])5 mg", "ar")
        page.locator('[aria-live="polite"]').scroll_into_view_if_needed()
        page.evaluate("window.scrollBy(0, -12)")
        settle(page, 400)
        page.screenshot(path=str(OUT / "m-ar-results.png"))
        page.locator('[aria-live="polite"]').screenshot(path=str(OUT / "m-ar-results-full.png"))
    shot("m-ar-results", results_ar)

    def home_ar():
        page.goto(f"{BASE}/", wait_until="networkidle")
        settle(page, 300)
        page.screenshot(path=str(OUT / "m-ar-home.png"))
    shot("m-ar-home", home_ar)

    def account_ar():
        login(page, "patient@demo.local")
        page.goto(f"{BASE}/account", wait_until="networkidle")
        settle(page, 600)
        page.screenshot(path=str(OUT / "m-ar-account.png"))
    shot("m-ar-account", account_ar)
    ctx.close()

    # ---------- Patient (English, desktop) ----------
    ctx = new_context(browser, "en")
    page = ctx.new_page()

    def results_en():
        run_finder_search(page, "concor", r"(?<![\d.])5 mg", "en")
        page.screenshot(path=str(OUT / "d-en-search-top.png"))
        page.locator('[aria-live="polite"]').screenshot(path=str(OUT / "d-en-results.png"))
        page.locator('[aria-live="polite"]').scroll_into_view_if_needed()
        page.evaluate("window.scrollBy(0, -16)")
        settle(page, 300)
        page.screenshot(path=str(OUT / "d-en-results-viewport.png"))
    shot("d-en-results", results_en)

    def map_en():
        page.goto(f"{BASE}/", wait_until="networkidle")
        page.get_by_role("button", name=re.compile("Pick on map")).click()
        page.wait_for_selector(".leaflet-container", timeout=10000)
        try:
            page.wait_for_selector(".leaflet-tile-loaded", timeout=12000)
        except PWTimeout:
            pass
        page.wait_for_timeout(2500)
        box = page.locator(".leaflet-container").bounding_box()
        page.mouse.click(box["x"] + box["width"] * 0.55, box["y"] + box["height"] * 0.45)
        page.wait_for_timeout(800)
        page.locator("form").screenshot(path=str(OUT / "d-en-map.png"))
    shot("d-en-map", map_en)
    ctx.close()

    # ---------- Pharmacy workspace (English, desktop) ----------
    ctx = new_context(browser, "en")
    page = ctx.new_page()

    def pharmacy():
        login(page, "ph1@demo.local")
        page.get_by_role("tab", name="Inventory").click()
        settle(page, 800)
        page.screenshot(path=str(OUT / "d-pharmacy-inventory.png"))
        row = page.locator("tr", has_text="Panadol 500 mg").filter(has_not_text="Extra")
        row.get_by_role("button", name="Manage").click()
        page.wait_for_selector("text=Movement history", timeout=10000)
        settle(page, 800)
        page.locator("section.border-teal-300").first.screenshot(path=str(OUT / "d-pharmacy-ledger.png"))
        page.get_by_role("tab", name="Incoming stock").click()
        settle(page, 800)
        page.screenshot(path=str(OUT / "d-pharmacy-incoming.png"))
        page.get_by_role("tab", name="Patient requests").click()
        settle(page, 800)
        page.screenshot(path=str(OUT / "d-pharmacy-requests.png"))
        page.get_by_role("tab", name="Overview").click()
        settle(page, 800)
        page.screenshot(path=str(OUT / "d-pharmacy-overview.png"))
    shot("pharmacy", pharmacy)
    ctx.close()

    # ---------- Warehouse (English, desktop) ----------
    ctx = new_context(browser, "en")
    page = ctx.new_page()

    def warehouse():
        login(page, "wh1@demo.local")
        page.get_by_role("tab", name="Purchase orders").click()
        settle(page, 800)
        page.screenshot(path=str(OUT / "d-warehouse-orders.png"))
        row = page.locator("tr", has_text="Canal Pharmacy").filter(has_text="SUBMITTED")
        row.get_by_role("button", name="Open").first.click()
        page.wait_for_selector("text=Confirm & allocate", timeout=10000)
        settle(page, 800)
        page.locator("section.border-teal-300").first.screenshot(path=str(OUT / "d-warehouse-po.png"))
        page.get_by_role("tab", name="Shipments").click()
        settle(page, 800)
        page.screenshot(path=str(OUT / "d-warehouse-shipments.png"))
        row = page.locator("tr", has_text="Al-Nour")
        row.get_by_role("button", name="Open").first.click()
        page.wait_for_selector("text=Schedule history", timeout=10000)
        page.locator("summary", has_text="Schedule history").click()
        settle(page, 600)
        page.locator("section.border-teal-300").first.screenshot(path=str(OUT / "d-warehouse-shipment.png"))
    shot("warehouse", warehouse)
    ctx.close()

    # ---------- Admin (English, desktop) ----------
    ctx = new_context(browser, "en")
    page = ctx.new_page()

    def admin():
        login(page, "admin@demo.local")
        page.goto(f"{BASE}/admin", wait_until="networkidle")
        settle(page, 900)
        page.screenshot(path=str(OUT / "d-admin-overview.png"))
        page.get_by_role("tab", name="Search analytics").click()
        settle(page, 900)
        page.screenshot(path=str(OUT / "d-admin-analytics.png"))
        page.get_by_role("tab", name="Audit log").click()
        settle(page, 900)
        page.screenshot(path=str(OUT / "d-admin-audit.png"))
    shot("admin", admin)
    ctx.close()
    browser.close()

print("\n".join(results))
for f in sorted(OUT.glob("*.png")):
    print(f"{f.name:32s} {f.stat().st_size // 1024:6d} KB")
