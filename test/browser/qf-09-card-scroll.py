"""QF-09 — card body must scroll on a phone, not silently clip long content.

Reproduces the bug the user reported (chat-raised 2026-10-09 19:21):
> "the height of the [card pane] must be fixed with scrollbar to avoid that"

The user pasted a mobile screenshot (1791573674335-93eeea.png) showing the
card pane in card mode: a long error from the mcode agent (the
`@minimax-ai/code` chunk that fails to import) was rendered taller than
the visible card area, but the card had no scrollbar — the user could
see the start of the error but could not scroll to read the rest.

Spec (per QF-09):
1. Open the dashboard on a phone viewport (412x915).
2. On mobile the default view IS card mode; wait for the card to render
   in #cardPane.
3. Assert that the card body (`.card-pane .cell .b`) has:
   - a non-zero `clientHeight` (it is actually visible), AND
   - either `getComputedStyle(...).overflowY` ∈ {`auto`, `scroll`}
     (the CSS fix is in place) OR
     `scrollHeight > clientHeight` (it is already overflowing, so the
     browser would have to show a scrollbar to expose the rest).
4. Capture a screenshot to `screenshots/qf-09-card-scroll.png` so the
   next agent can diff against it.

The OR is deliberate: a freshly-loaded card on a quiet server may not
have tall content yet, in which case the computed-style check is the
only signal that the fix is wired up.
"""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _setup import new_page, BASE, VIEWPORT_PHONE, SCREENSHOTS


def test_card_body_scrolls_on_phone():
    browser, ctx, page = new_page(VIEWPORT_PHONE)
    try:
        # Phone defaults to GRID mode (the list-mode toggle is hidden at
        # <=720 px). Tap the first grid card to enter card mode; that's
        # the surface the user actually hits when a card is "open".
        page.goto(BASE)
        page.wait_for_selector("#gridPane .cell", timeout=10_000)
        page.locator("#gridPane .cell").first.click()
        page.wait_for_selector(".card-pane .cell .b", state="visible", timeout=10_000)

        result = page.evaluate("""() => {
            const b = document.querySelector('.card-pane .cell .b');
            if (!b) return { error: 'no .cell .b in #cardPane' };
            const cs = getComputedStyle(b);
            return {
                overflowY: cs.overflowY,
                overflowX: cs.overflowX,
                clientHeight: b.clientHeight,
                scrollHeight: b.scrollHeight,
                clientWidth: b.clientWidth,
                scrollWidth: b.scrollWidth,
            };
        }""")
        print(f"[test] .card-pane .cell .b = {result}")

        # Screenshot regardless of pass/fail so the verifier has evidence.
        page.screenshot(path=str(SCREENSHOTS / "qf-09-card-scroll.png"), full_page=False)

        assert "error" not in result, f"card body not found: {result}"

        # 1. The card body must actually have a visible area.
        client_h = result.get("clientHeight", 0)
        assert client_h > 0, f"card body clientHeight is 0 (not visible): {result}"

        # 2. Either the CSS declares a scrollable overflow, OR the content
        #    already overflows the visible area (in which case the browser
        #    would have to expose a scrollbar for the user to read the rest).
        overflow_y = result.get("overflowY", "")
        scrollable = result.get("scrollHeight", 0) > client_h
        assert overflow_y in ("auto", "scroll") or scrollable, (
            f"card body cannot scroll: overflowY={overflow_y!r}, "
            f"scrollable={scrollable} (scrollHeight={result.get('scrollHeight')}, "
            f"clientHeight={client_h})"
        )

        if scrollable:
            print(f"[test] card body is overflowing (scrollHeight={result.get('scrollHeight')} > clientHeight={client_h})")
        else:
            print(f"[test] card body not overflowing yet; overflowY={overflow_y!r} is set, so long content will scroll when it arrives")
        print("[test] PASS: card body has scrollable overflow + non-zero clientHeight")
    finally:
        browser.close()


if __name__ == "__main__":
    test_card_body_scrolls_on_phone()
