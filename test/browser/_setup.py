"""Shared Playwright setup for ghosty-sessions browser tests.

Use as: `from _setup import new_ctx, BASE, VIEWPORT_*`

Run a spec from the worktree root:

    python3 -m playwright test test/browser/qf-07-keyboard-focus.py

The harness here deliberately keeps things tiny (no fixtures, no
parametrize): each spec is a single `def test_X(page): ...` function.
Screenshots land in `screenshots/` next to the repo root.
"""
from __future__ import annotations
import os, sys, pathlib
from playwright.sync_api import sync_playwright, Browser, BrowserContext, Page

BASE = os.environ.get("GHOSTY_URL", "http://localhost:7777")
VIEWPORT_PHONE = {"width": 412, "height": 915, "deviceScaleFactor": 2,
                  "isMobile": True, "hasTouch": True}
VIEWPORT_DESK  = {"width": 1280, "height": 800}
ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
SCREENSHOTS = ROOT / "screenshots"
SCREENSHOTS.mkdir(exist_ok=True)


def new_page(viewport: dict = VIEWPORT_DESK) -> tuple[Browser, BrowserContext, Page]:
    """Spin up a headless chromium and a fresh context/page. Caller closes
    the browser (we use one browser per spec to keep tests independent)."""
    p = sync_playwright().start()
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport=viewport)
    page = ctx.new_page()
    page.on("console", lambda m: print(f"[browser {m.type}] {m.text}", file=sys.stderr))
    page.on("pageerror", lambda e: print(f"[browser pageerror] {e.message}", file=sys.stderr))
    return browser, ctx, page


def goto_base(page: Page) -> None:
    """Open the dashboard and wait for the JS shell to come online."""
    page.goto(BASE)
    # Either the grid list (`.cell .name`) or the list-empty state, whichever
    # appears first after fetchInitial(). 5 s is plenty.
    page.wait_for_function(
        "() => document.querySelector('#listPane')?.innerHTML?.length "
        "    || document.querySelector('#gridPane')?.innerHTML?.length",
        timeout=10_000,
    )