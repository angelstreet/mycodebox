// Queued send (send-queue.js): a when:'idle' send to a busy session is parked, the poll loop delivers the oldest entry
// once the pane is free, entries expire after 24 h, one can be cancelled, and a send without `when` is never queued.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSendQueue, shouldQueue, shouldDeliver, blockReason, planSend, MAX_PER_SESSION, TTL_MS, WHEN } from '../send-queue.js';
import { tmp } from './helpers-tmp.js';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const clock = (start = NOW) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };
const queueAt = (file, c = clock()) => createSendQueue({ file, now: c.now });

const working = { state: 'working' };
const done = { state: 'done', stall: {} };
const idle = { state: 'idle' };
const waiting = { state: 'waiting', stall: {} };

// --- the gate: one rule, two uses (queue now / deliver later) ---

test('blockReason: idle or done with nothing typed is free; every busy shape is blocked', () => {
  assert.equal(blockReason({ status: idle }), null);
  assert.equal(blockReason({ status: done }), null);
  assert.equal(blockReason({ status: working }), 'working');
  assert.equal(blockReason({ status: { state: 'done', stall: { draft: 'half typed' } } }), 'draft');
  assert.equal(blockReason({ status: done, held: true }), 'held');
  assert.equal(blockReason({ status: done, paused: true }), 'paused');
  assert.equal(blockReason({ status: waiting }), 'state:waiting');
  assert.equal(blockReason({}), 'unknown');           // no poll status yet
  assert.equal(blockReason({ status: null }), 'unknown');
});

test('shouldQueue and shouldDeliver are two views of the same gate', () => {
  assert.equal(shouldQueue({ status: working }), true);
  assert.equal(shouldDeliver({ status: working }), false);
  assert.equal(shouldQueue({ status: done }), false);
  assert.equal(shouldDeliver({ status: done }), true);
  assert.equal(shouldDeliver({ status: done, paused: true }), false);
});

test('WHEN is the only accepted value', () => {
  assert.equal(WHEN, 'idle');
});

// --- queueing ---

test('a message queued while the session works is pending, oldest first, and persisted', () => {
  const dir = tmp('sendq-'), file = join(dir, 'send-queue.json'), c = clock();
  const q = queueAt(file, c);
  const a = q.enqueue({ session: 'dev1', keys: 'first', by: 'manager-agent' });
  c.advance(1000);
  const b = q.enqueue({ session: 'dev1', keys: 'second', by: 'manager-agent' });

  assert.equal(typeof a.id, 'string');
  assert.notEqual(a.id, b.id);
  assert.equal(a.pending, 1);
  assert.equal(b.pending, 2);
  assert.deepEqual(q.list().map((e) => e.keys), ['first', 'second']);
  assert.equal(q.list('dev1').length, 2);
  assert.equal(q.list('other').length, 0);

  // persisted in the state dir, so a restart keeps the parked messages
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.entries.length, 2);
  assert.equal(onDisk.entries[0].session, 'dev1');
  assert.equal(onDisk.entries[1].keys, 'second');

  // a fresh store reads them back (a restart)
  const reloaded = queueAt(file, c);
  assert.deepEqual(reloaded.list().map((e) => e.id), [a.id, b.id]);
});

test('a queued key send keeps the key and the enter flag', () => {
  const dir = tmp('sendq-'), c = clock();
  const q = queueAt(join(dir, 'send-queue.json'), c);
  const e = q.enqueue({ session: 'dev1', key: 'Enter', enter: false, by: 'manager-agent' });
  assert.equal(e.key, 'Enter');
  assert.equal(e.enter, false);
  assert.equal(q.list()[0].key, 'Enter');
});

test('one queue per session, max 5 pending; a 6th is refused and nothing is dropped', () => {
  const dir = tmp('sendq-'), c = clock();
  const q = queueAt(join(dir, 'send-queue.json'), c);
  for (let i = 1; i <= MAX_PER_SESSION; i++) q.enqueue({ session: 'dev1', keys: `m${i}` });
  assert.equal(q.pending('dev1'), 5);
  assert.throws(() => q.enqueue({ session: 'dev1', keys: 'm6' }), /queue full/i);
  // the five are still there, oldest first: a refused message never evicts an older one
  assert.deepEqual(q.list('dev1').map((e) => e.keys), ['m1', 'm2', 'm3', 'm4', 'm5']);
  // another session has its own queue
  q.enqueue({ session: 'dev2', keys: 'other' });
  assert.equal(q.pending('dev2'), 1);
});

