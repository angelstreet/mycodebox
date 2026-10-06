// Tests for handoffs.js (TASK-58 C3): parseHandoff / dueFromHM, store create+dedupe+persistence, lease/holder events,
// tick() overdue emit-once, and the handoff:overdue classification + filter script passthrough.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseHandoff, dueFromHM, createHandoffs } from '../handoffs.js';
import { classifyKey } from '../manager-events.js';
import { machinesOf } from '../public/platforms.js';

const M = machinesOf('codebox-vm');
const NOW = 1_800_000_000_000;

const tmpDir = async () => mkdtemp(join(tmpdir(), 'handoffs-'));

// ---------------------------------------------------------------------------
// parseHandoff: arrow variants, whitespace, optional due, garbage
// ---------------------------------------------------------------------------

test('parseHandoff: arrow -> with by HH:MM', () => {
  assert.deepEqual(parseHandoff('lease -> task58-b by 14:30'), { resource: 'lease', to: 'task58-b', dueHM: '14:30' });
});
test('parseHandoff: unicode arrow, no due', () => {
  assert.deepEqual(parseHandoff('stb4 \u2192 task28'), { resource: 'stb4', to: 'task28', dueHM: null });
});
test('parseHandoff: whitespace tolerant, single-digit hours', () => {
  assert.deepEqual(parseHandoff('  lease   ->   TASK1   by   9:05  '), { resource: 'lease', to: 'TASK1', dueHM: '9:05' });
});
test('parseHandoff: garbage returns null', () => {
  assert.equal(parseHandoff('hello world'), null);
  assert.equal(parseHandoff(''), null);
  assert.equal(parseHandoff(null), null);
  assert.equal(parseHandoff('->'), null);
  assert.equal(parseHandoff('foo ->'), null);
  assert.equal(parseHandoff('-> bar'), null);
});

// ---------------------------------------------------------------------------
// dueFromHM: local time, rolls to tomorrow if more than 6 h past
// ---------------------------------------------------------------------------

test('dueFromHM: same day when HH:MM is in the future today', () => {
  // NOW = 1.8e12 ms = 2027-01-15 06:40:00 UTC; local TZ is whatever node sees. Use a fixed offset.
  const ms = dueFromHM('23:00', NOW);
  assert.ok(Number.isFinite(ms));
  const d = new Date(ms);
  assert.equal(d.getHours(), 23);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
});
test('dueFromHM: when HH:MM is more than 6 h in the past, push to tomorrow', () => {
  // Pick a NOW such that "00:10" is clearly >6h past in local time. Make NOW = 14:00 local.
  const d = new Date(NOW);
  d.setHours(14, 0, 0, 0);
  const noon = d.getTime();
  const ms = dueFromHM('00:10', noon);
  const r = new Date(ms);
  assert.equal(r.getDate(), d.getDate() + 1);   // pushed to tomorrow
  assert.equal(r.getHours(), 0);
  assert.equal(r.getMinutes(), 10);
});
test('dueFromHM: invalid times return null', () => {
  assert.equal(dueFromHM('foo', NOW), null);
  assert.equal(dueFromHM('25:00', NOW), null);
  assert.equal(dueFromHM('12:60', NOW), null);
});

// ---------------------------------------------------------------------------
// create / dedupe / persistence
// ---------------------------------------------------------------------------

test('create: dedupes an existing open/overdue row with same from+to+resource (case-insens)', async () => {
  const dir = await tmpDir();
  const h = createHandoffs({ file: join(dir, 'handoffs.json'), now: () => NOW });
  const a = await h.create({ resource: 'Lease', from: 'TASK1', to: 'TASK2', due: NOW + 1000 });
  const b = await h.create({ resource: 'lease', from: 'task1', to: 'task2', due: NOW + 2000 });
  assert.equal(b.id, a.id);   // returned the existing row, not a new one
  assert.equal(b.due, NOW + 2000);   // and updated the due
  assert.equal((await h.list()).length, 1);
});

test('create: a done row is NOT deduped; a new one is added', async () => {
  const dir = await tmpDir();
  const h = createHandoffs({ file: join(dir, 'handoffs.json'), now: () => NOW });
  const a = await h.create({ resource: 'lease', from: 'a', to: 'b', due: null });
  await h.done(a.id, 'manual');
  const b = await h.create({ resource: 'lease', from: 'a', to: 'b', due: null });
  assert.notEqual(b.id, a.id);
});

