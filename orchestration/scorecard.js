// V2 scorecard and tool score (docs/v2/SCORING.md). Not the root scorecard.js (manager scorecard): that one is untouched.
// Pure: input is per-task event logs ({ task_id, events }) and an optional bench manifest; no I/O, no clock. Unknown stays
// unknown: a metric that cannot be derived is null with a reason, never 0. Nothing here changes a router, registry or policy.
import { RUNTIME_EFFORTS } from './model-registry.js';
import { outcomeOf, STATES } from './task-contract.js';

export const SCORECARD_SCHEMA = 'mycodebox.v2.scorecard/1';
export const BENCH_SCHEMA = 'mycodebox.v2.bench-run/1';
export const TOOL_SCORE_SCHEMA = 'mycodebox.v2.tool-score/1';
export const SMALL_SAMPLE = 5;
// Actor id of the bench runner's suite-ledger budget confirmation (scripts/v2-bench.js): policy-authorized, not an owner act.
export const BENCH_LEDGER_ACTOR_ID = 'v2-bench-ledger';
// Tool score: weights sum to 1, each component in [0,1]; score = 100 * sum(weight * component). Changing a weight is a new
// formula version, and scores of different formulas or suite versions are never compared.
export const TOOL_SCORE_FORMULA = 'v1';
export const TOOL_SCORE_WEIGHTS = Object.freeze({ outcome_correctness: 0.30, verified_rate: 0.25, first_pass_rate: 0.15, cost: 0.10, latency: 0.10, owner_interventions: 0.10 });
// One vocabulary for the bench (scripts/v2-bench.js, test/fixtures/v2-bench) and this validator. `waiting_no_progress` is
// `waiting` whose last block reason is no_progress.
export const EXPECTED_OUTCOMES = Object.freeze(['done', 'awaiting_approval', 'waiting', 'waiting_no_progress']);
// Bench outcomes of runs that never created a task (suite ledger refused it, runtime unavailable, harness or intake error
// before the task existed): task_id is null and the
// run counts as not run, never as a task result.
export const NOT_RUN_OUTCOMES = Object.freeze(['skipped_budget', 'not_started', 'harness_error']);
// expected outcome -> the final state (and block reason) that counts as correct. `done` is only `accepted`; the others
// never accept `accepted`.
const EXPECTED_STATE = { done: 'accepted', awaiting_approval: 'awaiting_approval', waiting: 'waiting', waiting_no_progress: 'waiting' };
const EXPECTED_REASON = { waiting_no_progress: 'no_progress' };
const matchesExpected = (r, expected) => !!r && r.status === EXPECTED_STATE[expected] && (!EXPECTED_REASON[expected] || r.wait_reason === EXPECTED_REASON[expected]);
const notRun = (m) => m.task_id == null && NOT_RUN_OUTCOMES.includes(m.outcome);
const REWORK_STATES = ['repair', 'replan'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_CLASS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const OWNER_MESSAGES_UNKNOWN = 'no V2 event records owner chat messages; only approval requests, answers and resume grants are counted';
const REOPEN_UNKNOWN = 'the store refuses any transition out of accepted, so a reopen cannot be recorded; regressions come from later evidence only';

export const isRegistryId = (id) => { const s = String(id || ''); const i = s.indexOf(':'); return i > 0 && s.length > i + 1 && Object.hasOwn(RUNTIME_EFFORTS, s.slice(0, i)); };
const split = (id) => { const s = String(id || ''); const i = s.indexOf(':'); return i > 0 ? { runtime: s.slice(0, i), model: s.slice(i + 1) } : { runtime: 'unknown', model: 'unknown' }; };
const actorId = (a) => (typeof a === 'string' ? a : a?.id ?? null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round4 = (x) => (x === null ? null : Math.round(x * 1e4) / 1e4);
const cmdKey = (c) => JSON.stringify(c ?? null);

// ---------- manifest ----------

// -> { ok, errors, manifest } with suite_version normalized to a string. Unknown fields are kept (forward compatible).
export function validateManifest(m) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: [{ path: '', message: 'manifest must be an object' }] };
  if (m.schema !== BENCH_SCHEMA) err('schema', `must be ${BENCH_SCHEMA}`);
  if (typeof m.suite_id !== 'string' || !m.suite_id.trim()) err('suite_id', 'non-empty string');
  if (!((typeof m.suite_version === 'string' && m.suite_version.trim()) || Number.isInteger(m.suite_version))) err('suite_version', 'non-empty string or integer');
  if (!Array.isArray(m.runs) || !m.runs.length) err('runs', 'non-empty array');
  else {
    const seen = new Set();
    m.runs.forEach((r, i) => {
      const p = `runs[${i}]`;
      if (!r || typeof r !== 'object') return err(p, 'object');
      if (notRun(r)) { /* not run: no task to point at */ } else if (typeof r.task_id !== 'string' || !ID_RE.test(r.task_id)) err(`${p}.task_id`, `task id (null only with outcome ${NOT_RUN_OUTCOMES.join(' or ')})`);
      else if (seen.has(r.task_id)) err(`${p}.task_id`, 'duplicate'); else seen.add(r.task_id);
      if (!EXPECTED_OUTCOMES.includes(r.expected_outcome)) err(`${p}.expected_outcome`, `one of ${EXPECTED_OUTCOMES.join(', ')}`);
      if (r.task_class != null && !(typeof r.task_class === 'string' && TASK_CLASS_RE.test(r.task_class))) err(`${p}.task_class`, 'null or [a-z0-9][a-z0-9._-]{0,63} (as in the task contract)');
      for (const k of ['bench_task_id', 'runtime', 'model', 'reviewer_runtime', 'reviewer_model']) {
        if (r[k] != null && typeof r[k] !== 'string') err(`${p}.${k}`, 'string or null');
      }
    });
  }
  const b = m.budget_policy;
  if (b != null) {
    if (typeof b !== 'object' || Array.isArray(b)) err('budget_policy', 'object');
    else for (const k of ['max_usd', 'max_task_ms']) if (b[k] != null && !(typeof b[k] === 'number' && Number.isFinite(b[k]) && b[k] > 0)) err(`budget_policy.${k}`, 'positive number or null');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors, manifest: { ...m, suite_version: String(m.suite_version) } };
}

