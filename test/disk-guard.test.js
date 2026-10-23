// The disk-space safety policy (disk-guard.js): the thresholds, the switch, the refusal of new work and the
// read-only top consumers. The disk readings are fake (an injected statfs) and the state dir is a temp dir:
// no live state is read or written here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers-tmp.js';
import { createDiskGuard, guardConfig, diskLevel, sampleDisks, parseDu, holdMessage, REASON } from '../disk-guard.js';

// A statfs reading: a volume of `usedPct` percent used. `dev` identifies the volume (the same one twice is one volume).
const vol = (usedPct, { dev = 1, bsize = 4096, sizeGb = 100 } = {}) => {
  const blocks = Math.round((sizeGb * 2 ** 30) / bsize);
  const used = Math.round((blocks * usedPct) / 100);
  return { blocks, bfree: blocks - used, bavail: blocks - used, bsize, dev };
};
const statfsFake = (map) => async (p) => {
  const v = map[p];
  if (!v) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
  return v;
};

test('the thresholds: warn at 85 %, hold at 90 %', () => {
  assert.equal(diskLevel(84.9), 'ok');
  assert.equal(diskLevel(85), 'warn');
  assert.equal(diskLevel(89.9), 'warn');
  assert.equal(diskLevel(90), 'hold');
  assert.equal(diskLevel(99), 'hold');
  assert.equal(diskLevel(null), 'unknown');
  assert.equal(diskLevel(undefined), 'unknown');
});

test('the switch: on by default, manager.json and the environment both set it', () => {
  const dir = tmp('diskcfg-');
  const file = path.join(dir, 'manager.json');

  const def = guardConfig({ file, env: {} });
  assert.equal(def.enabled, true, 'the policy is on by default');
  assert.equal(def.holdPct, 90);
  assert.equal(def.warnPct, 85);
  assert.equal(def.override, false);

  const env = guardConfig({ file, env: { GHOSTY_DISK_HOLD_PCT: '95', GHOSTY_DISK_WARN_PCT: '80', GHOSTY_DISK_PATHS: '/a,/b' } });
  assert.equal(env.holdPct, 95);
  assert.equal(env.warnPct, 80);
  assert.deepEqual(env.paths, ['/a', '/b']);

  fs.writeFileSync(file, JSON.stringify({ diskGuard: { holdPct: 70, warnPct: 60, paths: ['/x'] } }));
  const j = guardConfig({ file, env: { GHOSTY_DISK_HOLD_PCT: '95', GHOSTY_DISK_PATHS: '/a' } });
  assert.equal(j.holdPct, 70, 'the owner\'s setting wins over the environment');
  assert.equal(j.warnPct, 60);
  assert.deepEqual(j.paths, ['/x']);

  fs.writeFileSync(file, JSON.stringify({ diskGuard: { enabled: false } }));
  assert.equal(guardConfig({ file, env: {} }).enabled, false, 'the owner can turn the policy off');
  assert.equal(guardConfig({ file: path.join(dir, 'absent.json'), env: { GHOSTY_DISK_GUARD: '0' } }).enabled, false,
    'the environment can turn it off too');
});

test('the volumes: one reading per volume, an unreadable path is skipped', async () => {
  const vols = { '/state': vol(50, { dev: 7 }), '/wt': vol(50, { dev: 7 }), '/other': vol(10, { dev: 8 }) };
  const list = await sampleDisks(['/state', '/wt', '/other', '/missing'], statfsFake(vols));
  assert.equal(list.length, 2, 'the same volume listed twice is one volume');
  assert.deepEqual(list.map((d) => d.path), ['/state', '/other']);
  assert.ok(Math.abs(list[0].pct - 50) < 0.01);
  assert.ok(Math.abs(list[1].pct - 10) < 0.01);
});

test('the policy: at 86 % the banner shows and new work still starts', async () => {
  const dir = tmp('diskwarn-');
  const g = createDiskGuard({ configFile: path.join(dir, 'manager.json'), env: {}, defaultPaths: ['/state'],
    statfsImpl: statfsFake({ '/state': vol(86) }) });
  const s = await g.status();
  assert.equal(s.level, 'warn');
  assert.equal(s.reason, REASON);
  assert.equal(s.blocked, false, 'a warning does not refuse new work');
  await assert.doesNotReject(() => g.assertStart('Starting a new session'));
});