test('fromStop: parses the STATUS line and creates a row', async () => {
  const dir = await tmpDir();
  const h = createHandoffs({ file: join(dir, 'handoffs.json'), now: () => NOW });
  const row = await h.fromStop('sender', 'lease -> receiver by 15:00', NOW);
  assert.ok(row);
  assert.equal(row.from, 'sender');
  assert.equal(row.to, 'receiver');
  assert.equal(row.resource, 'lease');
  assert.equal(typeof row.due, 'number');
  assert.equal(row.state, 'open');
});
test('fromStop: garbage returns null', async () => {
  const dir = await tmpDir();
  const h = createHandoffs({ file: join(dir, 'handoffs.json'), now: () => NOW });
  assert.equal(await h.fromStop('sender', 'all good', NOW), null);
});

test('persistence: a fresh createHandoffs on the same file sees the rows', async () => {
  const dir = await tmpDir();
  const file = join(dir, 'handoffs.json');
  const h1 = createHandoffs({ file, now: () => NOW });
  await h1.create({ resource: 'lease', from: 'a', to: 'b', due: NOW + 1000 });
  await h1.create({ resource: 'stb4', from: 'b', to: 'c', due: null });
  const h2 = createHandoffs({ file, now: () => NOW });
  await h2.load();
  assert.equal((await h2.list()).length, 2);
});

test('persistence: a corrupt file does not crash; rows start empty', async () => {
  const dir = await tmpDir();
  const file = join(dir, 'handoffs.json');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(file, '}{garbage'));
  const h = createHandoffs({ file, now: () => NOW });
  await h.load();
  assert.deepEqual(await h.list(), []);
});

// ---------------------------------------------------------------------------
// onLeaseEvent: only the from-session holder + matching resource marks done
// ---------------------------------------------------------------------------

test('onLeaseEvent: marks done only for the from holder with matching resource', async () => {
  const dir = await tmpDir();
  const h = createHandoffs({ file: join(dir, 'handoffs.json'), machines: M, now: () => NOW });
  const r1 = await h.create({ resource: 'stb4', from: 'TASK1', to: 'TASK2', due: null });
  const r2 = await h.create({ resource: 'stb4', from: 'OTHER', to: 'TASK2', due: null });
  const r3 = await h.create({ resource: 'pi1', from: 'TASK1', to: 'TASK2', due: null });
  await h.onLeaseEvent({ key: 'lease:released', agent: 'codebox:task-1', env: 'node1-vpt', resources: ['vpt-pi1/stb4'] });
  // r1: from=TASK1 matches TASK1 via tolerant matcher; resource "stb4" is a substring of "vpt-pi1/stb4"
  assert.equal((await h.list()).find((x) => x.id === r1.id).state, 'done');
  // r2: from=OTHER does not match the event agent
  assert.equal((await h.list()).find((x) => x.id === r2.id).state, 'open');
  // r3: from matches but resource "pi1" is not a substring of "vpt-pi1/stb4" the other way (no "pi1" inside); pi1 IS a substring of vpt-pi1/stb4 - check
  // Actually "pi1" IS a substring of "vpt-pi1/stb4" - so this should be done. Update assertion to match.
  assert.equal((await h.list()).find((x) => x.id === r3.id).state, 'done');
  // Now test that a non-matching resource stays open: create r4 with resource "no-match-zzz"
  const r4 = await h.create({ resource: 'no-match-zzz', from: 'TASK1', to: 'TASK2', due: null });
  await h.onLeaseEvent({ key: 'lease:released', agent: 'codebox:task-1', env: 'node1-vpt', resources: ['vpt-pi1/stb4'] });
  assert.equal((await h.list()).find((x) => x.id === r4.id).state, 'open');
});

test('onLeaseEvent: ignores events with no matching agent', async () => {
  const dir = await tmpDir();
  const h = createHandoffs({ file: join(dir, 'handoffs.json'), machines: M, now: () => NOW });
  const r = await h.create({ resource: 'lease', from: 'TASK1', to: 'TASK2', due: null });
  await h.onLeaseEvent({ key: 'lease:released', agent: 'codebox:OTHER', env: 'node1-vpt', resources: ['lease'] });
  assert.equal((await h.list()).find((x) => x.id === r.id).state, 'open');
});

// ---------------------------------------------------------------------------
// onHolders: marks done when the to session holds the resource
// ---------------------------------------------------------------------------

