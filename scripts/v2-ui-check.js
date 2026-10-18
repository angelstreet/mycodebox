#!/usr/bin/env node
// Dev-only browser check for the V2 Tasks view (T20). Not part of `npm test`; playwright-core is NOT a dependency:
// point PLAYWRIGHT_CORE at an installed copy. Without it this prints SKIPPED and exits 0.
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/v2-ui-check.js [outDir]
//
// Isolation: starts server.js as a child with GHOSTY_V2=1, HOST=127.0.0.1, a free port, a temp HOME and temp
// GHOSTY_STATE_DIR seeded with synthetic V2 tasks, and TMUX_BIN pointing at a wrapper for a private tmux server
// (`tmux -L v2ui-<random>`). Both are stopped at the end. It never touches the live socket or live state.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pwPath = process.env.PLAYWRIGHT_CORE;
if (!pwPath) { console.log('SKIPPED: set PLAYWRIGHT_CORE to a playwright-core directory to run the browser check'); process.exit(0); }

const out = process.argv[2] || mkdtempSync(join(tmpdir(), 'v2-ui-shots-'));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'v2-ui-work-'));
const stateDir = join(work, 'state'), home = join(work, 'home');
mkdirSync(stateDir, { recursive: true }); mkdirSync(home, { recursive: true });
const sock = `v2ui-${randomBytes(4).toString('hex')}`;
const realTmux = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux'].find(existsSync) || 'tmux';
const wrapper = join(work, 'tmux-wrapper.sh');
writeFileSync(wrapper, `#!/bin/sh\nexec ${realTmux} -L ${sock} "$@"\n`); chmodSync(wrapper, 0o755);

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

