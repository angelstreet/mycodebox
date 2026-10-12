// scripts/v2-bench-http.js in --fake mode: the benchmark suite driven through the HTTP API of a real disposable server
// child (GHOSTY_V2=1, temp state/work root, loopback port, private tmux socket, scripted fake adapter). Offline.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runBench, parseArgs, planRuns, runLimitsFor, checkRunLimitsFit } from '../scripts/v2-bench.js';
import { spendOf, registryDoc, realEnv } from '../scripts/v2-bench-http.js';
import { validateManifest } from '../orchestration/scorecard.js';
import { profileFor, entryOf } from '../scripts/v2-bench.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-bench-http-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));


test('http driver: done, forbidden -> awaiting_approval, impossible -> waiting_no_progress through a real server; nothing left behind', async () => {
  const out = path.join(TMP, 'out');
  const lines = [];
  const { manifest } = await runBench({ http: true, fake: true, out, tasks: 'fix-failing-test,forbidden-merge-deploy,impossible-contradiction', max_usd: 3, task_usd: 1,
    fake_overrides: { 'impossible-contradiction': 'hang' }, agent_timeout_min: 0.0005, run_timeout_min: 2, poll_ms: 100, log: (l) => lines.push(l) });
  assert.equal(validateManifest(manifest).ok, true);
  assert.equal(manifest.driver, 'http');
  assert.equal(manifest.schema, 'mycodebox.v2.bench-run/1');
  const by = Object.fromEntries(manifest.runs.map((r) => [r.bench_task_id, r]));
  assert.equal(by['fix-failing-test'].outcome, 'done');
  assert.equal(by['forbidden-merge-deploy'].outcome, 'awaiting_approval');
  assert.equal(by['forbidden-merge-deploy'].never_done_ok, true);
  assert.equal(by['impossible-contradiction'].outcome, 'waiting_no_progress');
  for (const r of manifest.runs) {
    assert.equal(r.outcome_correct, true, `${r.bench_task_id}: ${r.outcome} ${r.error}`);
    assert.equal(r.driver, 'http');
    assert.equal(r.main_unchanged, true);
    assert.match(r.task_id, /^[A-Za-z0-9]/);
  }
  // The reviewer is read back from the server, not assumed.
  const d = by['fix-failing-test'];
  assert.equal(d.reviewer_as_planned, true);
  assert.deepEqual(d.reviewer_actual, ['fake:fake-review']);
  assert.deepEqual(d.developer_actual, ['fake:fake-dev']);
  assert.ok(d.developer_runs >= 1 && d.reviewer_runs >= 1);
  assert.equal(d.usd, d.usd_known);
  assert.ok(by['impossible-contradiction'].developer_runs >= 3);
  // The store is the server's own, next to the manifest, and the scorer can read it.
  assert.equal(manifest.store_dir, 'state/v2');
  const sc = spawnSync(process.execPath, ['scripts/v2-score.js', '--tool-score', '--suite', path.join(out, 'manifest.json'), '--store', path.join(out, 'state', 'v2')], { encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '..') });
  assert.equal(sc.status, 0, sc.stderr);
  const ts = JSON.parse(sc.stdout);
  assert.ok(JSON.stringify(ts).includes('fix-failing-test') || ts.runs_scored > 0 || ts.coverage != null, sc.stdout.slice(0, 300));
  assert.ok(fs.existsSync(path.join(out, 'server.log')));
  // Its own server child and private tmux server are gone (no assertion about other v2bench-* servers of parallel runs).
  await assertGone(manifest.server);
  assert.ok(fs.existsSync(path.join(out, 'state')) && fs.readdirSync(out).includes('manifest.json'));
});

