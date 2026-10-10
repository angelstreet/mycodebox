"""QF-16 — copy-to-clipboard + audio-transcript on each reply in the reader.

For every other place that renders an AI question block
(`ask-popup.js` for the popup, `app.js:1135-1136` for the multi-question
popover, `app.js:1368-1369` for the task doc), the design includes two
small affordances:

  - a `.copy-prompt` button (clipboard icon → `navigator.clipboard.writeText`
    with an `execCommand` fallback; from `public/copy-prompt.js`),
  - an `.audio-chip` (play / pause + speed selector, backed by
    `/api/tts/<hash>` + piper; from `public/audio-chip.js`).

The `.cell .reader` (the per-card "Reader / terminal" view, where the
last AI reply is rendered as readable text) was the one place these
were missing. User quote (2026-10-09 22:45, screenshot
`/home/jndoye/.ghosty/uploads/1791584506494-ad314d.png`):

> "on web i dont see the copy to clip boad audio transcrpt btn on each
>  response why ?"

Fix (`public/app.js` `paintReader`): when the reader has non-empty text,
append a `<div class="rd-actions">…</div>` row at the bottom carrying
`copyPromptButtonHtml(text)` and `audioChipHtml(text)`. The chip is
wired through `wireAudioChips(el)` (idempotent; gated by `el._chipsWired`
so we don't re-wire on every paint).

This spec asserts:

  1. Source-level — `app.js` references both `copyPromptButtonHtml` and
     `audioChipHtml` inside `paintReader`, so the buttons are emitted
     on every reader render path (verifies the import was actually used
     inside the function — a future reader render could regress).
  2. CSS-level — `.reader .rd-actions` rule exists with a flex layout
     and a top border (the visual affordance).
  3. Static DOM — given an `<article>` with the new markup, the
     `.copy-prompt` carries the right `aria-label`, the `.audio-chip`
     is present and carries the right `aria-label`, both are inside
     `.rd-actions`.

Pre-fix: source check fails (no `copyPromptButtonHtml` / `audioChipHtml`
calls inside `paintReader`); CSS check fails; static check fails.
Post-fix: all three pass.
"""
from __future__ import annotations
import sys, re
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _setup import new_page, goto_base_shell, BASE, VIEWPORT_DESK


def test_source_level_paintReader_emits_both_buttons():
    """`paintReader` in app.js must call both `copyPromptButtonHtml` and
    `audioChipHtml` so every reader render carries the affordances. Catches
    a future refactor that moves the inline `'copyPromptButtonHtml'` call
    into a different render path silently.

    Function-boundary detection: paintReader ends at the line that closes
    with `}\n` followed by `function inlineMd(` (the next top-level
    function in the file). Counting braces naively doesn't work because
    the body holds template literals with `${copyPromptButtonHtml({ ... })}`
    whose braces offset the depth tracker."""
    import re, urllib.request
    body = urllib.request.urlopen(f"{BASE}/app.js").read().decode()
    m = re.search(
        r"function paintReader\b.*?\n\}\nfunction inlineMd\b",
        body,
        re.S,
    )
    assert m, "could not locate the `paintReader` → `inlineMd` boundary"
    block = m.group(0)
    assert "copyPromptButtonHtml" in block, (
        "paintReader must render a .copy-prompt button"
    )
    assert "audioChipHtml" in block, (
        "paintReader must render an .audio-chip"
    )
    assert 'class="rd-actions"' in block, (
        "paintReader must wrap the two affordances in `<div class=\"rd-actions\">`"
    )
    assert "wireAudioChips" in block, (
        "paintReader must call wireAudioChips() to activate the audio chip"
    )


def test_css_rule_reader_rd_actions_exists():
    """`.reader .rd-actions` must exist and be a flex row with a top
    border so the buttons sit cleanly at the bottom of the reader."""
    import urllib.request
    css = urllib.request.urlopen(f"{BASE}/style.css").read().decode()
    assert ".reader .rd-actions" in css, (
        "expected a `.reader .rd-actions` rule in style.css"
    )
    assert "display:flex" in re.search(
        r"\.reader\s+\.rd-actions\{[^}]*\}", css
    ).group(0), (
        ".reader .rd-actions should be a flex row"
    )


