#!/usr/bin/env node
// Dev-only real-browser check of the message dock: type, send three times, the box must empty and no "failed · retry" may show.
// Not part of `npm test`; playwright-core is NOT a dependency (same recipe as v2-ui-check.js):
//   PLAYWRIGHT_CORE=/path/to/playwright-core [APP_ROOT=/checkout/to/test] node scripts/send-ui-check.js [outDir] [label]
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
execFileSync(wrapper, ['new-session', '-d', '-s', 'send-demo', '-x', '100', '-y', '30', 'cat']);
// a second session stuck on a permission question: the "need you" popup gets an item for it, like on the live dashboard
const ASK = process.env.WITH_ASK === '1';
for (const nm of ASK ? ['send-ask', 'send-ask2'] : []) execFileSync(wrapper, ['new-session', '-d', '-s', nm, '-x', '100', '-y', '30',
  "printf 'Edit file src/app.js\\n\\n Do you want to make this edit?\\n  1. Yes\\n  2. Yes, allow all edits\\n  3. No, and tell Claude what to do differently (esc)\\n'; cat"]);
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
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const consoleLines = [], pageErrors = [];
    page.on('console', (m) => { if (/\[send\]|error/i.test(m.text())) consoleLines.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('#sendInput');
    await page.waitForTimeout(1500);
    if (ASK) { await page.waitForTimeout(6000); await page.screenshot({ path: join(out, `${label}-ask-state.png`) }); }
    const tgt = ASK ? 'send-ask' : 'send-demo';
    await page.locator(`[data-session="${tgt}"]`).first().tap().catch(() => {});
    await page.waitForTimeout(500);
    for (let i = 1; i <= 3; i++) {
      const text = `message number ${i}`;
      await page.locator('#sendInput').fill(text);
      await page.locator('#sendBtn').click();
      await page.waitForTimeout(700);
      const v = await page.locator('#sendInput').inputValue();
      const pill = (await page.locator('#dstat').textContent()).trim();
      await page.screenshot({ path: join(out, `${label}-send${i}.png`) });
      check(`send ${i}: box is empty after sending`, v === '', `value=${JSON.stringify(v)}`);
      check(`send ${i}: pill does not say failed`, !/failed/.test(pill), `pill=${JSON.stringify(pill)} title=${JSON.stringify(await page.locator('#dstat').getAttribute('title'))}`);
    }
    const pane = execFileSync(wrapper, ['capture-pane', '-p', '-t', `=${tgt}:`]).toString();
    check('the session received all three messages', [1, 2, 3].every((i) => pane.includes(`message number ${i}`)));
    check('no uncaught page errors', pageErrors.length === 0, pageErrors[0] || '');
    console.log('console:', JSON.stringify(consoleLines), 'pageerrors:', JSON.stringify(pageErrors));
  } finally { await browser.close(); }
} finally { server.kill('SIGTERM'); try { execFileSync(wrapper, ['kill-server']); } catch { /* gone */ } }
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