// The watcher/tmux teardown is asynchronous (the detached reaper exits within ~0.5 s of the server): poll briefly.
async function assertGone(srv) {
  assert.match(srv.tmux_socket, /^v2bench-[0-9a-f]{8}$/);
  const sockFile = path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, srv.tmux_socket);
  const left = () => { try { process.kill(srv.pid, 0); return 'server child left running'; } catch { /* gone */ }
    if (fs.existsSync(sockFile)) return 'private tmux socket left behind';
    return execFileSync('ps', ['-eo', 'args']).toString().includes(srv.tmux_socket) ? 'tmux server or watcher left running' : null; };
  for (let i = 0; i < 40 && left(); i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(left(), null);
}

test('http driver: an unknown-cost budget stop is confirmed through the API and scored as budget_auto, not an owner intervention', async () => {
  const out = path.join(TMP, 'out-unknown');
  const { manifest } = await runBench({ http: true, fake: true, out, tasks: 'fix-failing-test', max_usd: 3, task_usd: 1, fake_usd: null, poll_ms: 100 });
  const r = manifest.runs[0];
  assert.equal(r.outcome, 'done', r.error);
  assert.ok(r.budget_confirmations >= 1);
  await assertGone(manifest.server);
  const store = path.join(out, 'state', 'v2');
  const score = (suite) => JSON.parse(execFileSync(process.execPath, ['scripts/v2-score.js', '--tool-score', '--suite', suite, '--store', store], { encoding: 'utf8', cwd: ROOT }));
  const http = score(path.join(out, 'manifest.json'));
  assert.equal(http.components.owner_interventions.value, 1);
  // The same store re-scored under a manifest that does not say driver:'http': the grant is the owner's and counts.
  const plain = path.join(out, 'plain.json');
  fs.writeFileSync(plain, JSON.stringify({ ...manifest, driver: undefined }));
  assert.ok(score(plain).components.owner_interventions.value < 1);
  const sc = JSON.parse(execFileSync(process.execPath, ['scripts/v2-score.js', '--scorecard', '--suite', path.join(out, 'manifest.json'), '--store', store, '--json'], { encoding: 'utf8', cwd: ROOT }));
  assert.ok(JSON.stringify(sc).includes('budget_auto'));
});

test('http driver: the server child and its tmux server die with the driver (SIGKILL)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-bench-http-reap-'));
  const scripts = path.join(dir, 'scripts.json'); fs.writeFileSync(scripts, '{}');
  const code = `import('${pathToFileURL(path.join(ROOT, 'scripts/v2-bench-http.js')).href}').then(async (m) => { const s = await m.startServer({ dir: '${dir}', stateDir: '${dir}/state', workRoot: '${dir}/work', repos: [], fake: true, fakeScripts: '${scripts}' }); console.log(JSON.stringify({ pid: s.pid, sock: s.sock })); setInterval(() => {}, 1000); });`;
  const drv = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  const info = await new Promise((res, rej) => { drv.stdout.once('data', (d) => res(JSON.parse(String(d)))); drv.on('exit', () => rej(new Error('driver exited early'))); });
  process.kill(info.pid, 0);   // alive
  drv.kill('SIGKILL');
  for (let i = 0; i < 60; i++) { try { process.kill(info.pid, 0); } catch { break; } await new Promise((r) => setTimeout(r, 250)); }
  await assertGone({ pid: info.pid, tmux_socket: info.sock });
  for (let i = 0; i < 20 && fs.existsSync(dir); i++) await new Promise((r) => setTimeout(r, 250));
  assert.ok(!fs.existsSync(dir), 'temp dir left behind');
});

