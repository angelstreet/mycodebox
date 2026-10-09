"""QF-08 — MD doc should render instantly on second click, no 'loading…' flicker.

Reproduces the bug (chat-raised 2026-10-09 19:19):
> "when we load a md it hsould be cached sonext time i click i dont want
> to see laoding"

Spec:
1. Open the dashboard, switch to list mode (mobile-like view).
2. Open a session that has a task doc (e.g. task64 / TASK65-projects).
3. Click the MD button — the doc renders. (cold open; 'loading…' is OK
   here, but on a fast LAN the flicker is invisible.)
4. Click the back button to close the doc view.
5. Click the MD button again — body must appear, NO 'loading…' must
   flash in between. The .mdbody element must already have content the
   instant the click is dispatched.

The trick: assert the .mdbody has non-loading content within a short
window after the second click (Playwright polls at ~50 ms).
"""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _setup import new_page, goto_base, BASE, VIEWPORT_PHONE, SCREENSHOTS


def test_md_doc_renders_instantly_on_second_click():
    browser, ctx, page = new_page(VIEWPORT_PHONE)
    try:
        goto_base(page)

        # Phone is grid-mode by default (the list-mode toggle is hidden in the
        # topbar at <=720 px). Wait for the grid cards, then find a taskNN one.
        page.wait_for_selector(".card-pane .cell", timeout=10_000)
        target_session = page.evaluate(
            """() => {
                const c = Array.from(document.querySelectorAll('.card-pane .cell'))
                  .find((x) => /^task\\d+/i.test(x.dataset.session || ''));
                return c ? c.dataset.session : null;
            }"""
        )
        assert target_session, "no taskNN session card in grid"

        # 1. Cold open: click into the taskdoc.
        page.locator(f'#listPane .row-item[data-session="{target_session}"]').click()
        page.wait_for_selector(".card-pane .cell", state="visible", timeout=10_000)
        # Wait for the MD button to appear (only shown when server confirms files).
        page.wait_for_selector(".card-pane .cell .td:not(.hidden)", timeout=10_000)
        td_btn = page.locator(".card-pane .cell .td")
        td_btn.click()
        # Wait for cold render to complete (.mdbody exists and has content).
        page.wait_for_selector(".docview .mdbody", timeout=10_000)
        page.wait_for_function(
            "() => { const b = document.querySelector('.docview .mdbody'); return b && b.textContent && b.textContent.length > 20; }",
            timeout=10_000,
        )

        # 2. Close the doc view.
        page.locator(".docview .mdback").click()
        page.wait_for_function(
            "() => document.querySelector('.card-pane .cell')?.classList.contains('doc-on') === false",
            timeout=5_000,
        )

        # 3. Second click — must NOT show "loading…" between dispatch and render.
        # We use page.evaluate to run the click synchronously and immediately
        # inspect .docview innerHTML. If the cache works, the innerHTML jumps
        # straight to the rendered body; if it doesn't, we'll see "loading…".
        result = page.evaluate("""(session) => {
            const btn = document.querySelector('.card-pane .cell .td');
            if (!btn) return { error: 'no td btn' };
            btn.click();
            // Sample the innerHTML right after the click (synchronous).
            const dv = document.querySelector('.docview');
            const immediateHTML = dv ? dv.innerHTML : '';
            const hasLoading = immediateHTML.includes('loading…');
            const hasBody = !!dv && !!dv.querySelector('.mdbody') && dv.querySelector('.mdbody').textContent.length > 20;
            return { immediateHTML: immediateHTML.slice(0, 200), hasLoading, hasBody };
        }""", target_session)
        print(f"[test] immediate after second click: {result}")
        assert not result.get("hasLoading"), f"docview still shows loading… on second click: {result}"
        assert result.get("hasBody"), f"docview body not rendered on second click: {result}"

        page.screenshot(path=str(SCREENSHOTS / "qf-08-md-cache.png"), full_page=False)
        print("[test] PASS: second MD click rendered without 'loading…' flash")
    finally:
        browser.close()


if __name__ == "__main__":
    test_md_doc_renders_instantly_on_second_click()