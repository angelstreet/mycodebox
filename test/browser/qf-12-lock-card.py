"""QF-12 — pin a card so it survives nav taps, unlock it, verify focus returns.

Reproduces the user's request (2026-10-09 19:24 UTC, screenshot
1791573844131-e70f27.png):
> "lock the card so it stays as the displayed/focused card even when you tap
>  another session in the left navigation. Specifically keep
>  codebox-quickfix-migr… displayed so I can keep working in it while I poke
>  at other sessions in the side panel."

Spec (per QF-12):
1. Open the dashboard on desktop (the side list is docked, so the user
   can tap rows without first opening a drawer).
2. Switch to single-card mode by clicking the size-1 button so the
   `.card-pane` is visible (the lock button only renders there).
3. Click a side list row (`.meta` — that's the side list's actual click
   target) to focus a session. The card pane cell gets `.focus`, the
   side list `li` gets `.active`, and the lock button (`.lk`) renders
   in the cell header.
4. Click the lock button (`.card-pane .cell .h .lk`).
   - Button gains `.on` and `aria-pressed="true"`.
   - The lock glyph flips to the unlock glyph.
5. Click a DIFFERENT session row in the side list. The click handler
   calls focusSession(other); the lock guard bails and the toast appears.
   - `.card-pane .cell.focus` is still the FIRST session's cell.
   - The side list `li.active` is still the FIRST session.
   - `#toast` mentions the locked name (or contains the word "locked").
6. Click the lock button again to unlock.
   - Button loses `.on` and `aria-pressed` is "false".
7. Click a different session row in the side list. The focus must now move.
   - `.card-pane .cell.focus` now corresponds to the OTHER session.
   - The side list `li.active` is the OTHER session.
8. localStorage persistence sanity: lock again, reload, expect the pin
   to come back (button `.on` and `aria-pressed="true"` again).
9. Screenshot the card with the lock-on state to `screenshots/qf-12-lock-card.png`.
"""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _setup import new_page, goto_base, BASE, VIEWPORT_DESK, SCREENSHOTS


def _side_rows(page):
    """Snapshot the side list rows in order: [(name, display), ...]."""
    return page.evaluate("""() => Array.from(document.querySelectorAll('#sessionList > li[data-session]'))
        .map(li => [li.dataset.session, li.querySelector('.name')?.textContent?.trim() || li.dataset.session])""")


def _active_side_name(page) -> str:
    return page.evaluate("() => document.querySelector('#sessionList > li.active')?.dataset?.session || ''")


def _active_cell_session(page) -> str:
    return page.evaluate("() => document.querySelector('.card-pane .cell.focus')?.dataset?.session || ''")


def _lk_state(page) -> dict:
    return page.evaluate("""() => {
        const lk = document.querySelector('.card-pane .cell .h .lk');
        if (!lk) return { found: false };
        return {
            found: true,
            on: lk.classList.contains('on'),
            ariaPressed: lk.getAttribute('aria-pressed'),
            ariaLabel: lk.getAttribute('aria-label'),
        };
    }""")


def _click_side_row(page, name: str):
    """Click the side list row's .meta element (the side list's click target).
    The li itself has no click handler — only .meta does."""
    page.locator(f"#sessionList > li[data-session='{name}'] .meta").click()
    page.wait_for_timeout(150)   # let focusSession + renderCard settle


