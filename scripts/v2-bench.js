#!/usr/bin/env node
// V2 benchmark suite runner (owner round 2 §6 "dry run"). Generalizes scripts/v2-live-smoke.js: every run is one bench
// task (test/fixtures/v2-bench/tasks.js) x one developer runtime/model, driven through the real goal loop (store,
// worktrees, lease authority, registry, verifier, intake, router) in a disposable repo under the system temp dir, with an
// INDEPENDENT reviewer of a different model. Spends real quota unless --fake.
//
//   node scripts/v2-bench.js --runtimes claude:haiku,claude:sonnet,codex,minimax,opencode --tasks all|id,id \
//     --out DIR --max-usd 20 [--reviewer-map dev=rev,...] [--task-usd N] [--run-timeout-min 20] [--agent-timeout-min 8]
//     [--wait-up-to-sec 0] [--no-confirm-unknown] [--fake [--fake-behaviour solve|noop]] [--keep]
//
// Runtimes: claude:haiku, claude:sonnet, codex (CLI default model, low effort), minimax (CLI default; set MCODE_NODE_DIR
// to a Node 24 bin dir when the default node is 23.x), opencode (opencode/big-pickle), opencode:<provider/model>.
// Default reviewers: claude:* -> codex, codex -> claude:sonnet, minimax and opencode -> claude:haiku. Never the same model.
//
// Spend control. The suite budget_policy { mode:'cap', max_usd } is split into a per-task cap passed to every task (the
// goal loop's own budget gate stops at it). A suite ledger refuses to start a run unless known spend + a conservative
// estimate for runs of unknown cost + the run's full per-task cap fits under max_usd (free models are estimated above $0). Providers that report no USD (codex, minimax, opencode) make the
// goal loop stop for an owner confirmation before the next run of unknown cost: the --max-usd the owner passed is that
// authorization, so the bench confirms such a stop only while the suite ledger (with the estimate) stays under the cap
// (--no-confirm-unknown records it as budget_stop instead). A reached cap is never raised. Unknown stays unknown.
//
// Each run stops at the first state that needs time, quota or the owner (recorded), or at its wall clock. Output: the
// task store (DIR/store) and DIR/manifest.json (schema mycodebox.v2.bench-run/1, consumed by
// `scripts/v2-score.js --tool-score --suite`). No model output is printed or kept in the manifest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BENCH_LEDGER_ACTOR_ID } from '../orchestration/scorecard.js';
import { createTaskStore } from '../orchestration/store.js';
import { createWorktrees } from '../orchestration/worktrees.js';
import { createLeaseAuthority, fileBackend } from '../orchestration/lease-authority.js';
import { createRegistry } from '../orchestration/model-registry.js';
import { createVerifier } from '../orchestration/verifier.js';
import { createGoalLoop } from '../orchestration/goal-loop.js';
import { createIntake } from '../orchestration/intake.js';
import { route as realRoute } from '../orchestration/router.js';
import { createAdapter as fakeAdapter } from '../orchestration/adapters/fake.js';
import { SUITE_ID, SUITE_VERSION, TASKS, policyFor, noopFiles } from '../test/fixtures/v2-bench/tasks.js';
import { EXPECTED_OUTCOMES, NOT_RUN_OUTCOMES } from '../orchestration/scorecard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_SCHEMA = 'mycodebox.v2.bench-run/1';
// Bounded iterations per task: two identical failures force one strategy change, the next stall suspends (no_progress).
export const NO_PROGRESS = Object.freeze({ same_signature: 2, strategy_changes_without_progress: 1 });
const BENCH_ACTOR = { role: 'owner', id: BENCH_LEDGER_ACTOR_ID };
const STOP_STATES = ['accepted', 'failed_unrecoverable', 'cancelled'];

