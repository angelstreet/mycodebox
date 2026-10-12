#!/usr/bin/env node
// V2 benchmark suite over HTTP (OWNER_DECISIONS §11.2). The same suite, fixtures, manifest schema and suite ledger as
// scripts/v2-bench.js, but every run goes through the REAL server: a disposable `node server.js` child (GHOSTY_V2=1) is
// started on a free loopback port, tasks are created with POST /api/v2/tasks, polled with GET /api/v2/tasks/:id, budget
// stops for unknown cost are answered with POST .../approve (the pending action_id and sha) and a run past its wall
// clock is cancelled with POST .../cancel. Reach it as `node scripts/v2-bench.js --http ...` (same options, plus
// --concurrency N, default 1, and --poll-ms, default 1000) or run this file directly.
//
// Isolation: the child gets GHOSTY_STATE_DIR=<out>/state, a temp GHOSTY_V2_WORK_ROOT, the fixture repos as
// GHOSTY_V2_REPOS, HOST=127.0.0.1 and a free PORT (never 7777/7443), TLS pointed at missing files (no TLS listener), and
// TMUX_BIN = a wrapper around `tmux -L <unique>`: the live state dir, ports and default tmux socket are never touched.
// The server, its processes and the private tmux server are killed at the end, on error and on SIGINT/SIGTERM.
//
// The developer is pinned (preferred_models) and the reviewer is fixed by runtime/model allowlists naming exactly the
// two planned models; the reviewer the server actually used is read back from the task detail and recorded
// (reviewer_runtime/model, reviewer_planned, reviewer_as_planned). Real runs use a registry file written next to the
// manifest with the same entries as v2-bench.js, so entry ids are identical. Not identical to the in-process harness:
// the server's goal loop has no estimateRun (the router's price estimate or "unknown" stops, answered by the suite
// ledger), claude runs share one --max-budget-usd (GHOSTY_V2_CLAUDE_RUN_USD = the largest run_usd, capped at the per-task
// cap), and checks in the manifest are the latest evidence per check. Output: <out>/manifest.json (driver: 'http',
// store_dir 'state/v2': score with `v2-score.js --tool-score --suite <out>/manifest.json --store <out>/state/v2`),
// <out>/server.log (the server's own log, local only). Spends real quota unless --fake.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUITE_ID, SUITE_VERSION, policyFor, noopFiles } from '../test/fixtures/v2-bench/tasks.js';
import { parseArgs, planRuns, createSuiteLedger, refuseOutDir, notRunOutcome, classify, summarize, entryOf, MANIFEST_SCHEMA, NO_PROGRESS, DEFAULTS, validateOptions } from './v2-bench.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STOP_STATES = ['accepted', 'failed_unrecoverable', 'cancelled'];
const BENCH_REASON = 'v2-bench-http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round6 = (x) => Math.round(x * 1e6) / 1e6;

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// Spend of one task from its detail usage records: known USD, and an estimate for every record without USD.
export function spendOf(records, estOf) {
  let known = 0, estimated = 0, unknown = 0, allKnown = records.length > 0;
  for (const u of records) {
    if (typeof u.usd === 'number' && Number.isFinite(u.usd) && u.incomplete !== true) known += u.usd;
    else { unknown += 1; allKnown = false; estimated += estOf(`${u.runtime}:${u.model}`) ?? 0; }
  }
  return { known_usd: known, estimated_usd: estimated, unknown: unknown > 0, unknown_records: unknown, usd: records.length === 0 ? 0 : allKnown ? known : null };
}

// Real runs need the owner's CLI logins, not the whole service environment: PATH, HOME, locale, proxies and the provider
// auth/config variables only (no NTFY_*, USAGE_SUMMARY, JEV_*, PUBLIC_URL, AGENT_CMD_*, GHOSTY_*; those are set or dropped here).
const ENV_KEEP = /^(PATH|HOME|LANG|LC_[A-Z]+|USER|LOGNAME|SHELL|TMPDIR|TMUX_TMPDIR|XDG_[A-Z_]+|SSL_CERT_(FILE|DIR)|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|(ANTHROPIC|OPENAI|CODEX|MINIMAX|MCODE|OPENCODE|OPENROUTER|CLAUDE)_[A-Z0-9_]+)$/;
export function realEnv(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) if (ENV_KEEP.test(k) && v != null) out[k] = v;
  out.LANG ||= 'C.UTF-8';
  return out;
}

