import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestartCheck, unitsFor, verdict, FILE_NAME } from '../restart-check.js';

const T0 = Date.parse('2026-11-28T12:00:00Z');

test('unitsFor: ghosty-sessions always, ghosty-usage only for the tailer paths', () => {
  assert.deepEqual(unitsFor(['server.js', 'docs/x.md']), ['ghosty-sessions']);
  assert.deepEqual(unitsFor(['usage/ingest.js']), ['ghosty-sessions', 'ghosty-usage']);
  assert.deepEqual(unitsFor(['scorecard.js']), ['ghosty-sessions', 'ghosty-usage']);
  assert.deepEqual(unitsFor(['public/usage-view.js']), ['ghosty-sessions']);   // not the tailer
  assert.deepEqual(unitsFor(undefined), ['ghosty-sessions']);
});

test('verdict: started after the restart = ok; before = stale; not installed = skipped; failed waiter = not ok', () => {
  assert.equal(verdict({ exitCode: 0, starts: { 'ghosty-sessions': T0 + 5e3 }, restartAt: T0 }).ok, true);
  const stale = verdict({ exitCode: 0, starts: { 'ghosty-sessions': T0 + 5e3, 'ghosty-usage': T0 - 3600e3 }, restartAt: T0 });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /still on old code: ghosty-usage/);
  const skipped = verdict({ exitCode: 0, starts: { 'ghosty-sessions': T0 + 5e3, 'ghosty-usage': null }, restartAt: T0 });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.units[1].ok, null);
  const failed = verdict({ exitCode: 2, starts: { 'ghosty-sessions': T0 - 10e3 }, restartAt: T0 });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /safe-restart exited 2; still on old code: ghosty-sessions/);
});