test('onHolders: marks done when row.to holds a matching resource', async () => {
  const dir = await tmpDir();
  const h = createHandoffs({ file: join(dir, 'handoffs.json'), now: () => NOW });
  const r = await h.create({ resource: 'lease', from: 'sender', to: 'TASK28', due: null });
  await h.onHolders([{ session: 'TASK28', env: 'node1-vpt', resources: ['lease'] }]);
  const done = (await h.list()).find((x) => x.id === r.id);
  assert.equal(done.state, 'done');
  assert.equal(done.doneBy, 'claimed');
});

test('onHolders: a holder for a different session does not match', async () => {
  const dir = await tmpDir();
  const h = createHandoffs({ file: join(dir, 'handoffs.json'), now: () => NOW });
  const r = await h.create({ resource: 'lease', from: 'sender', to: 'TASK28', due: null });
  await h.onHolders([{ session: 'OTHER', env: 'node1-vpt', resources: ['lease'] }]);
  assert.equal((await h.list()).find((x) => x.id === r.id).state, 'open');
});

// ---------------------------------------------------------------------------
// tick(): overdue emits exactly one handoff:overdue record; never again; done rows never emit
// ---------------------------------------------------------------------------

test('tick: an overdue row fires exactly one handoff:overdue record, never again', async () => {
  const dir = await tmpDir();
  let t = NOW;
  const recorded = [];
  const h = createHandoffs({ file: join(dir, 'handoffs.json'), now: () => t, record: async (e) => { recorded.push(e); } });
  await h.create({ resource: 'lease', from: 'sender', to: 'receiver', due: NOW - 1000 });   // already past due
  await h.tick();
  await h.tick();
  await h.tick();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].key, 'handoff:overdue');
  assert.equal(recorded[0].session, 'sender');
  assert.equal(recorded[0].handoffId, (await h.list())[0].id);
  const all = await h.list();
  assert.equal(all[0].state, 'overdue');
});

test('tick: a row whose due is still in the future does not fire', async () => {
  const dir = await tmpDir();
  const recorded = [];
  const h = createHandoffs({ file: join(dir, 'handoffs.json'), now: () => NOW, record: async (e) => { recorded.push(e); } });
  await h.create({ resource: 'lease', from: 'sender', to: 'receiver', due: NOW + 60_000 });
  await h.tick();
  assert.equal(recorded.length, 0);
});

test('tick: a done row never emits (no resurrection)', async () => {
  const dir = await tmpDir();
  const recorded = [];
  const h = createHandoffs({ file: join(dir, 'handoffs.json'), now: () => NOW, record: async (e) => { recorded.push(e); } });
  const r = await h.create({ resource: 'lease', from: 'a', to: 'b', due: NOW - 1000 });
  await h.done(r.id, 'manual');
  await h.tick();
  assert.equal(recorded.length, 0);
});

test('tick: an overdue row can still become done (no re-emit)', async () => {
  const dir = await tmpDir();
  let t = NOW;
  const recorded = [];
  const h = createHandoffs({ file: join(dir, 'handoffs.json'), now: () => t, record: async (e) => { recorded.push(e); } });
  const r = await h.create({ resource: 'lease', from: 'sender', to: 'receiver', due: NOW - 1000 });
  await h.tick();
  assert.equal(recorded.length, 1);
  await h.onHolders([{ session: 'receiver', env: 'node1-vpt', resources: ['lease'] }]);
  const after = (await h.list()).find((x) => x.id === r.id);
  assert.equal(after.state, 'done');
  // subsequent ticks don't re-emit (still only one record)
  await h.tick();
  assert.equal(recorded.length, 1);
});

// ---------------------------------------------------------------------------
// manager-events: classifyKey('handoff:overdue')
// ---------------------------------------------------------------------------

test('classifyKey: handoff:overdue -> {kind:"handoff", state:"overdue"}', () => {
  assert.deepEqual(classifyKey('handoff:overdue'), { kind: 'handoff', state: 'overdue' });
});

// ---------------------------------------------------------------------------
// filter script: handoff events pass through unchanged
// ---------------------------------------------------------------------------

test('manager-event-filter.sh: handoff events pass through unchanged', () => {
  // Skip when jq is not installed.
  const which = spawnSync('which', ['jq'], { encoding: 'utf8' });
  if (which.status !== 0) return;
  const input = JSON.stringify({ kind: 'handoff', state: 'overdue', session: 'x', body: 'b' }) + '\n';
  const r = spawnSync('bash', ['scripts/manager-event-filter.sh'], { input, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /handoff/);
  assert.match(r.stdout, /overdue/);
});