def test_lock_card_survives_nav_taps():
    # service_workers='block' so the SW can't pin the page in a stale state
    # between the click and the reload — the SW registered a scope on the
    # live host and would otherwise intercept the reload with cached HTML.
    browser, ctx, page = new_page(VIEWPORT_DESK, service_workers="block")
    try:
        goto_base(page)
        rows = _side_rows(page)
        print(f"[test] side list rows ({len(rows)}): {[r[0] for r in rows]}")
        assert len(rows) >= 2, f"need at least 2 sessions in the side list, got {len(rows)}"
        first, other = rows[0][0], rows[1][0]
        print(f"[test] using sessions: first={first!r} other={other!r}")

        # 1. Switch to single-card mode so the card pane (with the lock button)
        #    is visible. The topbar's size-1 button calls setMode('card').
        page.locator('.size-btn[data-size="1"]').click()
        page.wait_for_selector(".card-pane .cell", state="visible", timeout=10_000)
        page.wait_for_selector(".card-pane .cell .h .lk", timeout=5_000)

        # 2. Click the first row to focus it (focusSession + openCard because
        #    state.mode is now 'card').
        _click_side_row(page, first)
        page.wait_for_function(
            f"() => document.querySelector('.card-pane .cell.focus')?.dataset?.session === {first!r}",
            timeout=5_000,
        )
        active_cell = _active_cell_session(page)
        active_side = _active_side_name(page)
        print(f"[test] step 1: card.focus={active_cell!r}, side.active={active_side!r}")
        assert active_cell == first, f"expected card.focus={first!r}, got {active_cell!r}"
        assert active_side == first, f"expected side.active={first!r}, got {active_side!r}"

        # 3. Click the lock button on the card header.
        lk = page.locator(".card-pane .cell .h .lk")
        lk.click()
        st = _lk_state(page)
        print(f"[test] step 2: .lk state = {st}")
        assert st["found"], "lock button must exist in the card header"
        assert st["on"] is True, f"expected .lk.on after click, got {st!r}"
        assert st["ariaPressed"] == "true", f"expected aria-pressed='true', got {st!r}"
        assert "Unlock" in (st.get("ariaLabel") or ""), (
            f"expected aria-label to flip to 'Unlock' when locked, got {st!r}"
        )

        # 4. Tap a different session in the side list. focusSession(other)
        #    must bail because state.lockedSession === first.
        _click_side_row(page, other)
        page.wait_for_timeout(200)   # toast + syncAll settle
        active_cell = _active_cell_session(page)
        active_side = _active_side_name(page)
        toast_text = page.evaluate("() => document.getElementById('toast')?.textContent || ''")
        print(f"[test] step 3: card.focus={active_cell!r}, side.active={active_side!r}, toast={toast_text!r}")
        assert active_cell == first, (
            f"focus must NOT switch while locked: card.focus={active_cell!r}, expected {first!r}"
        )
        assert active_side == first, (
            f"focus must NOT switch while locked: side.active={active_side!r}, expected {first!r}"
        )
        assert first in toast_text or "locked" in toast_text.lower(), (
            f"toast should mention the lock, got {toast_text!r}"
        )

        # Capture the locked-state visual now (card stays focused, lock chip
        # is lit) so the screenshot always shows the pin regardless of which
        # subsequent step fails.
        page.screenshot(path=str(SCREENSHOTS / "qf-12-lock-card.png"), full_page=False)

        # 5. Click the lock button again to unlock.
        lk.click()
        st = _lk_state(page)
        print(f"[test] step 4: .lk state = {st}")
        assert st["on"] is False, f"expected .lk.on=false after second click, got {st!r}"
        assert st["ariaPressed"] == "false", f"expected aria-pressed='false', got {st!r}"

        # 6. Tap the other session. Focus must now move.
        _click_side_row(page, other)
        page.wait_for_function(
            f"() => document.querySelector('.card-pane .cell.focus')?.dataset?.session === {other!r}",
            timeout=5_000,
        )
        active_cell = _active_cell_session(page)
        active_side = _active_side_name(page)
        print(f"[test] step 5: card.focus={active_cell!r}, side.active={active_side!r}")
        assert active_cell == other, f"focus must switch after unlock, got {active_cell!r}"
        assert active_side == other, f"side.active must update, got {active_side!r}"

        # 7. localStorage persistence: lock again, reload, expect the pin to
        #    come back. This catches the regression where state.lockedSession
        #    is set in memory but never written to localStorage.
        lk.click()
        assert _lk_state(page)["on"] is True, "lock should be re-applied before reload"
        # Reload the page; the in-flight state goes away, but localStorage
        # keeps the lock name. We re-enter card mode (the same path the user
        # does after a soft reload) and verify the .lk button comes back lit.
        page.reload()
        page.wait_for_function(
            "() => document.querySelector('#listPane')?.innerHTML?.length "
            "    || document.querySelector('#gridPane')?.innerHTML?.length",
            timeout=10_000,
        )
        page.locator('.size-btn[data-size="1"]').click()
        page.wait_for_selector(".card-pane .cell .h .lk", state="visible", timeout=10_000)
        st = _lk_state(page)
        print(f"[test] step 6: after reload, .lk state = {st}")
        assert st["found"], "lock button must exist after reload"
        assert st["on"] is True, f"lock must survive reload, got {st!r}"
        assert st["ariaPressed"] == "true", f"aria-pressed must persist, got {st!r}"

        print("[test] PASS: lock guards focus, unlock restores it, and the pin survives reload")
    finally:
        browser.close()


if __name__ == "__main__":
    test_lock_card_survives_nav_taps()
