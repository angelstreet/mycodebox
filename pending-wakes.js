// Pending wakes (2026-11-02). A wake for a session (an integration result, a lease ticket grant) used to be typed only if the session was stopped
// at that very moment; otherwise it was dropped ("session not stopped" / "session not listed") and the session sat idle until the owner came back
// (kpi-provider-page, 2026-11-01: int-1a198cdf2b550daea ended 20:57:25 -> "session not listed" -> never told; 98 min idle).
// Now such a wake is KEPT per target session, in memory and in <stateDir>/pending-wakes.json (a restart does not lose it), and
//  - is delivered the next time the session stops (server.js calls onStop() on the reporter's turn.end event: no poller),
//  - or, when the session never stops, by a timer armed per wake (no loop): after timeoutMs, and once more after another timeoutMs; then it is dropped,
//  - exactly once per key (`integration:<id>:<state>`, `granted:<ticket>`): a delivered or dropped key is remembered (bounded) and refused by add(),
//  - and is cleared as soon as it is delivered or the session is gone (forget(), or exists() false at an attempt).
// deps: canSend(session) -> bool (stopped on a finished turn, nothing typed), canForce(session) -> bool (the timeout path: nothing typed, no menu),
//       exists(session) -> bool, send(session, text, by) -> Promise, log(record). All may be async.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 2;          // the timeout delivery: at N s, and once more at 2N s
export const DONE_KEEP = 2000;
const BOOT_DELAY_MS = 5000;             // after a restart nothing fires sooner than this: sessions are listed again by then

export function createPendingWakes({ file = null, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = DEFAULT_TIMEOUT_MS,
  canSend = () => false, canForce = () => false, exists = () => true, send = async () => {}, log = () => {} } = {}) {
  let pending = [];     // { session, key, text, by, at, due, attempts }
  let done = [];        // keys delivered or dropped, newest last
  const timers = new Map();   // key -> timer
  const busy = new Set();     // keys being sent right now

  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pending, done: done.slice(-DONE_KEEP) }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { log({ type: 'pending_wake_save_failed', error: String(e?.message || e).slice(0, 160) }); }
  };
  const rememberDone = (key) => { if (!done.includes(key)) { done.push(key); if (done.length > DONE_KEEP) done.splice(0, done.length - DONE_KEEP); } };
  const disarm = (key) => { const t = timers.get(key); if (t) { clearTimer(t); timers.delete(key); } };
  const remove = (e) => { disarm(e.key); pending = pending.filter((x) => x !== e); };
  const finish = (e, how) => { remove(e); rememberDone(e.key); save(); log({ type: `pending_wake_${how}`, session: e.session, key: e.key, attempts: e.attempts }); };

  function arm(e, minMs = 0) {
    disarm(e.key);
    const t = setTimer(() => { timers.delete(e.key); return fire(e).catch((err) => log({ type: 'pending_wake_failed', key: e.key, error: String(err?.message || err).slice(0, 160) })); }, Math.max(minMs, e.due - now()));
    t?.unref?.();
    timers.set(e.key, t);
  }

  // one delivery attempt; force = the timeout path (does not need the session to be stopped)
  async function deliver(e, force) {
    if (!pending.includes(e) || busy.has(e.key)) return false;
    busy.add(e.key);
    try {
      if (!(await exists(e.session))) { finish(e, 'session_gone'); return false; }
      if (!(await (force ? canForce(e.session) : canSend(e.session)))) return false;
      if (!pending.includes(e)) return false;   // delivered or cleared while we looked
      await send(e.session, e.text, e.by);
      finish(e, 'delivered');
      return true;
    } catch (err) { log({ type: 'pending_wake_send_failed', session: e.session, key: e.key, error: String(err?.message || err).slice(0, 160) }); return false; } finally { busy.delete(e.key); }
  }

  async function fire(e) {
    if (!pending.includes(e)) return;
    if (await deliver(e, true)) return;
    if (!pending.includes(e)) return;
    e.attempts += 1;
    if (e.attempts >= MAX_ATTEMPTS) { finish(e, 'gave_up'); return; }
    e.due = now() + timeoutMs; save(); arm(e);
  }

  return {
    // -> { queued: true } | { dup: true } | { ok: false }
    add({ session, key, text, by = 'integration' } = {}) {
      if (!session || !key || !text) return { ok: false };
      if (done.includes(key) || pending.some((e) => e.key === key)) return { dup: true };
      const e = { session: String(session), key: String(key), text: String(text), by, at: now(), due: now() + timeoutMs, attempts: 0 };
      pending.push(e); save(); arm(e);
      log({ type: 'pending_wake_queued', session: e.session, key: e.key });
      return { queued: true };
    },
    // the session stopped: deliver its pending wakes in order, each only if it can still be typed
    async onStop(session) {
      let n = 0;
      for (const e of pending.filter((x) => x.session === session)) { if (!(await deliver(e, false))) break; n++; }
      return n;
    },
    has: (session) => pending.some((e) => e.session === session),
    pendingOf: (session) => pending.filter((e) => e.session === session).map((e) => ({ key: e.key, text: e.text, attempts: e.attempts })),
    // the session ended: nothing to deliver any more
    forget(session) { for (const e of pending.filter((x) => x.session === session)) { remove(e); log({ type: 'pending_wake_cleared', session, key: e.key }); } save(); },
    seen: (key) => done.includes(key) || pending.some((e) => e.key === key),
    markDone(key) { rememberDone(key); save(); },   // a note that went out directly (lease notes): never queued afterwards
    // after a restart: read the file back and re-arm every wake with the time it has left
    restore() {
      if (!file) return 0;
      let j = null; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return 0; }
      done = Array.isArray(j?.done) ? j.done.map(String) : [];
      pending = (Array.isArray(j?.pending) ? j.pending : []).filter((e) => e && e.session && e.key && e.text).map((e) => ({ session: String(e.session), key: String(e.key), text: String(e.text), by: e.by || 'integration', at: Number(e.at) || now(), due: Number(e.due) || now(), attempts: Number(e.attempts) || 0 }));
      for (const e of pending) arm(e, BOOT_DELAY_MS);
      return pending.length;
    },
    stop() { for (const k of [...timers.keys()]) disarm(k); },
    size: () => pending.length,
  };
}
