#!/usr/bin/env node
// Phone-width overflow check over the page map (scripts/ui-pages.json): every deep-linked view at 390 px, headless.
// Fails a page when the document is wider than the viewport, or a visible element sticks out past the right edge and no
// ancestor clips or scrolls it (owner 2026-11-28 follow-up: two usage-page overflows were only found by hand).
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/ui-overflow-check.js [outDir]       (also a daily check: ui-overflow)
// Without a playwright-core it prints SKIPPED and exits 0 (daily-check shape below). It starts server.js as a child on a free
// port with a temp HOME and temp GHOSTY_STATE_DIR (seeded with a usage ledger so the Waste/Trending sections have rows), so it
// never touches the live socket, layout or sessions. Output: PASS/FAIL lines, then ONE JSON line { summary, report, findings }
// (the daily-checks.js result shape). Exit 1 when a page overflows.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const loadMap = () => JSON.parse(readFileSync(join(ROOT, 'scripts/ui-pages.json'), 'utf8'));

// Runs IN the page: -> { doc, vw, over: [{sel, right}] }. Exported so the unit test can pin its logic without a browser.
export const MEASURE = () => {
  const vw = document.documentElement.clientWidth;
  const clipped = (el) => { for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if ((o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') && p.getBoundingClientRect().width < vw - 2) return true; } return false; };   // a clipping ancestor as wide as the screen is the sheet itself scrolling sideways: that IS the bug; only a narrower local scroller (a table wrapper) is intended
  const over = [];
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= vw + 1 || clipped(el)) continue;
    over.push({ sel: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`, right: Math.round(r.right) });
  }
  return { doc: document.documentElement.scrollWidth, vw, over: over.slice(0, 5) };
};
export const verdict = (m) => (m.doc > m.vw + 1 ? `document ${m.doc}px > viewport ${m.vw}px` : m.over.length ? `${m.over[0].sel} reaches ${m.over[0].right}px of ${m.vw}px` : '');

// A synthetic usage-summary.json (what the ghosty-usage unit writes): the usage page needs it to render at all (/api/usage is 404 without).
export function syntheticSummary(now) {
  const day = (i) => new Date(now - i * 864e5).toISOString().slice(0, 10), z = { input: 1e5, output: 2e5, cache_read: 5e7, cache_creation: 1e6, total: 5.1e7, cost: 40, unpriced: 0, turns: 300 };
  const days = Array.from({ length: 14 }, (_, i) => day(13 - i)), models = ['claude-opus-5-5', 'claude-sonnet-5-5'];
  const agents = { claude: z, codex: z, minimax: { ...z, cost: null } };
  const kinds = ['high-avg-context', 'subagent-heavy', 'idle-polling', 'cache-churn'];
  return { generatedAt: new Date(now).toISOString(), windowDays: 14, total: z, perAgent: agents, perProject: { 'synthetic-project-with-a-rather-long-name-here': z }, perModel: { [models[0]]: z, [models[1]]: z },
    perDay: Object.fromEntries(days.map((d) => [d, { ...z, perAgent: agents }])), perDayModel: Object.fromEntries(days.map((d, i) => [d, Object.fromEntries(models.map((m, j) => [m, { ...z, total: 2.5e7 + i * 1e6 * (j + 1) }]))])),
    today: { day: day(0), total: z, perAgent: agents, perProject: {}, perModel: {} },
    perSession: [{ ...z, id: 'synthetic-id', name: 'synthetic-session-with-a-long-name', agent: 'claude', project: 'synthetic', model: models[0], lastTs: now }], outliers: [],
    waste: { windowH: 48, perAccount: {}, hourly: Array.from({ length: 24 }, (_, i) => ({ hour: now - i * 36e5, context: 1e8, account: 'team1' })), counts: { 'high-avg-context': 2 }, thresholds: { avgCtx: 3e5, hitBelow: 0.6, churnWrite: 5e6, subShare: 0.5, pollShare: 0.5 },
      findings: kinds.map((k, i) => ({ kind: k, id: `tr-${i}`, session: `synthetic-session-number-${i}-with-a-long-name`, agent: 'claude', value: 4e5, detail: 'avg context 420k per call over 40 calls, a long detail sentence to wrap on a phone screen', cost: 12 })) },
    perAccount: { team1: { share: 60, turns: 900, context: 1e9, cost: 120, subShare: 10 }, team2: { share: 40, turns: 600, context: 7e8, cost: 80, subShare: 5 } },
    burn: [{ account: 'team1', window: 'seven_day', usedPct: 80, resetsAt: now + 864e5, avgPctPerHour: 0.6, etaHours: 30, hoursToReset: 24, hitsBeforeReset: true, recentCostPerHour: 3 }],
    loops: [{ session: 'synthetic-session', kind: 'wait-loop', count: 80, sample: '~/synthetic/scripts/a-long-command-name-that-goes-on-and-on.sh --with --flags', label: 'synthetic' }],
    wasteLine: 'waste (48 h): 4 findings (synthetic)' };
}
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
function headlessShell(pwPath) {
  let want = null;
  try { want = JSON.parse(readFileSync(join(pwPath, 'browsers.json'), 'utf8')).browsers.find((b) => b.name === 'chromium-headless-shell')?.revision; } catch { /* any revision */ }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort() : [];
  const pick = dirs.find((d) => d.endsWith(`-${want}`)) || dirs.at(-1);
  if (!pick) throw new Error(`no chromium_headless_shell in ${base}`);
  return join(base, pick, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
}
const findPw = () => [process.env.PLAYWRIGHT_CORE, join(homedir(), 'virtualpytest/tests/e2e/playwright/node_modules/playwright-core')].find((p) => p && existsSync(join(p, 'index.mjs')));
const emit = (o) => console.log(JSON.stringify(o));

async function main() {
  const pwPath = findPw();
  if (!pwPath) { console.log('SKIPPED: set PLAYWRIGHT_CORE to a playwright-core directory to run the 390 px overflow check'); emit({ summary: 'skipped: no playwright-core on this host', report: '', findings: [] }); return 0; }
  const map = loadMap();
  const work = mkdtempSync(join(tmpdir(), 'ui-overflow-')), stateDir = join(work, 'state'), home = join(work, 'home');
  mkdirSync(stateDir, { recursive: true }); mkdirSync(home, { recursive: true });
  writeFileSync(join(stateDir, 'usage-summary.json'), JSON.stringify(syntheticSummary(Date.now())));
  // the Waste tab's advisory lines read the manager feed: a long session name on one kind, none on the others
  // the Cloud view (/?cloud=1): one row with a long label and task that must wrap, one with no hand-off
  writeFileSync(join(stateDir, 'cloud-sessions.jsonl'), [
    { at: new Date(Date.now() - 2 * 36e5).toISOString(), id: 'session_01Synthetic', url: 'https://claude.ai/code/session_01Synthetic', repo: 'synthetic-repo', base: 'feat/a-really-long-branch-name-that-must-wrap-20261128', label: 'cloud-check-with-a-really-long-label', by: 'synthetic-session', task: 'Run the setup script, the whole Python suite and the frontend typecheck, then push a report branch with the numbers and every failing test listed by name.' },
    { at: new Date(Date.now() - 9 * 6e4).toISOString(), id: 'session_02Synthetic', url: 'https://claude.ai/code/session_02Synthetic', repo: 'demo', base: 'main', label: 'fix-b', by: 'cli', task: 'Fix b' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  writeFileSync(join(stateDir, 'manager-events.jsonl'), `${JSON.stringify({ at: new Date(Date.now() - 5 * 36e5).toISOString(), key: 's:context-advisory', kind: 'context-advisory', session: 'synthetic-session-with-a-really-long-name-that-must-wrap', priority: 'low' })}\n`);
  const wrapper = join(work, 'tmux-wrapper.sh');   // a private tmux server: never the live one
  const realTmux = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux'].find(existsSync) || 'tmux';
  writeFileSync(wrapper, `#!/bin/sh\nexec ${realTmux} -L uiov-${process.pid} "$@"\n`); chmodSync(wrapper, 0o755);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: stateDir, TMUX_BIN: wrapper, TLS_KEY: join(work, 'none.pem'), TLS_CERT: join(work, 'none.pem') };
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  const fails = [], lines = [];
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/sessions`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); if (i === 149) throw new Error(`server did not start:\n${log.slice(-500)}`); }
    const pw = (await import(pathToFileURL(join(pwPath, 'index.mjs')))).default ?? (await import(pathToFileURL(join(pwPath, 'index.mjs'))));
    const browser = await pw.chromium.launch({ executablePath: headlessShell(pwPath), headless: true });
    try {
      const ctx = await browser.newContext({ viewport: map.viewport, serviceWorkers: 'block', isMobile: true, hasTouch: true });
      for (const pg of map.pages) {
        const page = await ctx.newPage(), errs = [];
        page.on('pageerror', (e) => errs.push(e.message));
        await page.goto(base + pg.url, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(pg.wait, { timeout: 8000 }).catch(() => errs.push(`never showed ${pg.wait}`));
        await page.waitForTimeout(700);
        const steps = [{ name: '' }];
        if (pg.id === 'usage') for (const t of map.usageTabs || []) steps.push({ name: t });
        for (const st of steps) {
          const label = st.name ? `${pg.id}/${st.name}` : pg.id;
          if (st.name) { const tab = page.locator(`.uv-navb:has-text("${st.name}")`).first(); if (await tab.count()) { await tab.click(); await page.waitForTimeout(500); } }
          const m = await page.evaluate(MEASURE);
          if (process.argv[2]) { mkdirSync(process.argv[2], { recursive: true }); await page.screenshot({ path: join(process.argv[2], `${label.replace(/\//g, '-')}.png`), fullPage: true }).catch(() => {}); }   // [outDir]: one frame per view
          let why = verdict(m) || (errs.length ? `page error: ${errs[0].slice(0, 120)}` : '');
          if (!why && st.name === 'Waste') { const t = await page.evaluate(() => document.body.innerText); if (!/advisories/i.test(t) || !/manager restart\s+never/i.test(t) || !/context\s+5 h ago/i.test(t)) why = 'the Advisories section (last fired per kind) is missing or wrong'; }
          lines.push(`${why ? 'FAIL' : 'PASS'}  ${label}  (doc ${m.doc}/${m.vw}${why ? `; ${why}` : ''})`);
          if (why) fails.push({ label, why });
        }
        await page.close();
      }
    } finally { await browser.close(); }
  } finally { server.kill('SIGTERM'); try { execTmuxKill(wrapper); } catch { /* none */ } }
  for (const l of lines) console.log(l);
  emit({ summary: fails.length ? `${fails.length} page(s) overflow at ${map.viewport.width}px: ${fails.map((f) => f.label).join(', ')}` : `${lines.length} views fit ${map.viewport.width}px`,
    report: lines.map((l) => `- ${l}`).join('\n'),
    findings: fails.map((f) => ({ key: `ui-overflow:${f.label}`, title: `${f.label} overflows a ${map.viewport.width}px phone`, body: `${f.why}. Page map: scripts/ui-pages.json; rerun: node scripts/ui-overflow-check.js`, priority: 'normal' })) });
  return fails.length ? 1 : 0;
}
function execTmuxKill(wrapper) { spawn(wrapper, ['kill-server'], { stdio: 'ignore' }); }

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().then((c) => process.exit(c), (e) => { console.error(e.message); emit({ summary: `ui-overflow check crashed: ${e.message.slice(0, 160)}`, report: '', findings: [] }); process.exit(2); });
