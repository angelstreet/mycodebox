#!/usr/bin/env python3
"""Scroll bench for the dashboard card (docs/SCROLL-DESIGN.md).

Measures, in headless Chromium at phone width, how the text of a FULLSCREEN (alternate-screen) session follows a finger:
  terminal  the wheel notches forwarded to the app (POST /api/scroll), the card redrawn from the pushed pane
  reader    the conversation as a local HTML document (read mode)
  local     the terminal with "Smooth scroll" on: scrolling up shows the conversation locally, the bottom returns to the live screen

Nothing live is touched: a TEST server.js on a free loopback port, a temp GHOSTY_STATE_DIR and HOME, a private tmux socket with one
throwaway session running test/fixtures/fake-fullscreen-tui.mjs (one line per notch, as Claude Code), and a TCP proxy that adds the
network delay (delay-proxy.mjs). The conversation is served to the page by a route override (the fake app has no session file).

  python3 scripts/scroll-bench/bench.py [--rtt 0,100,300] [--redraw 30] [--modes terminal,reader,local] [--json out.json] [--shots dir]
"""
import argparse, json, os, shutil, socket, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
LINES = 3000

INIT = r"""
(() => {
  const B = window.__bench = { ws: [], req: [], scroll: [], touch: [], frames: [], t0: performance.now() };
  for (const [k, v] of Object.entries(__LS__)) localStorage.setItem(k, v);
  const O = window.WebSocket;
  window.WebSocket = class extends O {
    constructor(...a) { super(...a); this.addEventListener('message', (ev) => {
      try { const m = JSON.parse(ev.data); if (m.type !== 'snapshot') return;
        const k = /off=(\d+)/.exec(m.pane.replace(/\x1b\[[0-9;]*m/g, '')); if (k) B.ws.push([performance.now(), Number(k[1])]); } catch {}
    }); }
  };
  const f = window.fetch;
  window.fetch = function (u, o) {
    if (typeof u === 'string' && u.startsWith('/api/scroll/')) {
      const r = { t: performance.now(), n: JSON.parse(o.body).n, dir: JSON.parse(o.body).dir }; B.req.push(r);
      return f.apply(this, arguments).then((x) => { r.end = performance.now(); return x; });
    }
    return f.apply(this, arguments);
  };
  document.addEventListener('touchstart', () => B.touch.push(['start', performance.now()]), { capture: true, passive: true });
  document.addEventListener('touchend', () => B.touch.push(['end', performance.now()]), { capture: true, passive: true });
  let last = null;
  const tick = () => {
    const el = document.querySelector('.cell.rd-on .reader');
    const v = el ? Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) : null;   // px above the bottom
    B.frames.push(performance.now());
    if (v !== last) { B.scroll.push([performance.now(), v]); last = v; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
"""


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def wait_http(url, tries=150):
    import urllib.request
    for _ in range(tries):
        try:
            urllib.request.urlopen(url, timeout=1).read(); return
        except Exception:
            time.sleep(0.1)
    raise SystemExit(f'not up: {url}')


