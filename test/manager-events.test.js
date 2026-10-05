// Tests for manager-events.js (the AI manager event feed) and the onFired hook in push.js#createAlerts.
//
// Pure coverage: classifyKey, the skip rules, rotation, onFired debounce. The /api/manager/events route is
// a tiny tail of the file — we test it through the createManagerEvents.tail() function it calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAlerts } from '../push.js';
import { createManagerEvents, classifyKey, FILE_NAME, FILE_NAME_OLD } from '../manager-events.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ghosty-mevents-'));
const quiet = { error() {} };
const readLines = (file) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }) : [];

// ---------------------------------------------------------------------------
// classifyKey: every key family -> kind / session / extras
// ---------------------------------------------------------------------------

test('classifyKey: <session>:asks|waiting|done|hold|resume', () => {
  assert.deepEqual(classifyKey('web:asks'), { kind: 'asks', session: 'web' });
  assert.deepEqual(classifyKey('api:waiting'), { kind: 'waiting', session: 'api' });
  assert.deepEqual(classifyKey('foo:done'), { kind: 'done', session: 'foo' });
  assert.deepEqual(classifyKey('foo:hold'), { kind: 'hold', session: 'foo' });
  assert.deepEqual(classifyKey('foo:resume'), { kind: 'resume', session: 'foo' });
});

test('classifyKey: deploy:<id>:<state> -> deployId + state; empty state is null', () => {
  assert.deepEqual(classifyKey('deploy:abc123:start'), { kind: 'deploy', deployId: 'abc123', state: 'start' });
  assert.deepEqual(classifyKey('deploy:abc123:done'), { kind: 'deploy', deployId: 'abc123', state: 'done' });
  assert.deepEqual(classifyKey('deploy:abc123:failed'), { kind: 'deploy', deployId: 'abc123', state: 'failed' });
  assert.deepEqual(classifyKey('deploy:abc123:approve'), { kind: 'deploy', deployId: 'abc123', state: 'approve' });
  assert.deepEqual(classifyKey('deploy:abc123'), { kind: 'deploy', deployId: 'abc123', state: null });
});

test('classifyKey: quota / disk / openrouter / other / manager-agent', () => {
  assert.deepEqual(classifyKey('quota:codex:5h'), { kind: 'quota', quotaKey: 'codex:5h' });
  assert.deepEqual(classifyKey('disk:/'), { kind: 'disk', diskPath: '/' });
  assert.deepEqual(classifyKey('disk:/var'), { kind: 'disk', diskPath: '/var' });
  assert.deepEqual(classifyKey('openrouter:credits'), { kind: 'credits', creditsKey: 'credits' });
  assert.deepEqual(classifyKey('manager-agent:something-up'), { kind: 'agent-skip' });
  assert.deepEqual(classifyKey('manager-agent:'), { kind: 'agent-skip' });
  assert.deepEqual(classifyKey('orphan'), { kind: 'other' });
  assert.deepEqual(classifyKey(''), { kind: 'other' });
});

// ---------------------------------------------------------------------------
// record(): the skip rules
// ---------------------------------------------------------------------------

test('record: skips events whose session is in managerSessions()', async () => {
  const dir = tmp();
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => ['manager', 'ops'] });
  assert.equal(await me.record({ key: 'manager:asks', title: 'm asks', priority: 'high' }), false);
  assert.equal(await me.record({ key: 'ops:waiting', title: 'o needs you' }), false);
  // different session lands
  assert.equal(await me.record({ key: 'web:asks', title: 'w asks' }), true);
  const lines = readLines(me.file);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].session, 'web');
  assert.equal(lines[0].kind, 'asks');
});

test('record: skips the manager agent\'s own /api/alert (manager-agent:* keys)', async () => {
  const dir = tmp();
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => [] });
  assert.equal(await me.record({ key: 'manager-agent:build-broken', title: 'x' }), false);
  assert.equal(await me.record({ key: 'manager-agent:', title: 'x' }), false);
  assert.equal(existsSync(me.file), false);
});

test('record: skips kind=done (a turn finishing is noise for the manager)', async () => {
  const dir = tmp();
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => [] });
  assert.equal(await me.record({ key: 'web:done', title: 'w is done' }), false);
  assert.equal(existsSync(me.file), false);
  // other kinds for the same session still land
  assert.equal(await me.record({ key: 'web:asks', title: 'w asks' }), true);
  assert.equal(await me.record({ key: 'web:waiting', title: 'w needs you' }), true);
  const lines = readLines(me.file);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.kind).sort(), ['asks', 'waiting']);
});

