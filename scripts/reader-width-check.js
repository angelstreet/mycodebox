#!/usr/bin/env node
// Dev-only real-browser check of the reader view: on a wide card the reply text column is at most 820px wide and centred; on a phone it keeps the full width.
// Not part of `npm test`; playwright-core is NOT a dependency (same recipe as v2-ui-check.js):
//   PLAYWRIGHT_CORE=/path/to/playwright-core [APP_ROOT=/checkout/to/test] node scripts/reader-width-check.js [outDir] [label]
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
execFileSync(wrapper, ['new-session', '-d', '-s', 'rd-demo', '-x', '100', '-y', '30', 'cat']);
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
    const ctx = await browser.newContext({ viewport: { width: Number(process.env.VW || 1280), height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('.xterm-screen');
    if (process.env.ONE_UP) await page.locator('#gridSizes button').first().click().catch(() => {});
    await page.waitForTimeout(2000);
    // CSS-only change: put the cell in reader mode and fill it with one long paragraph
    const m = await page.evaluate(() => {
      const cell = document.querySelector('.cell'); const rd = cell.querySelector('.reader');
      cell.classList.add('rd-on');
      rd.innerHTML = '<p>' + 'The quick brown fox jumps over the lazy dog and keeps running across the whole wide screen. '.repeat(40) + '</p>';
      const p = rd.querySelector('p').getBoundingClientRect(), r = rd.getBoundingClientRect();
      return { readerW: Math.round(r.width), textW: Math.round(p.width), left: Math.round(p.left - r.left), right: Math.round(r.right - p.right) };
    });
    console.log(JSON.stringify(m));
    await page.screenshot({ path: join(out, `${label}-reader.png`) });
    const wide = m.readerW > 900;
    if (wide) { check('wide card: text column is at most 820px', m.textW <= 820, `textW=${m.textW}`); check('wide card: column is centred', Math.abs(m.left - m.right) <= 20, `left=${m.left} right=${m.right}`); }
    else { check('narrow card: text keeps the full width (minus 14px padding)', m.textW >= m.readerW - 40, `textW=${m.textW} readerW=${m.readerW}`); }
  } finally { await browser.close(); }
} finally { server.kill('SIGTERM'); try { execFileSync(wrapper, ['kill-server']); } catch { /* gone */ } }
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