test('the hold: at 91 % new work is refused with 409 and the reason code', async () => {
  const dir = tmp('diskhold-');
  const g = createDiskGuard({ configFile: path.join(dir, 'manager.json'), env: {}, defaultPaths: ['/state'],
    statfsImpl: statfsFake({ '/state': vol(91) }) });
  const s = await g.status();
  assert.equal(s.level, 'hold');
  assert.equal(s.reason, REASON);
  assert.equal(s.blocked, true);
  await assert.rejects(() => g.assertStart('Starting a new session'), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.reason, REASON);
    assert.equal(err.code, REASON);
    assert.match(err.message, /91% full/, 'the owner reads the real number');
    return true;
  });
});

test('the owner override: the hold is lifted, the banner still shows', async () => {
  const dir = tmp('diskover-');
  const file = path.join(dir, 'manager.json');
  fs.writeFileSync(file, JSON.stringify({ diskGuard: { override: true } }));
  const g = createDiskGuard({ configFile: file, env: {}, defaultPaths: ['/state'],
    statfsImpl: statfsFake({ '/state': vol(93) }) });
  await assert.doesNotReject(() => g.assertStart('Starting a new session'), 'the explicit override wins');
  const s = await g.status();
  assert.equal(s.level, 'hold');
  assert.equal(s.blocked, false);
  assert.equal(s.reason, REASON, 'the disk is still low, so the banner stays');
});

test('the switch off: nothing is refused and no banner is shown', async () => {
  const dir = tmp('diskoff-');
  const file = path.join(dir, 'manager.json');
  fs.writeFileSync(file, JSON.stringify({ diskGuard: { enabled: false } }));
  const g = createDiskGuard({ configFile: file, env: {}, defaultPaths: ['/state'],
    statfsImpl: statfsFake({ '/state': vol(97) }) });
  await assert.doesNotReject(() => g.assertStart('Starting a new session'));
  const s = await g.status();
  assert.equal(s.blocked, false);
  assert.equal(s.reason, null);
});

test('an unreadable volume never blocks: no reading, no decision', async () => {
  const dir = tmp('diskunknown-');
  const g = createDiskGuard({ configFile: path.join(dir, 'manager.json'), env: {}, defaultPaths: ['/gone'],
    statfsImpl: statfsFake({}) });
  const s = await g.status();
  assert.equal(s.level, 'unknown');
  assert.equal(s.blocked, false);
  await assert.doesNotReject(() => g.assertStart('Starting a new session'));
});

test('the V2 admission: the same decision, as a coded verdict for the worktree', async () => {
  const dir = tmp('diskadmit-');
  const file = path.join(dir, 'manager.json');
  const g = createDiskGuard({ configFile: file, env: {}, defaultPaths: ['/state'],
    statfsImpl: statfsFake({ '/state': vol(95) }) });
  const v = await g.admit();
  assert.equal(v.ok, false);
  assert.equal(v.code, REASON);
  assert.match(v.message, /paused/);

  fs.writeFileSync(file, JSON.stringify({ diskGuard: { override: true } }));
  assert.equal((await g.admit()).ok, true);
});

test('the detail: the biggest folders of the watched places, read-only', async () => {
  const dir = tmp('diskdetail-');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'logs', 'big.log'), 'x'.repeat(300_000));
  const g = createDiskGuard({ configFile: path.join(dir, 'manager.json'), env: {}, defaultPaths: [stateDir],
    stateDir, repoRoot: null, workRoot: null, statfsImpl: statfsFake({ [stateDir]: vol(50) }) });
  const d = await g.detail();
  assert.equal(d.reason, null);
  assert.ok(Array.isArray(d.top));
  assert.ok(d.top.some((t) => t.path.endsWith('logs')), 'the logs folder is a consumer');
  assert.ok(d.top.every((t) => t.bytes > 0 && typeof t.path === 'string'));
});

test('the du output is parsed into bytes and paths', () => {
  assert.deepEqual(parseDu('12\t/a\n345\t/b\n'), [{ bytes: 12 * 1024, path: '/a' }, { bytes: 345 * 1024, path: '/b' }]);
  assert.deepEqual(parseDu(''), []);
  assert.deepEqual(parseDu('not du output'), []);
});

test('the message the owner reads says what is wrong, what is refused and what still works', () => {
  const msg = holdMessage({ worst: { path: '/', pct: 91.4, free: 2 * 2 ** 30 }, holdPct: 90 }, 'Starting a new session');
  assert.match(msg, /91% full/);
  assert.match(msg, /2\.0 GB free/);
  assert.match(msg, /Starting a new session is paused until it drops below 90%/);
  assert.match(msg, /already running are not affected/);
});