// Runtime profiles (cheapest settings of v2-live-smoke.js). est_usd: conservative per agent-run estimate used when a
// provider reports no USD and nothing was measured yet; run_usd: claude's own --max-budget-usd per CLI run.
const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');
// A "free" model's cost is still unknown (opencode reports 0 for unpriced providers too): never estimate it as $0.
const FREE_EST_USD = 0.02;
export const PROFILES = {
  'claude:haiku': { runtime: 'claude', module: 'claude.js', model: 'claude-haiku-4-5', provider: 'anthropic', tier: 'light', efforts: ['low', 'medium'], effort: null, passModel: true, run_usd: 0.25, est_usd: 0.10 },
  'claude:sonnet': { runtime: 'claude', module: 'claude.js', model: 'claude-sonnet-5-5', provider: 'anthropic', tier: 'standard', efforts: ['low', 'medium', 'high'], effort: null, passModel: true, run_usd: 1.00, est_usd: 0.40 },
  codex: { runtime: 'codex', module: 'codex.js', model: 'default', provider: 'openai', tier: 'standard', efforts: ['low'], effort: 'low', passModel: false, est_usd: 0.30 },
  minimax: { runtime: 'minimax', module: 'minimax.js', model: 'default', provider: 'minimax', tier: 'light', efforts: [], effort: null, passModel: false, est_usd: 0.10 },
  opencode: { runtime: 'opencode', module: 'opencode.js', model: 'opencode/big-pickle', provider: 'opencode', tier: 'standard', efforts: [], effort: null, passModel: true, est_usd: FREE_EST_USD, free: true, pathDirs: [LOCAL_BIN] },
};
export const DEFAULT_REVIEWERS = { 'claude:haiku': 'codex', 'claude:sonnet': 'codex', codex: 'claude:sonnet', minimax: 'claude:haiku', opencode: 'claude:haiku' };

// -> profile for a runtime spec, or throws. `opencode:<provider/model>` selects any opencode model.
export function profileFor(spec, { fake = false } = {}) {
  if (fake) {
    const label = String(spec).replace(/[^\w.-]+/g, '-');
    return { runtime: 'fake', model: label, provider: 'fake', tier: 'standard', efforts: [], effort: null, passModel: true, est_usd: 0.01, fake: true };
  }
  if (PROFILES[spec]) return { ...PROFILES[spec] };
  const m = /^opencode:([\w.-]+\/[\w.:-]+)$/.exec(String(spec));
  if (m) {
    const free = /(?:-free|big-pickle)$/.test(m[1]);
    return { ...PROFILES.opencode, model: m[1], provider: m[1].split('/')[0], free, est_usd: free ? FREE_EST_USD : 0.10 };
  }
  throw new Error(`unknown runtime ${spec} (known: ${Object.keys(PROFILES).join(', ')}, opencode:<provider/model>)`);
}
export const entryOf = (p) => `${p.runtime}:${p.model}`;

// The model behind a profile, whatever runtime or gateway serves it. Names are compared normalised (no provider/
// prefix, lowercase, '.' -> '-', no -YYYYMMDD snapshot suffix), whatever the provider: opencode:openrouter/
// claude-sonnet-5-5 is claude:sonnet. A CLI default ('default') is unknown, so it matches every model of its provider
// family; gateways (opencode, openrouter) take the family from the model name (claude, gpt/codex, minimax).
const GATEWAYS = ['opencode', 'openrouter'];
export const normModel = (m) => String(m).split('/').pop().toLowerCase().replace(/\./g, '-').replace(/-\d{8}$/, '');
function familyOf(p) {
  const prov = String(p.provider).toLowerCase();
  if (!GATEWAYS.includes(prov)) return prov;
  const n = normModel(p.model);
  return /claude/.test(n) ? 'anthropic' : /gpt|codex/.test(n) ? 'openai' : /minimax/.test(n) ? 'minimax' : prov;
}
export function sameModel(a, b) {
  const na = normModel(a.model), nb = normModel(b.model);
  if (na === nb) return true;
  return (na === 'default' || nb === 'default') && familyOf(a) === familyOf(b);
}

// The smallest per-task cap that fits one developer run and one review for every planned pair: a claude run counts
// at its --max-budget-usd (the goal loop estimates it no lower), other runtimes at their estimate.
export function minViableTaskUsd(pairs) {
  const cost = (p) => p.run_usd ?? p.est_usd ?? 0;
  let best = { usd: 0, pair: null };
  for (const x of pairs) {
    const usd = Math.round((cost(x.dev) + cost(x.rev)) * 1e4) / 1e4;
    if (usd > best.usd) best = { usd, pair: `${x.spec} + reviewer ${x.revSpec}` };
  }
  return best;
}