// --- delivery on idle ---

test('the tick delivers the oldest entry once the session is idle, through the guarded send, and records it', async () => {
  const dir = tmp('sendq-'), c = clock();
  const q = queueAt(join(dir, 'send-queue.json'), c);
  q.enqueue({ session: 'dev1', keys: 'first', by: 'manager-agent' });
  c.advance(1000);
  q.enqueue({ session: 'dev1', keys: 'second', by: 'manager-agent' });
  const sent = [], notices = [];

  // still working -> nothing goes out
  let r = await q.tick({ status: () => working, deliver: async (s, e) => sent.push([s, e.keys]), onDelivered: (e) => notices.push(e.id) });
  assert.equal(r.length, 0);
  assert.deepEqual(sent, []);
  assert.equal(q.pending('dev1'), 2);

  // free at last: the oldest one only, oldest entry first
  r = await q.tick({ status: () => done, deliver: async (s, e) => sent.push([s, e.keys, e.by]), onDelivered: (e) => notices.push(e.keys) });
  assert.equal(r.length, 1);
  assert.deepEqual(sent, [['dev1', 'first', 'manager-agent']]);
  assert.deepEqual(notices, ['first']);
  assert.deepEqual(q.list().map((e) => e.keys), ['second']);   // the delivered one is gone

  // the pane is working again after the send: the rest waits
  sent.length = 0;
  r = await q.tick({ status: () => working, deliver: async (s, e) => sent.push(e.keys) });
  assert.equal(r.length, 0);
  r = await q.tick({ status: () => idle, deliver: async (s, e) => sent.push(e.keys) });
  assert.deepEqual(sent, ['second']);
  assert.equal(q.pending('dev1'), 0);
});

test('the tick never delivers into a held, paused or waiting session', async () => {
  const dir = tmp('sendq-'), c = clock();
  const q = queueAt(join(dir, 'send-queue.json'), c);
  for (const s of ['held1', 'paused1', 'ask1', 'typing1']) q.enqueue({ session: s, keys: 'hello' });
  const sent = [];
  const deliver = async (s, e) => sent.push(s);

  // one tick, four sessions, each blocked by its own reason
  await q.tick({
    status: (s) => (s === 'ask1' ? waiting : s === 'typing1' ? { state: 'done', stall: { draft: 'half' } } : done),
    isHeld: (s) => s === 'held1',
    isPaused: (s) => s === 'paused1',
    deliver,
  });
  assert.deepEqual(sent, []);
  assert.equal(q.list().length, 4);   // all four are still parked

  // everything released / typed away -> all four go out
  await q.tick({ status: () => done, deliver });
  assert.deepEqual(sent.sort(), ['ask1', 'held1', 'paused1', 'typing1']);
});

test('a refused delivery keeps the message queued for the next idle moment', async () => {
  const dir = tmp('sendq-'), c = clock();
  const q = queueAt(join(dir, 'send-queue.json'), c);
  q.enqueue({ session: 'dev1', keys: 'hello', by: 'manager-agent' });
  const errors = [];
  let r = await q.tick({ status: () => done, deliver: async () => { throw Object.assign(new Error('not an agent pane'), { status: 409 }); }, onError: (e, err) => errors.push(err.message) });
  assert.equal(r.length, 0);
  assert.deepEqual(errors, ['not an agent pane']);
  assert.equal(q.pending('dev1'), 1);

  let sent = null;
  r = await q.tick({ status: () => done, deliver: async (s, e) => { sent = e.keys; } });
  assert.deepEqual(sent, 'hello');
  assert.equal(q.pending('dev1'), 0);
});

// --- expiry ---

test('an entry older than 24 h is dropped, never delivered', async () => {
  const dir = tmp('sendq-'), file = join(dir, 'send-queue.json'), c = clock();
  const q = queueAt(file, c);
  q.enqueue({ session: 'dev1', keys: 'stale' });
  assert.equal(TTL_MS, 24 * 3600 * 1000);

  c.advance(TTL_MS + 60_000);
  const sent = [];
  assert.deepEqual(q.list(), []);                                  // gone on read
  assert.equal(q.pending('dev1'), 0);
  assert.deepEqual(await q.tick({ status: () => done, deliver: async (s, e) => sent.push(e.keys) }), []);
  assert.deepEqual(sent, []);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).entries, []);   // and pruned from disk
});