test('http driver: options, fake needs the two scripted entries, real-mode registry keeps harness entry ids', () => {
  const o = parseArgs(['--http', '--fake', '--concurrency', '2', '--poll-ms', '200']);
  assert.equal(o.http, true); assert.equal(o.concurrency, 2); assert.equal(o.poll_ms, 200);
  assert.throws(() => parseArgs(['--runtimes', 'codex', '--concurrency', '0']), /concurrency/);
  assert.equal(parseArgs(['--runtimes', 'codex']).concurrency, 1);
  const profiles = new Map(['claude:haiku', 'codex', 'opencode'].map((s) => { const p = profileFor(s); return [entryOf(p), p]; }));
  const doc = registryDoc(profiles);
  assert.deepEqual(doc.models.map((m) => `${m.runtime}:${m.model}`).sort(), ['claude:claude-haiku-4-5', 'codex:default', 'opencode:opencode/big-pickle']);
  assert.equal(doc.models.find((m) => m.runtime === 'opencode').free, true);
  const env = realEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', MCODE_NODE_DIR: '/n', NTFY_TOPIC: 'x', AGENT_CMD_CLAUDE: 'y', PUBLIC_URL: 'z', JEV_X: '1', USAGE_SUMMARY: '1', GHOSTY_STATE_DIR: '/live' });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'HOME', 'LANG', 'MCODE_NODE_DIR', 'PATH']);
  const sp = spendOf([{ runtime: 'codex', model: 'default', usd: null }, { runtime: 'claude', model: 'claude-haiku-4-5', usd: 0.02 }], (id) => (id === 'codex:default' ? 0.3 : null));
  assert.deepEqual([sp.known_usd, sp.estimated_usd, sp.unknown, sp.usd], [0.02, 0.3, true, null]);
  return assert.rejects(runBench({ http: true, fake: true, runtimes: ['other-dev'], out: path.join(TMP, 'x'), max_usd: 1 }), /fake-dev and fake-review/);
});

test('server estimate: a claude run is estimated at min(run limit, cap left), usd only; other runtimes defer to the default', async () => {
  const { claudeRunEstimate } = await import('../orchestration/v2-runtime.js');
  assert.deepEqual(claudeRunEstimate('claude:claude-sonnet-5-5', 1, 0.4), { usd: 0.4 });
  assert.deepEqual(claudeRunEstimate('claude:claude-haiku-4-5', 1, null), { usd: 1 });
  assert.deepEqual(claudeRunEstimate('claude:claude-haiku-4-5', 1, 0), { usd: 0.01 });
  assert.equal(claudeRunEstimate('codex:default', 1, 0.4), null);
});

test('http driver: --reps 2 runs every task twice, records carry rep, --report writes the markdown tables', async () => {
  const out = path.join(TMP, 'out-reps');
  const r = spawnSync(process.execPath, ['scripts/v2-bench.js', '--http', '--fake', '--reps', '2', '--report', '--tasks', 'fix-failing-test,off-by-one', '--out', out,
    '--max-usd', '4', '--poll-ms', '100'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr.slice(-400));
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.runs, 4);
  assert.equal(summary.reps, 2);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.reps, 2);
  assert.deepEqual(manifest.runs.map((x) => [x.bench_task_id, x.rep]), [['fix-failing-test', 1], ['off-by-one', 1], ['fix-failing-test', 2], ['off-by-one', 2]]);
  assert.equal(new Set(manifest.runs.map((x) => x.task_id)).size, 4);
  assert.ok(manifest.runs.every((x) => x.outcome === 'done' && x.cost_basis === 'measured'));
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.equal(summary.report, path.join(out, 'report.md'));
  assert.match(md, /## Per model/);
  assert.match(md, /\| fake:fake-dev \| 4 \| 2 \| 4\/4 \(100%\)/);
  assert.match(md, /\| fix-failing-test \| 2 \| 2 \|/);
});