class Rig:
    """The test server, its private tmux and one delay proxy per round trip."""

    def __init__(self, redraw_ms):
        self.tmp = tempfile.mkdtemp(prefix='scrollbench-')
        self.sock = f'scrollbench-{os.getpid()}'
        real = shutil.which('tmux')
        self.tmux = os.path.join(self.tmp, 'tmux-wrapper.sh')
        with open(self.tmux, 'w') as fh:
            fh.write(f'#!/bin/sh\nexec {real} -L {self.sock} "$@"\n')
        os.chmod(self.tmux, 0o755)
        self.real = real
        tui = os.path.join(ROOT, 'test', 'fixtures', 'fake-fullscreen-tui.mjs')
        node = shutil.which('node')
        subprocess.check_call([self.tmux, 'new-session', '-d', '-s', 'bench', '-x', '80', '-y', '30',
                               f'TUI_LINES={LINES} TUI_STEP=1 TUI_REDRAW_MS={redraw_ms} {node} {tui}'])
        self.port = free_port()
        state, home = os.path.join(self.tmp, 'state'), os.path.join(self.tmp, 'home')
        os.makedirs(state); os.makedirs(home)
        env = {'PATH': os.environ['PATH'], 'HOME': home, 'LANG': 'C.UTF-8', 'HOST': '127.0.0.1', 'PORT': str(self.port),
               'GHOSTY_STATE_DIR': state, 'TMUX_BIN': self.tmux, 'TLS_KEY': os.path.join(self.tmp, 'none.pem'), 'TLS_CERT': os.path.join(self.tmp, 'none.pem')}
        self.procs = [subprocess.Popen([node, 'server.js'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)]
        wait_http(f'http://127.0.0.1:{self.port}/api/sessions')
        self.proxies = {}

    def url(self, rtt):
        if rtt not in self.proxies:
            p = free_port()
            self.procs.append(subprocess.Popen([shutil.which('node'), os.path.join(os.path.dirname(__file__), 'delay-proxy.mjs'), str(p), str(self.port), str(rtt / 2)],
                                               stdout=subprocess.DEVNULL))
            wait_http(f'http://127.0.0.1:{p}/api/sessions')
            self.proxies[rtt] = p
        return f'http://127.0.0.1:{self.proxies[rtt]}'

    def bottom(self):
        subprocess.call([self.tmux, 'send-keys', '-t', '=bench:', 'C-End'])

    def close(self):
        for p in self.procs:
            p.kill()
        subprocess.call([self.real, '-L', self.sock, 'kill-server'], stderr=subprocess.DEVNULL)
        shutil.rmtree(self.tmp, ignore_errors=True)


def transcript():
    # the same lines the fake app shows, as one paragraph each: the reader's document is about as long as the app's transcript
    return '\n\n'.join(f'msg {i:03d} of the transcript' for i in range(LINES))


def swipe(cdp, x, y0, dy, ms, steps):
    """Finger down at y0, moved by dy px over ms, lifted. dy > 0 = finger down = older text."""
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y0}]})
    t0 = time.time()
    for i in range(1, steps + 1):
        due = t0 + ms / 1000 * i / steps
        d = due - time.time()
        if d > 0:
            time.sleep(d)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y0 + dy * i / steps}]})
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})