test('a fresh entry survives an almost-expired one (expiry is per entry, not per queue)', async () => {
  const dir = tmp('sendq-'), c = clock();
  const q = queueAt(join(dir, 'send-queue.json'), c);
  q.enqueue({ session: 'dev1', keys: 'stale' });
  c.advance(TTL_MS - 1000);
  q.enqueue({ session: 'dev1', keys: 'fresh' });
  c.advance(2000);
  assert.deepEqual(q.list().map((e) => e.keys), ['fresh']);
});

test('a queue file that is corrupt or from an older version loads as empty instead of throwing', () => {
  const dir = tmp('sendq-'), file = join(dir, 'send-queue.json');
  writeFileSync(file, '{not json');
  const q = queueAt(file);
  assert.deepEqual(q.list(), []);
  const e = q.enqueue({ session: 'dev1', keys: 'ok' });   // and still usable
  assert.equal(q.pending('dev1'), 1);
  assert.ok(e.id);
});

// --- cancel ---

test('DELETE /api/send-queue/<id> cancels one entry and leaves the rest', async () => {
  const dir = tmp('sendq-'), c = clock();
  const q = queueAt(join(dir, 'send-queue.json'), c);
  const a = q.enqueue({ session: 'dev1', keys: 'first' });
  q.enqueue({ session: 'dev1', keys: 'second' });
  q.enqueue({ session: 'dev2', keys: 'other' });

  const cancelled = q.cancel(a.id);
  assert.equal(cancelled.id, a.id);
  assert.equal(cancelled.session, 'dev1');
  assert.equal(cancelled.keys, 'first');
  assert.equal(q.pending('dev1'), 1);
  assert.deepEqual(q.list('dev1').map((e) => e.keys), ['second']);
  assert.equal(q.pending('dev2'), 1);   // another session is untouched

  assert.equal(q.cancel(a.id), null);   // already gone
  assert.equal(q.cancel('no-such-id'), null);

  // a cancelled message is never delivered later
  const sent = [];
  await q.tick({ status: () => done, deliver: async (s, e) => sent.push(e.keys) });
  assert.deepEqual(sent.sort(), ['other', 'second']);
});

// --- unchanged default ---

test('planSend: without `when` the send is typed now, even into a working pane (unchanged)', () => {
  // The queue is reached only when the body asks for it. Every `when`-less body takes the same branch as before:
  // sendKeys / sendKey straight away, whatever the session is doing.
  assert.deepEqual(planSend({ ctx: { status: working } }), { mode: 'send' });
  assert.deepEqual(planSend({ ctx: { status: done } }), { mode: 'send' });
  assert.deepEqual(planSend({ when: null, ctx: { status: working } }), { mode: 'send' });
  assert.deepEqual(planSend({ when: '', ctx: { status: working } }), { mode: 'send' });
  assert.deepEqual(planSend({}), { mode: 'send' });
});

test('planSend: when:"idle" queues only what the pane cannot take, sends the rest', () => {
  assert.deepEqual(planSend({ when: 'idle', ctx: { status: working } }), { mode: 'queue' });
  assert.deepEqual(planSend({ when: 'idle', ctx: { status: { state: 'done', stall: { draft: 'x' } } } }), { mode: 'queue' });
  assert.deepEqual(planSend({ when: 'idle', ctx: { status: done, held: true } }), { mode: 'queue' });
  assert.deepEqual(planSend({ when: 'idle', ctx: { status: idle } }), { mode: 'send' });   // free now: typed at once
  assert.deepEqual(planSend({ when: 'idle', ctx: { status: done } }), { mode: 'send' });
});

test('planSend: an unknown when is a 400, not a silent send', () => {
  assert.throws(() => planSend({ when: 'later', ctx: { status: working } }), (e) => e.status === 400 && /when/.test(e.message));
  assert.throws(() => planSend({ when: 'now', ctx: { status: working } }), (e) => e.status === 400);
});

test('a when-less send leaves the queue empty, so the tick has nothing to deliver', async () => {
  const dir = tmp('sendq-'), c = clock();
  const q = queueAt(join(dir, 'send-queue.json'), c);
  for (const keys of ['one', 'two']) {
    assert.equal(planSend({ ctx: { status: working } }).mode, 'send');   // what the route does with this body
  }
  assert.deepEqual(q.list(), []);
  assert.equal(q.pending('dev1'), 0);
  // and the poll loop has nothing to hand over
  assert.deepEqual(await q.tick({ status: () => done, deliver: async () => { throw new Error('must not deliver'); } }), []);
});