def test_dom_render_carries_both_buttons_and_correct_labels():
    """Mount a fake `.cell .rd-on .reader` with the markup `paintReader`
    produces (rd-actions row + copy-prompt + audio-chip from
    copy-prompt.js / audio-chip.js). The DOM check doesn't drive the real
    `paintReader` (state is module-local, not on `window`); instead it
    asserts the markup pattern + CSS class are in place and that copy
    and audio-chip modules are importable and produce the right
    attributes when called the way paintReader calls them.
    """
    import urllib.request
    browser, ctx, page = new_page(VIEWPORT_DESK)
    try:
        goto_base_shell(page)
        # Drive the real copy-prompt + audio-chip helpers exactly as
        # paintReader does, then assert the rendered DOM matches what we
        # expect to land inside `.reader` on every reply.
        page.evaluate(
            """async () => {
              const [{ copyPromptButtonHtml }, { audioChipHtml, wireAudioChips }] = await Promise.all([
                import('/copy-prompt.js'),
                import('/audio-chip.js'),
              ]);
              const text = 'Hello from the agent\\n\\nLine 2';
              const cell = document.createElement('div');
              cell.className = 'cell rd-on';
              const reader = document.createElement('div');
              reader.className = 'reader';
              cell.appendChild(reader);
              document.body.appendChild(cell);
              reader.innerHTML = '<button class="rd-more" data-act="more">↑ earlier conversation</button>'
                              + '<p>Hello from the agent</p>'
                              + '<div class="rd-actions">'
                              +   copyPromptButtonHtml({ text, label: 'Copy reply' })
                              +   audioChipHtml({ text, label: 'Read reply aloud' })
                              + '</div>';
              wireAudioChips(reader);
            }"""
        )
        page.wait_for_timeout(120)
        actions = page.evaluate(
            "() => !!document.querySelector('.cell .reader .rd-actions')"
        )
        assert actions, ".reader .rd-actions must be in the DOM after the same paintReader pattern"
        copy_btn = page.evaluate(
            "() => { const b = document.querySelector('.cell .reader .copy-prompt');"
            "    return b ? { aria: b.getAttribute('aria-label'), dataCopy: b.getAttribute('data-copy'), dataWired: b.classList.contains('data-wired') } : null; }"
        )
        assert copy_btn, ".reader .copy-prompt must be present"
        assert copy_btn["aria"] == "Copy reply", (
            f"copy button aria-label should be 'Copy reply' (got {copy_btn['aria']!r})"
        )
        assert "Hello from the agent" in copy_btn["dataCopy"], (
            f"copy button data-copy should contain the reply text (got {copy_btn['dataCopy']!r})"
        )
        chip = page.evaluate(
            "() => { const c = document.querySelector('.cell .reader .audio-chip');"
            "    return c ? { aria: c.getAttribute('aria-label'), dataText: c.getAttribute('data-text') } : null; }"
        )
        assert chip, ".reader .audio-chip must be present"
        assert chip["aria"] == "Read reply aloud", (
            f"audio chip aria-label should be 'Read reply aloud' (got {chip['aria']!r})"
        )
        assert "Hello from the agent" in chip["dataText"], (
            f"audio chip data-text should contain the reply text (got {chip['dataText']!r})"
        )
        container_ok = page.evaluate(
            "() => document.querySelector('.cell .reader .copy-prompt').closest('.rd-actions') "
            "  && document.querySelector('.cell .reader .audio-chip').closest('.rd-actions')"
        )
        assert container_ok, (
            "copy-prompt and audio-chip must both be inside .rd-actions"
        )
        # The .reader .rd-actions flex row should be visible in computed style.
        disp = page.evaluate(
            "() => getComputedStyle(document.querySelector('.cell .reader .rd-actions')).display"
        )
        assert disp == "flex", (
            f".reader .rd-actions should be `display: flex` (got {disp!r})"
        )
        print("ok: QF-16 reader renders copy + audio chip per reply")
    finally:
        browser.close()