// ---------- suite ledger ----------
// Known spend is measured USD; estimated is the conservative estimate standing in for usage records without USD;
// unknown_runs counts runs with at least one such record. The cap compares known + estimated.
export function createSuiteLedger({ max_usd }) {
  if (!(typeof max_usd === 'number' && Number.isFinite(max_usd) && max_usd > 0)) throw new Error('max_usd must be a positive number');
  const s = { known_usd: 0, estimated_usd: 0, unknown_runs: 0 };
  const round = (x) => Math.round(x * 1e6) / 1e6;
  return {
    max_usd,
    // spend of one finished run: { known_usd, estimated_usd, unknown }
    record(run) {
      s.known_usd = round(s.known_usd + (run.known_usd || 0));
      s.estimated_usd = round(s.estimated_usd + (run.estimated_usd || 0));
      if (run.unknown) s.unknown_runs += 1;
    },
    committed: (extra = 0) => round(s.known_usd + s.estimated_usd + extra),
    // May a run start that reserves `extra` (its full per-task cap), or an in-flight run commit `extra` more? Refused
    // once the committed spend reaches the cap, or when the reservation would pass it.
    allows(extra = 0) {
      const base = round(s.known_usd + s.estimated_usd);
      const c = round(base + extra);
      return base < max_usd && c <= max_usd ? { ok: true, committed: c }
        : { ok: false, committed: c, reason: `suite ledger: known ${s.known_usd} + estimated ${s.estimated_usd} + reserved ${round(extra)} USD passes the cap ${max_usd}` };
    },
    summary: () => ({ ...s }),
  };
}

// ---------- CLI ----------
export const DEFAULTS = Object.freeze({ runtimes: null, tasks: 'all', out: null, max_usd: 20, fake: false, reviewer_map: {}, task_usd: null, run_timeout_min: 20,
  agent_timeout_min: 8, confirm_unknown: true, fake_behaviour: 'solve', keep: false, wait_up_to_sec: 0 });