const manifestOrThrow = (m) => {
  if (m == null) return null;
  const v = validateManifest(m);
  if (!v.ok) { const e = new Error(`invalid bench manifest: ${v.errors.map((x) => `${x.path} ${x.message}`).join('; ')}`); e.code = 'E_MANIFEST'; e.details = v.errors; throw e; }
  return v.manifest;
};

// ---------- one task ----------

// One task log -> facts, or null without task.created. Read-only over the events; never re-judges acceptance (the store
// refuses `accepted` without passing required checks and an independent approve).
export function foldRun(events, { httpSuite = false } = {}) {
  const created = events.find((e) => e.kind === 'task.created');
  const task = created?.payload?.task;
  if (!task) return null;
  const f = { task_id: created.task_id, task, status: task.status, created_at: created.timestamp, completed_at: null,
    info: task.review_policy?.mode === 'informational', head_sha: null, producers: new Map(), devs: new Map(), last_actor: null,
    usage: [], rework: 0, owner: { approvals_requested: 0, approvals_granted: 0, approvals_denied: 0, resumes: 0, budget_auto: 0 },
    verdicts: [], evidence: [], wait_reason: null };
  for (const e of events) {
    const p = e.payload || {};
    if (['task.transitioned', 'task.completed', 'task.cancelled'].includes(e.kind) && typeof p.to === 'string') {
      f.status = p.to;
      if (p.to !== 'waiting') f.wait_reason = null;   // a block reason describes the current wait only
      if (p.to === 'accepted') f.completed_at = e.timestamp;
      if (REWORK_STATES.includes(p.to)) f.rework += 1;
    } else if (e.kind === 'task.head_changed') {
      f.head_sha = p.sha;
      const id = actorId(p.actor);
      if (id) { const s = f.devs.get(p.sha) || f.devs.set(p.sha, new Set()).get(p.sha); s.add(id); }
      if (isRegistryId(id)) { f.producers.set(p.sha, id); f.last_actor = id; }
    } else if (e.kind === 'usage.recorded') {
      f.usage.push({ runtime: p.runtime ?? null, model: p.model ?? null, incomplete: p.incomplete === true, usd: Number.isFinite(p.usd) && p.incomplete !== true ? p.usd : null });
    } else if (e.kind === 'approval.requested') f.owner.approvals_requested += 1;
    else if (e.kind === 'approval.granted') { if (p.kind === 'resume') f.owner.resumes += 1; else f.owner.approvals_granted += 1; }
    else if (e.kind === 'approval.denied') f.owner.approvals_denied += 1;
    else if ((e.kind === 'verification.passed' || e.kind === 'verification.failed') && (p.verdict === 'approve' || p.verdict === 'reject')) {
      f.verdicts.push({ sha: p.sha, actor: actorId(p.actor), verdict: p.verdict, findings: Array.isArray(p.findings) ? p.findings.length : 0, seq: e.seq });
    } else if (e.kind === 'evidence.recorded') {
      f.evidence.push({ check_id: p.check_id, sha: p.sha, command: p.command, exit: Number.isInteger(p.exit) ? p.exit : null, ts: e.timestamp, seq: e.seq });
    } else if (e.kind === 'task.blocked') f.wait_reason = p.reason ?? null;
  }
  // A budget stop answered by the bench ledger's grant (matched by the approval index k) is a policy-authorized confirmation,
  // not an owner intervention: count it as budget_auto and drop both events from the owner counters.
  for (const r of events.filter((e) => e.kind === 'approval.requested' && e.payload?.kind === 'budget')) {
    const d = events.filter((e) => ['approval.granted', 'approval.denied'].includes(e.kind) && e.payload?.k === r.payload.k && e.payload?.kind !== 'resume').at(-1);
    // The HTTP bench driver answers through the dashboard route (actor owner); its grant carries the ledger's reason. Only
    // for a manifest that says driver:'http', and never a raise of a reached cap (that grant names a budget_policy).
    const viaHttp = httpSuite && d?.kind === 'approval.granted' && actorId(d.payload.actor) === 'owner' && d.payload.grants?.request_kind === 'budget'
      && !d.payload.grants?.budget_policy && typeof d.payload.reason === 'string' && d.payload.reason.startsWith('suite-ledger ');
    if (d?.kind === 'approval.granted' && (actorId(d.payload.actor) === BENCH_LEDGER_ACTOR_ID || viaHttp)) {
      f.owner.budget_auto += 1; f.owner.approvals_requested -= 1; f.owner.approvals_granted -= 1;
    }
  }
  return f;
}

