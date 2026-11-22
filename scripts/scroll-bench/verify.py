#!/usr/bin/env python3
"""Headless check of "Smooth scroll" at phone width (360 x 780, scale 3), on the bench's TEST server and throwaway tmux session
(bench.py: nothing live is touched). Prints one PASS / FAIL line per check and exits 1 on any FAIL.

  python3 scripts/scroll-bench/verify.py [--shots dir]
"""
import argparse, json, os, sys, time
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(__file__))
from bench import Rig, INIT, transcript, swipe   # noqa: E402

CELL = "document.querySelector('.cell[data-session=\"bench\"]')"
fails = []


def check(name, ok, detail=''):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  [' + str(detail) + ']' if detail != '' else ''}", flush=True)
    if not ok:
        fails.append(name)


def view(page):
    return page.evaluate(f"""() => {{ const c = {CELL}, r = c.querySelector('.reader'); return {{ rd: c.classList.contains('rd-on'),
        fromBottom: Math.round(r.scrollHeight - r.clientHeight - r.scrollTop), top: Math.round(r.scrollTop), saved: localStorage.getItem('ghosty.reader'),
        reqs: window.__bench.req.length, first: (r.innerText.match(/msg \\d+/) || [''])[0],
        thumb: c.querySelector('.cthumb')?.style.transform || '', est: !!c.querySelector('.cbar.est') }}; }}""")


def open_card(browser, rig, smooth, shots=None):
    ctx = browser.new_context(viewport={'width': 360, 'height': 780}, device_scale_factor=3, is_mobile=True, has_touch=True)
    ctx.add_init_script(INIT.replace('__LS__', json.dumps({'ghosty.reader': '0', **({} if smooth is None else {'ghosty.smoothScroll': '1' if smooth else '0'})})))
    page = ctx.new_page()
    body = json.dumps({'session': 'bench', 'text': transcript(), 'hash': 'bench', 'source': 'session-file'})
    page.route('**/api/transcript/*', lambda route, request: route.fulfill(status=200, content_type='application/json', body=body))
    page.goto(f'{rig.url(0)}/?s=bench')
    page.wait_for_selector('.cell[data-session="bench"] .xterm', timeout=20000)
    time.sleep(3.5)
    box = page.evaluate(f"() => {{ const r = {CELL}.querySelector('.b').getBoundingClientRect(); return {{ x: r.left + r.width / 2, y: r.top + 60 }}; }}")
    return ctx, page, ctx.new_cdp_session(page), box


