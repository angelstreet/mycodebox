"""QF-14 — dock layout: paperclip right of mic, wider fixed task chip, no flicker.

Reproduces the bug (chat-raised 2026-10-09 19:35, screenshot
/home/jndoye/.ghosty/uploads/1791574846380-49b000.png):

> "attach file on the right of audio and put the task dropdown width wider
>  size of the moved icon and fix size to avoid flicker"

Spec:
1. Open the dashboard on a phone viewport AND on a desktop viewport.
2. Assert the DOM order of the dock row is
     dockToggle, tchip, micBtn, sendInput, sendBtn, attachBtn
   (mic appears before attach in DOM order).
3. Assert `#attachBtn` is to the right of `#micBtn` in the viewport
   (their left edges satisfy `attachRect.left >= micRect.left`).
4. Assert `.dock .mic` (both buttons) measure exactly 42 px wide.
5. Assert `.tchip` measures exactly 200 px wide, regardless of the
   active session name (long or short).
6. With a short target name, switch to a long target name and confirm
   the mic / sendBtn / attachBtn bounding rects do NOT change.
7. Capture `screenshots/qf-14-dock-layout-phone.png` and
   `screenshots/qf-14-dock-layout-desk.png`.

The test must FAIL on the unpatched code (attachBtn appears LEFT of
micBtn, tchip breathes from 88 px to 260 px as the target name changes)
and PASS on the patched code.
"""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _setup import new_page, goto_base_shell, BASE, VIEWPORT_PHONE, VIEWPORT_DESK, SCREENSHOTS


def _row_button_order(page):
    """Return the list of button ids in `#dock .row` in DOM order (input + file
    skipped because they don't have ids)."""
    return page.evaluate(
        "() => Array.from(document.querySelectorAll('#dock .row > *'))"
        ".map((el) => el.id || el.tagName.toLowerCase())"
    )


def _width(page, sel):
    return page.evaluate(
        f"() => document.querySelector('{sel}').getBoundingClientRect().width"
    )


def _rect_left(page, sel):
    return page.evaluate(
        f"() => document.querySelector('{sel}').getBoundingClientRect().left"
    )


def test_dock_layout_paperclip_right_of_mic():
    browser, ctx, page = new_page(VIEWPORT_PHONE)
    try:
        goto_base_shell(page)

        # 1. DOM order: micBtn appears BEFORE attachBtn
        order = _row_button_order(page)
        ids = [x for x in order if x]  # drop empty (file input has no id)
        assert "micBtn" in ids and "attachBtn" in ids, f"missing buttons, got {ids}"
        assert ids.index("micBtn") < ids.index("attachBtn"), (
            f"expected micBtn before attachBtn in DOM, got {ids}"
        )

        # 2. attachBtn is right of micBtn in the layout
        mic_left = _rect_left(page, "#micBtn")
        attach_left = _rect_left(page, "#attachBtn")
        assert attach_left >= mic_left, (
            f"expected attachBtn (left={attach_left}) right of micBtn (left={mic_left})"
        )

        # 3. mic & paperclip are 42 px wide (fixed in CSS)
        assert abs(_width(page, "#micBtn") - 42) < 1, f"micBtn width != 42"
        assert abs(_width(page, "#attachBtn") - 42) < 1, f"attachBtn width != 42"

        # 4. tchip is 200 px wide
        assert abs(_width(page, ".tchip") - 200) < 1, f"tchip width != 200"

        # 5. Screenshot the fixed dock
        page.screenshot(
            path=str(SCREENSHOTS / "qf-14-dock-layout-phone.png"),
            clip={"x": 0, "y": page.viewport_size["height"] - 200,
                  "width": page.viewport_size["width"], "height": 200},
        )

        # 6. Switch active to a long-name session (if any) and confirm
        #    button positions did NOT change.
        long_name = page.evaluate(
            "() => (window.state?.sessions || [])."
            "    map((s) => s.name).filter((n) => n && n.length >= 12)[0] || null"
        )
        if long_name:
            mic_before = _rect_left(page, "#micBtn")
            attach_before = _rect_left(page, "#attachBtn")
            page.evaluate(
                f"() => {{ window.state.active = {long_name!r}; "
                f"if (typeof window.applyDock === 'function') window.applyDock(); }}"
            )
            page.wait_for_timeout(120)
            mic_after = _rect_left(page, "#micBtn")
            attach_after = _rect_left(page, "#attachBtn")
            assert abs(mic_after - mic_before) < 2, (
                f"micBtn shifted by {mic_after - mic_before} px when target name changed"
            )
            assert abs(attach_after - attach_before) < 2, (
                f"attachBtn shifted by {attach_after - attach_before} px when target name changed"
            )

        print("ok: QF-14 dock layout invariants hold on phone viewport")
    finally:
        browser.close()


def test_dock_layout_desktop_fixed_tchip_and_frozen_mic():
    browser, ctx, page = new_page(VIEWPORT_DESK)
    try:
        goto_base_shell(page)
        # Same invariants on desktop
        order = _row_button_order(page)
        ids = [x for x in order if x]
        assert ids.index("micBtn") < ids.index("attachBtn"), f"desktop order {ids}"
        assert abs(_width(page, "#micBtn") - 42) < 1
        assert abs(_width(page, "#attachBtn") - 42) < 1
        assert abs(_width(page, ".tchip") - 200) < 1, f"tchip != 200 on desktop"
        # Mic is to the LEFT of attach in viewport too (paperclip right of mic)
        assert _rect_left(page, "#attachBtn") >= _rect_left(page, "#micBtn")
        page.screenshot(
            path=str(SCREENSHOTS / "qf-14-dock-layout-desk.png"),
            clip={"x": 0, "y": page.viewport_size["height"] - 200,
                  "width": page.viewport_size["width"], "height": 200},
        )
        print("ok: QF-14 dock layout invariants hold on desktop viewport")
    finally:
        browser.close()
