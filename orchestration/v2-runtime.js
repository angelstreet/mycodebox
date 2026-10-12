// V2 engine wiring for server.js (OWNER_DECISIONS §11.1; D-016, D-017, D-020, D-021). server.js imports this module
// only when GHOSTY_V2=1 and does nothing else with V2: it forwards /api/v2/* to `http.handle`, calls start() once and
// awaits stop() on SIGINT/SIGTERM.
//
// One process, ONE store handle, shared by the HTTP routes and the goal loop. start() takes the controller lease
// (service:<host>:goal-loop), runs loop.recover() under it, then starts a scheduler that steps open tasks. Another live
// controller holds the lease -> no loop here: every write route (create, approve, deny, cancel, ops request) answers
// 503 E_NO_CONTROLLER and nothing is written (never two writers). Reads always work.
//
// Execution (D-021): only repositories on GHOSTY_V2_REPOS that carry a valid .ai/project.json; worktrees under
// GHOSTY_V2_WORK_ROOT (required, outside this checkout, the state dir and every allowlisted repo). Adapters are the real
// runtimes (launch modes unchanged: no bypass flags); the scripted fake adapter exists only behind the test-only
// GHOSTY_V2_TEST_FAKE_ADAPTER, and then it is the ONLY runtime (no real CLI can be reached from a test).
import fs from 'node:fs';
import path from 'node:path';
import { ContractError, TERMINAL } from './task-contract.js';
import { createTaskStore } from './store.js';
import { createIntake, isInformational } from './intake.js';
import { createV2Http } from './http.js';
import { loadPolicy } from './policy.js';
import { normalizeBudgetPolicy } from './budget.js';