def main(args):
    rig = Rig(12)
    shot = (lambda page, n: (os.makedirs(args.shots, exist_ok=True), page.screenshot(path=os.path.join(args.shots, n)))) if args.shots else (lambda page, n: None)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)

            # --- default (no saved setting): on
            ctx, page, cdp, box = open_card(browser, rig, None)
            v = view(page)
            check('opens on the terminal, live end', not v['rd'] and v['est'], v)
            shot(page, '1-terminal-live.png')
            swipe(cdp, box['x'], box['y'], 300, 500, 20); time.sleep(1.2)
            v = view(page)
            check('scroll up: the card shows the conversation, scrolled by the drag', v['rd'] and v['fromBottom'] >= 250, v)
            check('no scroll request went to the server', v['reqs'] == 0, v['reqs'])
            check('the saved reader / terminal choice is untouched', v['saved'] == '0', v['saved'])
            check('the scrollbar is the document\'s real one (not the estimate)', not v['est'])
            shot(page, '2-scrolled-local.png')
            swipe(cdp, box['x'], box['y'], 300, 80, 6); time.sleep(1.5)
            v2 = view(page)
            check('a second swipe (native, on the document) scrolls further', v2['rd'] and v2['fromBottom'] >= v['fromBottom'] + 200, v2['fromBottom'])   # the fling's length depends on host load: bench.py measures it
            # the pane keeps arriving while the card is local: the app is still at its live end
            off = page.evaluate("window.__bench.ws.at(-1)?.[1]")
            check('the app itself was never scrolled (off=0)', off == 0, off)
            # back down: big swipes up until the bottom
            for _ in range(8):
                if not view(page)['rd']:
                    break
                swipe(cdp, box['x'], box['y'] + 420, -420, 60, 5); time.sleep(1.3)
            v = view(page)
            check('at the bottom the live terminal is back', not v['rd'], v)
            check('still no scroll request, still the saved terminal', v['reqs'] == 0 and v['saved'] == '0', v)
            shot(page, '3-back-live.png')
            # jump buttons
            page.evaluate(f"() => {CELL}.querySelector('.jump [data-j=\"top\"]').click()"); time.sleep(1.6)
            v = view(page)
            check('jump to top: the oldest message, locally', v['rd'] and v['top'] == 0 and v['first'] == 'msg 000', v)
            shot(page, '4-jump-top.png')
            page.evaluate(f"() => {CELL}.querySelector('.jump [data-j=\"bottom\"]').click()"); time.sleep(0.8)
            check('jump to bottom: the live terminal', not view(page)['rd'])
            # scrollbar drag on the estimate bar
            bar = page.evaluate(f"() => {{ const r = {CELL}.querySelector('.cbar').getBoundingClientRect(); return {{ x: r.left + r.width / 2, y: r.top, h: r.height }}; }}")
            page.mouse.move(bar['x'], bar['y'] + bar['h'] * 0.5); page.mouse.down(); time.sleep(0.2)
            v = view(page)
            page.mouse.up(); time.sleep(0.5)
            frac = v['top'] / max(1, v['top'] + v['fromBottom'])
            check('a press on the scrollbar at mid height lands mid conversation', v['rd'] and 0.4 <= frac <= 0.6, round(frac, 2))
            # a reload comes back on the terminal (nothing was saved)
            page.evaluate(f"() => {CELL}.querySelector('.jump [data-j=\"bottom\"]').click()"); time.sleep(0.5)
            swipe(cdp, box['x'], box['y'], 200, 300, 12); time.sleep(0.8)
            check('scrolled up again before the reload', view(page)['rd'])
            page.reload(); page.wait_for_selector('.cell[data-session="bench"] .xterm', timeout=20000); time.sleep(3)
            check('after a reload the card is the terminal (the user\'s saved view)', not view(page)['rd'])
            # the switch: the More menu on a phone (the text popover is desktop only)
            page.evaluate("() => document.querySelector('#moreBtn').click()"); time.sleep(0.4)
            on = page.evaluate("() => { const b = document.querySelector('#smoothBtn'); const r = b.getBoundingClientRect(); return { on: b.classList.contains('on'), vis: r.width > 0 && r.height > 0 && r.bottom <= innerHeight, text: b.textContent.trim() }; }")
            check('the "Smooth scroll" switch is in the More menu, on by default', on['on'] and on['vis'] and on['text'] == 'Smooth scroll: on', on)
            shot(page, '5-setting.png')
            page.evaluate("() => document.querySelector('#smoothBtn').click()"); time.sleep(0.3)
            check('switching it off is saved', page.evaluate("localStorage.getItem('ghosty.smoothScroll')") == '0')
            swipe(cdp, box['x'], box['y'], 240, 400, 16); time.sleep(1.5)
            v = view(page)
            off = page.evaluate("window.__bench.ws.at(-1)?.[1]")
            check('setting off: the terminal stays and the app scrolls (wheel notches, as before)', not v['rd'] and v['reqs'] > 0 and off >= 15, {'reqs': v['reqs'], 'off': off})
            shot(page, '6-off-forwarded.png')
            # switching it on again while the app is scrolled up: the next scroll goes local and puts the app back at its live end
            page.evaluate("() => document.querySelector('#smoothToggle').click()"); time.sleep(0.3)   # the desktop switch drives the same setting
            swipe(cdp, box['x'], box['y'], 200, 300, 12); time.sleep(2.5)
            v = view(page); off = page.evaluate("window.__bench.ws.at(-1)?.[1]")
            check('on again with the app scrolled up: local, and the app is sent back to its live end', v['rd'] and off == 0, {'rd': v['rd'], 'off': off})
            ctx.close()
            browser.close()
    finally:
        rig.close()
    print(f"\n{'ALL PASS' if not fails else 'FAILED: ' + '; '.join(fails)}")
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--shots')
    main(ap.parse_args())
