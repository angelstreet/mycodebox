#!/usr/bin/env node
// Headless browser proof on a worktree server or the deployed URL. Only production assets are read: all API calls
// and ALL WebSockets are fulfilled with synthetic zz- fixtures, and no layout, resize, send or TTS write reaches the server.
// PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/reader-copy-check.js <baseUrl> [outDir]
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
const [base, output = '/tmp/reader-copy-check'] = process.argv.slice(2);
if (!base || !process.env.PLAYWRIGHT_CORE) { console.error('Set PLAYWRIGHT_CORE, then: node scripts/reader-copy-check.js <baseUrl> [outDir]'); process.exit(2); }
mkdirSync(output, { recursive: true });
const pw = await import(pathToFileURL(join(process.env.PLAYWRIGHT_CORE, 'index.mjs')));
const bins = join(homedir(), '.cache/ms-playwright');
const bin = join(bins, readdirSync(bins).filter((d) => d.startsWith('chromium_headless_shell-')).sort().at(-1), 'chrome-headless-shell-linux64/chrome-headless-shell');
const browser = await pw.chromium.launch({ executablePath: bin, headless: true });
const session = 'zz-reader-copy', summary = ['The change is ready.', 'No action is needed.'];
const reply = 'Latest reply only.\n\nSummary:\n' + summary.join('\n') + '\n\nVerification:\n1. pass — synthetic check\nSTATUS: done';
const full = 'START OF FULL SESSION\nOwner: Earlier request.\nAgent: Earlier reply.\n' + 'Earlier conversation text. '.repeat(2400) + '\nOwner: Latest request.\nAgent: ' + reply;
const results = [];
try {
  for (const width of [1280, 375]) {
    let hasSummary = true, fullFails = false;
    const errors = [], writes = [], transcriptRequests = [];
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => { localStorage.setItem('ghosty.reader', '1'); localStorage.setItem('ghosty.mode', 'card'); });
    const row = { agent: 'claude', cmd: 'claude', state: 'done', priority: 'P1', replyHash: 'fixture', name: session };
    await ctx.routeWebSocket('**/ws/**', (ws) => {
      if (ws.url().endsWith('/ws/status')) ws.send(JSON.stringify({ type: 'status', status: { [session]: row } }));
      else ws.send(JSON.stringify({ type: 'snapshot', session, pane: reply, cols: 100, rows: 30, alt: false }));
    });
    await ctx.route('**/api/**', async (route, request) => {
      const url = new URL(request.url());
      let data = { ok: true, items: [], accounts: [], plans: [], asks: [], events: [] };
      if (request.method() !== 'GET') { writes.push(url.pathname); data = { ok: true }; }
      else if (url.pathname === '/api/sessions') data = { sessions: [{ name: session, cmd: 'claude' }], status: { [session]: row } };
      else if (url.pathname === '/api/layout') data = { order: [session], hidden: [], pins: [] };
      else if (url.pathname.startsWith('/api/reply/')) data = { reply, summary: hasSummary ? summary : null };
      else if (url.pathname.startsWith('/api/transcript/')) {
        transcriptRequests.push(url.search);
        if (fullFails) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        await new Promise((r) => setTimeout(r, 250));
        data = url.searchParams.has('max') ? { text: full.slice(-40000), partial: true } : { text: full, source: 'session-file' };
      } else if (url.pathname.startsWith('/api/senders/')) data = { ai: [] };
      else if (url.pathname === '/api/leases') data = { leases: [], envs: [], tickets: [] };
      else if (url.pathname === '/api/deploys') data = { deploys: [], running: {}, enabled: false };
      else if (url.pathname === '/api/disk') data = { level: 'ok', volumes: [] };
      else if (url.pathname === '/api/parking') data = { parked: [], sessions: [], cap: 99 };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    // Observe the real fallback copy operation even on an HTTP origin where clipboard.readText is unavailable.
    await page.addInitScript(() => {
      window.copyWrites = [];
      const original = document.execCommand.bind(document);
      document.execCommand = (cmd, ...args) => {
        if (cmd === 'copy') {
          if (window.denyCopy) return false;
          const field = document.activeElement;
          const ok = original(cmd, ...args);
          if (ok) window.copyWrites.push(field.value);
          return ok;
        }
        return original(cmd, ...args);
      };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => {
        if (window.denyCopy) throw new Error('Synthetic denial');
        window.copyWrites.push(text);
      } } });
    });
    const url = `${base.replace(/\/$/, '')}/?s=${session}`;
    await page.goto(url, { waitUntil: 'load' });
    const trigger = page.locator('.reader .rd-copy-trigger').first();
    await trigger.waitFor({ timeout: 20000 });
    const menu = page.locator('.reader .rd-copy-pop').first();
    // The reader's repaint guard needs the open state before the queued toggle event runs.
    assert.equal(await trigger.evaluate((b) => { b.click(); return b.getAttribute('aria-expanded'); }), 'true', 'opening synchronously protects the menu from transcript repaints');
    await menu.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    const open = async () => { await trigger.click(); await menu.waitFor({ state: 'visible' }); };
    const waitFull = () => page.waitForFunction(() => !document.querySelector('.rd-copy-pop [data-copy-kind="full"]').disabled);
    const copy = async (kind, text) => {
      await open(); if (kind === 'full') await waitFull();
      const before = await page.evaluate(() => copyWrites.length);
      await menu.locator(`[data-copy-kind="${kind}"]`).click();
      await menu.waitFor({ state: 'hidden' });
      assert.deepEqual(await page.evaluate((n) => copyWrites.slice(n), before), [text], `${width}: copy ${kind} exactly once`);
      assert.equal(await trigger.evaluate((b) => document.activeElement === b), true, 'focus returns to clipboard');
      console.log(`PASS ${width}px copy ${kind}`);
    };
    await copy('reply', reply);
    await copy('summary', summary.join('\n'));
    // Switch atomically: the automatic conversation load can replace this toggle while a test is reading it.
    await page.locator('.reader .rd-more').first().evaluate((b) => { if (b.dataset.act === 'more') b.click(); });
    await page.waitForFunction(() => document.querySelector('.reader .rd-more[data-act="less"]'));
    await copy('reply', reply);
    await copy('full', full);
    assert.ok(transcriptRequests.some((q) => q === ''), 'full copy requested unbounded text');
    await page.locator('.reader .rd-more[data-act="less"]').first().click();
    await trigger.focus(); await page.keyboard.press('ArrowDown');
    await menu.waitFor({ state: 'visible' }); await waitFull();
    await page.waitForFunction(() => document.activeElement?.dataset.copyKind === 'reply');
    await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement.dataset.copyKind), 'summary');
    await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => document.activeElement.dataset.copyKind), 'reply');
    await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.dataset.copyKind), 'full');
    const keyCopyAt = await page.evaluate(() => copyWrites.length);
    await page.keyboard.press('Enter'); await menu.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate((n) => copyWrites.slice(n), keyCopyAt), [full], 'Enter activates the focused copy action');
    await trigger.focus(); await page.keyboard.press('ArrowDown'); await menu.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    assert.equal(await trigger.evaluate((b) => document.activeElement === b), true);
    await open(); await waitFull();
    const rect = await menu.boundingBox();
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width + 1 && rect.y + rect.height <= 901, `${width}: popup stays in viewport`);
    await page.screenshot({ path: join(output, `reader-copy-${width}.png`) });
    await page.keyboard.press('Tab'); await menu.waitFor({ state: 'hidden' });
    // Test failure + retry through the real insecure-context fallback, with cleanup/focus assertions.
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); window.denyCopy = true; });
    await open(); await menu.locator('[data-copy-kind="reply"]').click();
    await page.waitForFunction(() => document.querySelector('.rd-copy-status')?.textContent.includes('Copy failed'));
    assert.equal(await menu.locator('[data-copy-kind="reply"]').isEnabled(), true);
    await page.evaluate(() => { window.denyCopy = false; });
    const before = await page.evaluate(() => copyWrites.length);
    await menu.locator('[data-copy-kind="reply"]').click(); await menu.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate((n) => copyWrites.slice(n), before), [reply]);
    assert.equal(await page.locator('textarea[readonly]').count(), 0, 'fallback cleans up its textarea');
    assert.equal(await trigger.evaluate((b) => document.activeElement === b), true);
    // An absent summary or failed full fetch is explicit; neither silently copies the reply instead.
    hasSummary = false; fullFails = true;
    await page.reload({ waitUntil: 'load' }); await trigger.waitFor(); await open();
    assert.equal(await menu.locator('[data-copy-kind="summary"]').isDisabled(), true);
    await page.waitForFunction(() => document.querySelector('.rd-copy-note')?.textContent.includes('Could not load'));
    assert.equal(await menu.locator('[data-copy-kind="full"]').isDisabled(), true);
    assert.equal(await menu.locator('[data-copy-kind="reply"]').isEnabled(), true);
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, [], 'no uncaught page errors');
    assert.deepEqual(writes.filter((p) => /\/api\/(?:send|key)\//.test(p)), [], 'menu keys never reach the terminal');
    results.push({ width, pass: true, url, writesIntercepted: writes.length, fullChars: full.length });
    await ctx.close();
    console.log(`PASS ${width}px: three exact sources, complete transcript, keyboard, viewport, copy fallback and failures`);
  }
} catch (error) {
  for (const ctx of browser.contexts()) for (const page of ctx.pages()) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(`PASS screenshots: ${output}`);
