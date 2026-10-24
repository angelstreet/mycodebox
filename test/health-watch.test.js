// Pure parts of scripts/health-watch.js: thresholds, owner resolution, scratch eligibility, worktree class, debounce, event shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TMP_PREFIXES, cleanTmp, readInodes, DEFAULT_CONFIG, evalLoad, evaluate, findRunaways, resolveOwner, ownerLabel, scratchEligible, classifyWorktree, shouldWake, buildEvent, isStuckNodeTest, parsePs, scanWorktrees, worktreeIsLive, worktreeReport, runOptionalFixes, stripDeletedSuffix, readProcCwds, mergeTarget, parseWorktreePorcelain, configRepos, configRoots } from '../scripts/health-watch.js';

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

test('findRunaways: the agent of a tmux pane is not a runaway; its children still are (3 false alerts 2026-10-20)', () => {
  // Real topology on codebox: pane 100 -> bash launch script -> agent, plus the agent run straight from the pane.
  const panes = new Set([100, 200]);
  const hot = { etimes: 6 * 3600, rssKB: 1500 * 1024, cpu: 114 };
  const procs = [
    proc({ pid: 100, ppid: 1, args: '-bash', ...hot }),
    proc({ pid: 200, ppid: 100, args: 'minimax-code', ...hot }),
    proc({ pid: 201, ppid: 100, args: '/home/u/.local/bin/claude --dangerously-skip-permissions', ...hot }),
    proc({ pid: 202, ppid: 100, args: 'node /home/u/lib/node_modules/@minimax-ai/code/cli.js', ...hot }),
    proc({ pid: 203, ppid: 100, args: 'node /home/u/lib/node_modules/@openai/codex/bin/cli.js', ...hot }),
    proc({ pid: 110, ppid: 100, args: 'bash /home/u/handovers/task.launch.sh' }),      // pane shell -> launch script
    proc({ pid: 111, ppid: 110, args: 'minimax-code', ...hot }),                       // the agent behind it
    proc({ pid: 112, ppid: 110, args: 'python3 build.py', ...hot }),                   // same wrapper, but not an agent
    proc({ pid: 210, ppid: 201, args: 'node --test test/foo.test.js', ...hot }),        // child of the agent: still a candidate
    proc({ pid: 211, ppid: 100, args: 'npm run build', ...hot }),                      // not an agent command
    proc({ pid: 300, ppid: 99, args: 'minimax-code', ...hot }),                         // agent-shaped but no pane
  ];
  assert.deepEqual(findRunaways(procs, cfg, new Set(), panes).map((p) => p.pid), [100, 112, 210, 211, 300],
    'only the agents (200-203, 111) are exempt; shells, launch-script children and agent children keep the normal rule');
  assert.deepEqual(findRunaways(procs, cfg, new Set()).map((p) => p.pid), [100, 200, 202, 203, 111, 112, 210, 211, 300],
    'without pane info the behaviour is unchanged (201 `claude` was already exempt before this change)');
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

test('findTestLeftovers: orphaned test runs older than the limit, with their whole subtree; live and young ones are left alone', async () => {
  const { findTestLeftovers, isTestArgs } = await import('../scripts/health-watch.js');
  const H = 3600;
  const procs = [
    // 2026-10-15: manager-fresh.sh orphan whose children are the fake git/tmux of a test fixture
    { pid: 10, ppid: 1, etimes: 90 * H, mine: true, args: '/bin/bash /home/user/repo-wt/scripts/manager-fresh.sh' },
    { pid: 11, ppid: 10, etimes: 90 * H, mine: true, args: '/usr/local/bin/node /tmp/rv2-fresh-y0SA70/bin/git -C /tmp/x fetch -q origin' },
    { pid: 20, ppid: 1, etimes: 11 * H, mine: true, args: 'node --import ./checks/freeze-assert.mjs test/report.test.js' },
    { pid: 30, ppid: 1, etimes: 13 * H, mine: true, args: 'node /home/user/app/node_modules/.pnpm/tinypool@1.1.1/node_modules/tinypool/dist/entry/process.js' },
    // not leftovers: a test run with a live parent, a young orphan, an orphan that is not a test, someone else's
    { pid: 40, ppid: 400, etimes: 20 * H, mine: true, args: 'node --test test/a.test.js' },
    { pid: 50, ppid: 1, etimes: 10 * 60, mine: true, args: 'node --test test/b.test.js' },
    { pid: 60, ppid: 1, etimes: 50 * H, mine: true, args: 'python3 work/rangeserver.py site 8901' },
    { pid: 70, ppid: 1, etimes: 50 * H, mine: false, args: 'node --test test/c.test.js' },
    { pid: 80, ppid: 1, etimes: 50 * H, mine: true, args: 'node /home/user/ghosty-sessions/server.js' },
  ];
  const got = findTestLeftovers(procs, 60);
  assert.deepEqual(got.map((l) => [l.pid, l.pids.sort((a, b) => a - b)]), [[10, [10, 11]], [20, [20]], [30, [30]]]);
  assert.ok(isTestArgs('node_modules/.bin/vitest run'));
  assert.ok(!isTestArgs('node server.js --testing-mode'));
});

// ---- tmp auto-clean + inode check
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('TMP_PREFIXES covers every mkdtemp(join(tmpdir(), prefix)) in test/ and scripts/', () => {
  const re = /mkdtemp(?:Sync)?\(\s*(?:path\.)?join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*(['"`])([^'"`$]*)/g;
  const found = new Set();
  for (const d of ['test', 'scripts']) for (const f of readdirSync(new URL(`../${d}`, import.meta.url))) {
    if (!/\.m?js$/.test(f)) continue;
    for (const m of readFileSync(new URL(`../${d}/${f}`, import.meta.url), 'utf8').matchAll(re)) found.add(m[2]);
  }
  // Enough to prove the scan still matches, not a fixed count: tests that create dirs via helpers-tmp.js
  // contribute no mkdtemp prefix, so this shrinks as the leak fix lands.
  assert.ok(found.size > 20, `scan only found ${found.size} prefixes; expected the regex to still match`);
  const missing = [...found].filter((p) => !TMP_PREFIXES.some((q) => p.startsWith(q)));
  assert.deepEqual(missing, [], 'add these prefixes to TMP_PREFIXES in scripts/health-watch.js');
});

test('cleanTmp: removes only old, own, known-prefix real dirs; never follows symlinks; bounded', () => {
  const root = mkdtempSync(join(homedir(), 'tmpclean-test-'));
  try {
    const now = Date.now(), old = new Date(now - 3 * 3600e3), fresh = new Date(now - 600e3);
    const mk = (name, t) => { const p = join(root, name); mkdirSync(join(p, 'sub'), { recursive: true }); writeFileSync(join(p, 'sub', 'f'), 'x'); utimesSync(p, t, t); return p; };
    mk('cbs-old1', old); mk('cbs-old2', old); mk('cbs-fresh', fresh); mk('other-old', old);
    writeFileSync(join(root, 'cbs-file'), 'x');
    const victim = mk('victim', old);
    symlinkSync(victim, join(root, 'cbs-link'));
    const uid = process.getuid();
    const r0 = cleanTmp({ root, uid: uid + 1, now, prefixes: ['cbs-'] });
    assert.equal(r0.removed, 0, 'other owner untouched');
    const r1 = cleanTmp({ root, uid, now, prefixes: ['cbs-'], maxRemovals: 1 });
    assert.deepEqual([r1.removed, r1.truncated], [1, true], 'bounded by count');
    const r2 = cleanTmp({ root, uid, now, prefixes: ['cbs-'] });
    assert.equal(r2.removed, 1);
    assert.deepEqual(readdirSync(root).sort(), ['cbs-file', 'cbs-fresh', 'cbs-link', 'other-old', 'victim']);
    assert.ok(existsSync(join(victim, 'sub', 'f')), 'symlink target intact');
    // time budget: a clock that jumps stops the sweep without throwing
    mk('cbs-old3', old);
    let t = 0; const r3 = cleanTmp({ root, uid, now, prefixes: ['cbs-'], budgetMs: 10, clock: () => (t += 100) });
    assert.deepEqual([r3.removed, r3.truncated], [0, true]);
    assert.equal(cleanTmp({ root, uid, now, prefixes: ['cbs-'], dryRun: true }).removed, 1);
    assert.ok(existsSync(join(root, 'cbs-old3')), 'dry run deletes nothing');
    assert.doesNotThrow(() => cleanTmp({ root: join(root, 'missing'), uid }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readInodes + evaluate: inode % from statfs, alert at the 85% threshold like the bytes check', () => {
  assert.deepEqual(readInodes('/', () => ({ files: 1000, ffree: 150 })), { pct: 85, free: 150 });
  assert.deepEqual(readInodes('/', () => ({ files: 0, ffree: 0 })), { pct: 0, free: 0 });
  assert.deepEqual(readInodes('/', () => { throw new Error('x'); }), { pct: 0, free: 0 });
  const hit = evaluate({ ...base, inodePct: 85, inodeFree: 150 }, cfg, false);
  assert.equal(hit[0].type, 'inode');
  assert.match(hit[0].what, /Inodes on \/ are 85% used \(150 free, limit 85%\)/);
  assert.equal(evaluate({ ...base, inodePct: 84, inodeFree: 160 }, cfg, false).length, 0);
});

test('cachedSize: a report size is walked once per DU_TTL_MS, then again after it expires', async () => {
  const { cachedSize, DU_TTL_MS } = await import('../scripts/health-watch.js');
  const cache = {}; let walks = 0; const walk = () => ++walks;
  assert.equal(cachedSize('du:/x', walk, 1000, cache), 1);
  assert.equal(cachedSize('du:/x', walk, 1000 + DU_TTL_MS - 1, cache), 1);
  assert.equal(cachedSize('du:/x', walk, 1000 + DU_TTL_MS, cache), 2);
  assert.equal(cachedSize('du:/y', walk, 0, null), 3);   // no cache: always fresh
});

// ---- worktree scan: which paths may be removed at all, and the guards that keep a live session alive
// The scan used to walk ~/vpt-* and ~/ghosty-* only, so it never saw the worktrees that hold the space. It now walks
// the REGISTERED worktrees of the repos the owner configured (state-dir config), bounded by the allowed roots.
import { tmp } from './helpers-tmp.js';

// A fake git: one entry per path, so the tests drive the scan without a real repository.
function fakeGit(spec) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args.slice());
    const i = args.indexOf('-C');
    if (i < 0) return null;
    const e = spec[args[i + 1]], rest = args.slice(i + 2);
    if (!e) return null;
    if (rest[0] === 'rev-parse') {
      if (rest[1] === '--git-common-dir') return e.common;
      if (rest[1] === '--verify') return e.refs?.has(rest[3]) ? 'deadbeef' : null;
      if (rest[1] === '--abbrev-ref') return e.branch || 'HEAD';
      if (rest[1] === 'HEAD') return e.head || null;                     // the branch tip
      if (rest[1] && e.refs?.has(rest[1])) return e.target || null;      // the merge target's tip
    }
    if (rest[0] === 'worktree' && rest[1] === 'list') return e.list;
    if (rest[0] === 'status') return e.status;
    if (rest[0] === 'merge-base') return e.mergedRefs?.has(rest[3]) ? '' : null;
    if (rest[0] === 'reflog') return e.reflog || null;                   // branch reflog, newest entry first
    return null;
  };
  run.calls = calls;
  return run;
}

// A repo with a main worktree (a .git DIRECTORY) and linked worktrees (a .git FILE).
function makeRepo(root, name, worktrees = [], opts = {}) {
  const main = join(root, name), common = join(root, '.git', name);
  const refs = new Set(opts.refs || ['refs/remotes/origin/main']);
  const mergedRefs = new Set(opts.mergedRefs || ['refs/remotes/origin/main']);
  mkdirSync(join(main, '.git'), { recursive: true });
  const list = [`worktree ${main}\nHEAD aaa\nbranch refs/heads/main`];
  const spec = { [main]: { common, list: '', refs, mergedRefs, status: '', branch: 'main', head: 'aaa', target: 'aaa' } };
  for (const w of worktrees) {
    const p = join(main, w.name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, '.git'), `gitdir: ${common}/worktrees/${w.name}\n`);
    const branch = w.branch || 'feature';
    list.push(`worktree ${p}\nHEAD bbb\nbranch refs/heads/${branch}`);
    spec[p] = { common: `${common}/worktrees/${w.name}`, status: w.status ?? '', branch,
      head: w.head || 'bbb', target: w.target || 'aaa', reflog: w.reflog || null,
      refs, mergedRefs: new Set(w.mergedRefs ?? mergedRefs) };
  }
  spec[main].list = list.join('\n\n') + '\n';
  return { main, common, spec, paths: worktrees.map((w) => join(main, w.name)) };
}
const scanOf = (repos, cfg) => scanWorktrees({ cfg, run: fakeGit(Object.assign({}, ...repos.map((r) => r.spec))) });

test('T1 scan: a registered worktree whose name does not match the old ~/vpt-* ~/ghosty-* glob is found', () => {
  const root = tmp('hw-wt-');
  const a = makeRepo(root, 'alpha', [{ name: 'virtualpytest-ui-sunrise' }]);
  const scan = scanOf([a], { worktreeRepos: { alpha: a.main }, worktreeRoots: [root] });
  assert.ok(!/^(vpt-|ghosty-)/.test('virtualpytest-ui-sunrise'), 'the old glob never visited this name');
  assert.deepEqual(scan.candidates.map((w) => w.dir), [join(a.main, 'virtualpytest-ui-sunrise')]);
});

test('T2 live: exact match, sub-directory and a pane path ending in " (deleted)" all count as live', () => {
  const root = tmp('hw-wt-');
  const dir = join(root, 'wt-live');
  mkdirSync(dir, { recursive: true });
  assert.equal(worktreeIsLive(dir, { panes: [{ path: dir }] }), true, 'exact match');
  assert.equal(worktreeIsLive(dir, { panes: [{ path: join(dir, 'sub') }] }), true, 'sub-directory');
  assert.equal(worktreeIsLive(dir, { panes: [{ path: dir + ' (deleted)' }] }), true,
    'tmux appends " (deleted)" to the cwd of a session whose directory was deleted and recreated under it');
  assert.equal(worktreeIsLive(dir, { panes: [{ path: join(root, 'other') }] }), false);
  assert.equal(worktreeIsLive(dir, { panes: [{ path: dir + '-sibling' }] }), false, 'a name prefix is not inside it');
  assert.equal(worktreeIsLive(dir, { claude: [{ alive: true, cwd: dir + ' (deleted)' }] }), true);
  assert.equal(worktreeIsLive(dir, { claude: [{ alive: false, cwd: dir }] }), false, 'a dead session is not live');
  assert.equal(worktreeIsLive(dir, { procCwds: [{ pid: 1, cwd: join(dir, 'sub') }] }), true,
    'any live process whose /proc cwd is inside the worktree');
  assert.equal(stripDeletedSuffix('/x/y (deleted)'), '/x/y');
});

test('T2 scan: a worktree whose pane path ends in " (deleted)" is live-session, never removable', () => {
  const root = tmp('hw-wt-');
  const a = makeRepo(root, 'alpha', [{ name: 'wt-live' }]);
  const dir = join(a.main, 'wt-live');
  const scan = scanOf([a], { worktreeRepos: { alpha: a.main }, worktreeRoots: [root] });
  assert.equal(scan.candidates[0].kind, 'removable', 'without a session it is removable');
  const live = scanWorktrees({ cfg: { worktreeRepos: { alpha: a.main }, worktreeRoots: [root] },
    panes: [{ name: 'sess', pid: 1, path: dir + ' (deleted)' }], run: fakeGit(a.spec) });
  assert.equal(live.candidates[0].kind, 'live-session', 'the running session keeps the directory');
  assert.equal(live.candidates[0].liveSession, true);
});

test('T3 scope: a repo that is not configured is never enumerated, and a path outside the allowed roots is never a candidate', () => {
  const root = tmp('hw-wt-');
  const a = makeRepo(root, 'alpha', [{ name: 'wt-inside' }]);
  const b = makeRepo(root, 'beta', [{ name: 'wt-other' }]);
  const only = scanOf([a, b], { worktreeRepos: { alpha: a.main }, worktreeRoots: [root] });
  assert.deepEqual(only.candidates.map((w) => w.name), ['wt-inside']);
  assert.ok(!only.notConsidered.some((x) => x.name === 'wt-other'), 'an unconfigured repo is never enumerated');
  const both = scanOf([a, b], { worktreeRepos: { alpha: a.main, beta: b.main }, worktreeRoots: [join(root, 'alpha')] });
  assert.deepEqual(both.candidates.map((w) => w.name), ['wt-inside'], 'outside the allowed roots is never a candidate');
  assert.ok(both.notConsidered.some((x) => x.name === 'wt-other' && /outside the allowed roots/.test(x.reason)));
  assert.equal(configRepos({ worktreeRepos: { alpha: 'relative/path' } }).length, 0, 'only absolute repo paths');
  assert.deepEqual(configRoots({ worktreeRoots: ['/a', 'relative'] }), ['/a']);
});

test('T4 the main worktree of a repo is never removable', () => {
  const root = tmp('hw-wt-');
  const a = makeRepo(root, 'alpha', [{ name: 'wt-a' }]);
  const scan = scanOf([a], { worktreeRepos: { alpha: a.main }, worktreeRoots: [root] });
  assert.ok(!scan.candidates.some((w) => w.dir === a.main), 'the main worktree is not a candidate');
  assert.ok(scan.notConsidered.some((x) => x.dir === a.main && /main worktree/.test(x.reason)));
});

test('T5 merge target: origin/main when the repo has it, the local main otherwise, and the ref is reported', () => {
  const root = tmp('hw-wt-');
  const a = makeRepo(root, 'alpha', [
    { name: 'wt-merged', mergedRefs: ['refs/remotes/origin/main'] },   // merged upstream, stale local main
    { name: 'wt-unmerged', mergedRefs: [] },
  ], { refs: ['refs/remotes/origin/main', 'refs/heads/main'] });
  const scan = scanOf([a], { worktreeRepos: { alpha: a.main }, worktreeRoots: [root] });
  const by = Object.fromEntries(scan.candidates.map((w) => [w.name, w]));
  assert.equal(by['wt-merged'].kind, 'removable', 'merged into origin/main, not into the stale local main');
  assert.equal(by['wt-merged'].mergedRef, 'origin/main');
  assert.equal(by['wt-unmerged'].kind, 'unmerged');
  const b = makeRepo(root, 'beta', [{ name: 'wt-local', mergedRefs: ['refs/heads/main'] }],
    { refs: ['refs/heads/main'], mergedRefs: ['refs/heads/main'] });
  const scan2 = scanOf([b], { worktreeRepos: { beta: b.main }, worktreeRoots: [root] });
  assert.equal(scan2.candidates[0].kind, 'removable', 'no origin/main: the local main is the fallback');
  assert.equal(scan2.candidates[0].mergedRef, 'main');
  const report = worktreeReport(scan2, { du: () => 1024 });
  assert.match(report, /beta: merge target main/, 'the report says which ref was used');
  assert.match(report, /\| main \| yes \|/, 'the table says which ref was used');
  assert.equal(mergeTarget(fakeGit(b.spec), b.main).name, 'main');
});

test('T6 dry run: nothing is removed and the report states the not-considered count and bytes', () => {
  const root = tmp('hw-wt-');
  const a = makeRepo(root, 'alpha', [{ name: 'wt-a' }]);
  const scan = scanOf([a], { worktreeRepos: { alpha: a.main }, worktreeRoots: [root] });
  assert.equal(scan.candidates.filter((w) => w.kind === 'removable').length, 1);
  const log = [];
  runOptionalFixes({ cfg: { fixLevel: 'cleanup+worktrees' }, dryRun: true, wts: scan.candidates, log }, []);
  assert.match(log.join('\n'), /WOULD remove worktree/, 'the dry run only reports');
  assert.ok(existsSync(join(a.main, 'wt-a')), 'the dry run removed nothing');
  const report = worktreeReport(scan, { du: () => 4096 });
  assert.match(report, /not considered: 1 worktrees, 4 MB/, 'the blind spot is visible: count and bytes');
  assert.match(report, /not considered \| repo \| reason \| size/);
});

test('T7 a worktree whose only content is ignored files is not removable, and the report says so', () => {
  const root = tmp('hw-wt-');
  const a = makeRepo(root, 'alpha', [{ name: 'wt-ignored', status: '!! build/\n' }]);
  const scan = scanOf([a], { worktreeRepos: { alpha: a.main }, worktreeRoots: [root] });
  const w = scan.candidates[0];
  assert.equal(w.clean, true, 'nothing tracked or untracked is modified');
  assert.equal(w.ignoredFiles, 1);
  assert.equal(w.kind, 'ignored-files', 'git worktree remove would delete ignored files silently');
  assert.notEqual(w.kind, 'removable');
  const report = worktreeReport(scan, { du: () => 1 });
  assert.match(report, /ignored-files/);
  assert.match(report, /\| 1 \| origin\/main \| yes \| no \| ignored-files \|/, 'the ignored file count is in the table');
});

test('T8 an unstarted branch is not merged: a branch with no commits of its own is never removable', () => {
  const root = tmp('hw-wt-');
  const a = makeRepo(root, 'alpha', [
    { name: 'wt-unstarted', reflog: 'bbb\n' },      // created from main, never committed: HEAD is the fork point
    { name: 'wt-started', reflog: 'bbb\naaa\n' },   // created from main, one commit of its own, already in origin/main
    { name: 'wt-no-reflog', head: 'aaa' },          // no reflog: HEAD is the merge target's own tip
  ]);
  const scan = scanOf([a], { worktreeRepos: { alpha: a.main }, worktreeRoots: [root] });
  const by = Object.fromEntries(scan.candidates.map((w) => [w.name, w]));
  assert.equal(by['wt-unstarted'].merged, false, 'a branch with no commits of its own is unstarted, not merged');
  assert.equal(by['wt-unstarted'].kind, 'unstarted');
  assert.notEqual(by['wt-unstarted'].kind, 'removable', 'the E51 case: clean + ancestor of origin/main is not enough');
  assert.equal(by['wt-started'].merged, true, 'a branch with a commit of its own, already in origin/main, is merged');
  assert.equal(by['wt-started'].kind, 'removable', 'a merged branch with work of its own is still reclaimed');
  assert.equal(by['wt-no-reflog'].merged, false, 'without a reflog, HEAD == the merge target tip is unstarted too');
  assert.equal(by['wt-no-reflog'].kind, 'unstarted');
});

test('helpers: worktree porcelain, proc cwds and the deleted suffix', () => {
  const list = parseWorktreePorcelain('worktree /a\nHEAD x\nbranch refs/heads/main\n\nworktree /b\nHEAD y\ndetached\n');
  assert.deepEqual(list, [{ path: '/a', branch: 'main', detached: false }, { path: '/b', branch: '', detached: true }]);
  const cwds = readProcCwds([{ pid: 7, mine: true }, { pid: 8, mine: false }],
    (p) => (p === '/proc/7/cwd' ? '/x/y (deleted)' : '/x/y'));
  assert.deepEqual(cwds, [{ pid: 7, cwd: '/x/y (deleted)' }], 'only own processes');
});