// Developer credit: the developer of the accepted head; else the last developer; else the last usage; else the manifest.
function developerOf(f, run) {
  const id = (f.status === 'accepted' && f.producers.get(f.head_sha)) || f.last_actor;
  if (id) return { ...split(id), basis: 'developer' };
  const u = f.usage.findLast((x) => isRegistryId(`${x.runtime}:${x.model}`));
  if (u) return { runtime: u.runtime, model: u.model, basis: 'last_usage' };
  if (run?.runtime && run?.model) return { runtime: run.runtime, model: run.model, basis: 'manifest' };
  return { runtime: 'unknown', model: 'unknown', basis: 'none' };
}

// Reviewers: registry ids that gave a verdict, independent of the developers of the SHA they judged; else the manifest.
function reviewersOf(f, run) {
  const ids = [...new Set(f.verdicts.filter((v) => isRegistryId(v.actor) && !f.devs.get(v.sha)?.has(v.actor)).map((v) => v.actor))];
  if (!ids.length && run?.reviewer_runtime && run?.reviewer_model) ids.push(`${run.reviewer_runtime}:${run.reviewer_model}`);
  return ids;
}

// A defect caught by the independent reviewer: a `reject` verdict from an actor that is not a developer of the SHA it
// judged. Every verdict precedes acceptance (the store refuses writes after it).
const defectsOf = (f, onlyActor = null) => f.verdicts.filter((v) => v.verdict === 'reject' && v.actor && !f.devs.get(v.sha)?.has(v.actor) && (onlyActor === null || v.actor === onlyActor));