test('record: writes one JSON line with the expected shape per key family', async () => {
  const dir = tmp();
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => [] });
  const at = '2026-01-02T03:04:05.000Z';
  await me.record({ at, key: 'web:asks', title: 't1', url: '/?s=web', priority: 'high', body: 'b1' });
  await me.record({ at, key: 'deploy:abc123:failed', title: 't2', priority: 'default' });
  await me.record({ at, key: 'quota:codex:5h', title: 't3', priority: 'high' });
  await me.record({ at, key: 'disk:/', title: 't4', priority: 'urgent' });
  await me.record({ at, key: 'openrouter:credits', title: 't5' });
  const lines = readLines(me.file);
  assert.equal(lines.length, 5);
  assert.deepEqual(lines[0], { at, key: 'web:asks', kind: 'asks', session: 'web', title: 't1', body: 'b1', url: '/?s=web', priority: 'high' });
  assert.deepEqual(lines[1], { at, key: 'deploy:abc123:failed', kind: 'deploy', deployId: 'abc123', state: 'failed', title: 't2', body: '', url: '/', priority: 'default' });
  assert.deepEqual(lines[2], { at, key: 'quota:codex:5h', kind: 'quota', quotaKey: 'codex:5h', title: 't3', body: '', url: '/', priority: 'high' });
  assert.deepEqual(lines[3], { at, key: 'disk:/', kind: 'disk', diskPath: '/', title: 't4', body: '', url: '/', priority: 'urgent' });
  assert.deepEqual(lines[4], { at, key: 'openrouter:credits', kind: 'credits', creditsKey: 'credits', title: 't5', body: '', url: '/', priority: 'default' });
});

test('record: truncates body to 300 chars and tolerates missing/odd fields', async () => {
  const dir = tmp();
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => [] });
  await me.record({ key: 'web:asks', title: 't' });
  await me.record({ key: 'web:waiting', title: 't2', body: 'x'.repeat(800), url: 7, priority: null });
  const lines = readLines(me.file);
  assert.equal(lines[0].body, '');
  assert.equal(lines[0].url, '/');
  assert.equal(lines[0].priority, 'default');
  assert.equal(lines[1].body.length, 300);
  assert.equal(lines[1].url, '/');
  assert.equal(lines[1].priority, 'default');
});

// ---------------------------------------------------------------------------
// rotation: a small maxBytes forces a rename on the next append
// ---------------------------------------------------------------------------

test('rotation: when file size + new line >= maxBytes, the live file is renamed to .1 before the append', async () => {
  const dir = tmp();
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => [], maxBytes: 500 });
  // Three small writes that together exceed 500 bytes on the third append (each ~150 bytes including JSON overhead).
  await me.record({ at: '2026-01-01T00:00:00.000Z', key: 'web:asks', title: 'one', body: 'a'.repeat(80) });
  assert.equal(existsSync(join(dir, FILE_NAME_OLD)), false, 'no .1 yet');
  await me.record({ at: '2026-01-01T00:00:01.000Z', key: 'api:waiting', title: 'two', body: 'b'.repeat(80) });
  assert.equal(existsSync(join(dir, FILE_NAME_OLD)), false, 'still no .1 after second write');
  // third write: ~150 bytes (80 'c's + JSON), ~300 + ~150 = ~450. Still under 500. Use larger body to push past.
  await me.record({ at: '2026-01-01T00:00:02.000Z', key: 'foo:asks', title: 'three', body: 'c'.repeat(180) });
  const oldFile = join(dir, FILE_NAME_OLD);
  assert.ok(existsSync(oldFile), 'old file exists after rotation');
  const oldLines = readLines(oldFile);
  assert.equal(oldLines.length, 2, 'old file has the first two records');
  assert.deepEqual(oldLines.map((l) => l.title), ['one', 'two']);
  const live = readLines(me.file);
  assert.equal(live.length, 1, 'live file has only the third record');
  assert.equal(live[0].title, 'three');
});

