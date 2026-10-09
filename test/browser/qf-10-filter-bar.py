"""QF-10 — filter bar: one clear button, hide empty tasks chip.

Reproduces the bug (chat-raised 2026-10-09 19:22, mobile screenshot
/home/jndoye/.ghosty/uploads/1791573743757-46a1a7.png):
> "filter bar shows two clear buttons at once: 'clear all filters ×' at the
>  TOP and 'clear ×' at the BOTTOM. The top one flashes in/out and feels
>  duplicated. The 'tasks 0' chip is useless clutter when no TASK-prefixed
>  sessions exist."

Spec:
1. Open the dashboard, switch to list mode on a phone viewport.
2. Open the filter popover.
3. Activate a filter (e.g., click the 'working' status filter chip).
4. Assert that `.fclear` (the bottom clear) is visible.
5. Assert that `.fclear-top` does NOT exist in the DOM at all.
6. Clicking `.fclear` clears the filter (no top button means no extra
   duplicate to maintain).
7. For the tasks chip:
   - when no session matches /^TASK[-_]/i, the `.fchip-task` element is
     NOT in the DOM
   - when at least one session matches, `.fchip-task` IS in the DOM
8. Capture screenshots/qf-10-filter-bar.png.

The test should FAIL on the unpatched code (the top .fclear-top is still
rendered, and the tasks chip is still rendered even with a 0 count) and
PASS on the patched code.
"""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _setup import new_page, goto_base, BASE, VIEWPORT_PHONE, SCREENSHOTS


def test_filter_bar_one_clear_button_and_hidden_empty_tasks_chip():
    browser, ctx, page = new_page(VIEWPORT_PHONE)
    try:
        goto_base(page)

        # Phone defaults to grid; switch to list mode so the rows are visible.
        page.locator('[data-mode="list"]').click()
        page.wait_for_selector("#listPane .row-item", timeout=10_000)

        # Open the filter popover.
        page.locator("#filterBtn").click()
        # Wait for the bar to drop the .hidden class.
        page.wait_for_function(
            "() => document.querySelector('#filterBar')?.classList.contains('hidden') === false",
            timeout=5_000,
        )

        # Snapshot the tasks-chip presence BEFORE activating any filter.
        # The fix only renders .fchip-task when at least one session matches
        # /^TASK[-_]/i. We don't know the count in advance, but we can ask
        # the page to compute it and compare.
        task_meta = page.evaluate("""() => {
            const ch = document.querySelector('.fchip-task');
            const sessions = (window.state && window.state.sessions) || [];
            const matchCount = sessions.filter(s => /^TASK[-_]/i.test(s.name || '')).length;
            return { chipExists: !!ch, matchCount };
        }""")
        print(f"[test] tasks chip before filter: {task_meta}")
        if task_meta["matchCount"] == 0:
            # Patched: no chip should be rendered at all.
            assert not task_meta["chipExists"], (
                f"QF-10: .fchip-task should NOT be rendered when no session matches "
                f"^TASK[-_]/i, but it was found (matchCount={task_meta['matchCount']})."
            )
        else:
            # Patched: chip should be present.
            assert task_meta["chipExists"], (
                f"QF-10: .fchip-task should be rendered when {task_meta['matchCount']} "
                f"sessions match ^TASK[-_]/i, but it was missing."
            )

        # Activate a filter — click the 'working' status chip. If 'working'
        # isn't present (no session in that state), fall back to whichever
        # state chip has a non-zero count.
        activated = page.evaluate("""() => {
            const chips = [...document.querySelectorAll('.fchip[data-g="filter"]')];
            let target = chips.find(c => c.dataset.v === 'working' && c.querySelector('.n')?.textContent !== '0');
            if (!target) target = chips.find(c => c.dataset.v && c.querySelector('.n')?.textContent !== '0' && c.dataset.v !== '');
            if (!target) return null;
            target.click();
            return target.dataset.v;
        }""")
        print(f"[test] activated filter: {activated!r}")
        assert activated, "QF-10: no non-zero status filter chip was available to activate"

        # Wait for the .fclear (bottom) to appear — it's only rendered when
        # anyFilter() is true.
        page.wait_for_selector("#filterBar .fclear", timeout=5_000)

        # The bottom clear must be visible (not display:none, not hidden class).
        bottom_visible = page.evaluate("""() => {
            const b = document.querySelector('#filterBar .fclear');
            if (!b) return false;
            const cs = window.getComputedStyle(b);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && !b.classList.contains('hidden');
        }""")
        assert bottom_visible, "QF-10: bottom .fclear should be visible when a filter is active"

        # The top .fclear-top must NOT be in the DOM at all (the fix removes
        # the element rather than hiding it, so we can assert on count).
        top_count = page.locator("#filterBar .fclear-top").count()
        assert top_count == 0, (
            f"QF-10: top .fclear-top should NOT be in the DOM when a filter is active, "
            f"but found {top_count} element(s). The duplicate 'clear all filters' button "
            f"at the top of the bar is the bug — the bottom .fclear is enough."
        )

        # Clicking the bottom .fclear must clear the filter and hide itself.
        page.locator("#filterBar .fclear").click()
        page.wait_for_function(
            "() => !document.querySelector('#filterBar .fclear')",
            timeout=5_000,
        )
        assert page.locator("#filterBar .fclear-top").count() == 0, (
            "QF-10: top .fclear-top must still be absent after clearing."
        )

        # Re-activate a filter so the screenshot shows the post-fix state with
        # the single bottom clear button visible.
        page.evaluate("""() => {
            const chips = [...document.querySelectorAll('.fchip[data-g="filter"]')];
            const target = chips.find(c => c.dataset.v && c.querySelector('.n')?.textContent !== '0' && c.dataset.v !== '');
            if (target) target.click();
        }""")
        page.wait_for_selector("#filterBar .fclear", timeout=5_000)

        page.screenshot(path=str(SCREENSHOTS / "qf-10-filter-bar.png"), full_page=False)
        print("[test] PASS: filter bar shows one clear button (.fclear at the bottom); "
              f"tasks chip hidden when count=0 / shown when count>0 (matchCount={task_meta['matchCount']})")
    finally:
        browser.close()


if __name__ == "__main__":
    test_filter_bar_one_clear_button_and_hidden_empty_tasks_chip()
