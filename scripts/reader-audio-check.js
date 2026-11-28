#!/usr/bin/env node
// Dev-only real-browser check of the reader's play button on a running dashboard (the deployed one after a deploy, or a worktree server):
// the chip reads the session's `Summary:` lines only (owner 2026-11-28), or shows the "no summary yet" hint when the reply has none.
// Not part of `npm test`; playwright-core is NOT a dependency (same recipe as reader-width-check.js):
//   PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/reader-audio-check.js <baseUrl> <session> [outDir]
// Read-only on the dashboard: /api/tts (captured, never synthesised), /api/resize and every non-GET /api/layout are answered in the
// browser, so the check never resizes a live pane, never writes layout.json and never spends a TTS call. Desktop width only (a phone-width
// card resizes the real tmux pane). Exit 0 = PASS, 1 = FAIL.
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const [base, session, outArg] = process.argv.slice(2);
if (!base || !session) { console.error('usage: node scripts/reader-audio-check.js <baseUrl> <session> [outDir]'); process.exit(2); }
const pwPath = process.env.PLAYWRIGHT_CORE;
if (!pwPath) { console.log('SKIPPED: set PLAYWRIGHT_CORE to a playwright-core directory'); process.exit(0); }
const out = outArg || mkdtempSync(join(tmpdir(), 'reader-audio-'));
mkdirSync(out, { recursive: true });
const { spokenSummaryOf } = await import(pathToFileURL(join(fileURLToPath(new URL('..', import.meta.url)), 'public', 'reader-summary.js')));

function headlessShell() {
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  const dirs = readdirSync(dir).filter((d) => d.startsWith('chromium_headless_shell-')).sort();
  return join(dir, dirs.at(-1), 'chrome-headless-shell-linux64', 'chrome-headless-shell');
}
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const root = base.replace(/\/+$/, '');
const reply = await (await fetch(`${root}/api/reply/${encodeURIComponent(session)}`)).json();
const expected = spokenSummaryOf(reply.summary);
console.log(`session ${session}: summary ${reply.summary ? reply.summary.length + ' lines' : 'none'}, status ${reply.status?.kind || 'none'}`);

const pw = await import(pathToFileURL(join(pwPath, 'index.mjs')));
const browser = await (pw.default ?? pw).chromium.launch({ executablePath: headlessShell(), headless: true });
const posts = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('ghosty.reader', '1'); } catch { /* private mode */ } });
  await ctx.route('**/api/tts/**', (route, req) => {
    if (req.method() === 'POST') { try { posts.push(JSON.parse(req.postData() || '{}').text || ''); } catch { posts.push(''); } }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"state":"pending"}' });
  });
  await ctx.route('**/api/resize/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx.route('**/api/layout', (route, req) => req.method() === 'GET' ? route.continue() : route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const page = await ctx.newPage();
  const url = `${root}/?s=${encodeURIComponent(session)}`;
  await page.goto(url, { waitUntil: 'load' });
  const card = page.locator(`[data-session="${session}"] .reader .rd-actions`).first();
  await card.waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const chip = card.locator('.audio-chip');
  if (expected) {
    check('the play chip is shown', await chip.count() === 1);
    check('its label is "Read summary aloud"', await chip.getAttribute('aria-label') === 'Read summary aloud');
    await chip.locator('.ac-play').click();
    for (let i = 0; i < 50 && !posts.length; i++) await page.waitForTimeout(100);
    check('play sends one TTS request', posts.length === 1, `${posts.length}`);
    check('the spoken text is the summary only', posts[0] === expected, `${(posts[0] || '').length} chars`);
  } else {
    check('no play chip without a summary', await chip.count() === 0);
    check('the "no summary yet" hint is shown', await card.locator('.rd-nosum').count() === 1);
  }
  const shot = join(out, `reader-audio-${session}.png`);
  await page.screenshot({ path: shot });
  console.log(`url ${url}\nscreenshot ${shot}`);
} finally {
  await browser.close();
}
console.log(failed ? `FAIL: ${failed} check(s)` : 'PASS');
process.exit(failed ? 1 : 0);