test('rotation: a fresh second rotation overwrites the old .1', async () => {
  const dir = tmp();
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => [], maxBytes: 120 });
  await me.record({ at: '2026-01-01T00:00:00.000Z', key: 'web:asks', title: 'a' });   // small
  await me.record({ at: '2026-01-01T00:00:01.000Z', key: 'api:waiting', title: 'b' }); // rotates
  const firstOld = readLines(join(dir, FILE_NAME_OLD));
  assert.equal(firstOld.length, 1);
  assert.equal(firstOld[0].title, 'a');
  await me.record({ at: '2026-01-01T00:00:02.000Z', key: 'foo:asks', title: 'c' });    // small
  await me.record({ at: '2026-01-01T00:00:03.000Z', key: 'bar:asks', title: 'd' });    // rotates again
  const secondOld = readLines(join(dir, FILE_NAME_OLD));
  assert.equal(secondOld.length, 1, 'old .1 has one line (the previous "c")');
  assert.equal(secondOld[0].title, 'c');
  const live = readLines(me.file);
  assert.equal(live.length, 1);
  assert.equal(live[0].title, 'd');
});

// ---------------------------------------------------------------------------
// tail(): the API route's data source — since, limit, missing file
// ---------------------------------------------------------------------------

test('tail: returns the last `limit` lines (newest last); empty file gives []', async () => {
  const dir = tmp();
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => [] });
  for (let i = 0; i < 5; i++) await me.record({ at: new Date(Date.now() + i * 1000).toISOString(), key: `web:asks`, title: `t${i}` });
  const all = await me.tail({});
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((e) => e.title), ['t0', 't1', 't2', 't3', 't4']);
  const three = await me.tail({ limit: 3 });
  assert.deepEqual(three.map((e) => e.title), ['t2', 't3', 't4']);
  assert.deepEqual(await createManagerEvents({ stateDir: tmp() }).tail({}), []);
});

test('tail: since=<ISO> returns only entries strictly after `since` (newest last)', async () => {
  const dir = tmp();
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => [] });
  const at = (n) => `2026-01-01T00:00:0${n}.000Z`;
  await me.record({ at: at(0), key: 'web:asks', title: 't0' });
  await me.record({ at: at(1), key: 'web:asks', title: 't1' });
  await me.record({ at: at(2), key: 'web:asks', title: 't2' });
  const after = await me.tail({ since: at(1) });
  assert.deepEqual(after.map((e) => e.title), ['t2']);
  const afterNone = await me.tail({ since: at(3) });
  assert.deepEqual(afterNone, []);
});

// ---------------------------------------------------------------------------
// createAlerts: onFired fires only when an alert actually fires (not debounced)
// ---------------------------------------------------------------------------

test('createAlerts: onFired(event) fires only on non-debounced calls, with the expected shape', () => {
  let t = 1_000_000;
  const fired = [];
  const { alert, resetDebounce } = createAlerts({
    push: null, fetchImpl: async () => ({ ok: true }), now: () => t, log: quiet,
    onFired: (e) => fired.push(e),
  });
  // first call fires
  assert.equal(alert('web:asks', { title: 'web asks', body: 'q?', url: '/?s=web', priority: 'high' }), true);
  // second call within debounce -> not fired
  assert.equal(alert('web:asks', { title: 'web asks', body: 'q?', url: '/?s=web', priority: 'high' }), false);
  // a different key always fires
  assert.equal(alert('web:done', { title: 'web done' }), true);
  // resetDebounce clears the timer so the original key fires again
  resetDebounce('web:asks');
  assert.equal(alert('web:asks', { title: 'web asks', body: 'q?', url: '/?s=web', priority: 'high' }), true);
  assert.equal(fired.length, 3);
  assert.equal(fired[0].key, 'web:asks');
  assert.equal(fired[0].title, 'web asks');
  assert.equal(fired[0].url, '/?s=web');
  assert.equal(fired[0].priority, 'high');
  assert.equal(typeof fired[0].at, 'string');
  assert.ok(Number.isFinite(Date.parse(fired[0].at)));
  assert.equal(fired[0].body.length <= 300, true);
  assert.equal(fired[1].key, 'web:done');
  assert.equal(fired[2].key, 'web:asks');
  // long bodies are truncated to 300 chars on the event
  fired.length = 0;
  alert('api:waiting', { title: 't', body: 'x'.repeat(800), url: '/', priority: 'low' });
  assert.equal(fired[0].body.length, 300);
});