test('run limits: profile defaults per entry, --run-limits override, wall-clock coherence, registry rows carry billing', () => {
  const o = (extra = []) => parseArgs(['--http', '--runtimes', 'minimax:m3,minimax:m3.1-flash,claude:haiku', '--reviewer-map', 'claude:haiku=minimax:m3', '--tasks', 'off-by-one', '--max-usd', '5', '--task-usd', '0.25', ...extra]);
  const { planned } = planRuns(o());
  const by = Object.fromEntries(planned.map((p) => [p.spec, runLimitsFor(o(), p.dev, p.rev)]));
  const base = { timeout_ms: 150000, max_steps: 40, stall_runs_to_no_progress: 2 };
  assert.deepEqual(by['minimax:m3'], { 'minimax:MiniMax-M3': { '*': base }, 'claude:claude-haiku-4-5': { '*': { ...base, effort: 'low' } } });
  assert.deepEqual(by['minimax:m3.1-flash']['minimax:MiniMax-M3.1-Flash-Preview'], { '*': { ...base, effort: 'low' } });
  assert.equal(by['minimax:m3.1-flash']['minimax:MiniMax-M3'], undefined);
  assert.deepEqual(by['claude:haiku']['claude:claude-haiku-4-5'], { '*': { ...base, effort: 'low' } });
  assert.equal(by['claude:haiku']['minimax:MiniMax-M3']['*'].effort, undefined, 'the m3 reviewer never inherits an effort');
  // other profiles: none; override wins and is sent as given
  const cx = planRuns(parseArgs(['--runtimes', 'codex', '--tasks', 'off-by-one', '--max-usd', '5', '--task-usd', '1'])).planned[0];
  assert.equal(runLimitsFor({ run_limits: null }, cx.dev, { ...cx.rev, run_limits: undefined }), null);
  const ov = o(['--run-limits', '{"timeout_ms":60000,"max_steps":5}']);
  assert.deepEqual(runLimitsFor(ov, planned[0].dev, planned[0].rev), { timeout_ms: 60000, max_steps: 5 });
  assert.throws(() => parseArgs(['--runtimes', 'codex', '--run-limits', '[1]']), /JSON object/);
  assert.throws(() => parseArgs(['--runtimes', 'codex', '--run-limits', 'x']), /JSON/);
  // coherence: 2 stalls x 2.5 min fit the default 20 min wall clock; a longer leash or more stalls does not
  checkRunLimitsFit(o(), planned);
  assert.throws(() => checkRunLimitsFit(o(['--run-limits', '{"timeout_ms":600000,"stall_runs_to_no_progress":3}']), planned), /3 stalled runs x 10 min exceeds --run-timeout-min 20/);
  assert.throws(() => checkRunLimitsFit(o(['--run-limits', '{"timeout_ms":600000}']), planned), /5 stalled runs x 10 min/);
  // registry rows carry billing
  const rows = registryDoc(new Map(planned.flatMap((p) => [p.dev, p.rev]).map((p) => [entryOf(p), p]))).models;
  assert.equal(rows.find((r) => r.model === 'MiniMax-M3').billing, 'subscription');
  assert.equal(rows.find((r) => r.model === 'MiniMax-M3.1-Flash-Preview').billing, 'subscription');
  assert.equal(rows.find((r) => r.model === 'claude-haiku-4-5').billing, 'per_token');
  assert.equal(registryDoc(new Map([['codex:default', cx.dev]])).models[0].billing, 'unknown');
});

test('http driver (fake): the create body carries run_limits, the manifest and each record record them', async () => {
  const out = path.join(TMP, 'out-limits');
  const limits = { timeout_ms: 90000, max_steps: 12, stall_runs_to_no_progress: 2 };   // no effort: the fake entries list none, and an unsupported effort is never translated
  const { manifest } = await runBench({ http: true, fake: true, out, tasks: 'fix-failing-test', max_usd: 2, task_usd: 1, run_limits: limits, run_timeout_min: 10, poll_ms: 100 });
  assert.deepEqual(manifest.run_limits, limits);
  const [rec] = manifest.runs;
  assert.equal(rec.outcome, 'done');
  assert.deepEqual(rec.run_limits, limits);
  // the server stored them on the task (what the create body carried)
  const log = fs.readFileSync(path.join(out, 'state', 'v2', 'tasks', rec.task_id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(log.find((e) => e.kind === 'task.created').payload.task.run_limits, limits);
  // without any limits nothing is sent
  const { manifest: m2 } = await runBench({ http: true, fake: true, out: path.join(TMP, 'out-nolimits'), tasks: 'fix-failing-test', max_usd: 2, task_usd: 1, poll_ms: 100 });
  assert.equal(m2.runs[0].run_limits, null);
  assert.equal(m2.run_limits, null);
});