export function parseArgs(argv) {
  const o = { ...DEFAULTS, reviewer_map: {} };
  const need = (i) => { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runtimes') o.runtimes = need(i).split(',').map((x) => x.trim()).filter(Boolean), i++;
    else if (a === '--tasks') o.tasks = need(i), i++;
    else if (a === '--out') o.out = need(i), i++;
    else if (a === '--max-usd') o.max_usd = Number(need(i)), i++;
    else if (a === '--task-usd') o.task_usd = Number(need(i)), i++;
    else if (a === '--run-timeout-min') o.run_timeout_min = Number(need(i)), i++;
    else if (a === '--agent-timeout-min') o.agent_timeout_min = Number(need(i)), i++;
    else if (a === '--wait-up-to-sec') o.wait_up_to_sec = Number(need(i)), i++;
    else if (a === '--reviewer-map') {
      for (const pair of need(i).split(',').filter(Boolean)) {
        const k = pair.indexOf('=');
        if (k < 1) throw new Error(`--reviewer-map expects dev=reviewer pairs, got ${pair}`);
        o.reviewer_map[pair.slice(0, k)] = pair.slice(k + 1);
      }
      i++;
    } else if (a === '--fake') o.fake = true;
    else if (a === '--fake-behaviour') o.fake_behaviour = need(i), i++;
    else if (a === '--no-confirm-unknown') o.confirm_unknown = false;
    else if (a === '--keep') o.keep = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return validateOptions(o);
}

export function validateOptions(o) {
  if (!o.runtimes?.length) o.runtimes = o.fake ? ['fake-dev'] : null;
  if (!o.runtimes) throw new Error('--runtimes is required (e.g. claude:haiku,codex,opencode)');
  for (const k of ['max_usd', 'run_timeout_min', 'agent_timeout_min']) if (!(o[k] > 0)) throw new Error(`--${k.replace(/_/g, '-')} must be a positive number`);
  if (!(o.wait_up_to_sec >= 0)) throw new Error('--wait-up-to-sec must be 0 or more');
  if (o.task_usd !== null && !(o.task_usd > 0)) throw new Error('--task-usd must be a positive number');
  if (o.task_usd !== null && o.task_usd > o.max_usd) throw new Error('--task-usd cannot exceed --max-usd');
  if (!['solve', 'noop'].includes(o.fake_behaviour)) throw new Error('--fake-behaviour is solve or noop');
  return o;
}

export function selectTasks(sel) {
  if (sel === 'all' || sel == null) return [...TASKS];
  const ids = (Array.isArray(sel) ? sel : String(sel).split(',')).map((x) => x.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !TASKS.some((t) => t.id === id));
  if (unknown.length) throw new Error(`unknown bench task(s): ${unknown.join(', ')}`);
  return ids.map((id) => TASKS.find((t) => t.id === id));
}

// The bench never writes into this checkout or the live state dir. Resolved through the nearest existing ancestor
// so a symlink cannot route around it.
export function refuseOutDir(dir, { root = ROOT, stateDirs = [process.env.GHOSTY_STATE_DIR, path.join(os.homedir(), '.local', 'state', 'ghosty')] } = {}) {
  const real = (p) => { let cur = path.resolve(p); const rest = []; for (;;) { try { return path.join(fs.realpathSync(cur), ...rest); } catch { const up = path.dirname(cur); if (up === cur) return path.resolve(p); rest.unshift(path.basename(cur)); cur = up; } } };
  const inside = (a, b) => { const r = path.relative(real(b), real(a)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (inside(dir, root)) throw new Error(`refusing --out ${dir}: inside the repository`);
  for (const s of stateDirs.filter(Boolean)) if (inside(dir, s)) throw new Error(`refusing --out ${dir}: inside the live state dir`);
}

// -> 'done' | 'awaiting_approval' | 'budget_stop' | 'waiting_no_progress' | 'waiting' | 'failed' | 'cancelled' | 'not_yet_done'
export function classify(status, loop = {}) {
  switch (status) {
    case 'accepted': return 'done';
    case 'awaiting_approval': return loop.approval?.kind === 'budget' ? 'budget_stop' : 'awaiting_approval';
    case 'waiting': return loop.wait?.reason === 'no_progress' ? 'waiting_no_progress' : 'waiting';
    case 'failed_unrecoverable': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'not_yet_done';
  }
}

// ---------- the runner ----------
// opts: parseArgs() output (programmatic callers may also pass fake_overrides: { [bench_task_id]: 'solve'|'noop' },
// fake_usd: number|null for the fake developer's reported USD, log: (line) => void).
export async function runBench(opts) {
  const o = validateOptions({ ...DEFAULTS, ...opts });
  const tasks = selectTasks(o.tasks);
  for (const t of tasks) if (!EXPECTED_OUTCOMES.includes(t.expected_outcome)) throw new Error(`bench task ${t.id}: expected_outcome ${t.expected_outcome} is not one of ${EXPECTED_OUTCOMES.join(', ')}`);
  const devSpecs = o.runtimes;
  const reviewerOf = (spec) => (o.fake ? (o.reviewer_map[spec] ?? 'fake-review') : (o.reviewer_map[spec] ?? DEFAULT_REVIEWERS[spec] ?? (spec.startsWith('opencode:') ? DEFAULT_REVIEWERS.opencode : null)));
  const pairs = devSpecs.map((spec) => {
    const dev = profileFor(spec, o);
    const revSpec = reviewerOf(spec);
    if (!revSpec) throw new Error(`no reviewer for ${spec}: pass --reviewer-map ${spec}=<runtime>`);
    const rev = profileFor(revSpec, o);
    if (entryOf(dev) === entryOf(rev) || sameModel(dev, rev)) {
      throw new Error(`reviewer ${revSpec} is the same model as developer ${spec}: the reviewer must be independent`);
    }
    return { spec, revSpec, dev, rev };
  });
  const planned = tasks.flatMap((t) => pairs.map((p) => ({ task: t, ...p })));
  const ledger = createSuiteLedger({ max_usd: o.max_usd });
  // Floored so that the reservations of every planned run fit inside the suite cap.
  const taskUsd = o.task_usd ?? Math.floor((o.max_usd / Math.max(1, planned.length)) * 1e4) / 1e4;
  if (!(taskUsd > 0)) throw new Error(`per-task budget rounds to ${taskUsd} USD for ${planned.length} runs: raise --max-usd or pass --task-usd`);
  // A default share below one developer run plus one review would only produce budget_stop: refuse it at setup.
  const viable = minViableTaskUsd(pairs);
  if (o.task_usd == null && taskUsd < viable.usd) {
    throw new Error(`default per-task budget ${taskUsd} USD (--max-usd ${o.max_usd} / ${planned.length} runs) is below the minimum viable ${viable.usd} USD `
      + `(${viable.pair}: one developer run + one review): pass --task-usd ${viable.usd} or more (later runs are skipped once the suite cap is reached), `
      + 'raise --max-usd, or run fewer tasks/runtimes');
  }
  const log = o.log || (() => {});

  const outDir = path.resolve(o.out || fs.mkdtempSync(path.join(os.tmpdir(), 'v2-bench-out-')));
  refuseOutDir(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-bench-')));
  if (!path.relative(ROOT, tmp).startsWith('..')) throw new Error('refusing to run inside the repository');
  const manifest = { schema: MANIFEST_SCHEMA, suite_id: SUITE_ID, suite_version: SUITE_VERSION, started_at: new Date().toISOString(), finished_at: null,
    mode: o.fake ? 'fake' : 'real', store_dir: 'store', runs: [], budget_policy: { mode: 'cap', max_usd: o.max_usd, per_task_usd: taskUsd },
    spend: { known_usd: 0, estimated_usd: 0, unknown_runs: 0 }, runtimes: {}, no_progress_policy: NO_PROGRESS };
  const manifestPath = path.join(outDir, 'manifest.json');
  const writeManifest = () => {
    manifest.spend = ledger.summary();
    manifest.cap_note = manifest.spend.unknown_runs
      ? `cap enforced on estimates for ${manifest.spend.unknown_runs} unknown-cost run(s): estimated_usd ${manifest.spend.estimated_usd} is not measured spend (known_usd ${manifest.spend.known_usd})`
      : 'cap enforced on measured spend only';
    const t = `${manifestPath}.${process.pid}.tmp`;
    fs.writeFileSync(t, `${JSON.stringify(manifest, null, 1)}\n`);
    fs.renameSync(t, manifestPath);
  };

  // Everything after the temp dir exists runs under the finally below: a failed setup still cleans up.
  try {
    const env = { PATH: process.env.PATH, HOME: os.homedir(), LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    const sh = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const git = (a, { cwd } = {}) => Promise.resolve().then(() => execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));
    const wtRoot = path.join(tmp, 'wt');
    const reviewRoot = path.join(tmp, 'review');
    for (const d of [wtRoot, reviewRoot, path.join(tmp, 'vtmp'), path.join(tmp, 'repos')]) fs.mkdirSync(d, { recursive: true });

    // One disposable repo per run: no run can see another's commits.
    function makeRepo(task, i) {
      const repo = path.join(tmp, 'repos', `${String(i).padStart(3, '0')}-${task.id}`);
      fs.mkdirSync(path.join(repo, '.ai'), { recursive: true });
      sh(repo, 'init', '-q', '-b', 'main');
      sh(repo, 'config', 'user.name', 'Bench User'); sh(repo, 'config', 'user.email', 'bench@example.invalid');
      for (const [f, c] of Object.entries(task.files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c); }
      fs.writeFileSync(path.join(repo, '.ai', 'project.json'), `${JSON.stringify(policyFor(task), null, 1)}\n`);
      sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', `bench fixture ${task.id}`);
      return { repo, main: sh(repo, 'rev-parse', 'main') };
    }
    const runs = planned.map((p, i) => ({ ...p, ...makeRepo(p.task, i) }));

    // ---------- registry, adapters, routing ----------
    const byTask = new Map();   // task_id -> { dev, rev, bench_task, run }
    const profiles = new Map();
    for (const p of pairs) { profiles.set(entryOf(p.dev), p.dev); profiles.set(entryOf(p.rev), p.rev); }
    const registry = createRegistry({ version: 1, as_of: '2026-10-11', models: [...profiles.values()].map((p) => ({ runtime: p.runtime, provider: p.provider, model: p.model,
      tier: p.tier, capabilities: ['text', 'code', 'tools'], efforts: p.efforts, context_tokens: 200000, latency_ms: 10000, ...(p.fake ? { test_only: true } : {}) })) });
    const allIds = [...profiles.keys()];

    const fakeUsd = Object.hasOwn(o, 'fake_usd') ? o.fake_usd : 0.01;
    function fakeScript(binding, role) {
      if (role === 'reviewer') return [{ op: 'usage', input_tokens: 500, output_tokens: 50, usd: fakeUsd == null ? null : fakeUsd / 2 }, { op: 'emit', event: { type: 'result', text: JSON.stringify({ verdict: 'approve', findings: [] }) } }];
      const behaviour = o.fake_overrides?.[binding.bench_task.id] ?? o.fake_behaviour;
      const files = behaviour === 'noop' ? noopFiles(binding.bench_task) : binding.bench_task.fake.solve;
      return [...Object.entries(files).map(([p, content]) => ({ op: 'write', path: p, content })), { op: 'usage', input_tokens: 1000, output_tokens: 200, usd: fakeUsd }];
    }

    const realAdapters = new Map();
    async function adapterFor(p) {
      const id = entryOf(p);
      if (realAdapters.has(id)) return realAdapters.get(id);
      let a;
      if (p.fake) a = fakeAdapter({ allowedRoots: [wtRoot, reviewRoot] });
      else {
        const { createAdapter } = await import(`../orchestration/adapters/${p.module}`);
        const childEnv = p.pathDirs ? { ...process.env, PATH: [...p.pathDirs, process.env.PATH].filter(Boolean).join(path.delimiter) } : process.env;
        const extraArgs = p.run_usd ? ['--max-budget-usd', String(Math.min(p.run_usd, taskUsd))] : [];
        a = createAdapter({ allowedRoots: [wtRoot, reviewRoot], extraArgs, killGraceMs: 2000, env: childEnv });
      }
      let probe;
      try { probe = await a.probeCapabilities(); } catch { probe = { available: 'unknown', version: null }; }
      manifest.runtimes[id] = { available: probe.available, version: probe.version ?? null };
      // Role guard: a task's developer entry never reviews it, its reviewer entry never develops it.
      const wrapped = { ...a, probe, start(x) {
        const b = byTask.get(x.task_id);
        if (!b) throw Object.assign(new Error(`bench: unknown task ${x.task_id}`), { code: 'E_INVALID' });
        const want = x.role === 'reviewer' ? entryOf(b.rev) : entryOf(b.dev);
        if (want !== id) throw Object.assign(new Error(`bench: ${id} may not run the ${x.role} role for this task`), { code: 'E_INVALID' });
        const model = p.passModel ? x.model : undefined;
        if (p.fake) return a.start({ ...x, model, effort: undefined, script: fakeScript(b, x.role) });
        return a.start({ ...x, model, effort: p.effort ?? undefined });
      } };
      realAdapters.set(id, wrapped);
      return wrapped;
    }
    const adapters = {};
    for (const p of profiles.values()) adapters[entryOf(p)] = await adapterFor(p);

    // The developer route sees only the run's developer entry; a route that excludes it (independent evaluation) sees
    // only the run's reviewer. With strategy_changes_without_progress=1 the loop never switches the developer model.
    const route = (task, ro = {}) => {
      const b = byTask.get(task.task_id);
      const ex = ro.exclude || [];
      const allowedId = b && ex.includes(entryOf(b.dev)) ? entryOf(b.rev) : b ? entryOf(b.dev) : null;
      return realRoute(task, { ...ro, exclude: [...new Set([...ex, ...allIds.filter((x) => x !== allowedId)])] });
    };
    // Measured performance first (mean known USD of this entry so far in the suite), else the profile's estimate.
    const measured = new Map();
    // A claude run may spend up to its --max-budget-usd: never estimate below that bound, or it could pass the cap.
    const estUsd = (id) => {
      const xs = measured.get(id) || [];
      const est = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : (profiles.get(id)?.est_usd ?? null);
      const p = profiles.get(id);
      return p?.run_usd ? Math.max(est ?? 0, Math.min(p.run_usd, taskUsd)) : est;
    };
    const estimateRun = ({ entry }) => ({ usd: estUsd(entry), input_tokens: null, output_tokens: null, duration_ms: null, turns: 1 });

    const storeDir = path.join(outDir, 'store');
    const store = createTaskStore({ dir: storeDir });
    const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(storeDir, 'leases') }) });
    const loop = createGoalLoop({ store, registry, adapters, worktrees: createWorktrees({ root: wtRoot, repoAllowlist: runs.map((r) => r.repo), leases, git }),
      worktreeRoot: wtRoot, verifier: createVerifier({ tmpRoot: path.join(tmp, 'vtmp'), timeoutMs: 60_000 }), reviewRoot, leases, git, allowFake: !!o.fake, route,
      estimateRun, runTimeoutMs: Math.round(o.agent_timeout_min * 60_000) });
    const intake = createIntake({ store });

    // Spend of one task from its usage records: known USD, and an estimate for every record without USD.
    function spendOf(v) {
      let known = 0, estimated = 0, unknown = 0, allKnown = v.usage.length > 0;
      for (const u of v.usage) {
        const id = `${u.runtime}:${u.model}`;
        if (typeof u.usd === 'number' && Number.isFinite(u.usd) && u.incomplete !== true) known += u.usd;
        else { unknown += 1; allKnown = false; estimated += profiles.get(id)?.est_usd ?? 0; }
      }
      return { known_usd: known, estimated_usd: estimated, unknown: unknown > 0, unknown_records: unknown, usd: v.usage.length === 0 ? 0 : allKnown ? known : null };
    }

    for (const r of runs) {
      const t0 = Date.now();
      const rec = { task_id: null, bench_task_id: r.task.id, task_class: r.task.task_class, expected_outcome: r.task.expected_outcome,
        runtime: r.dev.runtime, model: r.dev.model, reviewer_runtime: r.rev.runtime, reviewer_model: r.rev.model, runtime_spec: r.spec, reviewer_spec: r.revSpec,
        final_state: null, outcome: null, outcome_correct: false, usd: null, duration_ms: null, error: null,
        wait_reason: null, developer_runs: 0, reviewer_runs: 0, checks: [], usd_known: 0, usd_estimated: 0, unknown_cost_records: 0, budget_confirmations: 0,
        main_unchanged: null, never_done_ok: null, stop_note: null };
      const gateL = ledger.allows(taskUsd);   // reserve the run's full per-task cap before it starts
      const devAvail = manifest.runtimes[entryOf(r.dev)]?.available;
      const revAvail = manifest.runtimes[entryOf(r.rev)]?.available;
      if (!gateL.ok) {
        rec.outcome = 'skipped_budget'; rec.error = gateL.reason; rec.usd = 0; rec.duration_ms = 0;
      } else if (devAvail === false || revAvail === false) {
        rec.outcome = 'not_started'; rec.error = `runtime unavailable (probe): ${devAvail === false ? r.spec : r.revSpec}`; rec.usd = 0; rec.duration_ms = 0;
      } else {
        log(`run ${r.task.id} x ${r.spec} (reviewer ${r.revSpec})`);
        let timedOut = false;
        try {
          const { task } = await intake.createTask({ project_id: `bench-${r.task.id}`, title: `bench ${r.task.id}`, repository: r.repo, risk_class: 'low', runtime_capabilities: ['code'],
            goal: r.task.goal, budget_policy: { mode: 'cap', max_usd: taskUsd }, no_progress_policy: { ...NO_PROGRESS },
            acceptance_checks: r.task.checks.map((c) => ({ id: c.id, command: c.command, expect: { exit: 0 }, evidence_type: 'exit_code', required: true })) },
          { source: 'api', actor_id: 'v2-bench' });
          rec.task_id = task.task_id;
          byTask.set(task.task_id, { dev: r.dev, rev: r.rev, bench_task: r.task });
          const deadline = t0 + o.run_timeout_min * 60_000;
          for (;;) {
            if (Date.now() > deadline) { timedOut = true; break; }
            const s = await loop.step(task.task_id);
            if (s.terminal) break;
            const ins = await loop.inspect(task.task_id);
            const st = ins.task.status;
            if (STOP_STATES.includes(st)) break;
            if (st === 'awaiting_approval') {
              const req = ins.loop.approval;
              // Only a stop that exists because a cost is unknown, never a reached cap or any other owner question.
              if (o.confirm_unknown && req?.kind === 'budget' && req.cap_reached === false) {
                const sp = spendOf(ins.task);
                const ok = ledger.allows(sp.known_usd + sp.estimated_usd + (estUsd(req.entry) ?? 0));
                if (ok.ok) { await loop.approve(task.task_id, { actor: BENCH_ACTOR, approval_ref: `suite-ledger ${ok.committed}/${o.max_usd}` }); rec.budget_confirmations += 1; continue; }
                rec.error = ok.reason;
              }
              break;
            }
            if (st === 'waiting') {
              const w = ins.loop.wait;
              // A timed wait no longer than --wait-up-to-sec (default: only zero-length waits such as a reviewer change)
              // elapses inside the run's wall clock; anything longer, or one that needs the owner, is recorded.
              const left = w?.until_ms != null ? w.until_ms - Date.now() : null;
              if (left != null && left <= Math.max(2000, o.wait_up_to_sec * 1000) && Date.now() + left < deadline) { await new Promise((res) => setTimeout(res, Math.max(0, w.until_ms - Date.now()))); continue; }
              break;
            }
            if (!s.transitioned && !s.again) break;
          }
          if (timedOut) await loop.cancel(task.task_id, { actor: BENCH_ACTOR, reason: `bench wall clock ${o.run_timeout_min} min` }).catch(() => null);
          const ins = await loop.inspect(task.task_id);
          const v = ins.task;
          rec.final_state = v.status;
          rec.outcome = timedOut ? 'timeout' : classify(v.status, ins.loop);
          rec.wait_reason = v.status === 'waiting' ? ins.loop.wait?.reason ?? null : v.status === 'awaiting_approval' ? ins.loop.approval?.kind ?? null : null;
          // Why the run stopped short of done, in the controller's words (decision rationale; never model output).
          if (v.status !== 'accepted' && ins.loop.approval?.kind !== 'agent_action' || v.status === 'waiting') rec.stop_note = String(v.decisions.filter((d) => d.loop).at(-1)?.rationale ?? '').slice(0, 240) || null;
          const evs = await store.events(task.task_id);
          const started = evs.filter((e) => e.kind === 'task.started');
          rec.developer_runs = started.filter((e) => e.payload.role === 'developer').length;
          rec.reviewer_runs = started.filter((e) => e.payload.role === 'reviewer').length;
          rec.checks = v.evidence.map((e) => ({ check_id: e.check_id, exit: e.exit }));
          const failedRuns = evs.filter((e) => e.kind === 'tool.failed').map((e) => e.payload.error?.class ?? 'unknown');
          if (failedRuns.length && !rec.error) rec.error = `run error class(es): ${[...new Set(failedRuns)].join(', ')}`;
          const sp = spendOf(v);
          Object.assign(rec, { usd: sp.usd, usd_known: Math.round(sp.known_usd * 1e6) / 1e6, usd_estimated: Math.round(sp.estimated_usd * 1e6) / 1e6, unknown_cost_records: sp.unknown_records });
          ledger.record(sp);
          for (const u of v.usage) if (typeof u.usd === 'number' && u.incomplete !== true) { const id = `${u.runtime}:${u.model}`; measured.set(id, [...(measured.get(id) || []), u.usd]); }
        } catch (e) {
          rec.outcome = timedOut ? 'timeout' : 'error';
          rec.error = String(e?.code || e?.message || e).slice(0, 200);
          if (rec.task_id) {
            try { const v = await store.get(rec.task_id); rec.final_state = v?.status ?? null; const sp = spendOf(v); rec.usd = sp.usd; ledger.record(sp); } catch { /* recorded as error */ }
          }
        }
      }
      // Invariants: the fixture's main branch never moves; a task that must not be done is never done.
      try { rec.main_unchanged = sh(r.repo, 'rev-parse', 'main') === r.main; } catch { rec.main_unchanged = null; }
      // No task was created (refused or failed before intake): the run did not start, whatever stopped it.
      if (rec.task_id == null && !NOT_RUN_OUTCOMES.includes(rec.outcome)) rec.outcome = 'not_started';
      rec.never_done_ok = r.task.expected_outcome === 'done' ? null : rec.outcome !== 'done';
      rec.outcome_correct = rec.outcome === rec.expected_outcome;
      rec.duration_ms ??= Date.now() - t0;
      manifest.runs.push(rec);
      writeManifest();
      log(`  -> ${rec.outcome} (${rec.final_state}) usd ${rec.usd ?? 'unknown'} in ${Math.round(rec.duration_ms / 1000)} s`);
    }
  } finally {
    manifest.finished_at = new Date().toISOString();
    writeManifest();
    if (!o.keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { manifest, manifestPath, outDir };
}

// Short, output-free summary for the terminal.
export function summarize(manifest) {
  const runs = manifest.runs;
  const by = (k) => runs.reduce((m, r) => ({ ...m, [r[k]]: (m[r[k]] || 0) + 1 }), {});
  return { suite_id: manifest.suite_id, suite_version: manifest.suite_version, mode: manifest.mode, runs: runs.length, correct: runs.filter((r) => r.outcome_correct).length,
    outcomes: by('outcome'), spend: manifest.spend, cap_note: manifest.cap_note, budget_policy: manifest.budget_policy,
    table: runs.map((r) => `${r.bench_task_id} | ${r.runtime}:${r.model} <- ${r.reviewer_runtime}:${r.reviewer_model} | ${r.outcome}${r.outcome_correct ? '' : ` (expected ${r.expected_outcome})`} | usd ${r.usd ?? 'unknown'} | ${Math.round(r.duration_ms / 1000)} s`) };
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`${e.message}\nusage: node scripts/v2-bench.js --runtimes claude:haiku,codex,... --tasks all|id,id --out DIR --max-usd 20 [--fake] (spends real quota unless --fake)\n`);
    process.exitCode = 2;
    return;
  }
  const { manifest, manifestPath } = await runBench({ ...o, log: (l) => process.stderr.write(`${l}\n`) });
  process.stdout.write(`${JSON.stringify({ manifest: manifestPath, ...summarize(manifest) }, null, 1)}\n`);
  process.exitCode = manifest.runs.every((r) => r.outcome_correct) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