function harness({ reqs, exits = {}, starts = {}, changed = [], now = T0 + 600e3 }) {
  const dir = mkdtempSync(join(tmpdir(), 'restart-check-'));
  const items = [], calls = { exit: 0 };
  const rc = createRestartCheck({ stateDir: dir,
    listDeployed: async () => reqs,
    getReq: (id) => reqs.find((r) => r.id === id) || null,
    changedPaths: async () => changed,
    unitStartMs: async (u) => (u in starts ? starts[u] : null),
    readExit: async (f) => { calls.exit++; return f in exits ? exits[f] : null; },
    managerItem: (e) => { items.push(e); },
    now: () => now, log: { log() {}, error() {} } });
  return { rc, dir, items, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const sd = (o) => ({ live: '/live', prevSha: 'a'.repeat(40), newSha: 'b'.repeat(40), expectedSha: 'b'.repeat(40), restartAt: new Date(T0).toISOString(), ...o });

test('tick: waits while the waiter runs, then ok once, state saved', async () => {
  const reqs = [{ id: 'int-1', selfDeploy: sd({ restart: 'scheduled', exit: '/r/int-1.exit' }) }];
  const exits = {};
  const h = harness({ reqs, exits, starts: { 'ghosty-sessions': T0 + 30e3 } });
  try {
    assert.deepEqual(await h.rc.tick(), []);                         // no exit file yet: look again next tick
    exits['/r/int-1.exit'] = 0;                                      // the waiter exits
    const out = await h.rc.tick();
    assert.equal(out.length, 1);
    assert.equal(out[0].ok, true);
    assert.equal(h.items.length, 0);
    const saved = JSON.parse(readFileSync(join(h.dir, 'integration', FILE_NAME), 'utf8'));
    assert.equal(saved['int-1'].ok, true);
    assert.deepEqual(await h.rc.tick(), []);                         // checked once
  } finally { h.cleanup(); }
});

test('tick: a stale tailer after a usage/ merge raises ONE high manager item, kept across a restart of the checker', async () => {
  const reqs = [{ id: 'int-2', selfDeploy: sd({ restart: 'scheduled', exit: '/r/int-2.exit' }) }];
  const opts = { reqs, exits: { '/r/int-2.exit': 0 }, changed: ['usage/loops.js'], starts: { 'ghosty-sessions': T0 + 30e3, 'ghosty-usage': T0 - 7200e3 } };
  const h = harness(opts);
  try {
    const out = await h.rc.tick();
    assert.equal(out[0].ok, false);
    assert.equal(h.items.length, 1);
    assert.equal(h.items[0].key, 'integration:int-2:not-live');
    assert.equal(h.items[0].priority, 'high');
    assert.match(h.items[0].title, /merged but not live \(still on old code: ghosty-usage/);
    assert.ok(h.items[0].body.length <= 300);
    await h.rc.tick();
    assert.equal(h.items.length, 1);
    // a new checker on the same state dir (server restarted) does not raise it again
    const again = createRestartCheck({ stateDir: h.dir, listDeployed: async () => reqs, changedPaths: async () => opts.changed,
      unitStartMs: async () => T0 - 7200e3, readExit: async () => 0, managerItem: (e) => h.items.push(e), now: () => T0 + 700e3, log: { log() {}, error() {} } });
    assert.deepEqual(await again.tick(), []);
    assert.equal(h.items.length, 1);
  } finally { h.cleanup(); }
});

test('tick: a coalesced restart reads the waiter request exit; skipped/launch_failed/old/non-self requests are ignored', async () => {
  const reqs = [
    { id: 'int-3', selfDeploy: sd({ restart: 'coalesced', restartWaiter: 'int-w' }) },
    { id: 'int-w', selfDeploy: sd({ restart: 'scheduled', exit: '/r/int-w.exit' }) },
    { id: 'int-4', selfDeploy: sd({ restart: 'skipped' }) },
    { id: 'int-5', selfDeploy: sd({ restart: 'launch_failed', exit: '/r/int-5.exit' }) },
    { id: 'int-6', selfDeploy: sd({ restart: 'scheduled', exit: '/r/int-6.exit', restartAt: new Date(T0 - 30 * 3600e3).toISOString() }) },
    { id: 'int-7' },
  ];
  const h = harness({ reqs, exits: { '/r/int-w.exit': 0, '/r/int-5.exit': 2, '/r/int-6.exit': 0 }, starts: { 'ghosty-sessions': T0 + 30e3 } });
  try {
    const out = await h.rc.tick();
    assert.deepEqual(out.map((o) => o.id).sort(), ['int-3', 'int-w']);
    assert.ok(out.every((o) => o.ok));
  } finally { h.cleanup(); }
});

test('tick: a waiter that exited before this process started is recorded unwatched: no item, not judged live', async () => {
  const reqs = [
    { id: 'int-old', selfDeploy: sd({ restart: 'scheduled', exit: '/r/int-old.exit' }) },
    { id: 'int-new', selfDeploy: sd({ restart: 'scheduled', exit: '/r/int-new.exit' }) },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'restart-check-'));
  const items = [], logged = [];
  const startedAt = T0 + 60e3;
  const exits = { '/r/int-old.exit': { code: 0, at: T0 + 30e3 }, '/r/int-new.exit': { code: 0, at: T0 + 90e3 } };
  const rc = createRestartCheck({ stateDir: dir, startedAt, listDeployed: async () => reqs, changedPaths: async () => ['usage/loops.js'],
    unitStartMs: async () => T0 - 7200e3,                                 // both units look stale
    readExit: async (f) => exits[f] ?? null, managerItem: (e) => items.push(e), now: () => T0 + 600e3,
    log: { log: (...a) => logged.push(a.join(' ')), error() {} } });
  try {
    const out = await rc.tick();
    const old = out.find((o) => o.id === 'int-old'), fresh = out.find((o) => o.id === 'int-new');
    assert.equal(old.ok, null);
    assert.equal(old.unwatched, true);
    assert.equal(fresh.ok, false);                                         // watched: judged, and stale
    assert.deepEqual(items.map((i) => i.key), ['integration:int-new:not-live']);
    assert.ok(!logged.some((l) => l.includes('int-old')));
    const saved = JSON.parse(readFileSync(join(dir, 'integration', FILE_NAME), 'utf8'));
    assert.deepEqual(saved['int-old'], { at: T0 + 600e3, ok: null, unwatched: true });
    assert.deepEqual(await rc.tick(), []);                                 // recorded once
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