test('createAlerts: an exception thrown by onFired is caught and logged, the alert still returns true', () => {
  const errors = [];
  const { alert } = createAlerts({
    push: null, fetchImpl: async () => ({ ok: true }), log: { error: (m) => errors.push(m) },
    onFired: () => { throw new Error('boom'); },
  });
  assert.equal(alert('web:asks', { title: 't' }), true);
  assert.ok(errors.some((m) => m.includes('boom')));
});

// ---------------------------------------------------------------------------
// end-to-end: createAlerts(onFired) -> managerEvents.record -> tail (the /api/manager/events data path)
// ---------------------------------------------------------------------------

test('end-to-end: a fired alert (manager sessions + done skipped) lands in manager-events.jsonl', async () => {
  const dir = tmp();
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => ['manager'] });
  const fired = [];
  const pending = [];
  const { alert } = createAlerts({
    push: null, fetchImpl: async () => ({ ok: true }), log: quiet,
    onFired: (e) => { fired.push(e); pending.push(me.record(e)); },
  });
  // skipped (manager session): no line
  alert('manager:asks', { title: 'm asks', priority: 'high' });
  // skipped (done): no line
  alert('web:done', { title: 'w done' });
  // landed
  alert('web:asks', { title: 'w asks', body: 'q', priority: 'high', url: '/?s=web' });
  alert('api:waiting', { title: 'a needs you', priority: 'high' });
  await Promise.all(pending);
  const lines = readLines(me.file);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.session + ':' + l.kind).sort(), ['api:waiting', 'web:asks']);
});
// ---------------------------------------------------------------------------
// dedupe: the same stop re-fired within 6 h is not appended again
// ---------------------------------------------------------------------------

test('dedupe: same session + kind + text within 6 h is skipped; different text, other session, and after the window are kept', async () => {
  const dir = tmp();
  const H = 3600 * 1000, t0 = Date.parse('2026-01-01T00:00:00Z');
  const me = createManagerEvents({ stateDir: dir });
  const ev = (key, body, hours) => ({ key, title: 't', body, at: new Date(t0 + hours * H).toISOString() });
  assert.equal(await me.record(ev('web:asks', 'Should I  deploy\nnow?', 0)), true);
  assert.equal(await me.record(ev('web:asks', 'Should I deploy now?', 0.2)), false);       // whitespace-insensitive duplicate
  assert.equal(await me.record(ev('web:asks', 'Pick A or B?', 0.3)), true);                // different stop
  assert.equal(await me.record(ev('api:asks', 'Should I deploy now?', 0.4)), true);        // other session
  assert.equal(await me.record(ev('web:waiting', 'Should I deploy now?', 0.5)), true);     // other kind
  assert.equal(await me.record(ev('web:asks', 'Should I deploy now?', 6.5)), true);        // after the window
  assert.equal(readLines(me.file).length, 5);
});

test('dedupe: survives a restart (seeded from the file tail)', async () => {
  const dir = tmp();
  const at = '2026-01-01T00:00:00Z';
  await createManagerEvents({ stateDir: dir }).record({ key: 'web:asks', title: 't', body: 'same', at });
  const again = createManagerEvents({ stateDir: dir });
  assert.equal(await again.record({ key: 'web:asks', title: 't', body: 'same', at: '2026-01-01T01:00:00Z' }), false);
});

test('record: routine deploy start/done are not written; kept when a lease blocked them, and failed/orphan always', async () => {
  const dir = tmp();
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => [] });
  assert.equal(await me.record({ key: 'deploy:a:start', title: 't' }), false);
  assert.equal(await me.record({ key: 'deploy:a:done', title: 't', blockedBy: [] }), false);
  assert.equal(await me.record({ key: 'deploy:b:start', title: 't', blockedBy: ['lease'] }), true);
  assert.equal(await me.record({ key: 'deploy:c:failed', title: 't' }), true);
  assert.equal(await me.record({ key: 'deploy:d:orphan', title: 't' }), true);
  const lines = readLines(me.file);
  assert.deepEqual(lines.map((l) => l.key), ['deploy:b:start', 'deploy:c:failed', 'deploy:d:orphan']);
  assert.deepEqual(lines[0].blockedBy, ['lease']);
});
