// V2 integration queue (spec §12.3, docs/v2/ARCHITECTURE.md §11): durable FIFO of developer handoffs per
// (repo, target). Append-only JSONL (fsync per line, persisted before acknowledging), replayed on open; a torn
// last line is dropped and recorded. One `running` item per target at a time inside a process; across processes
// the `repo:<repo>:integration` lease is the authority, the queue is only the ordered intent.
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const coded = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });

// queued -> running -> one of the outcomes below. Parked states wait for an input (approval, CI, lease) and are
// picked up again in FIFO order; final states never run again.
export const ITEM_STATES = Object.freeze(['queued', 'running', 'blocked', 'awaiting_approval', 'unknown', 'merged',
  'returned', 'rejected', 'cancelled']);
export const ELIGIBLE = Object.freeze(['queued', 'blocked', 'awaiting_approval', 'unknown']);
export const FINAL = Object.freeze(['merged', 'returned', 'rejected', 'cancelled']);

export function createIntegrationQueue({ dir, fs = realFs, now = () => Date.now(), randomId = () => randomUUID() } = {}) {
  if (!dir) throw coded('E_CONFIG', 'integration queue: dir required');
  const log = join(dir, 'queue.jsonl');
  const items = new Map();   // item_id -> item; Map keeps insertion (= enqueue) order
  const keys = new Map();    // idempotency key -> item_id
  let seq = 0;
  let recovered = null;
  let chain = Promise.resolve();
  // Serialize mutations in this process: read-check-append-apply must not interleave.
  const serial = (fn) => { const r = chain.then(fn); chain = r.catch(() => {}); return r; };

  function apply(rec) {
    seq = Math.max(seq, rec.seq);
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

  function recover() {
    items.clear(); keys.clear(); seq = 0;
    fs.mkdirSync(dir, { recursive: true });
    let buf;
    try { buf = fs.readFileSync(log); } catch (e) { if (e.code === 'ENOENT') return { items: 0, torn: 0, interrupted: [] }; throw e; }
    const end = buf.lastIndexOf(0x0a) + 1;
    const torn = buf.length - end;
    if (torn) {   // never acknowledged: drop it so the next append starts on a clean line
      fs.truncateSync(log, end);
      const fd = fs.openSync(log, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { throw coded('E_QUEUE_CORRUPT', 'unparseable queue record'); }
      apply(rec);
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
  const ensure = () => (recovered ||= Promise.resolve().then(recover).catch((e) => { recovered = null; throw e; }));

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
    recover: () => (recovered = Promise.resolve().then(recover)),

    // Same idempotency key -> same item (a re-sent handoff never queues twice).
    enqueue: (handoff, { idempotencyKey } = {}) => ensure().then(() => serial(() => {
      const key = idempotencyKey ?? null;
      if (key && keys.has(key)) return view(items.get(keys.get(key)));
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
    start: (item_ids, { owner } = {}) => ensure().then(() => serial(() => {
      const its = item_ids.map((id) => items.get(id) || (() => { throw coded('E_NOT_FOUND', `queue item ${id} not found`); })());
      const lanes = new Set(its.map(laneOf));
      if (lanes.size !== 1) throw coded('E_INVALID', 'one integration run covers one repo/target');
      const busy = runningIn(its[0].repo, its[0].target);
      if (busy) throw coded('E_BUSY', `item ${busy.item_id} is already running for ${its[0].repo}/${its[0].target}`);
      for (const it of its) if (!ELIGIBLE.includes(it.state)) throw coded('E_ILLEGAL_TRANSITION', `item ${it.item_id} is ${it.state}`);
      return its.map((it) => setState(it.item_id, 'running', { owner: owner ?? null }));
    })),
    finish: (item_id, state, { reason, detail } = {}) => ensure().then(() => serial(() => {
      if (state === 'running') throw coded('E_INVALID', 'use start() to run an item');
      return setState(item_id, state, { reason: reason ?? null, detail });
    })),
    cancel: (item_id, { reason } = {}) => ensure().then(() => serial(() => setState(item_id, 'cancelled', { reason: reason ?? null }))),
  };
}