def stats(b, row_px, mode):
    """One gesture's numbers out of the page's log. Position unit: px of text above the live end (terminal: rows x row height)."""
    start = [t for k, t in b['touch'] if k == 'start'][-1]
    end = [t for k, t in b['touch'] if k == 'end'][-1]
    if mode == 'terminal':
        pts = [(t, off * row_px) for t, off in b['ws'] if t >= start]
        base = ([off * row_px for t, off in b['ws'] if t < start] or [0])[-1]
    else:   # reader, local: the document's own scroll position, sampled every animation frame
        pts = [(t, v) for t, v in b['scroll'] if t >= start and v is not None]
        base = 0
    moves, prev = [], base
    for t, v in pts:
        if abs(v - prev) > 1e-6:
            moves.append((t, v - prev)); prev = v
    if not moves:
        return {'updates': 0}
    gaps = [moves[i][0] - moves[i - 1][0] for i in range(1, len(moves))]
    during = [m for m in moves if m[0] <= end + 1]
    dur = max(1.0, end - start)
    reqs = [r for r in b['req'] if r['t'] >= start]
    out = {
        'gesture_ms': round(dur), 'frames_in_gesture': len([f for f in b['frames'] if start <= f <= end]),
        'first_move_ms': round(moves[0][0] - start),
        'updates': len(moves),
        'updates_in_gesture': len(during), 'updates_per_s_in_gesture': round(len(during) / dur * 1000, 1),
        'px_per_update_avg': round(sum(abs(d) for _, d in moves) / len(moves), 1),
        'px_per_update_max': round(max(abs(d) for _, d in moves), 1),
        'gap_ms_median': round(sorted(gaps)[len(gaps) // 2]) if gaps else None,
        'gap_ms_max': round(max(gaps)) if gaps else None,
        'px_total': round(prev - base),
        'px_after_lift': round(sum(d for t, d in moves if t > end + 1)),
        'settle_after_lift_ms': round(moves[-1][0] - end),
        'requests': len(reqs),
    }
    if reqs:
        done = [r for r in reqs if 'end' in r]
        out['request_ms_avg'] = round(sum(r['end'] - r['t'] for r in done) / max(1, len(done)))
        out['notches_per_request_max'] = max(r['n'] for r in reqs)
    return out


def run(args):
    rig = Rig(args.redraw)
    results = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            for rtt in args.rtt:
                for mode in args.modes:
                    ls = {'ghosty.reader': '1' if mode == 'reader' else '0', 'ghosty.smoothScroll': '1' if mode == 'local' else '0'}
                    ctx = browser.new_context(viewport={'width': 360, 'height': 780}, device_scale_factor=args.dsf, is_mobile=True, has_touch=True)
                    ctx.add_init_script(INIT.replace('__LS__', json.dumps(ls)))
                    page = ctx.new_page()
                    body = json.dumps({'session': 'bench', 'text': transcript(), 'hash': 'bench', 'source': 'session-file'})
                    page.route('**/api/transcript/*', lambda route, request: route.fulfill(status=200, content_type='application/json', body=body))
                    page.goto(f'{rig.url(rtt)}/?s=bench')
                    page.wait_for_selector('.cell[data-session="bench"] .xterm, .cell[data-session="bench"].rd-on .reader p', timeout=20000)
                    time.sleep(3.5)   # the card claims its size, the pane redraws, the conversation loads
                    cdp = ctx.new_cdp_session(page)
                    box = page.evaluate("""() => { const c = document.querySelector('.cell[data-session="bench"]'); const el = c.classList.contains('rd-on') ? c.querySelector('.reader') : c.querySelector('.b');
                        const r = el.getBoundingClientRect(); const x = c.querySelector('.xterm-rows > div, .xterm-screen'); const rows = c.querySelectorAll('.xterm-rows > div').length;
                        const p = c.querySelector('.reader p'); return { x: r.left + r.width / 2, y: r.top + 60, h: r.height, rd: c.classList.contains('rd-on') }; }""")
                    row_px = page.evaluate("""() => { const c = document.querySelector('.cell[data-session="bench"]'); const n = c.querySelectorAll('.xterm-rows > div').length;
                        const sc = c.querySelector('.xterm-screen'); return n && sc ? sc.clientHeight / n : 12; }""")   # the terminal's row height
                    for name, dy, ms, steps in (('drag 300 px in 600 ms', 300, 600, 36), ('flick 300 px in 120 ms', 300, 120, 8)):
                        rig.bottom(); time.sleep(1.6)
                        page.evaluate("""() => { const r = document.querySelector('.cell.rd-on .reader'); if (r) r.scrollTop = r.scrollHeight; }""")
                        time.sleep(0.6)
                        swipe(cdp, box['x'], box['y'], dy, ms, steps)
                        time.sleep(2.5 + rtt / 100)
                        b = page.evaluate('window.__bench')
                        r = {'rtt_ms': rtt, 'mode': mode, 'gesture': name, 'term_row_px': round(row_px, 1), **stats(b, row_px, mode)}
                        results.append(r); print(json.dumps(r), flush=True)
                        if args.shots:
                            os.makedirs(args.shots, exist_ok=True)
                            page.screenshot(path=os.path.join(args.shots, f'{mode}-rtt{rtt}-{name.split()[0]}.png'))
                        if mode == 'local':   # back to the live screen: finger up until the bottom
                            swipe(cdp, box['x'], box['y'] + 400, -400, 150, 8); time.sleep(2.5)
                            r2 = page.evaluate("""() => ({ rd: document.querySelector('.cell[data-session="bench"]').classList.contains('rd-on') })""")
                            print(json.dumps({'mode': 'local', 'rtt_ms': rtt, 'after_swipe_back': 'reader' if r2['rd'] else 'terminal'}), flush=True)
                            results.append({'mode': 'local', 'rtt_ms': rtt, 'gesture': name, 'after_swipe_back': 'reader' if r2['rd'] else 'terminal'})
                    ctx.close()
            browser.close()
    finally:
        rig.close()
    if args.json:
        with open(args.json, 'w') as fh:
            json.dump(results, fh, indent=1)
    return results


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--rtt', default='0,100,300', type=lambda s: [int(x) for x in s.split(',')])
    ap.add_argument('--redraw', default=30, type=int, help="the fake app's redraw time per input, ms")
    ap.add_argument('--modes', default='terminal,reader', type=lambda s: s.split(','))
    ap.add_argument('--dsf', default=1, type=int, help='device scale factor (3 = the phone; 1 keeps the software renderer near 60 frames/s)')
    ap.add_argument('--json'); ap.add_argument('--shots')
    run(ap.parse_args())