// Regression after acceptance, conservatively: a check command that passed on task A's accepted head SHA later ran again on
// that exact SHA (in any other task, after A's acceptance) and exited differently from A's expectation. Same SHA = same
// code, so a later failure means the acceptance did not hold (a flaky or environment-dependent pass). `unknown` when no
// later evidence re-ran an accepted check on that SHA. Reopen is not derivable (REOPEN_UNKNOWN).
export function regressionsOf(facts) {
  const out = new Map();
  for (const a of facts) {
    if (a.status !== 'accepted' || !a.head_sha || !a.completed_at) continue;
    const expect = new Map(a.task.acceptance_checks.map((c) => [c.id, c.expect?.exit]));
    const passed = new Map();
    for (const e of a.evidence) if (e.sha === a.head_sha && e.exit !== null && e.exit === expect.get(e.check_id)) passed.set(cmdKey(e.command), e.exit);
    const doneMs = Date.parse(a.completed_at);
    let checked = 0; const refs = [];
    for (const b of facts) {
      if (b === a) continue;
      for (const e of b.evidence) {
        if (e.sha !== a.head_sha || !passed.has(cmdKey(e.command)) || !(Date.parse(e.ts) > doneMs) || e.exit === null) continue;
        checked += 1;
        if (e.exit !== passed.get(cmdKey(e.command))) refs.push(`${b.task_id}#${e.seq}`);
      }
    }
    out.set(a.task_id, checked ? { status: refs.length ? 'detected' : 'none', later_checks: checked, refs }
      : { status: 'unknown', later_checks: 0, refs, reason: 'no later evidence re-ran an accepted check on this SHA' });
  }
  return out;
}

function costOf(f) {
  if (!f.usage.length) return { usd: null, reason: 'no usage record' };
  if (f.usage.some((u) => u.incomplete)) return { usd: null, reason: 'usage marked incomplete' };
  if (f.usage.some((u) => u.usd === null)) return { usd: null, reason: 'unpriced usage (usd unknown)' };
  return { usd: f.usage.reduce((s, u) => s + u.usd, 0), reason: null };
}

function runRecord(f, run, regression) {
  // Settled = terminal. A cancelled (non-informational) task counts as settled and not verified: cancelling work the tool
  // could not finish must not raise its rates. The group's `cancelled` count shows how many.
  const settled = f.status === 'accepted' || f.status === 'failed_unrecoverable' || f.status === 'cancelled';
  const accepted = f.status === 'accepted';
  const cost = costOf(f);
  const latency = accepted && f.completed_at ? Date.parse(f.completed_at) - Date.parse(f.created_at) : null;
  const d = defectsOf(f);
  return {
    task_id: f.task_id, bench_task_id: run?.bench_task_id ?? null, task_class: f.task.task_class ?? run?.task_class ?? 'unknown',
    status: f.status, outcome: STATES.includes(f.status) ? outcomeOf(f.status) : 'unknown', settled, verified: accepted,
    first_pass: accepted && f.rework === 0, informational: f.info,
    developer: developerOf(f, run), reviewers: reviewersOf(f, run),
    cost_usd: cost.usd, cost_unknown_reason: cost.reason,
    latency_ms: Number.isFinite(latency) && latency >= 0 ? latency : null,
    rework_rounds: f.rework,
    owner: { ...f.owner, messages: null, interventions: f.owner.approvals_requested + f.owner.resumes },
    reviewer_defects: { caught: d.length, findings: d.reduce((s, v) => s + v.findings, 0) },
    regression: accepted ? regression || { status: 'unknown', later_checks: 0, refs: [], reason: 'accepted head SHA unknown' } : null,
    wait_reason: f.wait_reason,
  };
}

// ---------- groups ----------

