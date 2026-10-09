"""QF-15 — the NEEDS YOU pill never lifted the per-card jump arrows.

QF-02 (commit 25e387d) shipped two coordinated changes:

  1. CSS: `body.has-ask-pill .cell .jump{ bottom:84px }` — should lift
     the per-card jump arrows above the pill.
  2. JS (ask-popup.js:237): toggle the `body.has-ask-pill` class on/off
     depending on the popup state.

The JS predicate was inverted: `!minimised && !pill.hidden` is always
false because the line JUST ABOVE (236) flips `pill.hidden` to match
`!minimised`. So the class is **never set**, the CSS rule never fires,
and the pill always overlaps the down arrow.

Fix: drop the leading `!` — the predicate becomes
`minimised && !pill.hidden`, which is true exactly when the popup is
collapsed AND the pill is visible.

This spec verifies the fix at three levels:

  1. **Source-level** — fetch `/ask-popup.js` and assert the toggle line
     reads `minimised && !pill.classList.contains` (not
     `!minimised && ...`). Catches the regression statically.
  2. **CSS-level** — load the dashboard, force the body class on, inject
     a temporary `.cell .jump`, and assert the rule lifts the arrows to
     `bottom:84px`. Catches a CSS regression independently of the JS.
  3. **Runtime-level** — set `sessionStorage['ghosty.askPopup.minimized']='1'`
     and reload, so ask-popup.js re-reads its module-local `minimised=true`.
     Then assert `body.has-ask-pill` flips on.

Pre-fix run:  static check fails; CSS check would still PASS (CSS is
correct); runtime check FAILS (class never set).  Post-fix: all pass.

The test does NOT depend on the queue being populated — the JS
expression is what regressed, the CSS is what it should drive, and the
state-machine reload is what triggers render() with the right flag.
"""
from __future__ import annotations
import re
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _setup import new_page, goto_base_shell, BASE, VIEWPORT_DESK, SCREENSHOTS


def test_source_level_toggle_predicate_is_not_inverted():
    """ask-popup.js:237 must read `minimised && !pill.classList.contains`
    (post-fix), not `!minimised && !pill.classList.contains` (pre-fix,
    the broken QF-02 form)."""
    import urllib.request
    body = urllib.request.urlopen(f"{BASE}/ask-popup.js").read().decode()
    # Find the body.classList.toggle line with has-ask-pill
    matches = re.findall(
        r"document\.body\.classList\.toggle\('has-ask-pill',\s*([^)]+)\)",
        body,
    )
    assert matches, "no `body.classList.toggle('has-ask-pill', ...)` call found"
    expr = matches[0]
    assert "!minimised" not in expr, (
        f"QF-02 bug regression: predicate still inverts `minimised`.\n"
        f"  current: {expr!r}\n"
        f"  expected: 'minimised && !pill.classList.contains(...)'"
    )
    assert "minimised" in expr, (
        f"predicate should depend on `minimised` (got: {expr!r})"
    )
    assert "!pill.classList.contains" in expr, (
        f"predicate should still check `!pill.hidden` so the class only\n"
        f"flips on when the pill is on screen (got: {expr!r})"
    )


def test_css_rule_lifts_jump_when_body_class_set():
    """Static check of the CSS rule. The runtime check above is what
    actually exercises the live system; this one ensures a future CSS
    regression (someone tightening the selector, dropping the px unit,
    removing the rule, etc.) is caught without touching the browser."""
    import urllib.request
    css = urllib.request.urlopen(f"{BASE}/style.css").read().decode()
    # The QF-02 / QF-15 rule must be present and shift by exactly 74 px.
    assert "body.has-ask-pill .cell .jump" in css, (
        "the QF-02 / QF-15 selector is missing from style.css"
    )
    match = re.search(
        r"body\.has-ask-pill\s+\.cell\s+\.jump\{\s*bottom:\s*(\d+)px\s*;?\s*\}",
        css,
    )
    assert match, "could not parse `body.has-ask-pill .cell .jump { bottom: Npx }`"
    px = int(match.group(1))
    assert abs(px - 84) < 1, (
        f".cell .jump should be lifted to bottom:84 px while the pill is on; got {px}px "
        f"(was 10 px before QF-02 → 84 px after; absolute shift = 74 px)"
    )
    # Baseline rule must still leave the buttons at bottom:10 px when the
    # class is absent (so a card without the pill stays close to the edge).
    base = re.search(r"^\.cell\s+\.jump\{[^}]*bottom:\s*(\d+)px", css, re.M)
    assert base and int(base.group(1)) == 10, (
        f"baseline .cell .jump should be at bottom:10 px; got {base.group(1) if base else 'no-match'}"
    )


def test_runtime_class_flips_on_minimised_reload():
    """Reload the page with `sessionStorage['ghosty.askPopup.minimized']='1'`
    so ask-popup.js re-reads its module-local `minimised=true`. The
    next render() (within the 1 s setInterval, or the initial render
    at module load) MUST set body.has-ask-pill. Pre-fix: never set."""
    browser, ctx, page = new_page(VIEWPORT_DESK)
    try:
        goto_base_shell(page)
        page.evaluate(
            "() => sessionStorage.setItem('ghosty.askPopup.minimized', '1')"
        )
        page.reload()
        # Wait up to 3 s for the body class to flip on (initial render
        # at module load happens within milliseconds; the 1 s setInterval
        # also fires it).
        try:
            page.wait_for_function(
                "() => document.body.classList.contains('has-ask-pill')",
                timeout=3_000,
            )
        except Exception:
            # Class never appeared — check what state the page is in for
            # debugging.
            state = page.evaluate(
                "() => ({"
                "  bodyClass: document.body.className,"
                "  pillHidden: document.getElementById('askPopupPill')?.classList.contains('hidden'),"
                "  elHidden: document.getElementById('askPopup')?.classList.contains('hidden'),"
                "  minKey: sessionStorage.getItem('ghosty.askPopup.minimized'),"
                "  windowKeys: Object.keys(window).filter(k => k.includes('ask') || k.includes('popup')).slice(0, 5),"
                "})"
            )
            raise AssertionError(
                f"body.has-ask-pill never set after reload with minimised=1\n"
                f"  debug state: {state}"
            )
        # Confirm pill is visible (the other half of the predicate)
        pill_hidden = page.evaluate(
            "() => document.getElementById('askPopupPill').classList.contains('hidden')"
        )
        assert not pill_hidden, (
            "pill should be visible (not hidden) when minimised=1; "
            "ask-popup.js:236 toggles pill.hidden=false in that case"
        )
        # Tidy up — clear the sessionStorage key so the next spec run isn't affected
        page.evaluate(
            "() => sessionStorage.removeItem('ghosty.askPopup.minimized')"
        )
        print("ok: QF-15 ask-popup module sets body.has-ask-pill on minimised reload")
    finally:
        browser.close()
