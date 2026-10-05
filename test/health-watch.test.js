// Pure parts of scripts/health-watch.js: thresholds, owner resolution, scratch eligibility, worktree class, debounce, event shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, evalLoad, evaluate, findRunaways, resolveOwner, ownerLabel, scratchEligible, classifyWorktree, shouldWake, buildEvent, isStuckNodeTest, parsePs } from '../scripts/health-watch.js';

const cfg = DEFAULT_CONFIG;
const base = { diskPct: 50, diskFreeGB: 30, load1: 0.5, load5: 0.5, cores: 6, ramAvailPct: 50, runaways: [], stuck: [], defunct: 0 };
const proc = (o) => ({ pid: 10, ppid: 1, etimes: 10 * 3600, rssKB: 100 * 1024, mine: true, pcpu: 0, stat: 'S', args: '/usr/bin/foo --bar', ...o });

test('evaluate: healthy trips nothing; disk/ram thresholds are inclusive/exclusive as documented', () => {
  assert.deepEqual(evaluate(base, cfg, false), []);
  assert.equal(evaluate({ ...base, diskPct: 85 }, cfg, false)[0].type, 'disk');
  assert.equal(evaluate({ ...base, diskPct: 84 }, cfg, false).length, 0);
  assert.equal(evaluate({ ...base, ramAvailPct: 9.9 }, cfg, false)[0].type, 'ram');
  assert.equal(evaluate({ ...base, ramAvailPct: 10 }, cfg, false).length, 0);
  assert.equal(evaluate({ ...base, defunct: 51 }, cfg, false)[0].type, 'defunct');
  assert.equal(evaluate({ ...base, defunct: 50 }, cfg, false).length, 0);
});

test('evalLoad: needs sustained load over the whole window', () => {
  const now = 1e9, m = 60000;
  const hi = (t) => ({ t, load1: 8, load5: 8 });
  assert.equal(evalLoad([hi(now)], now, 6, 1, 10).tripped, false, 'one sample is not sustained');
  assert.equal(evalLoad([hi(now - 5 * m), hi(now)], now, 6, 1, 10).tripped, false, '5 min coverage < 10');
  assert.equal(evalLoad([hi(now - 10 * m), hi(now - 5 * m), hi(now)], now, 6, 1, 10).tripped, true);
  assert.equal(evalLoad([hi(now - 10 * m), { t: now - 5 * m, load1: 1, load5: 7 }, hi(now)], now, 6, 1, 10).tripped, false, 'a dip resets it');
  assert.equal(evalLoad([hi(now - 10 * m), { t: now - 5 * m, load1: 8, load5: 2 }, hi(now)], now, 6, 1, 10).tripped, false, 'load5 must be high too');
});

test('findRunaways: age AND (rss or cpu); skips young, foreign, claude/tmux and protected pids', () => {
  const procs = [
    proc({ pid: 1, rssKB: 2000 * 1024 }), proc({ pid: 2, cpu: 95 }), proc({ pid: 3, rssKB: 2000 * 1024, etimes: 3600 }),
    proc({ pid: 4, rssKB: 2000 * 1024, mine: false }), proc({ pid: 5, rssKB: 2000 * 1024, args: 'claude --resume x' }),
    proc({ pid: 6, rssKB: 2000 * 1024, args: 'tmux: server' }), proc({ pid: 7, rssKB: 2000 * 1024 }), proc({ pid: 8, cpu: 10 }),
  ];
  assert.deepEqual(findRunaways(procs, cfg, new Set([7])).map((p) => p.pid), [1, 2]);
});

test('isStuckNodeTest: bare node --test only', () => {
  assert.equal(isStuckNodeTest('node --test'), true);
  assert.equal(isStuckNodeTest('/usr/local/bin/node --test'), true);
  assert.equal(isStuckNodeTest('node --test test/a.test.js'), false);
  assert.equal(isStuckNodeTest('node server.js'), false);
});

test('resolveOwner: walks the parent chain to tmux pane and claude session', () => {
  const table = new Map([[100, 90], [90, 80], [80, 70], [70, 1], [200, 1]]);
  const panes = new Map([[80, 'task9']]);
  const claude = new Map([[70, { sessionId: 'abcdef12-0000' }]]);
  const o = resolveOwner(100, table, panes, claude);
  assert.equal(o.tmux, 'task9'); assert.ok(o.claude);
  assert.equal(ownerLabel(o), 'tmux:task9');
  assert.equal(ownerLabel(resolveOwner(70, table, new Map(), claude)), 'claude:abcdef12');
  assert.equal(ownerLabel(resolveOwner(200, table, panes, claude)), 'none');
  const loop = new Map([[5, 6], [6, 5]]);
  assert.equal(ownerLabel(resolveOwner(5, loop, new Map(), new Map())), 'none', 'cycle terminates');
});