// Dies with the driver: a detached watcher that, once the driver process is gone (SIGKILL, crash), kills the server, the
// private tmux server and the temp dir. It leaves quietly when the server is already gone (normal stop). Not in server.js.
const REAPER = `const [dp, sp, tmux, sock, sockFile, tmp] = process.argv.slice(1); const fs = require('fs');
const alive = (p) => { try { process.kill(Number(p), 0); return true; } catch { return false; } };
const ours = () => { try { return fs.readFileSync('/proc/' + sp + '/cmdline', 'utf8').split('\\0').includes('server.js'); } catch { return false; } };   // pid not reused
const t = setInterval(() => { if (!alive(sp) || !ours()) process.exit(0); if (alive(dp)) return; clearInterval(t);
  try { process.kill(Number(sp), 'SIGTERM'); } catch {}
  setTimeout(() => { if (alive(sp) && ours()) { try { process.kill(Number(sp), 'SIGKILL'); } catch {} }
    try { require('child_process').execFileSync(tmux, ['-L', sock, 'kill-server'], { stdio: 'ignore' }); } catch {}
    try { fs.rmSync(sockFile, { force: true }); if (tmp && /v2-bench-http-/.test(tmp)) fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(0); }, 10000); }, 500);`;

// The disposable server. Returns { base, api, stop, log }. `dir` holds the tmux wrapper and the fake HOME, `stateDir` the server's state (kept: it is the benchmark's task store).
export async function startServer({ dir, keepDir = false, stateDir, workRoot, repos, registryFile, fake, fakeScripts, pathDirs = [], claudeRunUsd, runTimeoutMs, concurrency = 1, log = () => {} }) {
  const sock = `v2bench-${randomBytes(4).toString('hex')}`;
  const realTmux = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux'].find((p) => fs.existsSync(p)) || 'tmux';
  const wrapper = path.join(dir, 'tmux-wrapper.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${realTmux} -L ${sock} "$@"\n`, { mode: 0o755 });
  const sockFile = path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, sock);
  const state = stateDir;
  fs.mkdirSync(state, { recursive: true });
  const port = await freePort();
  // Real runs need the owner's CLI logins (HOME and the provider environment, as the in-process harness has); a fake run
  // gets a bare environment and a temp HOME.
  const base = fake ? { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: path.join(dir, 'home') } : realEnv(process.env);
  if (fake) fs.mkdirSync(base.HOME, { recursive: true });
  const env = { ...base, HOST: '127.0.0.1', PORT: String(port), GHOSTY_STATE_DIR: state, TMUX_BIN: wrapper,
    TLS_KEY: path.join(dir, 'none.pem'), TLS_CERT: path.join(dir, 'none.pem'),   // missing files: no TLS listener
    GHOSTY_V2: '1', GHOSTY_V2_WORK_ROOT: workRoot, GHOSTY_V2_REPOS: repos.join(path.delimiter), GHOSTY_V2_CONCURRENCY: String(concurrency),
    ...(registryFile ? { GHOSTY_V2_REGISTRY: registryFile } : {}), ...(fakeScripts ? { GHOSTY_V2_TEST_FAKE_ADAPTER: fakeScripts } : {}),
    ...(pathDirs.length ? { GHOSTY_V2_PATH_DIRS: pathDirs.join(path.delimiter) } : {}),
    ...(claudeRunUsd ? { GHOSTY_V2_CLAUDE_RUN_USD: String(claudeRunUsd) } : {}), ...(runTimeoutMs ? { GHOSTY_V2_RUN_TIMEOUT_MS: String(runTimeoutMs) } : {}) };
  // A private tmux server with one idle session so the dashboard's session poll has something to list.
  execFileSync(wrapper, ['new-session', '-d', '-s', 'bench-fixture', '-x', '80', '-y', '20', 'sleep 86400'], { stdio: 'ignore' });
  let lines = [];
  const keep = (d) => { lines.push(...String(d).split('\n').filter((l) => l.trim() && !/listSessions/.test(l))); if (lines.length > 400) lines = lines.slice(-300); };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  const reaper = spawn(process.execPath, ['-e', REAPER, String(process.pid), String(child.pid), realTmux, sock, sockFile, keepDir ? '' : dir], { detached: true, stdio: 'ignore' });
  reaper.unref();
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  let done = false;
  const url = `http://127.0.0.1:${port}`;
  // Same headers as the dashboard: a same-origin Origin and a JSON content type.
  const api = async (method, p, body) => {
    const r = await fetch(`${url}${p}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', origin: url }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  async function stop() {
    if (done) return;
    done = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const r = await Promise.race([exited, sleep(10_000).then(() => null)]);
      if (!r) { child.kill('SIGKILL'); await Promise.race([exited, sleep(3000)]); }
    }
    try { execFileSync(realTmux, ['-L', sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* none was running */ }
    fs.rmSync(sockFile, { force: true });
  }
  try {
    for (let i = 0; ; i++) {
      if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${lines.slice(-20).join('\n')}`);
      try { if ((await fetch(`${url}/api/sessions`)).ok) break; } catch { /* not up yet */ }
      if (i > 300) throw new Error(`server did not start:\n${lines.slice(-20).join('\n')}`);
      await sleep(100);
    }
    const st = await (async () => {
      for (let i = 0; i < 300; i++) {
        const r = await api('GET', '/api/v2/ops/status').catch(() => null);
        const s = r?.body?.status;
        if (s && ['running', 'refused'].includes(s.state)) return s;
        await sleep(100);
      }
      throw new Error(`V2 engine did not settle:\n${lines.slice(-20).join('\n')}`);
    })();
    if (st.state !== 'running') throw new Error(`V2 engine refused to run: ${st.reason}`);
    log(`server up on ${url} (state ${state}, tmux socket ${sock})`);
    return { url, port, api, stop, status: st, logText: () => lines.join('\n'), pid: child.pid, sock, sockFile, realTmux };
  } catch (e) { await stop(); throw e; }
}

