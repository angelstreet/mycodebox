import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNameStatus, parseStatus, mergeChanges, findOverlaps, ignorer, message, createOverlapGuard, DEFAULT_IGNORE } from '../overlap-guard.js';
import { classifyKey } from '../manager-events.js';

const F = 'scripts/agent/vod_radio_offline_check.py';
const S = (name, startedAt, changes, checkout = `/w/${name}`, repo = '/r/.git') => ({ name, startedAt, repo, checkout, changes: new Map(Object.entries(changes)) });

test('parsers: renames become delete + add, untracked is added', () => {
  assert.deepEqual([...parseNameStatus('M\ta.js\nR100\told.py\tnew.py\nD\tgone.md\nA\tn.js\n')], [['a.js', 'M'], ['old.py', 'D'], ['new.py', 'A'], ['gone.md', 'D'], ['n.js', 'A']]);
  assert.deepEqual([...parseStatus(' M a.js\n?? b.js\nR  x.py -> y.py\n D z\n')], [['a.js', 'M'], ['b.js', 'A'], ['x.py', 'D'], ['y.py', 'A'], ['z', 'D']]);
  assert.equal(mergeChanges(new Map([['p', 'A']]), new Map([['p', 'M']])).get('p'), 'M');
});

test('findOverlaps: the real pair (script-naming vs migration-virtual) on vod_radio_offline_check.py, older first', () => {
  const o = findOverlaps([
    S('migration-virtual', 2000, { [F]: 'M', 'docs/TASK-174.md': 'M' }),
    S('script-naming', 1000, { [F]: 'D', 'scripts/agent/vod_radio_offline_check_v2.py': 'A', 'docs/TASK-174.md': 'M' }),
  ]);
  assert.equal(o.length, 1);
  assert.deepEqual(o[0].pair, ['script-naming', 'migration-virtual']);
  assert.deepEqual(o[0].paths.map((p) => p.path), ['docs/TASK-174.md', F]);
  assert.equal(o[0].paths.find((p) => p.path === F).destructive, true);   // delete vs edit
});

test('findOverlaps: no overlap, convention files, other repo and same checkout are not overlaps', () => {
  assert.deepEqual(findOverlaps([S('a', 1, { 'x.js': 'M' }), S('b', 2, { 'y.js': 'M' })]), []);
  assert.deepEqual(findOverlaps([S('a', 1, { 'VERSION.txt': 'M', 'docs/REFERENCE.md': 'M' }), S('b', 2, { 'VERSION.txt': 'M', 'docs/REFERENCE.md': 'M' })]), []);
  assert.deepEqual(findOverlaps([S('a', 1, { 'x.js': 'M' }), S('b', 2, { 'x.js': 'M' }, '/w/b', '/other/.git')]), []);
  assert.deepEqual(findOverlaps([S('a', 1, { 'x.js': 'M' }, '/w/same'), S('b', 2, { 'x.js': 'M' }, '/w/same')]), []);
  assert.ok(ignorer(['docs/**'])('docs/a/b.md') && !ignorer(['docs/*'])('docs/a/b.md') && ignorer(DEFAULT_IGNORE)('package-lock.json'));
});

test('message names the other session and paths, and the later one waits', () => {
  const paths = [{ path: F, destructive: true }];
  assert.match(message({ other: 'script-naming', paths, newer: true }), /script-naming also changes scripts\/agent\/vod_radio_offline_check\.py.*one message.*started later.*wait/s);
  assert.match(message({ other: 'x', paths, newer: false }), /It started later than you/);
});

test('classifyKey: <a>+<b>:overlap is kind overlap', () => assert.equal(classifyKey('a+b:overlap').kind, 'overlap'));

function harness(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'og-'));
  const sent = [], events = [];
  const diffs = { '/w/a': ` M ${F}\n`, '/w/b': ` M ${F}\n`, '/w/c': ' M other.js\n' };
  const g = createOverlapGuard({
    stateDir: dir, now: () => Date.parse('2026-10-28T10:00:00Z'), log: { error() {} },
    git: async (cwd, a) => a[0] === 'rev-parse' ? (a.includes('--show-toplevel') ? cwd : '/r/.git') : a[0] === 'status' ? (diffs[cwd] || '') : '',
    listTargets: async () => [{ name: 'a', cwd: '/w/a', startedAt: 1 }, { name: 'b', cwd: '/w/b', startedAt: 2 }, { name: 'c', cwd: '/w/c', startedAt: 3 }],
    send: async (n, t) => sent.push([n, t]), record: async (e) => events.push(e), ...over,
  });
  return { g, dir, sent, events };
}

test('tick: tells both sessions once, one manager event per pair per day, snapshot lists it', async () => {
  const { g, dir, sent, events } = harness();
  try {
    const r = await g.tick();
    assert.equal(r.overlaps.length, 1);
    assert.deepEqual(sent.map((s) => s[0]).sort(), ['a', 'b']);
    assert.equal(events.length, 1);
    assert.equal(events[0].key, 'a+b:overlap');
    await g.tick();
    assert.equal(sent.length, 2); assert.equal(events.length, 1);
    assert.match(readFileSync(join(dir, 'overlap-guard.jsonl'), 'utf8'), /"pair":"a\+b"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tick: dry mode tells nobody; a busy session is told later; no-overlap case is quiet', async () => {
  let h = harness({ mode: () => 'dry' });
  try { const r = await h.g.tick(); assert.equal(r.overlaps.length, 1); assert.equal(h.sent.length, 0); assert.equal(h.events.length, 0); } finally { rmSync(h.dir, { recursive: true, force: true }); }
  let busy = true;
  h = harness({ listTargets: async () => [{ name: 'a', cwd: '/w/a', startedAt: 1, working: busy }, { name: 'b', cwd: '/w/b', startedAt: 2 }] });
  try { await h.g.tick(); assert.deepEqual(h.sent.map((s) => s[0]), ['b']); busy = false; await h.g.tick(); assert.deepEqual(h.sent.map((s) => s[0]), ['b', 'a']); } finally { rmSync(h.dir, { recursive: true, force: true }); }
  h = harness({ listTargets: async () => [{ name: 'a', cwd: '/w/a', startedAt: 1 }, { name: 'c', cwd: '/w/c', startedAt: 3 }] });
  try { const r = await h.g.tick(); assert.deepEqual(r.overlaps, []); assert.equal(h.sent.length + h.events.length, 0); } finally { rmSync(h.dir, { recursive: true, force: true }); }
});
