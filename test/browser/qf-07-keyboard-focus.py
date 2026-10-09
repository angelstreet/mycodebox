"""QF-07 — typing on a focused card should move focus to the dock input.

Reproduces the bug the user reported (chat-raised 2026-10-09 10:14):
> "on web if i have the card content focused i press any keyboard key and i
> dont see the focus moving to text input and the letter there"

Expected (per QF-07 spec):
1. Open the dashboard.
2. Click a list row → focusSession + openCard, mode='card'.
3. Click somewhere inside the card body so focus lands on the xterm
   viewport (NOT on the dock input).
4. Press a printable key on the keyboard (e.g. 'h').
5. Assert: #sendInput now has focus.
6. Assert: #sendInput's value contains the pressed character.

If assertions 5/6 fail, the fix is missing — the document keydown handler
isn't focusing the input. The browser screenshot at the failure point is
captured to screenshots/qf-07-keyboard-focus.png for visual diffing.
"""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _setup import new_page, goto_base, BASE, VIEWPORT_DESK, SCREENSHOTS


def test_keyboard_focus_moves_to_dock_input():
    browser, ctx, page = new_page(VIEWPORT_DESK)
    try:
        goto_base(page)

        # Desktop defaults to grid mode; switch to list so #listPane has rows
        # to click on.
        page.locator('[data-mode="list"]').click()
        page.wait_for_selector("#listPane .row-item", timeout=10_000)

        # 1. Open a card by clicking a row.
        page.locator("#listPane .row-item").first.click()

        # 2. Card should be visible — wait for the card pane.
        page.wait_for_selector(".card-pane .cell", state="visible", timeout=10_000)

        # 3. Click inside the card body to move focus off the input and onto
        #    the xterm viewport (or whatever captures focus inside .cell).
        page.locator(".card-pane .cell .b").click(position={"x": 50, "y": 50})

        # 4. Press 'h' on the physical keyboard.
        page.keyboard.press("h")

        # Take a screenshot regardless of pass/fail so we can eyeball.
        page.screenshot(path=str(SCREENSHOTS / "qf-07-keyboard-focus.png"), full_page=False)

        # 5. Did focus move?
        focused = page.evaluate("document.activeElement && document.activeElement.id")
        print(f"[test] document.activeElement.id = {focused!r}")
        assert focused == "sendInput", f"expected focus on #sendInput, got {focused!r}"

        # 6. Did the letter land?
        val = page.locator("#sendInput").input_value()
        print(f"[test] #sendInput value = {val!r}")
        assert val.endswith("h"), f"expected 'h' at end of #sendInput, got {val!r}"

        print("[test] PASS: typing on focused card → focus + character on #sendInput")
    finally:
        browser.close()


if __name__ == "__main__":
    test_keyboard_focus_moves_to_dock_input()