// Real-mode registry: the harness's profile entries, so an entry id is the same in both drivers.
export function registryDoc(profiles) {
  return { version: 1, as_of: '2026-10-12', models: [...profiles.values()].map((p) => ({ runtime: p.runtime, provider: p.provider, model: p.model, tier: p.tier,
    capabilities: ['text', 'code', 'tools', 'json_output'], efforts: p.efforts, context_tokens: 200000, latency_ms: 10000, ...(p.free ? { free: true } : {}) })) };
}

export async function runBenchHttp(opts) {
  const o = validateOptions({ ...DEFAULTS, ...opts, http: true });
  const { tasks, pairs, planned, taskUsd } = planRuns(o);
  if (o.fake && pairs.some((p) => p.spec !== 'fake-dev' || p.revSpec !== 'fake-review')) throw new Error('--http --fake: the server\'s scripted fake adapter has the two entries fake-dev and fake-review only');
  const ledger = createSuiteLedger({ max_usd: o.max_usd });
  const log = o.log || (() => {});
  const outDir = path.resolve(o.out || fs.mkdtempSync(path.join(os.tmpdir(), 'v2-bench-out-')));
  refuseOutDir(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-bench-http-')));
  if (!path.relative(ROOT, tmp).startsWith('..')) throw new Error('refusing to run inside the repository');
  const stateDir = path.join(outDir, 'state');
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = { schema: MANIFEST_SCHEMA, suite_id: SUITE_ID, suite_version: SUITE_VERSION, driver: 'http', started_at: new Date().toISOString(), finished_at: null,
    mode: o.fake ? 'fake' : 'real', store_dir: 'state/v2', runs: [], budget_policy: { mode: 'cap', max_usd: o.max_usd, per_task_usd: taskUsd },
    spend: { known_usd: 0, estimated_usd: 0, unknown_runs: 0 }, runtimes: {}, no_progress_policy: NO_PROGRESS, concurrency: o.concurrency, server: null };
  const writeManifest = () => {
    manifest.spend = ledger.summary();
    manifest.cap_note = manifest.spend.unknown_runs
      ? `cap enforced on estimates for ${manifest.spend.unknown_runs} unknown-cost run(s): estimated_usd ${manifest.spend.estimated_usd} is not measured spend (known_usd ${manifest.spend.known_usd})`
      : 'cap enforced on measured spend only';
    const t = `${manifestPath}.${process.pid}.tmp`;
    fs.writeFileSync(t, `${JSON.stringify(manifest, null, 1)}\n`);
    fs.renameSync(t, manifestPath);
  };

  let server = null;
  const cleanup = async () => { await server?.stop(); if (!o.keep) fs.rmSync(tmp, { recursive: true, force: true }); };
  const onSignal = (sig) => { cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143)); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    const env = { PATH: process.env.PATH, HOME: os.homedir(), LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    const sh = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const workRoot = path.join(tmp, 'work');
    fs.mkdirSync(workRoot, { recursive: true });
    // One disposable repo per run, with its own valid .ai/project.json: no run sees another's commits.
    const runs = planned.map((p, i) => {
      const repo = path.join(tmp, 'repos', `${String(i).padStart(3, '0')}-${p.task.id}`);
      fs.mkdirSync(path.join(repo, '.ai'), { recursive: true });
      sh(repo, 'init', '-q', '-b', 'main');
      sh(repo, 'config', 'user.name', 'Bench User'); sh(repo, 'config', 'user.email', 'bench@example.invalid');
      for (const [f, c] of Object.entries(p.task.files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c); }
      fs.writeFileSync(path.join(repo, '.ai', 'project.json'), `${JSON.stringify(policyFor(p.task), null, 1)}\n`);
      sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', `bench fixture ${p.task.id}`);
      return { ...p, repo, main: sh(repo, 'rev-parse', 'main') };
    });

    const profiles = new Map();
    for (const p of pairs) { profiles.set(entryOf(p.dev), p.dev); profiles.set(entryOf(p.rev), p.rev); }
    const measured = new Map();
    // Same rule as the in-process harness: measured mean first, else the profile estimate, never below a claude run bound.
    const estUsd = (id) => {
      const xs = measured.get(id) || [];
      const est = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : (profiles.get(id)?.est_usd ?? null);
      const p = profiles.get(id);
      return p?.run_usd ? Math.max(est ?? 0, Math.min(p.run_usd, taskUsd)) : est;
    };

    // Scripted fake (test only): one script per bench task, selected by a [fake:<id>] marker in the goal.
    let fakeScripts = null, registryFile = null;
    const fakeUsd = Object.hasOwn(o, 'fake_usd') ? o.fake_usd : 0.01;
    if (o.fake) {
      const sc = {};
      for (const t of tasks) {
        const behaviour = o.fake_overrides?.[t.id] ?? o.fake_behaviour;
        const dev = behaviour === 'hang' ? [{ op: 'usage', input_tokens: 1000, output_tokens: 200, usd: fakeUsd }, { op: 'hang' }]
          : [...Object.entries(behaviour === 'noop' ? noopFiles(t) : t.fake.solve).map(([p, content]) => ({ op: 'write', path: p, content })), { op: 'usage', input_tokens: 1000, output_tokens: 200, usd: fakeUsd }];
        sc[t.id] = { developer: dev, reviewer: [{ op: 'usage', input_tokens: 500, output_tokens: 50, usd: fakeUsd == null ? null : fakeUsd / 2 }, { op: 'emit', event: { type: 'result', text: JSON.stringify({ verdict: 'approve', findings: [] }) } }] };
      }
      fakeScripts = path.join(tmp, 'fake-scripts.json');
      fs.writeFileSync(fakeScripts, JSON.stringify(sc));
    } else {
      registryFile = path.join(outDir, 'registry.json');
      fs.writeFileSync(registryFile, `${JSON.stringify(registryDoc(profiles), null, 1)}\n`);
    }
    const claudeBound = Math.max(0, ...[...profiles.values()].filter((p) => p.run_usd).map((p) => Math.min(p.run_usd, taskUsd)));
    server = await startServer({ dir: tmp, keepDir: o.keep, stateDir, workRoot, repos: runs.map((r) => r.repo), registryFile, fake: o.fake, fakeScripts,
      pathDirs: [...new Set([...profiles.values()].flatMap((p) => p.pathDirs || []))], claudeRunUsd: claudeBound || undefined,
      runTimeoutMs: Math.round(o.agent_timeout_min * 60_000), concurrency: o.concurrency, log });
    manifest.server = { pid: server.pid, tmux_socket: server.sock, runtimes: server.status.runtimes, concurrency: server.status.concurrency, test_fake_adapter: !!server.status.test_fake_adapter };
    for (const [id, p] of profiles) manifest.runtimes[id] = { available: o.fake ? true : server.status.runtimes?.[p.runtime]?.available ?? 'unknown', version: server.status.runtimes?.[p.runtime]?.version ?? null };
    writeManifest();

    let inflight = 0;
    async function runOne(r) {
      const t0 = Date.now();
      const devId = entryOf(r.dev), revId = entryOf(r.rev);
      const rec = { task_id: null, bench_task_id: r.task.id, task_class: r.task.task_class, expected_outcome: r.task.expected_outcome,
        runtime: r.dev.runtime, model: r.dev.model, reviewer_runtime: r.rev.runtime, reviewer_model: r.rev.model, runtime_spec: r.spec, reviewer_spec: r.revSpec,
        driver: 'http', reviewer_planned: revId, reviewer_as_planned: null,
        final_state: null, outcome: null, outcome_correct: false, usd: null, duration_ms: null, error: null,
        wait_reason: null, developer_runs: 0, reviewer_runs: 0, checks: [], usd_known: 0, usd_estimated: 0, unknown_cost_records: 0, budget_confirmations: 0,
        main_unchanged: null, never_done_ok: null, stop_note: null };
      const gateL = ledger.allows(taskUsd * (inflight + 1));   // reserve the run's full per-task cap (and the runs in flight) before it starts
      const devAvail = manifest.runtimes[devId]?.available, revAvail = manifest.runtimes[revId]?.available;
      if (!gateL.ok) {
        rec.outcome = 'skipped_budget'; rec.error = gateL.reason; rec.usd = 0; rec.duration_ms = 0;
      } else if (devAvail === false || revAvail === false) {
        rec.outcome = 'not_started'; rec.error = `runtime unavailable (server probe): ${devAvail === false ? r.spec : r.revSpec}`; rec.usd = 0; rec.duration_ms = 0;
      } else {
        inflight += 1;
        log(`run ${r.task.id} x ${r.spec} (reviewer ${r.revSpec})`);
        let timedOut = false;
        const get = async () => { const x = await server.api('GET', `/api/v2/tasks/${rec.task_id}`); if (x.status !== 200 || !x.body?.task) throw new Error(`GET task -> ${x.status}`); return x.body.task; };
        try {
          const goal = o.fake ? `${r.task.goal}\n[fake:${r.task.id}]` : r.task.goal;
          const body = { goal, title: `bench ${r.task.id}`, project_id: `bench-${r.task.id}`, repository: r.repo, risk_class: 'low', runtime_capabilities: ['code'],
            preferred_models: [devId], runtime_allowlist: [...new Set([r.dev.runtime, r.rev.runtime])], model_allowlist: [...new Set([r.dev.model, r.rev.model])],
            budget_policy: { mode: 'cap', max_usd: taskUsd }, no_progress_policy: { ...NO_PROGRESS }, task_class: r.task.task_class,
            acceptance_checks: r.task.checks.map((c) => ({ id: c.id, command: c.command, expect: { exit: 0 }, evidence_type: 'exit_code', required: true })) };
          const c = await server.api('POST', '/api/v2/tasks', body);
          if (c.status !== 201) { const e = new Error(`create -> ${c.status} ${c.body?.code || ''}`); e.code = `create_${c.status}_${c.body?.code || ''}`; throw e; }
          rec.task_id = c.body.task.task_id;
          const deadline = t0 + o.run_timeout_min * 60_000;
          let since = { state: null, at: 0 };
          for (;;) {
            if (Date.now() > deadline) { timedOut = true; break; }
            const t = await get();
            if (STOP_STATES.includes(t.state)) break;
            // Nothing further will happen on its own (round 2 recorded these as not_yet_done): an unreadable log, an external
            // effect to reconcile, or integration that does not move for a minute.
            if (t.store_error || t.state === 'unknown_external_effect') break;
            if (since.state !== t.state) since = { state: t.state, at: Date.now() };
            if (['integrating', 'release_verifying'].includes(t.state) && Date.now() - since.at > 60_000) break;
            if (t.state === 'awaiting_approval') {
              const p = t.pending_approval;
              if (!p) { await sleep(Math.min(o.poll_ms, 250)); continue; }   // answered; the loop moves on shortly
              // Only a stop that exists because a cost is unknown, never a reached cap or any other owner question.
              if (o.confirm_unknown && p.kind === 'budget' && p.cap_reached === false) {
                const sp = spendOf(t.usage.records, estUsd);
                const ok = ledger.allows(sp.known_usd + sp.estimated_usd + (estUsd(p.entry) ?? 0) + taskUsd * Math.max(0, inflight - 1));   // the other runs in flight keep their reservations
                if (ok.ok) {
                  const a = await server.api('POST', `/api/v2/tasks/${rec.task_id}/approve`, { action_id: p.action_id, ...(p.sha ? { sha: p.sha } : {}), reason: `suite-ledger ${ok.committed}/${o.max_usd}` });
                  if (a.status === 200) { rec.budget_confirmations += 1; await sleep(Math.min(o.poll_ms, 250)); continue; }
                  rec.error = `approve -> ${a.status} ${a.body?.code || ''}`;
                } else rec.error = ok.reason;
              }
              break;
            }
            if (t.state === 'waiting') {
              const w = t.wait;
              // A timed wait no longer than --wait-up-to-sec (default: only zero-length waits such as a reviewer change)
              // elapses inside the run's wall clock; anything longer, or one that needs the owner, is recorded.
              const left = w?.until_ms != null ? w.until_ms - Date.now() : null;
              if (left != null && left <= Math.max(2000, o.wait_up_to_sec * 1000) && Date.now() + left < deadline) { await sleep(Math.min(o.poll_ms, Math.max(50, left))); continue; }
              break;
            }
            await sleep(o.poll_ms);
          }
          if (timedOut) await server.api('POST', `/api/v2/tasks/${rec.task_id}/cancel`, { reason: `${BENCH_REASON}: wall clock ${o.run_timeout_min} min` }).catch(() => null);
          const t = await get();
          const kind = t.pending_approval?.kind ?? null;
          rec.final_state = t.state;
          rec.outcome = timedOut ? 'timeout' : classify(t.state, { approval: { kind }, wait: { reason: t.wait?.reason ?? null } });
          rec.wait_reason = t.state === 'waiting' ? t.wait?.reason ?? null : t.state === 'awaiting_approval' ? kind : null;
          if (t.state !== 'accepted' && kind !== 'agent_action' || t.state === 'waiting') {
            rec.stop_note = String((t.state === 'waiting' && t.wait?.diagnosis) || t.decisions.at(-1)?.rationale || '').slice(0, 240) || null;
          }
          const dr = t.runs.filter((x) => x.role === 'developer'), rr = t.runs.filter((x) => x.role === 'reviewer');
          rec.developer_runs = dr.length; rec.reviewer_runs = rr.length;
          rec.checks = t.acceptance_checks.filter((x) => x.latest_evidence).map((x) => ({ check_id: x.id, exit: x.latest_evidence.exit }));
          const failedRuns = t.runs.map((x) => /^failed: (.+)$/.exec(x.outcome)?.[1]).filter(Boolean);
          if (failedRuns.length && !rec.error) rec.error = `run error class(es): ${[...new Set(failedRuns)].join(', ')}`;
          // What the server really used: recorded, and a different developer or reviewer than planned is flagged.
          const seen = (xs) => [...new Set(xs.map((x) => `${x.runtime}:${x.model}`))];
          const actualRev = seen(rr);
          if (actualRev.length) { rec.reviewer_actual = actualRev; rec.reviewer_as_planned = actualRev.every((x) => x === revId); }
          if (actualRev.length === 1) { const [rt, ...m] = actualRev[0].split(':'); rec.reviewer_runtime = rt; rec.reviewer_model = m.join(':'); }
          const actualDev = seen(dr);
          rec.developer_actual = actualDev;
          if (actualDev.some((x) => x !== devId) || (actualRev.length && !rec.reviewer_as_planned)) rec.error = `${rec.error ? `${rec.error}; ` : ''}server used developer ${actualDev.join(',') || 'none'} / reviewer ${actualRev.join(',') || 'none'}, planned ${devId} / ${revId}`.slice(0, 300);
          const sp = spendOf(t.usage.records, estUsd);
          Object.assign(rec, { usd: sp.usd, usd_known: round6(sp.known_usd), usd_estimated: round6(sp.estimated_usd), unknown_cost_records: sp.unknown_records });
          ledger.record(sp);
          for (const u of t.usage.records) if (typeof u.usd === 'number' && u.incomplete !== true) { const id = `${u.runtime}:${u.model}`; measured.set(id, [...(measured.get(id) || []), u.usd]); }
        } catch (e) {
          rec.outcome = timedOut ? 'timeout' : 'error';
          rec.error = String(e?.code || e?.message || e).slice(0, 200);
          if (rec.task_id) {
            try {
              const x = await server.api('GET', `/api/v2/tasks/${rec.task_id}`); const t = x.body?.task;
              if (t) { rec.final_state = t.state; const sp = spendOf(t.usage.records, estUsd); rec.usd = sp.usd; ledger.record(sp); }
            } catch { /* recorded as error */ }
          }
        } finally { inflight -= 1; }
      }
      // Invariants: the fixture's main branch never moves; a task that must not be done is never done.
      try { rec.main_unchanged = sh(r.repo, 'rev-parse', 'main') === r.main; } catch { rec.main_unchanged = null; }
      rec.outcome = notRunOutcome(rec);
      rec.never_done_ok = r.task.expected_outcome === 'done' ? null : rec.outcome !== 'done';
      rec.outcome_correct = rec.outcome === rec.expected_outcome;
      rec.duration_ms ??= Date.now() - t0;
      return rec;
    }

    // At most o.concurrency runs in flight (the server's GHOSTY_V2_CONCURRENCY is the same number); records stay in plan order.
    const results = new Array(runs.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(o.concurrency, runs.length) }, async () => {
      while (next < runs.length) {
        const i = next++;
        const rec = await runOne(runs[i]);
        results[i] = rec;
        manifest.runs = results.filter(Boolean);
        writeManifest();
        log(`  -> ${rec.bench_task_id}: ${rec.outcome} (${rec.final_state}) usd ${rec.usd ?? 'unknown'} in ${Math.round(rec.duration_ms / 1000)} s`);
      }
    }));
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    try { if (server) fs.writeFileSync(path.join(outDir, 'server.log'), `${server.logText()}\n`); } catch { /* best effort */ }
    await cleanup();
    manifest.finished_at = new Date().toISOString();
    writeManifest();
    if (!o.keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { manifest, manifestPath, outDir };
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`${e.message}\nusage: node scripts/v2-bench-http.js --runtimes claude:haiku,codex,... --tasks all|id,id --out DIR --max-usd 20 [--fake] (spends real quota unless --fake)\n`);
    process.exitCode = 2;
    return;
  }
  const { manifest, manifestPath } = await runBenchHttp({ ...o, log: (l) => process.stderr.write(`${l}\n`) });
  process.stdout.write(`${JSON.stringify({ manifest: manifestPath, ...summarize(manifest) }, null, 1)}\n`);
  process.exitCode = manifest.runs.every((r) => r.outcome_correct) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
