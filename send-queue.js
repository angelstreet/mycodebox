// Queued send: POST /api/send/<session> {keys|key, enter, by, when: 'idle'}. The manager agent hand-polls a busy session
// (relays waited 25+ min for it to stop), so it parks the message instead of typing into a working pane: one queue per
// session in <STATE_DIR>/send-queue.json, max 5 pending, 24 h expiry. The poll loop's tick (server.js tick()) delivers
// the oldest entry of a session that is idle/done with nothing typed, not held and not paused, through the same guarded
// send path as the owner, then records a feed notice. No "when" -> the send is typed straight away, unchanged.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const MAX_PER_SESSION = 5;
export const TTL_MS = 24 * 3600 * 1000;   // a queued message is dropped a day later: a session idle for a day is gone
export const WHEN = 'idle';

// Why free text may not be typed into this pane right now, or null when it may. One gate, two uses: the POST queues
// when it is set, the tick delivers when it is not. `waiting` and an unknown state are blocked too: a live question
// would eat the text as its answer (the same reason noteAllowed / lease-service keeps quiet).
export function blockReason({ status, held = false, paused = false } = {}) {
  if (paused) return 'paused';
  if (held) return 'held';
  if (!status) return 'unknown';
  if (status.stall?.draft) return 'draft';
  if (status.state === 'working') return 'working';
  if (status.state !== 'idle' && status.state !== 'done') return `state:${status.state || 'none'}`;
  return null;
}
// working / a draft / held / paused right now -> queue it for the next idle moment
export const shouldQueue = (ctx) => blockReason(ctx) !== null;
// idle or done, nothing typed, not held, not paused -> the queue may deliver into it
export const shouldDeliver = (ctx) => blockReason(ctx) === null;

// What POST /api/send/<session> does with a body: no `when` -> 'send', whatever the pane is doing (unchanged, the
// message is typed right away and the queue is never touched). when:'idle' -> 'queue' when the pane cannot take the
// text now, 'send' when it can. Any other `when` is a 400.
export function planSend({ when, ctx } = {}) {
  if (when === undefined || when === null || when === '') return { mode: 'send' };
  if (String(when) !== WHEN) throw Object.assign(new Error(`when must be "${WHEN}"`), { status: 400 });
  return shouldQueue(ctx) ? { mode: 'queue' } : { mode: 'send' };
}

export function createSendQueue({ file, now = Date.now, maxPerSession = MAX_PER_SESSION, ttlMs = TTL_MS } = {}) {
  let entries = [];
  let seq = 0;   // insertion counter: entries queued in the same millisecond still keep their order
  const sane = (e) => !!e && typeof e.id === 'string' && e.id && typeof e.session === 'string' && e.session
    && Number.isFinite(e.queuedAt) && Number.isFinite(e.expiresAt)
    && (e.key !== undefined || typeof e.keys === 'string');
  const load = () => {
    try { const j = JSON.parse(readFileSync(file, 'utf8')); entries = Array.isArray(j.entries) ? j.entries.filter(sane) : []; } catch { entries = []; }
    seq = entries.reduce((m, e) => Math.max(m, Number(e.seq) || 0), 0);
  };
  const save = () => { try { writeFileSync(`${file}.tmp`, JSON.stringify({ entries })); renameSync(`${file}.tmp`, file); } catch (e) { console.error('[send-queue] save', e.message); } };
  // oldest first; expired entries go (the file is rewritten, so a restart does not keep them either)
  const live = () => {
    const t = now(), before = entries.length;
    entries = entries.filter((e) => e.expiresAt > t);
    if (entries.length !== before) save();
    return [...entries].sort((a, b) => a.queuedAt - b.queuedAt || (a.seq || 0) - (b.seq || 0));
  };
  const drop = (id) => { const before = entries.length; entries = entries.filter((e) => e.id !== id); if (entries.length !== before) save(); };
  load();

  const view = (e) => ({
    id: e.id, session: e.session, ...(e.key !== undefined ? { key: String(e.key) } : { keys: e.keys }),
    enter: e.enter !== false, by: e.by, queuedAt: e.queuedAt, expiresAt: e.expiresAt,
    ageMin: Math.max(0, Math.round((now() - e.queuedAt) / 60000)),
  });

  return {
    // Park one message for `session`. Refuses (409) once the session already has maxPerSession pending rather than
    // dropping an older message the caller asked for.
    enqueue({ session, key, keys, enter = true, by = 'owner' }) {
      live();
      const pending = entries.filter((e) => e.session === session);
      if (pending.length >= maxPerSession) throw Object.assign(new Error(`queue full for ${session} (max ${maxPerSession} pending)`), { status: 409 });
      const t = now();
      const e = { id: randomUUID(), session, ...(key !== undefined ? { key: String(key) } : { keys: String(keys ?? '') }), enter: enter !== false, by: String(by).slice(0, 40), queuedAt: t, expiresAt: t + ttlMs, seq: ++seq };
      entries.push(e); save();
      return { ...view(e), pending: pending.length + 1 };
    },
    // pending entries, oldest first, optionally of one session
    list(session) { return live().filter((e) => !session || e.session === session).map(view); },
    // drop one entry by id -> the entry that was cancelled, or null
    cancel(id) { live(); const e = entries.find((x) => x.id === id); if (!e) return null; drop(id); return view(e); },
    // The oldest pending entry of a session, or null. Exposed for the UI and tests.
    peek: (session) => live().find((e) => e.session === session) ? view(live().find((e) => e.session === session)) : null,
    pending: (session) => live().filter((e) => e.session === session).length,
    // The poll loop: deliver the oldest entry of every session whose pane is free right now. One entry per session
    // per tick — after a delivery the pane is working again, so the rest wait for the next idle moment.
    async tick({ status, isHeld = () => false, isPaused = () => false, deliver, onDelivered, onError } = {}) {
      const oldest = new Map();
      for (const e of live()) if (!oldest.has(e.session)) oldest.set(e.session, e);
      const sent = [];
      for (const e of oldest.values()) {
        const session = e.session;
        if (!shouldDeliver({ status: status?.(session), held: !!isHeld?.(session), paused: !!isPaused?.(session) })) continue;
        try {
          await deliver(session, e);
          drop(e.id);
          sent.push(view(e));
          onDelivered?.(view(e));
        } catch (err) { onError?.(view(e), err); }   // kept in the queue: a refused pane may be free again
      }
      return sent;
    },
  };
}