export const MAX_CONCURRENCY = 8;
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ACTION_RE = /^[a-z][a-z0-9_.-]{0,99}$/;
const HOST_ID = 'local';
const within = (root, p) => { const r = path.relative(root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const list = (v) => String(v || '').split(path.delimiter).map((s) => s.trim()).filter(Boolean);
const noController = (why) => new ContractError('E_NO_CONTROLLER', `no goal loop runs in this process (${why}): nothing was written`);

// -> { errors[] (the loop must not start), warnings[], workRoot, repos[], ... }. Pure apart from mkdir/realpath/reads.
export function v2Config(env, { stateDir, repoRoot }) {
  const errors = [], warnings = [];
  const state = real(stateDir) || path.resolve(stateDir);
  const checkout = real(repoRoot) || path.resolve(repoRoot);
  let workRoot = null;
  const wr = env.GHOSTY_V2_WORK_ROOT;
  if (!wr) errors.push('GHOSTY_V2_WORK_ROOT is not set');
  else if (!path.isAbsolute(wr)) errors.push('GHOSTY_V2_WORK_ROOT must be an absolute path');
  else {
    try { fs.mkdirSync(wr, { recursive: true, mode: 0o700 }); workRoot = fs.realpathSync(wr); } catch (e) { errors.push(`GHOSTY_V2_WORK_ROOT unusable: ${e.code || e.message}`); }
    if (workRoot) {
      for (const [name, dir] of [['the mycodebox checkout', checkout], ['the state dir', state]]) {
        if (within(dir, workRoot) || within(workRoot, dir)) { errors.push(`GHOSTY_V2_WORK_ROOT must not overlap ${name}`); workRoot = null; break; }
      }
    }
  }
  const repos = [];
  for (const r of list(env.GHOSTY_V2_REPOS)) {
    const rp = path.isAbsolute(r) ? real(r) : null;
    if (!rp) { warnings.push(`GHOSTY_V2_REPOS: ${r} is not an existing absolute path: ignored`); continue; }
    if (!fs.existsSync(path.join(rp, '.git'))) { warnings.push(`GHOSTY_V2_REPOS: ${r} is not a git repository: ignored`); continue; }
    if (within(state, rp) || within(rp, state) || (workRoot && (within(workRoot, rp) || within(rp, workRoot)))) { warnings.push(`GHOSTY_V2_REPOS: ${r} overlaps the state dir or the work root: ignored`); continue; }
    const pol = loadPolicy(rp);
    // Kept on the list either way: the loop re-reads the policy before every run (T01: invalid -> owner clarification).
    if (!pol.ok) warnings.push(`GHOSTY_V2_REPOS: ${r} has no valid .ai/project.json (${pol.code}): its tasks wait for an owner clarification`);
    if (!repos.includes(rp)) repos.push(rp);
  }
  if (!repos.length) warnings.push('GHOSTY_V2_REPOS lists no usable repository: every task creation is refused');
  const conc = env.GHOSTY_V2_CONCURRENCY == null || env.GHOSTY_V2_CONCURRENCY === '' ? 1 : Number(env.GHOSTY_V2_CONCURRENCY);
  const concurrency = Number.isInteger(conc) && conc >= 1 && conc <= MAX_CONCURRENCY ? conc : (warnings.push(`GHOSTY_V2_CONCURRENCY must be 1..${MAX_CONCURRENCY}: using 1`), 1);
  const pathDirs = list(env.GHOSTY_V2_PATH_DIRS).filter((d) => path.isAbsolute(d) || (warnings.push(`GHOSTY_V2_PATH_DIRS: ${d} is not absolute: ignored`), false));
  const usd = env.GHOSTY_V2_CLAUDE_RUN_USD == null || env.GHOSTY_V2_CLAUDE_RUN_USD === '' ? 1 : Number(env.GHOSTY_V2_CLAUDE_RUN_USD);
  const claudeRunUsd = Number.isFinite(usd) && usd > 0 && usd <= 100 ? usd : (warnings.push('GHOSTY_V2_CLAUDE_RUN_USD must be in (0, 100]: using 1'), 1);
  let pushRemote = null;
  if (env.GHOSTY_V2_PUSH_REMOTE) {
    if (REMOTE_RE.test(env.GHOSTY_V2_PUSH_REMOTE)) pushRemote = env.GHOSTY_V2_PUSH_REMOTE;
    else warnings.push('GHOSTY_V2_PUSH_REMOTE is not a plain remote name: task branches are not pushed');
  }
  const registryFile = env.GHOSTY_V2_REGISTRY || null;
  if (registryFile && !path.isAbsolute(registryFile)) errors.push('GHOSTY_V2_REGISTRY must be an absolute path');
  let fakeScripts = null;
  if (env.GHOSTY_V2_TEST_FAKE_ADAPTER) {
    try { fakeScripts = JSON.parse(fs.readFileSync(env.GHOSTY_V2_TEST_FAKE_ADAPTER, 'utf8')); } catch (e) { errors.push(`GHOSTY_V2_TEST_FAKE_ADAPTER unreadable: ${e.code || e.message}`); }
  }
  return { errors, warnings, workRoot, repos, concurrency, pathDirs, claudeRunUsd, pushRemote, registryFile, fakeScripts };
}

// Steps open tasks with at most `concurrency` steps in flight, round robin (one step, then the task goes to the back).
// No busy polling: a task is stepped when woken (create, owner answer, start), when its timed wait is due, or by a
// slow safety tick that rescans open tasks (an idle step writes nothing).
export function createScheduler({ step, listOpen, concurrency = 1, safetyMs = 60_000, now = Date.now, log = () => {}, beforeStep = async () => {} }) {
  const queue = new Set(), running = new Map(), due = new Map();
  let stopped = true, timer = null, tick = null, scanning = null;
  function armTimer() {
    clearTimeout(timer); timer = null;
    if (stopped || !due.size) return;
    const next = Math.min(...due.values());
    timer = setTimeout(() => {
      const t = now();
      for (const [id, at] of due) if (at <= t) { due.delete(id); queue.add(id); }
      armTimer(); pump();
    }, Math.min(Math.max(0, next - now()) + 5, 2 ** 31 - 1));
    timer.unref?.();
  }
  function scan() {
    if (stopped) return Promise.resolve();
    scanning ??= (async () => {
      try { for (const id of await listOpen()) queue.add(id); } catch (e) { log(`[v2] scheduler scan failed: ${e?.code || e?.message}`); }
      finally { scanning = null; }
      pump();
    })();
    return scanning;
  }
  function pump() {
    if (stopped) return;
    for (const id of queue) {
      if (running.size >= concurrency) break;
      if (running.has(id)) continue;
      queue.delete(id);
      running.set(id, drive(id).finally(() => { running.delete(id); pump(); }));
    }
  }
  async function drive(id) {
    let r;
    try { await beforeStep(id); r = await step(id); } catch (e) { log(`[v2] step ${id} failed: ${e?.code || 'error'}: ${String(e?.message).slice(0, 300)}`); return; }   // retried by the safety tick
    if (stopped || !r) return;
    if (r.controller) { log(`[v2] step ${id}: ${r.note || r.controller}`); return; }
    if (r.terminal) return;
    if (r.transitioned || r.again) { queue.delete(id); queue.add(id); return; }
    if (r.until_ms != null) { due.set(id, r.until_ms); armTimer(); }
  }
  return {
    start() { stopped = false; tick = setInterval(scan, safetyMs); tick.unref?.(); return scan(); },
    wake(id) { if (stopped) return; if (id) { queue.add(id); pump(); } else scan(); },
    async stop(timeoutMs = 5000) {
      stopped = true;
      clearTimeout(timer); clearInterval(tick); queue.clear(); due.clear();
      let to;
      const drained = await Promise.race([Promise.allSettled([...running.values()]).then(() => true), new Promise((r) => { to = setTimeout(() => r(false), timeoutMs); })]);
      clearTimeout(to);
      return { drained, in_flight: running.size };
    },
    status: () => ({ running: [...running.keys()], queued: [...queue], timed: due.size }),
  };
}

// Known USD left under a task's max_usd cap (spend without USD counts as 0 here: the budget gate stops on unknown
// spend itself; this only bounds a claude run). null = no cap.
export function capLeft(task) {
  const bp = normalizeBudgetPolicy(task?.budget_policy);
  if (typeof bp?.max_usd !== 'number') return null;
  const spent = (task.usage || []).reduce((a, u) => a + (typeof u.usd === 'number' && Number.isFinite(u.usd) ? u.usd : 0), 0);
  return Math.max(0, bp.max_usd - spent);
}

// Developer pins (D-021): a task's preferred_models ("runtime:model" ids) narrow the DEVELOPER route to those entries,
// and those entries never review it. Only ever adds exclusions: allowlists, floors and probes still apply.
export function pinnedRoute(realRoute) {
  return (task, ro = {}) => {
    const pins = Array.isArray(task?.preferred_models) ? task.preferred_models.filter((s) => typeof s === 'string' && s) : [];
    if (!pins.length) return realRoute(task, ro);
    const ids = typeof ro.registry?.entries === 'function' ? ro.registry.entries().map((e) => e.id) : [];
    const extra = (ro.role ?? 'developer') === 'developer' ? ids.filter((id) => !pins.includes(id)) : pins;
    return realRoute(task, { ...ro, exclude: [...new Set([...(ro.exclude || []), ...extra])] });
  };
}

const RUNTIMES = { claude: 'claude.js', codex: 'codex.js', minimax: 'minimax.js', opencode: 'opencode.js' };
// The registry's codex/minimax names are not CLI model ids: those CLIs run their configured default model.
const passModel = (runtime, model) => !!model && (runtime === 'claude' || (runtime === 'opencode' && model.includes('/')));

export async function createV2Runtime({ stateDir, env = process.env, repoRoot, log = (m) => console.log(m), safetyMs = 60_000, retryMs = 15_000 } = {}) {
  if (!stateDir || !repoRoot) throw new Error('v2 runtime: stateDir and repoRoot required');
  const v2dir = path.join(stateDir, 'v2');
  const store = createTaskStore({ dir: v2dir });   // the one store handle of this process (D-017)
  const cfg = v2Config(env, { stateDir, repoRoot });
  const info = new Map();   // task_id -> { goal, capLeft }, refreshed before each step (adapter start() is synchronous)
  const activeRuns = new Set();
  let state = cfg.errors.length ? 'refused' : 'idle';
  let reason = cfg.errors.join('; ') || null;
  let startP = Promise.resolve();
  let stopP = null;
  let engine = null;
  const runtimes = {};

  if (!cfg.errors.length) engine = await buildEngine();

  async function buildEngine() {
    const [{ createGoalLoop }, { createWorktrees }, { createLeaseAuthority, fileBackend }, reg, { createVerifier }, { route: realRoute },
      { createGitRunner }, { createServerIntegrate }, { createIncidentStore }, { createTelemetry, readingsFromHealth }, { createSystemOps, createAdmissionController }] = await Promise.all([
      import('./goal-loop.js'), import('./worktrees.js'), import('./lease-authority.js'), import('./model-registry.js'), import('./verifier.js'), import('./router.js'),
      import('./integration-controller.js'), import('./v2-integrate.js'), import('./incidents.js'), import('./telemetry.js'), import('./system-ops.js')]);
    const wtRoot = path.join(cfg.workRoot, 'wt'), reviewRoot = path.join(cfg.workRoot, 'review');
    for (const d of [wtRoot, reviewRoot, path.join(cfg.workRoot, 'vtmp')]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const roots = [fs.realpathSync(wtRoot), fs.realpathSync(reviewRoot)];
    const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(v2dir, 'leases') }) });
    const track = (adapter, run) => {
      const rec = { adapter, run };
      activeRuns.add(rec);
      Promise.resolve(run?.done).finally(() => activeRuns.delete(rec));
      return run;
    };
    const adapters = {};
    let registry, allowFake = false;
    if (cfg.fakeScripts) {
      // TEST ONLY: the scripted fake is the only runtime; two fake entries so the reviewer is a different model.
      log('[v2] TEST-ONLY fake adapter (GHOSTY_V2_TEST_FAKE_ADAPTER): no real runtime is wired');
      const { createAdapter } = await import('./adapters/fake.js');
      const fake = createAdapter({ allowedRoots: roots });
      // Script by goal marker [fake:<name>]; `developer_runs` picks one per developer run number (from the run id,
      // so it survives a restart), the last one repeating.
      const scriptOf = (o) => {
        const goal = info.get(o.task_id)?.goal || '';
        const name = /\[fake:([\w.-]+)\]/.exec(goal)?.[1] || 'default';
        const sc = cfg.fakeScripts[name] || cfg.fakeScripts.default || {};
        if (o.role === 'reviewer') return sc.reviewer || [{ op: 'emit', event: { type: 'result', text: JSON.stringify({ verdict: 'approve', findings: [] }) } }];
        if (Array.isArray(sc.developer_runs) && sc.developer_runs.length) {
          const k = Number(/\.run(\d+)$/.exec(String(o.run_id))?.[1] || 1);
          return sc.developer_runs[Math.min(Math.max(k, 1), sc.developer_runs.length) - 1];
        }
        return sc.developer || [];
      };
      adapters.fake = { ...fake, start: (o) => track(fake, fake.start({ ...o, effort: undefined, script: scriptOf(o) })),
        probeCapabilities: async () => ({ ...(await fake.probeCapabilities()), models: ['fake-dev', 'fake-review'] }) };
      const fe = { provider: 'fake', tier: 'standard', capabilities: ['text', 'code', 'tools', 'json_output'], efforts: [], context_tokens: 100000, latency_ms: 1, test_only: true };
      registry = reg.createRegistry({ version: 1, as_of: '2026-10-12', models: [{ runtime: 'fake', model: 'fake-dev', ...fe }, { runtime: 'fake', model: 'fake-review', ...fe }] });
      allowFake = true;
    } else {
      registry = reg.loadRegistry(cfg.registryFile ? { file: cfg.registryFile } : {});
      const childEnv = cfg.pathDirs.length ? { ...env, PATH: [...cfg.pathDirs, env.PATH].filter(Boolean).join(path.delimiter) } : env;
      for (const [rt, file] of Object.entries(RUNTIMES)) {
        const { createAdapter } = await import(`./adapters/${file}`);
        const base = { allowedRoots: roots, env: childEnv, killGraceMs: 2000, probeTimeoutMs: 15000 };
        const plain = createAdapter(base);
        const start = (o) => {
          const x = { ...o, model: passModel(rt, o.model) ? o.model : undefined };
          let a = plain;
          if (rt === 'claude') {
            // Per-run spend bound: the task's remaining cap, at most GHOSTY_V2_CLAUDE_RUN_USD.
            const left = info.get(o.task_id)?.capLeft;
            const usd = Math.max(0.01, Math.min(cfg.claudeRunUsd, left ?? Infinity));
            a = createAdapter({ ...base, extraArgs: ['--max-budget-usd', usd.toFixed(2)] });
          }
          try { return track(a, a.start(x)); } catch (e) {
            if (x.effort != null && e?.code === 'E_UNSUPPORTED') return track(a, a.start({ ...x, effort: undefined }));
            throw e;
          }
        };
        adapters[rt] = { ...plain, start };
      }
    }
    const incidents = createIncidentStore({ dir: path.join(v2dir, 'incidents') });
    const { sampleHealth } = await import('../health.js');
    const telemetry = createTelemetry({ probe: async () => readingsFromHealth(await sampleHealth()) });
    // Only the request-only handle leaves this function: no executor is configured and the controller is not kept.
    const { requester } = createSystemOps({ incidents, leases, telemetry, actions: {}, admission: createAdmissionController({}),
      deploys: { status: async () => ({ state: 'unknown' }) } });
    const git = createGitRunner({ env: { PATH: env.PATH, HOME: env.HOME, LANG: 'C', GIT_TERMINAL_PROMPT: '0' } });
    const loop = createGoalLoop({ store, registry, adapters, worktrees: createWorktrees({ root: wtRoot, repoAllowlist: cfg.repos, leases }),
      worktreeRoot: roots[0], reviewRoot: roots[1], verifier: createVerifier({ tmpRoot: path.join(cfg.workRoot, 'vtmp'), artifactRoot: path.join(cfg.workRoot, 'artifacts') }),
      leases, route: pinnedRoute(realRoute), allowFake, hostId: HOST_ID, integrate: createServerIntegrate({ git, pushRemote: cfg.pushRemote }),
      opsRequester: requester, incidents });
    const listOpen = async () => (await store.list()).filter((t) => !TERMINAL.includes(t.status) && !t.store_error && !isInformational(t)).map((t) => t.task_id);
    const beforeStep = async (id) => { const t = await store.get(id); if (t) info.set(id, { goal: t.goal, capLeft: capLeft(t) }); };
    const scheduler = createScheduler({ step: (id) => loop.step(id), listOpen, beforeStep, concurrency: cfg.concurrency, safetyMs, log });
    return { loop, scheduler, adapters, incidents, telemetry, requester };
  }

  // Writes are allowed only while this process is the controller (D-016/D-020): otherwise refused, not written.
  async function controller() {
    await startP;
    if (state !== 'running') throw noController(reason || state);
    return engine.loop;
  }
  const wake = (id) => engine?.scheduler.wake(id);
  const loopFacade = {
    approve: async (id, o) => { const r = await (await controller()).approve(id, o); wake(id); return r; },
    deny: async (id, o) => { const r = await (await controller()).deny(id, o); wake(id); return r; },
    cancel: async (id, o) => { const r = await (await controller()).cancel(id, o); wake(id); return r; },
  };
  const allowed = (repo) => { const rp = real(repo); return !!rp && cfg.repos.includes(rp); };
  const intake = {
    async createTask(input, opts = {}) {
      await controller();
      const informational = opts.template === 'informational';
      if (!informational && typeof input?.repository !== 'string') throw new ContractError('E_INTAKE_REPO', 'repository required: tasks run only in a repository listed in GHOSTY_V2_REPOS');
      if (input?.repository !== undefined && !allowed(input.repository)) throw new ContractError('E_INTAKE_REPO', 'repository is not on the V2 allowlist (GHOSTY_V2_REPOS)');
      // Through the loop under the controller lease and its fenced store (one writer, D-016): never the raw handle.
      const r = await (await controller()).ownerWrite((fenced) => createIntake({ store: fenced }).createTask(input, opts));
      wake(r.task.task_id);
      return r;
    },
  };
  const v2http = createV2Http({ store, intake, loop: loopFacade, log: (m) => log(m) });

  async function ops({ method, pathname, readBody }) {
    const m = /^\/api\/v2\/ops\/(status|telemetry|incidents|requests)$/.exec(pathname);
    if (!m) return null;
    const send = (status, body) => ({ status, body });
    try {
      if (m[1] === 'requests') {
        if (method !== 'POST') return send(405, { ok: false, code: 'E_METHOD', error: 'method not allowed' });
        let b;
        try { b = await readBody(); } catch { return send(400, { ok: false, code: 'E_INVALID', error: 'body must be JSON' }); }
        if (!b || typeof b !== 'object' || Array.isArray(b)) return send(400, { ok: false, code: 'E_INVALID', error: 'body must be a JSON object' });
        for (const k of Object.keys(b)) if (!['action', 'type', 'symptom'].includes(k)) return send(400, { ok: false, code: 'E_INVALID', error: 'unknown field' });
        if (typeof b.action !== 'string' || !ACTION_RE.test(b.action)) return send(400, { ok: false, code: 'E_INVALID', error: 'action: [a-z][a-z0-9_.-]{0,99}' });
        if (b.symptom !== undefined && (typeof b.symptom !== 'string' || b.symptom.length > 500)) return send(400, { ok: false, code: 'E_INVALID', error: 'symptom: string, max 500' });
        // Request-only: an incident in mitigation_requested; nothing executes (no executor is wired). Written only
        // while this process holds the controller lease.
        const r = await (await controller()).ownerWrite(() => engine.requester.request({ task_id: null, role: 'owner', op: { type: b.type, host_id: HOST_ID, action: b.action, symptom: b.symptom } }));
        return send(202, { ok: true, executed: false, incident_id: r.incident_id, state: r.state, deduped: r.deduped });
      }
      if (method !== 'GET') return send(405, { ok: false, code: 'E_METHOD', error: 'method not allowed: read-only' });
      if (m[1] === 'status') return send(200, { ok: true, status: status() });
      if (!engine) return send(503, { ok: false, code: 'E_NO_CONTROLLER', error: `V2 engine not configured: ${reason}` });
      if (m[1] === 'telemetry') return send(200, { ok: true, telemetry: await engine.telemetry.assess(HOST_ID) });
      return send(200, { ok: true, incidents: await engine.incidents.list({}) });
    } catch (e) {
      if (e instanceof ContractError && e.code === 'E_NO_CONTROLLER') return send(503, { ok: false, code: e.code, error: e.message });
      if (e instanceof ContractError && e.code === 'E_CONTROLLER_HELD') return send(409, { ok: false, code: e.code, error: 'another goal-loop controller holds the lease: nothing was written' });
      if (e instanceof ContractError && e.code === 'E_LEASE_UNAVAILABLE') return send(503, { ok: false, code: e.code, error: 'controller lease unavailable: nothing was written' });
      log(`[v2] ops route: ${e?.code || e?.message}`);
      return send(500, { ok: false, code: 'E_INTERNAL', error: 'internal error' });
    }
  }

  function status() {
    return { state, reason, repos: cfg.repos.length, concurrency: cfg.concurrency, work_root_set: !!cfg.workRoot, test_fake_adapter: !!cfg.fakeScripts,
      runtimes, scheduler: engine && state === 'running' ? engine.scheduler.status() : null };
  }

  // A lease backend that cannot answer (e.g. a lock file left by a killed process, broken only once stale and the
  // dead holder's TTL ran out) is retried; a live controller elsewhere (E_HELD) is final for this process.
  let retryTimer = null;
  async function attempt() {
    const a = await engine.loop.acquire({ watch: false });
    if (!a.ok) {
      reason = a.diagnosis || a.code;
      if (a.code === 'E_UNAVAILABLE' && !stopP) {
        state = 'refused';
        log(`[v2] goal loop not started yet: ${reason}; retrying in ${Math.round(retryMs / 1000)} s (V2 routes read-only meanwhile)`);
        retryTimer = setTimeout(() => { retryTimer = null; if (!stopP) { state = 'starting'; startP = attempt(); } }, retryMs);
        retryTimer.unref?.();
        return;
      }
      state = 'refused';
      log(`[v2] goal loop NOT started: ${reason}; V2 routes are read-only here`);
      return;
    }
    try {
      const r = await engine.loop.recover();
      log(`[v2] controller lease held; recovered the store (${r.resumable.length} open task(s))`);
    } catch (e) {
      await engine.loop.release().catch(() => null);
      state = 'refused'; reason = `recover failed: ${e?.code || e?.message}`; log(`[v2] goal loop NOT started: ${reason}`); return;
    }
    for (const [rt, ad] of Object.entries(engine.adapters)) {
      try { const p = await ad.probeCapabilities(); runtimes[rt] = { available: p.available, version: p.version ?? null }; } catch { runtimes[rt] = { available: 'unknown', version: null }; }
    }
    log(`[v2] runtimes: ${Object.entries(runtimes).map(([k, v]) => `${k}=${v.available}`).join(' ')}`);
    if (stopP) return;
    state = 'running'; reason = null;
    await engine.scheduler.start();
  }

  async function start() {
    for (const w of cfg.warnings) log(`[v2] ${w}`);
    if (state !== 'idle') { if (state === 'refused') log(`[v2] goal loop NOT started: ${reason}`); return status(); }
    state = 'starting';
    startP = attempt();
    await startP;
    return status();
  }

  // Bounded: stop scheduling, give in-flight steps the time left, release the controller lease (an in-flight step can no
  // longer write), then cancel the runs still going. Idempotent.
  function stop({ timeoutMs = 5000 } = {}) {
    // Hard bound: release() may queue behind the controller serial or the lease backend's lock wait.
    if (stopP) return stopP;
    let to;
    const bound = new Promise((r) => { to = setTimeout(() => { log('[v2] stop timed out: exiting without a confirmed lease release (the next start takes over a dead pid)'); r({ released: false, timed_out: true }); }, timeoutMs + 1500); to.unref?.(); });
    stopP = Promise.race([stopInner(timeoutMs).finally(() => clearTimeout(to)), bound]);
    return stopP;
  }
  function stopInner(timeoutMs) {
    return (async () => {
      clearTimeout(retryTimer);
      await startP.catch(() => null);
      const was = state;
      state = 'stopped';
      if (!engine) return { released: false };
      const d = was === 'running' ? await engine.scheduler.stop(Math.max(0, timeoutMs - 1500)) : { drained: true, in_flight: 0 };
      const rel = await engine.loop.release().catch(() => ({ released: false }));
      const runs = [...activeRuns];
      await Promise.race([Promise.allSettled(runs.map(({ adapter, run }) => adapter.cancel(run))), new Promise((r) => setTimeout(r, 1000).unref?.())]);
      log(`[v2] stopped: controller lease ${rel.released ? 'released' : 'not held'}${d.in_flight ? `, ${d.in_flight} step(s) interrupted (reconciled on the next start)` : ''}${runs.length ? `, ${runs.length} run(s) cancelled` : ''}`);
      return { released: rel.released, interrupted: d.in_flight, cancelled: runs.length };
    })();
  }

  async function handle(req) {
    if (/^\/api\/v2\/ops\//.test(req.pathname || '')) return ops(req);
    return v2http.handle(req);
  }

  return { http: { handle }, start, stop, status, store, config: cfg };
}