function aggregate(key, extra, runs, { defectsBy = null, facts = null } = {}) {
  const g = { key, ...extra, settled: 0, verified: 0, failed: 0, cancelled: 0, first_pass: 0, _lat: [], _usd: 0, spend_unknown_tasks: 0, rework: 0,
    owner: { approvals_requested: 0, approvals_granted: 0, approvals_denied: 0, resumes: 0, budget_auto: 0, interventions: 0 },
    defects: { caught: 0, findings: 0, tasks_with_defects: 0 }, reg: { detected: 0, none: 0, unknown: 0, refs: [] } };
  for (const r of runs) {
    g.settled += 1;
    if (r.verified) g.verified += 1; else if (r.status === 'cancelled') g.cancelled += 1; else g.failed += 1;
    if (r.first_pass) g.first_pass += 1;
    if (r.latency_ms !== null) g._lat.push(r.latency_ms);
    if (r.cost_usd === null) g.spend_unknown_tasks += 1; else g._usd += r.cost_usd;
    g.rework += r.rework_rounds;
    for (const k of Object.keys(g.owner)) g.owner[k] += r.owner[k];
    const d = defectsBy ? defectsOf(facts.get(r.task_id), defectsBy) : null;
    const caught = d ? d.length : r.reviewer_defects.caught;
    g.defects.caught += caught;
    g.defects.findings += d ? d.reduce((s, v) => s + v.findings, 0) : r.reviewer_defects.findings;
    if (caught) g.defects.tasks_with_defects += 1;
    if (r.regression) { g.reg[r.regression.status] += 1; g.reg.refs.push(...r.regression.refs); }
  }
  const unknown = {};
  const verified_rate = g.settled ? g.verified / g.settled : null;
  const per_verified = g.verified && !g.spend_unknown_tasks ? g._usd / g.verified : null;
  if (per_verified === null) unknown.cost_per_verified_completion = g.verified ? `${g.spend_unknown_tasks} settled task(s) with unknown cost` : 'no verified completion';
  const lat = median(g._lat);
  if (lat === null) unknown.median_latency_ms = 'no verified task with timestamps';
  const checked = g.reg.detected + g.reg.none;
  if (!checked) unknown.regressions = g.verified ? 'no later evidence re-ran an accepted check on an accepted SHA' : 'no accepted task';
  unknown.owner_messages = OWNER_MESSAGES_UNKNOWN;
  unknown.reopened = REOPEN_UNKNOWN;
  return {
    key: g.key, ...extra, settled: g.settled, verified: g.verified, failed: g.failed, cancelled: g.cancelled,
    verified_rate, first_pass: g.first_pass, first_pass_rate: g.settled ? g.first_pass / g.settled : null,
    cost: { per_verified_completion_usd: per_verified, usd_known_total: g.settled > g.spend_unknown_tasks ? g._usd : null, spend_unknown_tasks: g.spend_unknown_tasks },
    median_latency_ms: lat,
    rework: { rounds: g.rework, per_settled_task: g.settled ? g.rework / g.settled : null },
    owner_interventions: { ...g.owner, messages: null, per_settled_task: g.settled ? g.owner.interventions / g.settled : null },
    reviewer_defects: g.defects,
    regressions: { detected: checked ? g.reg.detected : null, accepted_checked: checked, accepted_unknown: g.reg.unknown, refs: g.reg.refs.slice(0, 50) },
    small_sample: g.settled < SMALL_SAMPLE,
    unknown,
  };
}

const order = (a, b) => b.settled - a.settled || a.key.localeCompare(b.key);
function groupBy(runs, keyOf, opts) {
  const m = new Map();
  for (const r of runs) for (const [key, extra] of keyOf(r)) { const x = m.get(key) || m.set(key, { extra, runs: [] }).get(key); x.runs.push(r); }
  return [...m].map(([key, { extra, runs: rs }]) => aggregate(key, extra, rs, typeof opts === 'function' ? opts(key, extra) : opts)).sort(order);
}

