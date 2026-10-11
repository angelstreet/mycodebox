// V2 durable task store (docs/v2/ARCHITECTURE.md §3). The per-task JSONL log is the source of truth;
// snapshot.json and index.json are derived caches rewritten atomically. Every write is validated, fsynced
// to the log and only then applied in memory and acknowledged. Recovery replays the logs, drops a torn
// last line, and parks tasks with unconfirmed external effects in `unknown_external_effect`.
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { makeEvent, validateEvent } from './events.js';
import { HOMOGLYPH } from './policy.js';
import {
  ContractError, SCHEMA_VERSION, TERMINAL, assertTransition, canTransition, outcomeOf, validateTask, normalizeTask,
  narrowsParent, validateDecision, normalizeDecision,
} from './task-contract.js';

const fail = (code, message, details) => { throw new ContractError(code, message, details); };
const SHA_RE = /^[0-9a-f]{7,64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;   // task ids become directory names
const TRANSITION_KINDS = { 'task.transitioned': null, 'task.cancelled': 'cancelled', 'task.completed': 'accepted' };
const EFFECT_KIND = { attempted: 'action.attempted', confirmed: 'action.confirmed', possibly_applied: 'action.unknown', failed: 'action.failed' };
const PHASE_OF = Object.fromEntries(Object.entries(EFFECT_KIND).map(([p, k]) => [k, p]));
const UNRESOLVED = ['attempted', 'possibly_applied'];
// Recording what really happened to an effect already in flight stays allowed in a terminal state: refusing
// it would hide external state, which is worse than the write.
const AFTER_TERMINAL_OK = new Set(['action.confirmed', 'action.unknown', 'action.failed']);
const USAGE_NUM = ['input_tokens', 'output_tokens', 'usd'];
const USAGE_KEYS = new Set([...USAGE_NUM, 'runtime', 'provider', 'model', 'unknown', 'run_id', 'attempt_id', 'ts', 'source', 'incomplete']);

export const defaultStoreDir = (env = process.env) =>
  join(env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty'), 'v2');

// Identity is the actor id only, compared trimmed, NFKC-normalized and case-folded. Role, runtime and model
// say nothing about who did the work, so an actor without an id cannot show independence (-> null).
// Format/zero-width characters, combining marks and common Cyrillic look-alikes are folded too, so a
// look-alike id cannot pose as a different actor.
const rawId = (a) => String(typeof a === 'string' ? a : a?.id ?? '').trim();
export const actorKey = (a) => {
  const id = typeof a === 'string' ? a : a && typeof a === 'object' ? a.id : null;
  if (typeof id !== 'string') return null;
  return id.normalize('NFKD').replace(/[\p{Cf}\p{M}]/gu, '').normalize('NFKC').trim().toLowerCase()
    .replace(/[^\x00-\x7F]/g, (c) => HOMOGLYPH[c] ?? c) || null;
};

const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  : JSON.stringify(v));
const hashOf = (v) => createHash('sha256').update(stable(v)).digest('hex').slice(0, 16);
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

const blank = () => ({ task: null, seq: 0, ids: new Set(), idempotency_key: null, head_sha: null, head_epoch: 0,
  head_actors: Object.create(null), evidence: [], verdicts: [], decisions: [], usage: [], effects: Object.create(null),
  policy_snapshot: null, history: [], store_error: null, recovery_pending: null });

// ---- validation of record payloads ----------------------------------------------------------------

function checkEvidence(e) {
  const bad = [];
  if (typeof e?.check_id !== 'string' || !e.check_id) bad.push('check_id');
  if (!SHA_RE.test(e?.sha ?? '')) bad.push('sha');
  if (!Array.isArray(e?.command) || !e.command.length || !e.command.every((s) => typeof s === 'string')) bad.push('command (argv)');
  if (!(e?.exit === null || Number.isInteger(e?.exit))) bad.push('exit (integer, null = unknown)');
  if (!(e?.duration_ms === null || (typeof e?.duration_ms === 'number' && e.duration_ms >= 0))) bad.push('duration_ms');
  if (!(e?.artifact === null || typeof e?.artifact === 'string')) bad.push('artifact');
  if (!actorKey(e?.actor)) bad.push('actor (needs an id)');
  if (bad.length) fail('E_INVALID', `evidence: invalid ${bad.join(', ')}`);
}

function checkVerdict(v) {
  const hasActor = (typeof v?.actor === 'string' && v.actor.trim()) || (v?.actor && typeof v.actor === 'object');
  if (!SHA_RE.test(v?.sha ?? '') || !hasActor || !['approve', 'reject'].includes(v?.verdict) || !Array.isArray(v?.findings)) {
    fail('E_INVALID', 'verdict needs { sha, actor, verdict: approve|reject, findings[] }');
  }
}

// Unknown usage stays null, never 0 (T22/GL13).
export function normalizeUsage(u = {}) {
  for (const k of Object.keys(u)) if (!USAGE_KEYS.has(k)) fail('E_INVALID', `usage: unknown field ${k}`);
  const out = { runtime: u.runtime ?? null, provider: u.provider ?? null, model: u.model ?? null, run_id: u.run_id ?? null };
  const unknown = new Set(Array.isArray(u.unknown) ? u.unknown : []);
  for (const k of USAGE_NUM) {
    const v = u[k];
    if (v === undefined || v === null) { out[k] = null; unknown.add(k); continue; }
    if (unknown.has(k)) fail('E_INVALID', `usage: ${k} is listed as unknown but has a value`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail('E_INVALID', `usage: ${k} must be a non-negative number or null`);
    out[k] = v;
  }
  out.unknown = [...unknown].sort();
  if (u.ts !== undefined) out.ts = u.ts;
  if (u.attempt_id !== undefined) out.attempt_id = u.attempt_id;
  if (u.source !== undefined) out.source = u.source;
  // The runtime said its counts are partial (e.g. MiniMax usageIncomplete): totals must not look complete.
  if (u.incomplete !== undefined) {
    if (typeof u.incomplete !== 'boolean') fail('E_INVALID', 'usage: incomplete must be a boolean');
    out.incomplete = u.incomplete;
  }
  return out;
}

// No records means nothing was measured, which is unknown, not zero.
export function usageTotals(records) {
  const t = { records: records.length };
  for (const k of USAGE_NUM) t[k] = !records.length || records.some((r) => r[k] === null) ? null : records.reduce((s, r) => s + r[k], 0);
  t.unknown = USAGE_NUM.filter((k) => t[k] === null);
  if (records.some((r) => r.incomplete === true)) t.incomplete = true;
  return t;
}

// ---- acceptance guard -----------------------------------------------------------------------------

// Why `accepted` is not allowed yet, or [] when it is. Fail closed on anything not observed.
export function acceptanceUnmet(st) {
  const why = [];
  const head = st.head_sha;
  if (!head) return ['head SHA unknown: call setHead with the candidate commit'];
  const devs = new Set(st.head_actors[head] || []);
  if (!devs.size) why.push(`no developer actor recorded for ${head}: independence cannot be shown`);
  const current = (r) => r.sha === head && r.epoch === st.head_epoch;
  for (const c of st.task.acceptance_checks.filter((x) => x.required)) {
    const ok = st.evidence.some((e) => current(e) && e.check_id === c.id && e.exit === c.expect.exit);
    if (!ok) why.push(`required check ${c.id}: no passing evidence on current head ${head}`);
  }
  const latest = new Map();
  // A verdict from an actor without an id has no identity: its approve never counts, its reject still blocks.
  const rawRejects = new Map();   // raw trimmed id -> latest verdict: a differently spelled id never clears a reject
  for (const v of st.verdicts.filter(current)) {
    if (actorKey(v.actor)) { latest.set(actorKey(v.actor), v.verdict); rawRejects.set(rawId(v.actor), v.verdict); }
    else if (v.verdict === 'reject') why.push(`an actor without id rejects ${head}`);
  }
  for (const [a, v] of rawRejects) if (v === 'reject' && !devs.has(actorKey(a)) && latest.get(actorKey(a)) !== 'reject') why.push(`verifier ${a} rejects ${head}`);
  const independent = [...latest].filter(([a]) => !devs.has(a));
  if (!independent.some(([, v]) => v === 'approve')) {
    why.push([...latest].some(([a, v]) => devs.has(a) && v === 'approve')
      ? 'only a developer of this SHA approved it: self-approval does not count'
      : `no independent approve verdict on ${head}`);
  }
  for (const [a, v] of independent) if (v === 'reject') why.push(`verifier ${a} rejects ${head}`);
  for (const e of Object.values(st.effects)) if (UNRESOLVED.includes(e.phase)) why.push(`effect ${e.effect_id} is ${e.phase}, not reconciled`);
  return why;
}

// ---- reducer: validate an event against state, return the commit (no mutation before the log write) ----

function step(st, ev) {
  const p = ev.payload;
  if (ev.kind === 'task.created') {
    if (st.task) fail('E_EXISTS', `task ${ev.task_id} already exists`);
    const v = validateTask(p.task);
    if (!v.ok) fail('E_INVALID_TASK', 'invalid task', v.errors);
    if (p.task.status !== 'created' || p.task.task_id !== ev.task_id) fail('E_INVALID_TASK', 'a new task starts in created under its own id');
    return () => { st.task = structuredClone(p.task); st.idempotency_key = p.idempotency_key ?? null; };
  }
  if (!st.task) fail('E_NOT_FOUND', `task ${ev.task_id} not found`);

  if (ev.kind in TRANSITION_KINDS) {
    const to = p.to ?? TRANSITION_KINDS[ev.kind];
    const from = st.task.status;
    if (TRANSITION_KINDS[ev.kind] && to !== TRANSITION_KINDS[ev.kind]) fail('E_INVALID_EVENT', `${ev.kind} must go to ${TRANSITION_KINDS[ev.kind]}`);
    if (p.from !== undefined && p.from !== from) fail('E_ILLEGAL_TRANSITION', `event expects ${p.from}, task is ${from}`);
    assertTransition(from, to);
    if (to === 'accepted') {
      const why = acceptanceUnmet(st);
      if (why.length) fail('E_ACCEPTANCE_UNMET', why.join('; '), why);
    }
    if (from === 'unknown_external_effect' && to !== 'cancelled') {
      const open = Object.values(st.effects).filter((e) => UNRESOLVED.includes(e.phase));
      if (open.length) fail('E_EFFECT_UNRECONCILED', `reconcile ${open.map((e) => e.effect_id).join(', ')} first`);
    }
    return () => {
      st.task.status = to;
      st.history.push({ from, to, reason: p.reason ?? null, actor: p.actor ?? null, ts: ev.timestamp, event_id: ev.event_id });
    };
  }
  switch (ev.kind) {
    case 'task.head_changed': {
      if (!SHA_RE.test(p.sha ?? '')) fail('E_INVALID', 'head sha must be a hex commit sha');
      // The actor is the developer who produced this SHA; acceptance compares verifiers against it. An actor
      // without an id is kept in the log but records no developer, so acceptance stays unmet (fail closed).
      const actor = p.actor == null ? null : actorKey(p.actor);
      return () => {
        if (p.sha !== st.head_sha) { st.head_sha = p.sha; st.head_epoch += 1; }   // older evidence no longer counts
        if (actor) st.head_actors[p.sha] = [...new Set([...(st.head_actors[p.sha] || []), actor])];
      };
    }
    case 'evidence.recorded':
      checkEvidence(p);
      return () => { st.evidence.push({ ...structuredClone(p), epoch: st.head_epoch, event_id: ev.event_id }); };
    case 'verification.passed': case 'verification.failed': {
      if (p.verdict === undefined) return () => {};   // plain verification signal, not a verdict
      checkVerdict(p);
      if ((p.verdict === 'approve') !== (ev.kind === 'verification.passed')) fail('E_INVALID_EVENT', 'verdict does not match event kind');
      return () => { st.verdicts.push({ ...structuredClone(p), epoch: st.head_epoch, ts: ev.timestamp, event_id: ev.event_id }); };
    }
    case 'decision.recorded': {
      const v = validateDecision(p);
      if (!v.ok) fail('E_INVALID', 'invalid decision', v.errors);
      if (p.task_id !== ev.task_id) fail('E_INVALID', 'decision belongs to another task');
      return () => { st.decisions.push(structuredClone(p)); };
    }
    case 'usage.recorded': {
      const u = normalizeUsage(p);
      return () => { st.usage.push({ ...u, ts: u.ts ?? ev.timestamp }); };
    }
    case 'action.attempted': case 'action.confirmed': case 'action.unknown': case 'action.failed': {
      const phase = PHASE_OF[ev.kind];
      const { effect_id, idempotency_key, kind } = p;
      if (typeof effect_id !== 'string' || !effect_id) fail('E_INVALID', 'effect_id required');
      if (p.phase !== undefined && p.phase !== phase) fail('E_INVALID_EVENT', `phase ${p.phase} does not match ${ev.kind}`);
      const cur = st.effects[effect_id];
      if (phase === 'attempted') {
        if (cur) fail('E_EFFECT_EXISTS', `effect ${effect_id} already recorded`);
        if (typeof idempotency_key !== 'string' || !idempotency_key || typeof kind !== 'string' || !kind) {
          fail('E_INVALID', 'an attempted effect needs idempotency_key and kind');
        }
        for (const e of Object.values(st.effects).filter((x) => x.idempotency_key === idempotency_key)) {
          if (e.phase === 'confirmed') fail('E_EFFECT_DUPLICATE', `${idempotency_key} already confirmed as ${e.effect_id}`);
          if (UNRESOLVED.includes(e.phase)) fail('E_EFFECT_UNRECONCILED', `${idempotency_key} is ${e.phase} as ${e.effect_id}: reconcile, do not repeat`);
        }
      } else if (!cur || !UNRESOLVED.includes(cur.phase) || cur.phase === phase) {
        fail('E_ILLEGAL_EFFECT', `effect ${effect_id}: ${cur?.phase ?? 'missing'} -> ${phase}`);
      }
      return () => {
        const e = st.effects[effect_id] ||= { effect_id, idempotency_key, kind, phase, history: [] };
        e.phase = phase;
        e.history.push({ phase, ts: ev.timestamp, event_id: ev.event_id });
      };
    }
    case 'policy.snapshot': {
      const cur = st.policy_snapshot;
      const hash = hashOf(p.policy);   // never trust a supplied hash
      if (cur && cur.run_id === (p.run_id ?? null) && cur.hash !== hash) fail('E_POLICY_IMMUTABLE', 'policy snapshot is immutable within a run');
      return () => { st.policy_snapshot = deepFreeze({ run_id: p.run_id ?? null, hash, policy: structuredClone(p.policy), ts: ev.timestamp }); };
    }
    default:
      return () => {};   // logged and deduplicated, no derived state
  }
}

function view(st) {
  const v = structuredClone({ ...st.task, head_sha: st.head_sha, seq: st.seq, evidence: st.evidence, verdicts: st.verdicts,
    decisions: st.decisions, usage: st.usage, effects: Object.values(st.effects), history: st.history,
    policy_snapshot: st.policy_snapshot, idempotency_key: st.idempotency_key });
  // A task whose log could not be replayed is not in a known state, whatever the partial replay says.
  v.outcome = st.store_error ? 'unknown' : outcomeOf(st.task.status);
  v.store_error = st.store_error;
  v.recovery_pending = st.recovery_pending;   // set by a read-only open: run recover() before writing
  v.usage_totals = usageTotals(st.usage);
  return v;
}

// ---- store ----------------------------------------------------------------------------------------

export function createTaskStore({ dir = defaultStoreDir(), fs = realFs, now = () => Date.now(), randomId = () => randomUUID() } = {}) {
  const tasksDir = join(dir, 'tasks');
  const tasks = new Map();
  const idem = new Map();
  const broken = new Map();   // task_id -> why: a failed write leaves the file state uncertain until recover()
  const locks = new Map();
  let initP = null;

  const withLock = (key, fn) => {
    const run = (locks.get(key) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  };

  function fsyncDir(d) {
    let fd;
    try { fd = fs.openSync(d, 'r'); fs.fsyncSync(fd); } catch (e) { if (!['EISDIR', 'EINVAL', 'EPERM'].includes(e.code)) throw e; } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function writeAtomic(path, data) {
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, path);
    fsyncDir(join(path, '..'));
  }
  function appendLine(id, ev) {
    const fd = fs.openSync(join(tasksDir, id, 'events.jsonl'), 'a');
    try { fs.writeSync(fd, `${JSON.stringify(ev)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const saveSnapshot = (id) => writeAtomic(join(tasksDir, id, 'snapshot.json'), `${JSON.stringify(view(tasks.get(id)), null, 1)}\n`);
  function saveIndex() {
    const out = { schema_version: SCHEMA_VERSION, tasks: {}, idempotency: Object.fromEntries(idem) };
    for (const [id, st] of tasks) {
      out.tasks[id] = { status: st.task.status, project_id: st.task.project_id, parent_task_id: st.task.parent_task_id ?? null, seq: st.seq };
    }
    writeAtomic(join(dir, 'index.json'), `${JSON.stringify(out, null, 1)}\n`);
  }

  // Single write path: dedup -> cancel guard -> seq -> validate -> log+fsync -> apply -> caches -> ack.
  function write(st, ev, { internal = false } = {}) {
    const id = ev.task_id;
    if (broken.has(id)) fail('E_STORE_FAILED', `task ${id} needs recover(): ${broken.get(id)}`);
    if (st.recovery_pending && !internal) fail('E_STORE_FAILED', `task ${id} needs recover(): ${st.recovery_pending}`);
    if (st.ids.has(ev.event_id)) return { applied: false, event_id: ev.event_id };
    const status = st.task?.status;
    if (TERMINAL.includes(status) && !internal && !AFTER_TERMINAL_OK.has(ev.kind)) {
      fail(status === 'cancelled' ? 'E_CANCELLED' : 'E_TERMINAL', `task ${id} is ${status}`);
    }
    // seq is dense: an explicit seq must be the next one, so it cannot skip ahead or overflow.
    const next = st.seq + 1;
    if (ev.seq === null) ev = { ...ev, seq: next };
    if (ev.seq !== next || !Number.isSafeInteger(ev.seq)) fail('E_SEQ', `seq ${ev.seq} is not the next seq ${next}`);
    const v = validateEvent(ev, { requireSeq: true });
    if (!v.ok) fail('E_INVALID_EVENT', 'invalid event', v.errors);
    const commit = step(st, ev);
    const before = st.task?.status;
    try { appendLine(id, ev); } catch (e) { broken.set(id, st.store_error = `log write failed: ${e.message}`); throw e; }
    commit();
    if (ev.kind === 'task.created' && st.idempotency_key != null) idem.set(st.idempotency_key, id);
    st.seq = ev.seq;
    st.ids.add(ev.event_id);
    st.task.updated_at = ev.timestamp;
    saveSnapshot(id);
    if (ev.kind === 'task.created' || st.task.status !== before) saveIndex();
    return { applied: true, event_id: ev.event_id, seq: ev.seq };
  }

  const stateOf = (id) => tasks.get(id) || fail('E_NOT_FOUND', `task ${id} not found`);
  // A failed recovery is retried by the next call instead of poisoning the store forever. The implicit open on first
  // access is READ-ONLY (D-016): it replays the logs but writes nothing (no truncation, no recovery events, no
  // snapshots), so merely reading a store another controller is writing cannot reconcile that controller's live run.
  // Tasks that need reconciliation (torn tail, unconfirmed effect) refuse writes until an explicit recover().
  let full = false;   // has a writing recover() run in this handle?
  const start = (opts = {}) => { if (!opts.readOnly) full = true; return (initP = recover(opts).catch((e) => { initP = null; if (!opts.readOnly) full = false; throw e; })); };
  const ensure = () => initP || start({ readOnly: true });
  // Every mutation: wait for recovery, take the task lock, write one event.
  const mutate = (id, fields, opts) => ensure().then(() => withLock(id, () =>
    write(stateOf(id), makeEvent({ ...fields, task_id: id }, { now, randomId }), opts)));

  function readLog(path) {
    const buf = fs.readFileSync(path);
    const end = buf.lastIndexOf(0x0a) + 1;   // anything after the last newline is a torn, unacknowledged write
    const events = [];
    let corrupt = null;
    const lines = buf.subarray(0, end).toString('utf8').split('\n').slice(0, -1);
    for (let i = 0; i < lines.length; i++) {
      try {
        const ev = JSON.parse(lines[i]);
        const v = validateEvent(ev, { requireSeq: true });
        if (!v.ok) throw new Error(v.errors.map((x) => `${x.path}: ${x.message}`).join('; '));
        events.push(ev);
      } catch (e) { corrupt = { line: i + 1, error: e.message }; break; }
    }
    return { events, goodBytes: end, tornBytes: buf.length - end, corrupt };
  }

  async function recover({ readOnly = false } = {}) {
    tasks.clear(); idem.clear(); broken.clear();
    const torn = [], corrupt = [], pendingEffects = [];
    if (readOnly && !fs.existsSync(tasksDir)) return { tasks: [], torn, corrupt, pendingEffects, read_only: true };
    if (!readOnly) {
      fs.mkdirSync(tasksDir, { recursive: true });
      for (const f of fs.readdirSync(dir)) if (/^index\.json\..*\.tmp$/.test(f)) fs.rmSync(join(dir, f), { force: true });
    }
    for (const id of fs.readdirSync(tasksDir).sort()) {
      const tdir = join(tasksDir, id), log = join(tdir, 'events.jsonl');
      if (!ID_RE.test(id) || !fs.statSync(tdir).isDirectory()) continue;
      if (!readOnly) for (const f of fs.readdirSync(tdir)) if (f.endsWith('.tmp')) fs.rmSync(join(tdir, f), { force: true });
      if (!fs.existsSync(log)) continue;
      const r = readLog(log);
      if (r.tornBytes && !readOnly) {
        fs.truncateSync(log, r.goodBytes);
        const fd = fs.openSync(log, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      const st = blank();
      for (const ev of r.events) {
        try {
          if (st.ids.has(ev.event_id) || ev.seq !== st.seq + 1) throw new Error(`duplicate event or seq gap at ${ev.seq}`);
          step(st, ev)();
          st.seq = ev.seq; st.ids.add(ev.event_id);
          if (st.task) st.task.updated_at = ev.timestamp;
        } catch (e) { r.corrupt = { line: ev.seq, error: e.message }; break; }
      }
      if (!st.task) continue;   // creation never acknowledged
      tasks.set(id, st);
      if (st.idempotency_key) idem.set(st.idempotency_key, id);
      if (r.corrupt) { corrupt.push({ task_id: id, ...r.corrupt }); broken.set(id, st.store_error = `corrupt log: ${r.corrupt.error}`); continue; }
      if (r.tornBytes && readOnly) { st.recovery_pending = 'torn tail'; torn.push({ task_id: id, dropped_bytes: r.tornBytes }); }
      else if (r.tornBytes) {
        torn.push({ task_id: id, dropped_bytes: r.tornBytes });
        write(st, makeEvent({ task_id: id, kind: 'recovery.torn_tail', payload: { recovered_torn_tail: true, dropped_bytes: r.tornBytes } }, { now, randomId }), { internal: true });
      }
    }
    // An effect attempted but never confirmed may or may not have happened: never repeat it blindly.
    for (const [id, st] of tasks) {
      if (broken.has(id)) continue;
      const open = Object.values(st.effects).filter((e) => UNRESOLVED.includes(e.phase));
      if (!open.length) continue;
      if (readOnly) {
        // S2: pending whenever a full recover() would write: an attempted effect (-> possibly_applied), or any open
        // effect on a task it would park in unknown_external_effect.
        const from = st.task.status;
        const wouldPark = !TERMINAL.includes(from) && from !== 'unknown_external_effect' && canTransition(from, 'unknown_external_effect');
        if (open.some((x) => x.phase === 'attempted') || wouldPark) st.recovery_pending ??= 'unconfirmed effect';
        for (const e of open) pendingEffects.push({ task_id: id, effect_id: e.effect_id, idempotency_key: e.idempotency_key, kind: e.kind, phase: e.phase, state: st.task.status, moved: false });
        continue;
      }
      for (const e of open.filter((x) => x.phase === 'attempted')) {
        write(st, makeEvent({ task_id: id, kind: 'action.unknown', event_id: `recover:${e.effect_id}:possibly_applied`,
          payload: { effect_id: e.effect_id, reason: 'restart before confirmation' } }, { now, randomId }), { internal: true });
      }
      const from = st.task.status;
      let moved = false;
      if (!TERMINAL.includes(from) && from !== 'unknown_external_effect' && canTransition(from, 'unknown_external_effect')) {
        write(st, makeEvent({ task_id: id, kind: 'task.transitioned', event_id: `recover:${id}:${open[0].effect_id}`,
          payload: { from, to: 'unknown_external_effect', reason: 'unconfirmed external effect at restart', actor: 'store.recover' } },
        { now, randomId }), { internal: true });
        moved = true;
      }
      for (const e of open) pendingEffects.push({ task_id: id, effect_id: e.effect_id, idempotency_key: e.idempotency_key,
        kind: e.kind, phase: st.effects[e.effect_id].phase, state: st.task.status, moved });
    }
    if (readOnly) return { tasks: [...tasks.keys()], torn, corrupt, pendingEffects, read_only: true };
    // Broken tasks get a snapshot too, so an external reader sees store_error rather than a stale healthy state.
    for (const id of tasks.keys()) { if (!broken.has(id)) saveSnapshot(id); else if (tasks.get(id).task) { try { saveSnapshot(id); } catch { /* reported by recover() */ } } }
    saveIndex();
    return { tasks: [...tasks.keys()], torn, corrupt, pendingEffects };
  }

  return {
    dir,
    init: () => (full && initP) || start(),   // explicit open by the store's owner: full (writing) recovery, once
    recover: () => start(),   // replays from disk and reconciles (writes); call at startup under the controller lease

    createTask: (spec, { idempotencyKey } = {}) => ensure().then(() => withLock('\0create', () => {
      if (idempotencyKey != null && idem.has(idempotencyKey)) return view(tasks.get(idem.get(idempotencyKey)));
      const task = normalizeTask(spec, { now, randomId });
      const v = validateTask(task);
      if (!v.ok) fail('E_INVALID_TASK', `invalid task: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`, v.errors);
      if (!ID_RE.test(task.task_id)) fail('E_INVALID_TASK', 'task_id must be [A-Za-z0-9._-], max 128');
      if (task.status !== 'created') fail('E_INVALID_TASK', 'a new task starts in created');
      if (tasks.has(task.task_id)) fail('E_EXISTS', `task ${task.task_id} already exists`);
      if (task.parent_task_id) {
        const parent = stateOf(task.parent_task_id).task;
        if (TERMINAL.includes(parent.status)) fail(parent.status === 'cancelled' ? 'E_CANCELLED' : 'E_TERMINAL', `parent ${parent.task_id} is ${parent.status}`);
        const n = narrowsParent(parent, task);
        if (!n.ok) fail('E_NARROWING', 'subtask weakens parent constraints', n.violations);
      }
      fs.mkdirSync(join(tasksDir, task.task_id), { recursive: true });
      fsyncDir(tasksDir);
      const st = blank();
      tasks.set(task.task_id, st);
      try {
        write(st, makeEvent({ task_id: task.task_id, kind: 'task.created', payload: { task, idempotency_key: idempotencyKey ?? null } }, { now, randomId }));
      } catch (e) { if (!st.task) tasks.delete(task.task_id); throw e; }
      return view(st);
    })),

    get: async (id) => { await ensure(); const st = tasks.get(id); return st ? view(st) : null; },
    // Read-only event log (validated lines, in seq order) for controllers that need run/approval history.
    events: async (id) => {
      await ensure();
      const st = stateOf(id);
      if (st.store_error) fail('E_STORE_FAILED', `task ${id}: ${st.store_error}`);   // a partial log is not the history
      return readLog(join(tasksDir, id, 'events.jsonl')).events;
    },
    // Independence on a SHA from the store's own record of who produced it, never from caller-supplied fields.
    independence: async (id, sha) => {
      await ensure();
      const st = stateOf(id);
      if (st.store_error) return { ok: false, reasons: [`store error: ${st.store_error}`], developers: [], approvers: [] };
      if (!sha || sha !== st.head_sha) return { ok: false, reasons: [`${sha} is not the current head`], developers: [], approvers: [] };
      const devs = new Set(st.head_actors[sha] || []);
      const latest = new Map();
      let anonReject = false;
      const rawRejects = new Map();
      for (const v of st.verdicts.filter((r) => r.sha === sha && r.epoch === st.head_epoch)) {
        if (actorKey(v.actor)) { latest.set(actorKey(v.actor), v.verdict); rawRejects.set(rawId(v.actor), v.verdict); }
        else if (v.verdict === 'reject') anonReject = true;
      }
      for (const [a, v] of rawRejects) if (v === 'reject' && !devs.has(actorKey(a)) && latest.get(actorKey(a)) !== 'reject') latest.set(`raw:${a}`, 'reject');
      const approvers = [...latest].filter(([a, v]) => !devs.has(a) && v === 'approve').map(([a]) => a);
      const reasons = [];
      if (!devs.size) reasons.push(`no developer recorded for ${sha}`);
      if (!approvers.length) reasons.push(`no independent approve on ${sha}`);
      for (const [a, v] of latest) if (!devs.has(a) && v === 'reject') reasons.push(`verifier ${a} rejects ${sha}`);
      if (anonReject) reasons.push(`an actor without id rejects ${sha}`);
      return { ok: !reasons.length, reasons, developers: [...devs], approvers };
    },
    list: async ({ state, project_id, parent_task_id } = {}) => {
      await ensure();
      return [...tasks.values()].filter((st) => (state === undefined || st.task.status === state)
        && (project_id === undefined || st.task.project_id === project_id)
        && (parent_task_id === undefined || (st.task.parent_task_id ?? null) === parent_task_id)).map(view);
    },

    append: (id, event) => ensure().then(() => withLock(id, () => {
      if (!event?.event_id) fail('E_INVALID_EVENT', 'append needs an event_id (it is the dedup key)');
      if (event.task_id !== undefined && event.task_id !== id) fail('E_INVALID_EVENT', 'event task_id mismatch');
      return write(stateOf(id), makeEvent({ ...event, task_id: id }, { now, randomId }));
    })),

    transition: (id, to, { reason, actor, causation_id, event_id } = {}) => {
      const kind = to === 'cancelled' ? 'task.cancelled' : to === 'accepted' ? 'task.completed' : 'task.transitioned';
      return ensure().then(() => withLock(id, () => {
        const st = stateOf(id);
        return write(st, makeEvent({ task_id: id, kind, event_id, causation_id,
          payload: { from: st.task.status, to, reason: reason ?? null, actor: actor ?? null } }, { now, randomId }));
      }));
    },

    // `actor` is the developer who produced `sha` (needs an id); without one, acceptance cannot show independence.
    setHead: (id, sha, { actor, event_id } = {}) => mutate(id, { kind: 'task.head_changed', event_id, payload: { sha, actor: actor ?? null } }),

    recordEvidence: (id, e = {}, { event_id } = {}) => mutate(id, { kind: 'evidence.recorded', event_id, payload: {
      check_id: e.check_id, sha: e.sha, command: e.command, exit: e.exit === undefined ? null : e.exit,
      duration_ms: e.duration_ms ?? null, artifact: e.artifact ?? null, actor: e.actor, ts: e.ts ?? new Date(now()).toISOString() } }),

    recordVerdict: (id, v = {}, { event_id } = {}) => mutate(id, {
      kind: v.verdict === 'approve' ? 'verification.passed' : 'verification.failed', event_id,
      payload: { sha: v.sha, actor: v.actor, verdict: v.verdict, findings: v.findings ?? [] } }),

    recordDecision: async (id, d) => {
      const dec = normalizeDecision(d, { task_id: id, now, randomId });
      return mutate(id, { kind: 'decision.recorded', event_id: `decision:${dec.decision_id}`, payload: dec });
    },

    recordUsage: async (id, u, { event_id } = {}) => mutate(id, { kind: 'usage.recorded', event_id, payload: normalizeUsage(u) }),

    // Deterministic event ids make a replayed effect record a no-op (T06).
    recordEffect: async (id, { effect_id, idempotency_key, kind, phase } = {}) => {
      if (!EFFECT_KIND[phase]) fail('E_INVALID', `phase must be one of ${Object.keys(EFFECT_KIND).join(', ')}`);
      return mutate(id, { kind: EFFECT_KIND[phase], event_id: `effect:${effect_id}:${phase}`, payload: { effect_id, idempotency_key, kind, phase } });
    },

    // Immutable within a run; a new run_id refreshes it (policy is re-read at the start of every run).
    snapshotPolicy: async (id, policy, { run_id = null } = {}) => {
      const hash = hashOf(policy);
      return mutate(id, { kind: 'policy.snapshot', run_id, event_id: `policy:${run_id}:${hash}`, payload: { run_id, hash, policy } });
    },
  };
}
