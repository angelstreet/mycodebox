#!/usr/bin/env node
// Dev-only real-browser check of clickable URLs in a card: a plain URL and a URL wrapped inside a table cell must open in a new tab on click.
// Not part of `npm test`; playwright-core is NOT a dependency (same recipe as v2-ui-check.js):
//   PLAYWRIGHT_CORE=/path/to/playwright-core [APP_ROOT=/checkout/to/test] node scripts/term-links-check.js [outDir] [label]
// Isolation: server.js child on a free loopback port, temp HOME and GHOSTY_STATE_DIR, private tmux socket. Never touches live state.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.APP_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const pwPath = process.env.PLAYWRIGHT_CORE;
if (!pwPath) { console.log('SKIPPED: set PLAYWRIGHT_CORE to a playwright-core directory'); process.exit(0); }
const out = process.argv[2] || mkdtempSync(join(tmpdir(), 'send-ui-shots-'));
const label = process.argv[3] || 'run';
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'send-ui-work-'));
const stateDir = join(work, 'state'), home = join(work, 'home');
mkdirSync(stateDir, { recursive: true }); mkdirSync(home, { recursive: true });
const sock = `sendui-${randomBytes(4).toString('hex')}`;
const realTmux = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux'].find(existsSync) || 'tmux';
const wrapper = join(work, 'tmux-wrapper.sh');
writeFileSync(wrapper, `#!/bin/sh\nexec ${realTmux} -L ${sock} "$@"\n`); chmodSync(wrapper, 0o755);
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
function headlessShell() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  const dirs = readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort();
  return join(base, dirs.at(-1), 'chrome-headless-shell-linux64', 'chrome-headless-shell');
}

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const port = await freePort();
const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: stateDir,
  TMUX_BIN: wrapper, TLS_KEY: join(work, 'none.pem'), TLS_CERT: join(work, 'none.pem') };
const URL1 = 'https://example.test/plain/page?x=1';
const URLW = 'https://example.test/script-reports/av_check_07d41d76/report.html?X-Amz-Signature=3ae3e9675be7449acdf1fa54a8445af2';
const cut = (u, n) => [u.slice(0, n), u.slice(n, 2 * n), u.slice(2 * n)];
const [w1, w2, w3] = cut(URLW, 36);
const pad = (t) => t.padEnd(40);
execFileSync(wrapper, ['new-session', '-d', '-s', 'link-demo', '-x', '100', '-y', '30',
  `printf '%s\\n' 'plain: ${URL1} and more text' '' '| mobile | (${w1} |' '|        | ${w2} |' '|        | ${w3}) - 07d41d76 |'; cat`]);
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
const base = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/sessions`)).ok) break; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 100)); if (i === 99) throw new Error(`server did not start: ${log.slice(-400)}`); }
  const pw = await import(pathToFileURL(join(pwPath, 'index.mjs')));
  const chromium = (pw.default ?? pw).chromium;
  const browser = await chromium.launch({ executablePath: headlessShell(), headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    const hits = [];
    await ctx.route('https://example.test/**', (r) => { hits.push(r.request().url()); r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }); });
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('.xterm-screen');
    await page.waitForTimeout(2500);
    const box = await page.locator('.xterm-screen').first().boundingBox();
    const rows = await page.locator('.xterm-rows > div').count();
    const rowH = box.height / rows;
    await page.screenshot({ path: join(out, `${label}-card.png`) });
    const text = await page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent));
    const findRow = (needle) => text.findIndex((t) => t.includes(needle));
    const pc = async (rowIdx, atText) => { const col = text[rowIdx].indexOf(atText) + 3; return { x: box.x + (col + 0.5) * (box.width / text[rowIdx].length), y: box.y + (rowIdx + 0.5) * rowH }; };
    for (const [name, needle, at] of [['plain URL', 'plain:', 'example.test'], ['wrapped URL, first row', 'mobile', 'example.test'], ['wrapped URL, second row', w2.slice(0, 12), w2.slice(2, 8)], ['wrapped URL, last row', w3.slice(0, 12), w3.slice(2, 6)]]) {
      const ri = findRow(needle);
      if (ri < 0) { check(`${name}: row found`, false, needle); continue; }
      const p = await pc(ri, at);
      await page.mouse.move(p.x, p.y); await page.waitForTimeout(250);
      const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 2500 }).catch(() => null), page.mouse.click(p.x, p.y)]);
      await page.waitForTimeout(400);
      const opened = hits.at(-1) ?? null; hits.length = 0;
      const want = name === 'plain URL' ? URL1 : URLW;
      check(`${name}: click opens the whole URL in a new tab`, opened === want, `opened=${opened}`);
      if (popup) await popup.close().catch(() => {});
    }
    console.log('done');
  } finally { await browser.close(); }
} finally { server.kill('SIGTERM'); try { execFileSync(wrapper, ['kill-server']); } catch { /* gone */ } }
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