// ---- seed: one synthetic task per outcome -------------------------------------------------------------------
async function seed() {
  const { createTaskStore } = await import(pathToFileURL(join(ROOT, 'orchestration/store.js')));
  const store = createTaskStore({ dir: join(stateDir, 'v2') });
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', HEAD = 'b2c3d4e5f60718293a4b5c6d7e8f9012345678a1';
  const spec = (id, goal) => ({ task_id: id, project_id: 'synthetic', goal, scope: 'synthetic repo', prohibited_actions: [],
    definition_of_done: ['unit passes on the candidate SHA', 'an independent reviewer approves'],
    acceptance_checks: [{ id: 'unit', command: ['npm', 'test'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }],
    risk_class: 'low', runtime_capabilities: ['code'], privacy_policy: 'synthetic', resources: [], dependencies: [], base_sha: SHA,
    created_by: { kind: 'api', id: 'ui-check' } });
  const path = async (id, states) => { for (const s of states) await store.transition(id, s, { reason: 'synthetic', actor: 'ui-check' }); };
  const dec = (id, k, patch) => ({ decision_id: `d-${id}-${k}`, kind: 'policy_gate', question: 'Can the task proceed without the owner?',
    alternatives: [{ option: 'ask the owner and wait', pros: ['safe'], cons: ['slow'] }], chosen: 'ask the owner and wait', evidence: ['policy blocks deploy'],
    expected_effect: 'awaiting_approval', rationale: 'Mandatory owner decision: deploy is an approval class.', actor: { role: 'manager', runtime: null, model: null },
    reversible: true, rollback: 'cancel the task', loop: { k, patch } });

  await store.createTask(spec('t-done', 'Synthetic: accepted task with evidence and an independent verdict'));
  await path('t-done', ['clarified', 'planned', 'ready', 'executing', 'evaluating']);
  await store.setHead('t-done', HEAD, { actor: { role: 'developer', id: 'dev-1' } });
  await store.recordEvidence('t-done', { check_id: 'unit', sha: HEAD, command: ['npm', 'test'], exit: 0, duration_ms: 1500, actor: { role: 'tester', id: 'tester-1' } });
  await store.recordVerdict('t-done', { sha: HEAD, actor: { role: 'verifier', id: 'rev-1' }, verdict: 'approve', findings: [] });
  await store.recordUsage('t-done', { runtime: 'claude', model: 'synthetic-model', input_tokens: 1200, output_tokens: 300, usd: null, run_id: 'r1' });
  await store.transition('t-done', 'accepted', { reason: 'verified', actor: 'goal-loop' });

  await store.createTask(spec('t-open', 'Synthetic: developer run in progress (not yet done)'));
  await path('t-open', ['clarified', 'planned', 'ready', 'executing']);

  await store.createTask(spec('t-waiting', 'Synthetic: waiting for the provider quota to reset'));
  await path('t-waiting', ['waiting']);

  await store.createTask(spec('t-owner', 'Synthetic: needs an owner decision before deploying'));
  await store.setHead('t-owner', HEAD, { actor: { role: 'developer', id: 'dev-1' } });
  await store.recordDecision('t-owner', dec('t-owner', 0, { approval: { k: 0, kind: 'policy_gate', question: 'Policy blocks deploy: owner approval required.', classes: ['deploy'], resume_to: 'ready' } }));
  await path('t-owner', ['awaiting_approval']);

  await store.createTask(spec('t-failed', 'Synthetic: unrecoverable failure'));
  await path('t-failed', ['waiting', 'failed_unrecoverable']);

  await store.createTask(spec('t-cancelled', 'Synthetic: cancelled by the owner'));
  await path('t-cancelled', ['cancelled']);

  await store.createTask(spec('t-unknown', 'Synthetic: restart before an external effect was confirmed'));
  await path('t-unknown', ['clarified', 'planned', 'ready', 'executing']);
  await store.recordEffect('t-unknown', { effect_id: 'e1', idempotency_key: 'k1', kind: 'push', phase: 'attempted' });
  await store.recover();   // an unconfirmed effect moves the task to unknown_external_effect
  return store;
}


// ---- seed: synthetic session history + usage ledger for the History view --------------------------------------
function seedHistory() {
  const NOW = Date.now(), H = 3600000;
  const hist = [], led = [];
  const start = (name, ts, o = {}) => hist.push({ schema_version: 1, kind: 'session.started', name, provider: 'claude', model: 'synthetic-model', cwd: '/synthetic/work', started_by: 'dashboard', prompt_ref: null, handover_ref: null, ts, ...o });
  const end = (name, ts) => hist.push({ schema_version: 1, kind: 'session.ended', name, ts, reason: 'killed' });
  const turns = (label, t0, n, o = {}) => { for (let i = 0; i < n; i++) led.push({ ts: t0 + (i + 1) * 120000, label, agent: o.agent || 'claude', model: o.model || 'synthetic-model', usage: { input: 1200, output: 300, cache_read: 4000, cache_write_5m: 500, cache_write_1h: 0 }, cost: o.cost === null ? null : { total: 0.05 } }); };
  for (let i = 0; i < 55; i++) {   // 55 ended runs: more than one page
    const t0 = NOW - (60 + i * 5) * H, name = `synthetic-run-${String(i).padStart(2, '0')}`;
    start(name, t0, { started_by: i % 5 === 0 ? 'v2' : i % 3 === 0 ? 'cbsession' : 'dashboard', prompt_ref: i % 2 ? '/synthetic/prompts/task.md' : 'Synthetic: summarise the synthetic repo', handover_ref: i % 7 === 0 ? '/synthetic/handover.md' : null });
    turns(name, t0, 1 + (i % 4)); end(name, t0 + 2 * H);
  }
  start('synthetic-minimax', NOW - 30 * H, { provider: 'minimax', model: 'synthetic-mm' }); turns('synthetic-minimax', NOW - 30 * H, 3, { agent: 'minimax', model: 'synthetic-mm', cost: null }); end('synthetic-minimax', NOW - 28 * H);
  start('synthetic-unpriced', NOW - 20 * H, { provider: 'codex', model: 'synthetic-cx' }); turns('synthetic-unpriced', NOW - 20 * H, 2, { agent: 'codex', model: 'synthetic-cx', cost: null }); end('synthetic-unpriced', NOW - 19 * H);
  start('synthetic-demo', NOW - 5 * H, { prompt_ref: '/synthetic/prompts/demo.md' }); turns('synthetic-demo', NOW - 5 * H, 4);   // running: has a card
  start('synthetic-running-nocard', NOW - 2 * H, { started_by: 'cbsession' });   // running in the log, no tmux session: detail sheet
  writeFileSync(join(stateDir, 'session-history.jsonl'), hist.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(stateDir, 'usage-ledger.jsonl'), led.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// ---- helpers ------------------------------------------------------------------------------------------------
function headlessShell(pw) {
  let want = null;
  try { want = JSON.parse(readFileSync(join(pwPath, 'browsers.json'), 'utf8')).browsers.find((b) => b.name === 'chromium-headless-shell')?.revision; } catch { /* any revision */ }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort() : [];
  const pick = dirs.find((d) => d.endsWith(`-${want}`)) || dirs.at(-1);
  if (!pick) throw new Error(`no chromium_headless_shell in ${base}`);
  return join(base, pick, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
}

const CONTRAST = () => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 0]; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] === 1) break; }
    let base = [13, 14, 18];   // page background fallback
    for (const l of layers.reverse()) base = base.map((v, i) => (i < 3 ? l[i] * l[3] + v * (1 - l[3]) : 1));
    return base;
  };
  const out = [];
  for (const el of document.querySelectorAll('.sheet.tasks .tk-badge, .sheet.tasks .tk-next, .sheet.tasks .tk-when, .sheet.tasks .tk-dim, .sheet.tasks .tk-goal, .sheet.tasks .sbtn')) {
    if (!el.offsetParent || !el.textContent.trim()) continue;
    const fg = parse(getComputedStyle(el).color), bg = bgOf(el);
    const a = lum(fg), b = lum(bg);
    out.push({ text: el.textContent.trim().slice(0, 40), cls: el.className, ratio: +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2) });
  }
  return out;
};

