// Pending wakes: a wake for a busy session is kept and typed at its next stop, exactly once, across a restart, by timeout, for lease tickets too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingWakes, MAX_ATTEMPTS } from '../pending-wakes.js';
import { createIntegrationNotify } from '../integration-notify.js';
import { eventNote } from '../lease-source.js';
import { tmp } from './helpers-tmp.js';
import { join } from 'node:path';

// fake clock + timers
function world(o = {}) {
  const w = { t: 1_000_000, timers: [], sent: [], logs: [], stopped: false, exists: true, forceOk: true };
  const mk = (extra = {}) => createPendingWakes({ file: o.file, now: () => w.t, timeoutMs: 1000,
    setTimer: (fn, ms) => { const x = { fn, at: w.t + ms, off: false, unref() {} }; w.timers.push(x); return x; }, clearTimer: (x) => { if (x) x.off = true; },
    canSend: () => w.stopped, canForce: () => w.forceOk, exists: () => w.exists, send: async (s, text, by) => { w.sent.push({ s, text, by }); }, log: (r) => w.logs.push(r), ...extra });
  w.mk = mk; w.pw = mk();
  w.advance = async (ms) => { w.t += ms; for (const x of [...w.timers]) if (!x.off && x.at <= w.t) { x.off = true; await x.fn(); } };
  return w;
}

test('a wake queued while the session is busy is delivered on its next stop', async () => {
  const w = world();
  assert.deepEqual(w.pw.add({ session: 's1', key: 'integration:int-1:merged', text: 'Integration int-1: merged' }), { queued: true });
  assert.equal(await w.pw.onStop('s1'), 0, 'still busy: nothing typed');
  assert.equal(w.sent.length, 0);
  w.stopped = true;
  assert.equal(await w.pw.onStop('s1'), 1);
  assert.deepEqual(w.sent.map((x) => x.text), ['Integration int-1: merged']);
  assert.equal(w.pw.has('s1'), false, 'cleared once delivered');
});

test('delivered once only: a repeated stop, a repeated add and the timer do not send again', async () => {
  const w = world(); w.stopped = true;
  w.pw.add({ session: 's1', key: 'k1', text: 't' });
  await w.pw.onStop('s1'); await w.pw.onStop('s1');
  assert.deepEqual(w.pw.add({ session: 's1', key: 'k1', text: 't' }), { dup: true });
  await w.advance(10_000);
  assert.equal(w.sent.length, 1);
  // two stops racing: one send
  const w2 = world(); w2.stopped = true; w2.pw.add({ session: 's', key: 'k', text: 't' });
  await Promise.all([w2.pw.onStop('s'), w2.pw.onStop('s')]);
  assert.equal(w2.sent.length, 1);
});

test('the pending wake survives a restart: reloaded from the file, still delivered once', async () => {
  const file = join(tmp('pw-'), 'pending-wakes.json');
  const a = world({ file }); a.pw.add({ session: 's1', key: 'k1', text: 'hello' }); a.pw.add({ session: 's2', key: 'k2', text: 'bye' });
  a.stopped = true; await a.pw.onStop('s2');                        // k2 delivered before the restart
  a.pw.stop();
  const b = world({ file });
  assert.equal(b.pw.restore(), 1, 'only k1 is still pending');
  assert.deepEqual(b.pw.pendingOf('s1').map((x) => x.key), ['k1']);
  b.stopped = true; assert.equal(await b.pw.onStop('s1'), 1);
  assert.deepEqual(b.sent.map((x) => x.text), ['hello']);
  assert.deepEqual(b.pw.add({ session: 's2', key: 'k2', text: 'bye' }), { dup: true }, 'the delivered key is remembered across the restart');
  const c = world({ file }); assert.equal(c.pw.restore(), 0);
});

test('a session that never stops gets the wake after N s, and once more after 2N s, then it is dropped', async () => {
  const w = world(); w.forceOk = false;
  w.pw.add({ session: 's1', key: 'k1', text: 'late' });
  await w.advance(1000);                                      // N: cannot type (a draft): kept, re-armed
  assert.equal(w.sent.length, 0); assert.equal(w.pw.has('s1'), true);
  w.forceOk = true;
  await w.advance(1000);                                      // the one more try
  assert.deepEqual(w.sent.map((x) => x.text), ['late']);
  assert.equal(w.pw.has('s1'), false);
  const g = world(); g.forceOk = false; g.pw.add({ session: 's', key: 'k', text: 't' });
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await g.advance(1000);
  assert.equal(g.sent.length, 0); assert.equal(g.pw.size(), 0, 'dropped after the second try');
  assert.ok(g.logs.some((l) => l.type === 'pending_wake_gave_up'));
});

test('a session that ended clears its pending wakes', async () => {
  const w = world(); w.pw.add({ session: 's1', key: 'k1', text: 't' });
  w.pw.forget('s1'); assert.equal(w.pw.size(), 0);
  w.pw.add({ session: 's2', key: 'k2', text: 't' }); w.exists = false;
  await w.advance(1000); assert.equal(w.sent.length, 0); assert.equal(w.pw.size(), 0);
});

test('integration notify keeps the wake for a busy or unlisted session instead of dropping it, and the own-job watch is released', async () => {
  const w = world(); const kept = []; let status = { state: 'working' }; const after = [];
  const notify = createIntegrationNotify({ status: () => status, canSend: (st) => st?.state === 'done', send: async () => { throw new Error('must not type now'); },
    defer: (s, r, text) => w.pw.add({ session: s, key: `integration:${r.id}:${r.state}`, text, by: 'integration' }).queued && kept.push(r.id), afterSend: (s, r) => after.push(r.id) });
  const r = { id: 'int-9', session: 'kpi', branch: 'feat/k', target: 'main', state: 'deployed', sha: 'a'.repeat(40), deployed: { version: 'v', env: 'e', scope: 'frontend' } };
  const out = await notify(r);
  assert.equal(out.sent, false); assert.match(out.why, /kept for the next stop/);
  assert.deepEqual(after, ['int-9']);
  status = undefined; const out2 = await notify({ ...r, id: 'int-10' });
  assert.match(out2.why, /session not listed; kept/);
  w.stopped = true; await w.pw.onStop('kpi');
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[0].text, /int-9: merged feat\/k into main/);
  assert.equal((await notify(r)).dup, true, 'the lane reporting it again changes nothing');
});

test('lease ticket grant: kept while the session is busy, typed at its stop, once', async () => {
  const w = world();
  const ev = { kind: 'granted', id: 'L7', ticket: 't-9', env: 'env-a', resources: ['host:h1'], agent: 'codebox:w1', session: 'w1' };
  const note = eventNote(ev);
  assert.deepEqual(w.pw.add({ session: 'w1', key: 'granted:t-9', text: note, by: 'lease-service' }), { queued: true });
  assert.deepEqual(w.pw.add({ session: 'w1', key: 'granted:t-9', text: note, by: 'lease-service' }), { dup: true });
  w.stopped = true; await w.pw.onStop('w1'); await w.pw.onStop('w1');
  assert.equal(w.sent.length, 1); assert.equal(w.sent[0].by, 'lease-service');
  assert.match(w.sent[0].text, /ticket t-9 was granted: lease L7/);
  w.pw.markDone('granted:t-10');
  assert.equal(w.pw.seen('granted:t-10'), true, 'a note sent directly is never queued afterwards');
});
