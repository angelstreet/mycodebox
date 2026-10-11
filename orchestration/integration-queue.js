// V2 integration queue (spec §12.3, docs/v2/ARCHITECTURE.md §11): durable FIFO of developer handoffs per
// (repo, target). Append-only JSONL (fsync per line, persisted before acknowledging), replayed on open; a torn
// last line is dropped and recorded. Single writer per directory: the first instance that mutates takes an
// exclusive owner lock (O_EXCL file with pid/host/nonce); any other instance, in this or another process, is
// read-only and gets E_BUSY on a write. A lock whose pid is dead on this host is taken over; a lock from another
// host is never guessed stale. The `repo:<repo>:integration` lease stays the authority for the lane itself.
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

const coded = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });

// queued -> running -> one of the outcomes below. Parked states wait for an input (approval, CI, lease) and are
// picked up again in FIFO order; final states never run again.
export const ITEM_STATES = Object.freeze(['queued', 'running', 'blocked', 'awaiting_approval', 'unknown', 'merged',
  'returned', 'rejected', 'cancelled']);
export const ELIGIBLE = Object.freeze(['queued', 'blocked', 'awaiting_approval', 'unknown']);
export const FINAL = Object.freeze(['merged', 'returned', 'rejected', 'cancelled']);

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function createIntegrationQueue({ dir, fs = realFs, now = () => Date.now(), randomId = () => randomUUID(), host = hostname() } = {}) {
  if (!dir) throw coded('E_CONFIG', 'integration queue: dir required');
  const log = join(dir, 'queue.jsonl');
  const lockPath = join(dir, 'owner.lock');
  const nonce = String(randomId());
  let writer = false;
  const items = new Map();   // item_id -> item; Map keeps insertion (= enqueue) order
  const keys = new Map();    // idempotency key -> item_id
  let seq = 0;
  let chain = Promise.resolve();
  // Serialize mutations in this process: read-check-append-apply must not interleave.
  const serial = (fn) => { const r = chain.then(fn); chain = r.catch(() => {}); return r; };

  function apply(rec) {
    seq = Math.max(seq, rec.seq);
    if (rec.op === 'note') return;
    if (rec.op === 'enqueue') {
      items.set(rec.item.item_id, { ...rec.item, history: [{ state: 'queued', ts: rec.ts }] });
      if (rec.item.idempotency_key) keys.set(rec.item.idempotency_key, rec.item.item_id);
      return;
    }
    const it = items.get(rec.item_id);
    if (!it) throw coded('E_QUEUE_CORRUPT', `record for unknown item ${rec.item_id}`);
    it.state = rec.state;
    it.updated_at = rec.ts;
    if (rec.state === 'running') { it.attempts = (it.attempts || 0) + 1; it.owner = rec.owner ?? null; }
    if (rec.reason !== undefined) it.reason = rec.reason;
    if (rec.detail !== undefined) it.detail = rec.detail;
    it.history.push({ state: rec.state, ts: rec.ts, owner: rec.owner ?? null, reason: rec.reason ?? null });
  }

  function append(rec) {
    const fd = fs.openSync(log, 'a', 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(rec)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  // Read-only replay; a torn tail is ignored in memory and only cut by the writer.
  function load() {
    items.clear(); keys.clear(); seq = 0;
    fs.mkdirSync(dir, { recursive: true });
    let buf;
    try { buf = fs.readFileSync(log); } catch (e) { if (e.code === 'ENOENT') return { end: 0, torn: 0 }; throw e; }
    const end = buf.lastIndexOf(0x0a) + 1;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { throw coded('E_QUEUE_CORRUPT', 'unparseable queue record'); }
      apply(rec);
    }
    return { end, torn: buf.length - end };
  }

  function takeLock() {
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 2; i++) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, host, nonce, at: now() })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        return;
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
      let cur = null;
      try { cur = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { cur = null; }
      if (cur?.nonce === nonce) return;
      // Only a lock provably left by a dead process on this host is taken over; anything unclear stays busy.
      if (!(cur && cur.host === host && Number.isInteger(cur.pid) && !pidAlive(cur.pid))) {
        throw coded('E_BUSY', `E_BUSY: queue ${dir} is owned by another writer (pid ${cur?.pid ?? '?'} on ${cur?.host ?? '?'})`);
      }
      const aside = `${lockPath}.stale-${nonce}`;
      try { fs.renameSync(lockPath, aside); fs.rmSync(aside, { force: true }); } catch { /* raced: retry once */ }
    }
    throw coded('E_BUSY', `E_BUSY: queue ${dir}: could not take the owner lock`);
  }

  // Become the single writer: lock, replay from disk, cut a torn tail, park runs interrupted by a crash.
  function claim() {
    if (writer) return { items: items.size, torn: 0, interrupted: [] };
    takeLock();
    writer = true;
    const { end, torn } = load();
    if (torn) {   // never acknowledged: drop it so the next append starts on a clean line
      fs.truncateSync(log, end);
      const fd = fs.openSync(log, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    // A run that was in flight at a crash may have changed the remote: it needs reconciliation, not a fresh start.
    const interrupted = [];
    for (const it of items.values()) {
      if (it.state !== 'running') continue;
      const rec = { seq: seq + 1, ts: new Date(now()).toISOString(), op: 'state', item_id: it.item_id, state: 'unknown', reason: 'interrupted while running' };
      append(rec); apply(rec); interrupted.push(it.item_id);
    }
    if (torn) {
      const rec = { seq: seq + 1, ts: new Date(now()).toISOString(), op: 'note', recovered_torn_tail: true, dropped_bytes: torn };
      append(rec); seq = rec.seq;
    }
    return { items: items.size, torn, interrupted };
  }
  // Readers re-read the log on every call (the writer may be another process); the writer's memory is authoritative.
  const ensure = () => Promise.resolve().then(() => { if (!writer) load(); });
  const ensureWriter = () => Promise.resolve().then(() => claim());

  const view = (it) => (it ? structuredClone(it) : null);
  const laneOf = (it) => `${it.repo}\0${it.target}`;
  const runningIn = (repo, target) => [...items.values()].find((x) => x.state === 'running' && x.repo === repo && x.target === target) || null;

  function setState(item_id, state, { owner, reason, detail, from } = {}) {
    const it = items.get(item_id);
    if (!it) throw coded('E_NOT_FOUND', `queue item ${item_id} not found`);
    if (!ITEM_STATES.includes(state)) throw coded('E_INVALID', `unknown item state ${state}`);
    if (FINAL.includes(it.state)) throw coded('E_ILLEGAL_TRANSITION', `item ${item_id} is ${it.state}`);
    if (from && !from.includes(it.state)) throw coded('E_ILLEGAL_TRANSITION', `item ${item_id} is ${it.state}, expected ${from.join('|')}`);
    const rec = { seq: seq + 1, ts: new Date(now()).toISOString(), op: 'state', item_id, state };
    if (owner !== undefined) rec.owner = owner;
    if (reason !== undefined) rec.reason = reason;
    if (detail !== undefined) rec.detail = detail;
    append(rec); apply(rec);
    return view(it);
  }

  return {
    dir,
    init: ensure,
    claim: ensureWriter,
    // Release the owner lock (only ours) so another instance can write.
    close: async () => {
      if (!writer) return;
      try { if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).nonce === nonce) fs.unlinkSync(lockPath); } catch { /* already gone */ }
      writer = false;
    },

    // Same idempotency key -> same item (a re-sent handoff never queues twice).
    enqueue: (handoff, { idempotencyKey } = {}) => ensureWriter().then(() => serial(() => {
      const key = idempotencyKey ?? null;
      // A key whose item is final (rejected, returned, merged...) does not pin the handoff: queue it again.
      if (key && keys.has(key) && !FINAL.includes(items.get(keys.get(key)).state)) return view(items.get(keys.get(key)));
      for (const k of ['task_id', 'repo', 'target']) if (typeof handoff?.[k] !== 'string' || !handoff[k]) throw coded('E_INVALID', `handoff.${k} required`);
      const ts = new Date(now()).toISOString();
      const item = { item_id: `iq-${randomId()}`, task_id: handoff.task_id, repo: handoff.repo, target: handoff.target,
        state: 'queued', enqueued_at: ts, updated_at: ts, idempotency_key: key, attempts: 0, handoff: structuredClone(handoff) };
      const rec = { seq: seq + 1, ts, op: 'enqueue', item };
      append(rec); apply(rec);
      return view(items.get(item.item_id));
    })),

    get: async (item_id) => { await ensure(); return view(items.get(item_id)); },
    list: async ({ repo, target, state } = {}) => {
      await ensure();
      return [...items.values()].filter((x) => (repo === undefined || x.repo === repo) && (target === undefined || x.target === target)
        && (state === undefined || (Array.isArray(state) ? state.includes(x.state) : x.state === state))).map(view);
    },
    // FIFO among eligible items; nothing while another item of the same lane is running.
    peek: async (repo, target, { limit = 1 } = {}) => {
      await ensure();
      if (runningIn(repo, target)) return [];
      return [...items.values()].filter((x) => x.repo === repo && x.target === target && ELIGIBLE.includes(x.state)).slice(0, limit).map(view);
    },
    // Claim items for one integration run: all-or-nothing, refused while the lane already runs.
    start: (item_ids, { owner } = {}) => ensureWriter().then(() => serial(() => {
      const its = item_ids.map((id) => items.get(id) || (() => { throw coded('E_NOT_FOUND', `queue item ${id} not found`); })());
      const lanes = new Set(its.map(laneOf));
      if (lanes.size !== 1) throw coded('E_INVALID', 'one integration run covers one repo/target');
      const busy = runningIn(its[0].repo, its[0].target);
      if (busy) throw coded('E_BUSY', `E_BUSY: item ${busy.item_id} is already running for ${its[0].repo}/${its[0].target}`);
      for (const it of its) if (!ELIGIBLE.includes(it.state)) throw coded('E_ILLEGAL_TRANSITION', `item ${it.item_id} is ${it.state}`);
      return its.map((it) => setState(it.item_id, 'running', { owner: owner ?? null }));
    })),
    finish: (item_id, state, { reason, detail } = {}) => ensureWriter().then(() => serial(() => {
      if (state === 'running') throw coded('E_INVALID', 'use start() to run an item');
      return setState(item_id, state, { reason: reason ?? null, detail });
    })),
    cancel: (item_id, { reason } = {}) => ensureWriter().then(() => serial(() => setState(item_id, 'cancelled', { reason: reason ?? null }))),
  };
}