// logs: [{ task_id, events }]. unreadable: [{ task_id, ... }] listed by the reader. -> scorecard (plain JSON).
export function buildScorecard(logs, { manifest = null, unreadable = [], since = null } = {}) {
  const mf = manifestOrThrow(manifest);
  const runOf = new Map((mf?.runs || []).filter((r) => !notRun(r)).map((r) => [r.task_id, r]));
  const sinceMs = since ? Date.parse(since) : null;
  if (since && Number.isNaN(sinceMs)) throw new Error(`since is not an ISO timestamp: ${since}`);
  const all = [];
  for (const { events } of logs) {
    const f = foldRun(events, { httpSuite: mf?.driver === 'http' });
    if (!f || (sinceMs !== null && Date.parse(f.created_at) < sinceMs)) continue;
    all.push(f);
  }
  const reg = regressionsOf(all);
  const facts = new Map(all.map((f) => [f.task_id, f]));
  const runs = all.filter((f) => !f.info).map((f) => runRecord(f, runOf.get(f.task_id), reg.get(f.task_id)));
  const counts = { total: all.length, informational: all.length - runs.length, settled: 0, accepted: 0, failed: 0, cancelled: 0, open: 0, unreadable: unreadable.length };
  for (const r of runs) {
    if (r.status === 'accepted') counts.accepted += 1; else if (r.status === 'failed_unrecoverable') counts.failed += 1;
    else if (r.status === 'cancelled') counts.cancelled += 1; else counts.open += 1;
    if (r.settled) counts.settled += 1;
  }
  const settled = runs.filter((r) => r.settled);
  const dev = (r) => `${r.developer.runtime}:${r.developer.model}`;
  const by_role = [
    ...groupBy(settled, (r) => [[`developer:${dev(r)}`, { role: 'developer', runtime: r.developer.runtime, model: r.developer.model }]]),
    // A task with two reviewers counts in both reviewer groups; defects are credited to the reviewer that raised them.
    ...groupBy(settled, (r) => r.reviewers.map((id) => [`reviewer:${id}`, { role: 'reviewer', ...split(id) }]), (key) => ({ defectsBy: key.slice('reviewer:'.length), facts })),
  ];
  const caveats = [];
  if (unreadable.length) caveats.push(`${unreadable.length} task log(s) could not be replayed and are excluded, not counted as success or failure`);
  const sc = {
    schema: SCORECARD_SCHEMA, suite: mf ? { suite_id: mf.suite_id, suite_version: mf.suite_version } : null,
    tasks: counts, unreadable,
    runs,
    by_model: groupBy(settled, (r) => [[dev(r), { runtime: r.developer.runtime, model: r.developer.model }]]),
    by_runtime: groupBy(settled, (r) => [[r.developer.runtime, { runtime: r.developer.runtime }]]),
    by_role,
    by_task_class: groupBy(settled, (r) => [[r.task_class, { task_class: r.task_class }]]),
    caveats,
  };
  const groups = [...sc.by_model, ...sc.by_runtime, ...sc.by_role, ...sc.by_task_class];
  if (groups.some((g) => g.small_sample)) caveats.push(`small samples: groups with fewer than ${SMALL_SAMPLE} settled tasks are anecdotes, not rankings`);
  if (groups.some((g) => g.cost.spend_unknown_tasks)) caveats.push('some settled tasks have unknown cost; their groups show cost per verified completion as unknown, never $0');
  if (sc.by_model.some((g) => g.runtime === 'unknown')) caveats.push('some tasks have no registry developer, usage or manifest entry: grouped under runtime "unknown"');
  if (settled.some((r) => r.regression?.status === 'unknown')) caveats.push('regressions are unknown for accepted tasks whose SHA was never re-checked later; reopening is not recordable');
  caveats.push('owner chat messages are not recorded as V2 events: owner interventions count approval requests and resume grants only');
  if (counts.cancelled) caveats.push(`${counts.cancelled} cancelled task(s) count as settled and not verified in every rate (unlike the plain report, which leaves them out)`);
  caveats.push('latency is wall time from creation to acceptance and includes time waiting for the owner or for quota');
  if (mf) {
    const skipped = mf.runs.filter(notRun);
    sc.not_run = skipped.map((r) => ({ bench_task_id: r.bench_task_id ?? null, runtime: r.runtime ?? null, model: r.model ?? null, outcome: r.outcome }));
    counts.not_run = skipped.length;
    if (skipped.length) caveats.push(`${skipped.length} manifest run(s) never started (${[...new Set(skipped.map((r) => r.outcome))].join(', ')}): not run, not counted as results`);
    const missing = mf.runs.filter((r) => !notRun(r) && !facts.has(r.task_id)).map((r) => r.task_id);
    if (missing.length) caveats.push(`${missing.length} manifest run(s) have no task in the store: ${missing.slice(0, 10).join(', ')}`);
    const mismatch = runs.filter((r) => { const m = runOf.get(r.task_id); return m?.runtime && m?.model && r.developer.basis !== 'manifest' && `${m.runtime}:${m.model}` !== dev(r); });
    if (mismatch.length) caveats.push(`${mismatch.length} run(s) were developed by a different model than the manifest declares; credit follows the recorded developer`);
  }
  return sc;
}