// V2 off (the default): the routes answer 404 and nothing is created on disk.
async function offCheck() {
  const port = await freePort();
  const off = join(work, 'state-off');
  mkdirSync(off, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: off,
    TMUX_BIN: wrapper, TLS_KEY: join(work, 'none.pem'), TLS_CERT: join(work, 'none.pem') };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/sessions`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
    const g = await fetch(`${base}/api/v2/tasks`);
    const p = await fetch(`${base}/api/v2/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"goal":"x","repository":"/x"}' });
    check('V2 off by default: GET and POST /api/v2/tasks answer 404', g.status === 404 && p.status === 404, `${g.status}/${p.status}`);
    check('V2 off: no v2 directory is created', !existsSync(join(off, 'v2')));
  } finally { child.kill('SIGTERM'); }
}

// Positive control for the origin guard: since round 3 a create needs the running goal loop, so this uses a second server
// with the engine configured (temp work root, one fixture repo, the test-only fake adapter: no real runtime can run) and
// fresh state, keeping the seeded tasks above away from any loop. A broken route would fail here instead of "passing" the 403.
async function controlCheck() {
  const port = await freePort();
  const st = join(work, 'state-ctl'), wr = join(work, 'v2-work-ctl'), ctlRepo = join(work, 'control-repo'), scripts = join(work, 'fake-scripts.json');
  mkdirSync(st, { recursive: true }); mkdirSync(ctlRepo);
  writeFileSync(scripts, '{}');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const a of [['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'init']]) execFileSync('git', a, { cwd: ctlRepo, env: gitEnv, stdio: 'ignore' });
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', GHOSTY_V2: '1', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: st,
    GHOSTY_V2_WORK_ROOT: wr, GHOSTY_V2_REPOS: ctlRepo, GHOSTY_V2_TEST_FAKE_ADAPTER: scripts,
    TMUX_BIN: wrapper, TLS_KEY: join(work, 'none.pem'), TLS_CERT: join(work, 'none.pem') };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/v2/ops/status`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
    for (let i = 0; i < 100; i++) { const s = await (await fetch(`${base}/api/v2/ops/status`)).json().catch(() => ({})); if (JSON.stringify(s).includes('"running"')) break; await new Promise((r) => setTimeout(r, 100)); }
    const body = JSON.stringify({ goal: 'Same-origin control task', project_id: 'ui-control', risk_class: 'low', runtime_capabilities: ['code'], repository: ctlRepo, idempotency_key: 'ui-control-1', acceptance_checks: [{ id: 'unit', command: ['npm', 'test'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }] });
    const bad = await fetch(`${base}/api/v2/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body });
    const good = await fetch(`${base}/api/v2/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body });
    check('same-origin POST /api/v2/tasks to the same route succeeds (positive control)', bad.status === 403 && good.status === 201, `status ${bad.status}/${good.status} ${good.status >= 400 ? (await good.clone().text()).slice(0, 200) : ''}`);
    check('accepted same-origin request recorded exactly one task', (await (await fetch(`${base}/api/v2/tasks`)).json()).tasks.length === 1);
  } finally { child.kill('SIGTERM'); }
}

async function main() {
  await seed();
  seedHistory();
  await offCheck();
  await controlCheck();
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', GHOSTY_V2: '1', HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: stateDir,
    TMUX_BIN: wrapper, TLS_KEY: join(work, 'none.pem'), TLS_CERT: join(work, 'none.pem') };
  execFileSync(wrapper, ['new-session', '-d', '-s', 'synthetic-demo', '-x', '120', '-y', '30', 'sleep 3000']);
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/sessions`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); if (i === 99) throw new Error(`server did not start:\n${log}`); }
    const pw = (await import(pathToFileURL(join(pwPath, 'index.mjs')))).default ?? (await import(pathToFileURL(join(pwPath, 'index.mjs'))));
    const browser = await pw.chromium.launch({ executablePath: headlessShell(pw), headless: true });
    try {
      // API sanity first: the page is only as honest as the data under it.
      const api = await (await fetch(`${base}/api/v2/tasks`)).json();
      check('API lists 7 seeded tasks, one per outcome', api.tasks.length === 7 && new Set(api.tasks.map((t) => t.outcome)).size === 6 /* done, not_yet_done, waiting, needs_owner, unrecoverable, cancelled; unknown is a state */, `${api.tasks.length} tasks`);

      for (const [label, vp] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
        const ctx = await browser.newContext({ viewport: vp, serviceWorkers: 'allow' });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base, { waitUntil: 'load' });
        await page.waitForSelector('#moreBtn');
        await page.waitForTimeout(1500);
        await page.screenshot({ path: join(out, `${label}-board.png`) });
        const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        check(`${label}: board has no horizontal overflow`, noScroll);

        const sw = await page.evaluate(async () => { try { const r = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]); return { active: !!r.active, scope: r.scope }; } catch (e) { return { error: e.message }; } });
        check(`${label}: service worker registers and activates`, sw.active, JSON.stringify(sw));
        const cached = await page.evaluate(async () => { const names = await caches.keys(); const c = await caches.open(names.find((n) => n.startsWith('ghosty-shell-')) || names[0]); return { names, has: !!(await c.match('/tasks-view.js')) }; });
        check(`${label}: tasks-view.js is precached under the new cache name`, cached.has && cached.names.includes('ghosty-shell-v148'), JSON.stringify(cached.names));

        await page.click('#moreBtn');
        await page.click('#tasksBtn');
        await page.waitForSelector('.sheet.tasks .tk-row', { timeout: 8000 });
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(out, `${label}-tasks-list.png`) });

        const rows = await page.$$eval('.sheet.tasks .tk-row:not([data-tk-queue])', (els) => els.map((e) => ({ id: e.dataset.tkOpen, cls: e.className, badge: e.querySelector('.tk-badge')?.textContent.trim(), badgeCls: e.querySelector('.tk-badge')?.className })));
        const doneBadges = rows.filter((r) => /\bdone\b/i.test(r.badge) || r.badgeCls.includes(' done'));
        check(`${label}: exactly one done badge and it is the accepted task`, doneBadges.length === 1 && doneBadges[0].id === 't-done', JSON.stringify(doneBadges.map((r) => r.id)));
        check(`${label}: no non-accepted row mentions "done" in its badge`, rows.filter((r) => r.id !== 't-done').every((r) => !/done/i.test(r.badge)), rows.map((r) => `${r.id}:${r.badge}`).join(' | '));
        const cls = Object.fromEntries(rows.map((r) => [r.id, r.badgeCls.replace('tk-badge ', '')]));
        check(`${label}: waiting, needs-owner and unknown are visually distinct`, new Set([cls['t-waiting'], cls['t-owner'], cls['t-unknown']]).size === 3, JSON.stringify(cls));

        // keyboard focus order: Tab from the sheet through the controls, DOM order, visible focus ring
        await page.evaluate(() => document.querySelector('.sheet.tasks [data-tk-new]').focus());
        const order = [];
        for (let i = 0; i < 14; i++) {
          order.push(await page.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); return { tag: e.tagName, key: e.dataset.tkOpen || e.dataset.tkNew !== undefined && 'new' || e.dataset.tkRefresh !== undefined && 'refresh' || e.dataset.tkScore !== undefined && 'score' || e.dataset.a || e.textContent.trim().slice(0, 20), inSheet: !!e.closest('.sheet.tasks'), ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 }; }));
          await page.keyboard.press('Tab');
        }
        const keys = order.map((o) => o.key);
        const domRows = rows.map((r) => r.id);
        const expected = ['new', 'refresh', 'score', 't-owner' /* the approval queue comes first */, ...domRows, 'close'];
        check(`${label}: Tab order is New, Refresh, Scorecard, the approval queue, rows in list order, then close`, JSON.stringify(keys.slice(0, expected.length)) === JSON.stringify(expected), keys.join(','));
        check(`${label}: Tab is trapped in the sheet (after close it wraps back to New task)`, keys[expected.length] === 'new', keys[expected.length]);
        check(`${label}: focused controls sit in the sheet and show a focus ring`, order.slice(1, 14).every((o) => o.inSheet && o.ring), JSON.stringify(order.slice(1, 14).filter((o) => !(o.inSheet && o.ring)).slice(0, 2)));   // [0] was focused by script, which is not :focus-visible

        const queue = await page.$$eval('.sheet.tasks .tk-queue .tk-row', (els) => els.map((e) => e.dataset.tkOpen));
        const queueFirst = await page.evaluate(() => { const q = document.querySelector('.sheet.tasks .tk-queue'), r = document.querySelector('.sheet.tasks .tk-row:not([data-tk-queue])'); return !!q && !!r && !!(q.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING); });
        check(`${label}: the Needs owner queue lists exactly the pending request, above the task rows`, JSON.stringify(queue) === '["t-owner"]' && queueFirst, JSON.stringify(queue));
        const listText = await page.innerText('.sheet.tasks');
        check(`${label}: the accepted task is labelled "verified in worktree, not integrated"`, /verified in worktree, not integrated/.test(listText));
        const ratios = await page.evaluate(CONTRAST);
        const low = ratios.filter((r) => r.ratio < 4.5);
        check(`${label}: text contrast >= 4.5:1 on ${ratios.length} sampled elements`, low.length === 0, low.slice(0, 4).map((r) => `${r.text} ${r.ratio}`).join('; '));

        // open the approval task with the keyboard; approve/deny are shown only here
        await page.focus('.sheet.tasks [data-tk-open="t-owner"]');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.sheet.tasks [data-tk-approve]', { timeout: 8000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(out, `${label}-tasks-detail-needs-owner.png`) });
        check(`${label}: approve and deny exist for the pending request (opened by keyboard)`, (await page.$$('.sheet.tasks [data-tk-approve]')).length === 1 && (await page.$$('.sheet.tasks [data-tk-deny]')).length === 1);
        await page.click('.sheet.tasks [data-tk-back]');
        await page.waitForSelector('.sheet.tasks .tk-row');
        await page.click('.sheet.tasks [data-tk-open="t-done"]');
        await page.waitForSelector('.sheet.tasks .tk-check');
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(out, `${label}-tasks-detail-accepted.png`) });
        const dtxt = await page.innerText('.sheet.tasks');
        check(`${label}: accepted detail shows evidence SHA, unknown cost, the not-integrated label, runs/roles/allowed actions, no approve button`, /sha b2c3d4e5f607/.test(dtxt) && /cost unknown/.test(dtxt) && /not integrated/i.test(dtxt) && /runs/i.test(dtxt) && /Roles/i.test(dtxt) && /Allowed actions/i.test(dtxt) && !(await page.$('.sheet.tasks [data-tk-approve]')));
        await page.keyboard.press('Escape');
        check(`${label}: Escape closes the view`, await page.waitForSelector('.sheet.tasks', { state: 'detached', timeout: 3000 }).then(() => true, () => false));
        // ---- History view: rows, filter, detail sheet, both colour schemes ----
        for (const scheme of ['dark', 'light']) {
          const tag = `${label}-${scheme}`;
          await page.emulateMedia({ colorScheme: scheme });
          await page.click('#moreBtn'); await page.click('#historyBtn');
          await page.waitForSelector('.sheet.history .hs-row', { timeout: 8000 });
          await page.waitForTimeout(300);
          await page.screenshot({ path: join(out, `${tag}-history-list.png`) });
          const n0 = (await page.$$('.sheet.history .hs-row')).length;
          check(`${tag}: History lists one page of rows (50) with a load-more`, n0 === 50 && !!(await page.$('.sheet.history [data-hs-more]')), `rows ${n0}`);
          const txt = await page.innerText('.sheet.history');
          check(`${tag}: subscription and unknown costs are labelled, no $0 for unknown`, /subscription/.test(txt) && /unknown/.test(txt));
          check(`${tag}: no horizontal overflow in the History sheet`, await page.evaluate(() => { const b = document.querySelector('.sheet.history'); return b.scrollWidth <= b.clientWidth + 1; }));
          await page.click('.sheet.history [data-hs-more]');
          await page.waitForFunction(() => document.querySelectorAll('.sheet.history .hs-row').length > 50, null, { timeout: 5000 });
          check(`${tag}: load more appends the remaining rows`, (await page.$$('.sheet.history .hs-row')).length === 59);
          await page.selectOption('.sheet.history [data-hs-f="provider"]', 'minimax');
          await page.waitForFunction(() => document.querySelectorAll('.sheet.history .hs-row').length === 1, null, { timeout: 5000 });
          await page.waitForTimeout(200);
          await page.screenshot({ path: join(out, `${tag}-history-filtered.png`) });
          check(`${tag}: provider filter narrows to the one minimax row, shown as subscription`, /synthetic-minimax/.test(await page.innerText('.sheet.history .hs-row')) && /subscription/.test(await page.innerText('.sheet.history .hs-row')));
          await page.click('.sheet.history [data-hs-clear]');
          await page.selectOption('.sheet.history [data-hs-f="status"]', 'running');
          await page.waitForFunction(() => document.querySelectorAll('.sheet.history .hs-row').length === 1, null, { timeout: 5000 });   // the nocard run was ended by the server's sync (no tmux session)
          await page.selectOption('.sheet.history [data-hs-f="status"]', 'ended');
          await page.fill('.sheet.history [data-hs-f="from"]', '2000-01-01'); await page.fill('.sheet.history [data-hs-f="to"]', '2999-01-01');
          await page.waitForFunction(() => /synthetic-running-nocard/.test(document.querySelector('.sheet.history .hs-out').textContent), null, { timeout: 5000 });
          await page.click('.sheet.history .hs-row:has-text("synthetic-running-nocard")');
          await page.waitForSelector('.sheet.history .hs-detail');
          await page.waitForTimeout(200);
          await page.screenshot({ path: join(out, `${tag}-history-detail.png`) });
          const dt = await page.innerText('.sheet.history');
          check(`${tag}: an ended row opens the detail sheet`, /synthetic-running-nocard/.test(dt) && /cbsession/.test(dt) && /usage per day/i.test(dt));
          await page.click('.sheet.history [data-hs-back]');
          await page.selectOption('.sheet.history [data-hs-f="status"]', 'running');
          await page.waitForFunction(() => document.querySelectorAll('.sheet.history .hs-row').length === 1, null, { timeout: 5000 });
          await page.click('.sheet.history .hs-row:has-text("synthetic-demo")');
          check(`${tag}: a running row with a card closes the sheet and focuses that card`, await page.waitForSelector('.sheet.history', { state: 'detached', timeout: 3000 }).then(() => true, () => false)
            && await page.evaluate(() => /synthetic-demo/.test(document.getElementById('appTitle')?.textContent + ' ' + (document.querySelector('.cell.active, .cell.focus, [data-session].active')?.dataset.session || '') + ' ' + localStorage.getItem('ghosty.active'))));
          await page.screenshot({ path: join(out, `${tag}-history-focused-card.png`) });
        }
        await page.emulateMedia({ colorScheme: null });
        check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 2).join('; '));
        await ctx.close();
      }
      // V2 off: the same server code path must 404 (checked by the unit tests too); here we only confirm the on-path origin guard
      const bad = await fetch(`${base}/api/v2/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{"goal":"x"}' });
      check('cross-origin POST /api/v2/tasks is refused (403)', bad.status === 403, `status ${bad.status}`);
      const tasksAfter = await (await fetch(`${base}/api/v2/tasks`)).json();
      check('refused request recorded nothing', tasksAfter.tasks.length === 7);
    } finally { await browser.close(); }
  } finally {
    server.kill('SIGTERM');
    try { execFileSync(wrapper, ['kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
}

let failed = false;
try { await main(); } catch (e) { failed = true; console.error(`ERROR: ${e.stack || e.message}`); }
writeFileSync(join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed. Screenshots and results.json: ${out}`);
process.exit(failed || bad.length ? 1 : 0);