test('scratchEligible: live vs dead session, age, shape', () => {
  const now = 10 * 86400000, id = '11111111-2222-3333-4444-555555555555';
  const e = (o) => ({ name: id, isDir: true, isSymlink: false, mtimeMs: now - 3 * 86400000, ...o });
  assert.equal(scratchEligible(e(), new Set(), now, 2).ok, true);
  assert.equal(scratchEligible(e(), new Set([id]), now, 2).ok, false, 'live session');
  assert.equal(scratchEligible(e({ mtimeMs: now - 3600000 }), new Set(), now, 2).ok, false, 'too young');
  assert.equal(scratchEligible(e({ name: 'scratchpad' }), new Set(), now, 2).ok, false, 'not a session id');
  assert.equal(scratchEligible(e({ isSymlink: true }), new Set(), now, 2).ok, false, 'symlink');
  assert.equal(scratchEligible(e({ isDir: false }), new Set(), now, 2).ok, false, 'file');
});

test('classifyWorktree: only clean+merged+no session+worktree is removable', () => {
  const ok = { isWorktree: true, clean: true, merged: true, liveSession: false };
  assert.equal(classifyWorktree(ok), 'removable');
  assert.equal(classifyWorktree({ ...ok, isWorktree: false }), 'not-worktree');
  assert.equal(classifyWorktree({ ...ok, liveSession: true }), 'live-session');
  assert.equal(classifyWorktree({ ...ok, clean: false }), 'dirty');
  assert.equal(classifyWorktree({ ...ok, merged: false }), 'unmerged');
});

test('shouldWake: debounce 6 h, worsened disk bypasses it', () => {
  const h = 3600000, now = 100 * h, disk = (s) => ({ type: 'disk', severity: s });
  assert.equal(shouldWake(disk(86), undefined, now, 6).why, 'new');
  assert.equal(shouldWake(disk(86), { at: now - h, severity: 86 }, now, 6).wake, false);
  assert.equal(shouldWake(disk(88), { at: now - h, severity: 86 }, now, 6).wake, false, '+2 is not enough');
  assert.equal(shouldWake(disk(89), { at: now - h, severity: 86 }, now, 6).why, 'worsened');
  assert.equal(shouldWake(disk(86), { at: now - 7 * h, severity: 86 }, now, 6).why, 'window elapsed');
  assert.equal(shouldWake({ type: 'runaway', severity: 0 }, { at: now - h, severity: 0 }, now, 6).wake, false);
});

test('buildEvent: manager-events shape, title <= 80, body <= 300, no jev', () => {
  const issue = { key: 'disk', type: 'disk', title: 'x'.repeat(200), what: 'y'.repeat(500) };
  const ev = buildEvent(issue, 'Auto-freed 1 GB.', '/home/u/.local/state/ghosty/health-reports/r.md', 1e12);
  assert.deepEqual(Object.keys(ev), ['at', 'key', 'kind', 'title', 'body', 'url', 'priority']);
  assert.equal(ev.kind, 'health'); assert.equal(ev.key, 'health:disk');
  assert.ok(ev.title.length <= 80); assert.ok(ev.body.length <= 300);
  assert.equal(ev.at, new Date(1e12).toISOString());
  assert.equal(buildEvent({ key: 'load', title: 't', what: 'w', decision: true }, '', 'p', 1).priority, 'high');
  const short = buildEvent({ key: 'disk', title: 'disk 86% full', what: 'Disk / is 86% full.' }, 'Auto-freed 2.0 GB.', '/r.md', 1);
  assert.match(short.body, /Disk \/ is 86% full\. Auto-freed 2\.0 GB\. Report: \/r\.md/);
});

test('parsePs: parses rows and the owner uid', () => {
  const rows = parsePs('  12   1  7300  2048 1000  1.5 Ssl node --test\n  13  12  5  0 0  0.0 Z [x] <defunct>\n', 1000);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].pid, rows[0].mine, rows[0].args], [12, true, 'node --test']);
  assert.equal(rows[1].mine, false);
});