// Task specs from the logs, for shadow routing (proposals). Informational tasks are never routed.
export function taskSpecsOf(logs) {
  return logs.map(({ events }) => foldRun(events)).filter((f) => f && !f.info).map((f) => f.task);
}

// ---------- tool score ----------

const comp = (value, reason = null) => ({ value: value === null ? null : round4(value), ...(value === null ? { reason } : {}) });

export function toolScore(scorecard, manifest) {
  const mf = manifestOrThrow(manifest);
  if (!mf) throw Object.assign(new Error('tool score needs a bench manifest'), { code: 'E_MANIFEST' });
  const byId = new Map(scorecard.runs.map((r) => [r.task_id, r]));
  const all = mf.runs.map((m) => {
    if (notRun(m)) return { task_id: null, bench_task_id: m.bench_task_id ?? null, task_class: m.task_class ?? 'unknown', expected: m.expected_outcome, actual: 'not_run', correct: false, run: null, not_run: m.outcome };
    const r = byId.get(m.task_id) || null;
    return { task_id: m.task_id, bench_task_id: m.bench_task_id ?? null, task_class: m.task_class ?? r?.task_class ?? 'unknown', expected: m.expected_outcome,
      actual: r ? (r.status === 'waiting' && r.wait_reason ? `waiting:${r.wait_reason}` : r.status) : 'missing', correct: matchesExpected(r, m.expected_outcome), run: r };
  });
  // Components cover the runs that ran; a suite with not-run runs only gets a partial score.
  const per_run = all.filter((p) => !p.not_run);
  const skipped = all.filter((p) => p.not_run);
  if (!per_run.length) throw Object.assign(new Error('tool score needs at least one run that started'), { code: 'E_MANIFEST' });
  const done = per_run.filter((p) => p.expected === 'done');
  const missing = per_run.filter((p) => !p.run).map((p) => p.task_id);
  const c = {};
  c.outcome_correctness = comp(per_run.filter((p) => p.correct).length / per_run.length);
  c.verified_rate = done.length ? comp(done.filter((p) => p.run?.status === 'accepted').length / done.length) : comp(null, 'no run expects done');
  c.first_pass_rate = done.length ? comp(done.filter((p) => p.run?.first_pass).length / done.length) : comp(null, 'no run expects done');
  const b = mf.budget_policy || {};
  if (!b.max_usd) c.cost = comp(null, 'manifest budget_policy.max_usd missing');
  else if (per_run.some((p) => !p.run || p.run.cost_usd === null)) c.cost = comp(null, `${per_run.filter((p) => !p.run || p.run.cost_usd === null).length} run(s) with unknown cost`);
  else c.cost = comp(clamp01(1 - per_run.reduce((s, p) => s + p.run.cost_usd, 0) / b.max_usd));
  const costKnown = per_run.filter((p) => p.run && p.run.cost_usd !== null).length;
  c.cost.cost_known_runs = costKnown;
  c.cost.cost_coverage = round4(costKnown / per_run.length);
  if (!b.max_task_ms) c.latency = comp(null, 'manifest budget_policy.max_task_ms missing');
  else if (!done.length) c.latency = comp(null, 'no run expects done');
  else if (done.some((p) => p.run?.status === 'accepted' && p.run.latency_ms === null)) c.latency = comp(null, 'an accepted run has no latency');
  // a run expected done that did not get accepted scores 0 on latency: it never finished within any budget
  else c.latency = comp(done.reduce((s, p) => s + (p.run?.status === 'accepted' ? clamp01(1 - p.run.latency_ms / b.max_task_ms) : 0), 0) / done.length);
  c.owner_interventions = done.length ? comp(done.filter((p) => p.run && p.run.owner.interventions === 0).length / done.length) : comp(null, 'no run expects done');
  const unknownC = Object.entries(c).filter(([, v]) => v.value === null).map(([k]) => k);
  const known = Object.entries(TOOL_SCORE_WEIGHTS).filter(([k]) => c[k].value !== null);
  // partial_score: 100 x the weighted sum of the KNOWN components, not rescaled, so it is a lower bound out of 100*coverage.
  const partial_score = Math.round(1000 * known.reduce((s, [k, w]) => s + w * c[k].value, 0)) / 10;
  const coverage = round4(known.reduce((s, [, w]) => s + w, 0));
  const score = unknownC.length || skipped.length ? null : partial_score;
  const reasons = [...(unknownC.length ? [`unknown component(s): ${unknownC.join(', ')}`] : []), ...(skipped.length ? [`${skipped.length} run(s) not run`] : [])];
  const caveats = [];
  if (per_run.length < 10) caveats.push('small suite: fewer than 10 runs; differences of a few points are noise');
  if (missing.length) caveats.push(`${missing.length} manifest run(s) missing from the store count as incorrect and unverified`);
  if (skipped.length) caveats.push(`${skipped.length} of ${all.length} manifest run(s) never started: the score is partial and covers the ${per_run.length} that ran`);
  return { schema: TOOL_SCORE_SCHEMA, formula: TOOL_SCORE_FORMULA, suite_id: mf.suite_id, suite_version: mf.suite_version, weights: { ...TOOL_SCORE_WEIGHTS },
    budget_policy: { max_usd: b.max_usd ?? null, max_task_ms: b.max_task_ms ?? null },
    runs: per_run.length, missing, skipped: skipped.length, run_coverage: round4(per_run.length / all.length),
    components: c, score, ...(score === null ? { score_reason: reasons.join('; ') } : {}),
    partial_score, coverage, unknown_components: unknownC,
    per_run: all.map(({ run, ...p }) => p), caveats };
}

// Refuses (throws E_SUITE_MISMATCH) unless both scores are tool scores of the same formula, suite id and suite version.
export function compareToolScores(a, b) {
  const fail = (m) => { const e = new Error(m); e.code = 'E_SUITE_MISMATCH'; throw e; };
  for (const s of [a, b]) if (s?.schema !== TOOL_SCORE_SCHEMA) fail('not a tool score');
  if (a.formula !== b.formula) fail(`different formulas (${a.formula} vs ${b.formula}): not comparable`);
  if (a.suite_id !== b.suite_id) fail(`different suites (${a.suite_id} vs ${b.suite_id}): not comparable`);
  if (a.suite_version !== b.suite_version) fail(`different suite versions (${a.suite_version} vs ${b.suite_version}): not comparable`);
  for (const k of ['max_usd', 'max_task_ms']) if ((a.budget_policy?.[k] ?? null) !== (b.budget_policy?.[k] ?? null)) fail(`different budget_policy.${k} (${a.budget_policy?.[k] ?? null} vs ${b.budget_policy?.[k] ?? null}): not comparable`);
  if ((a.score === null) !== (b.score === null)) fail('a partial score cannot be compared with a full score');
  if ((a.skipped ?? 0) !== (b.skipped ?? 0) || (a.runs ?? null) !== (b.runs ?? null)) fail(`different runs (${a.runs}+${a.skipped ?? 0} not run vs ${b.runs}+${b.skipped ?? 0} not run): not comparable`);
  if (a.coverage !== b.coverage || JSON.stringify(a.unknown_components || []) !== JSON.stringify(b.unknown_components || [])) fail(`different coverage (${a.coverage} vs ${b.coverage}): not comparable`);
  const d = (x, y) => (x === null || y === null || x === undefined || y === undefined ? null : round4(y - x));
  const components = Object.fromEntries(Object.keys(TOOL_SCORE_WEIGHTS).map((k) => {
    const x = a.components[k]?.value ?? null, y = b.components[k]?.value ?? null;
    return [k, { a: x, b: y, delta: d(x, y), weighted_delta: d(x, y) === null ? null : round4(d(x, y) * 100 * TOOL_SCORE_WEIGHTS[k]) }];
  }));
  return { suite_id: a.suite_id, suite_version: a.suite_version, formula: a.formula, coverage: a.coverage, score: { a: a.score, b: b.score, delta: d(a.score, b.score) },
    partial_score: { a: a.partial_score, b: b.partial_score, delta: d(a.partial_score, b.partial_score) }, components };
}
