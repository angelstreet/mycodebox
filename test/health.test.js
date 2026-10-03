import test from 'node:test';
import assert from 'node:assert/strict';
import { levelOf, parseProcStat, cpuPct, parseMeminfo, diskFromStatfs, loadLevel } from '../health.js';

test('levelOf: warn at 85 %, critical at 95 %', () => {
  assert.equal(levelOf(84.9), 'ok');
  assert.equal(levelOf(85), 'warn');
  assert.equal(levelOf(94.9), 'warn');
  assert.equal(levelOf(95), 'crit');
  assert.equal(levelOf(null), 'unknown');
});

test('cpuPct from two /proc/stat samples', () => {
  const a = parseProcStat('cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3 4\n');
  const b = parseProcStat('cpu  200 0 200 900 100 0 0 0 0 0\n');
  assert.deepEqual(a, { idle: 800, total: 1000 });
  // 400 jiffies elapsed, 200 idle -> 50 % busy
  assert.equal(cpuPct(a, b), 50);
  assert.equal(cpuPct(null, b), null);
});

test('parseMeminfo uses MemAvailable like `free`', () => {
  const m = parseMeminfo('MemTotal:       16000 kB\nMemFree:  1000 kB\nMemAvailable:    4000 kB\n');
  assert.equal(m.total, 16000 * 1024);
  assert.equal(m.used, 12000 * 1024);
  assert.equal(m.pct, 75);
});

test('diskFromStatfs matches df Use% (root-reserved blocks excluded)', () => {
  // 100 blocks, 10 free, 5 of those reserved for root -> used 90, avail 5 -> 90/95
  const d = diskFromStatfs('/', { bsize: 4096, blocks: 100, bfree: 10, bavail: 5 });
  assert.equal(d.used, 90 * 4096);
  assert.equal(d.free, 5 * 4096);
  assert.ok(Math.abs(d.pct - 100 * 90 / 95) < 1e-9);
  assert.equal(levelOf(d.pct), 'warn');
});

test('loadLevel: warn at load = cores, crit at 2x cores', () => {
  assert.equal(loadLevel(5.9, 6), 'ok');
  assert.equal(loadLevel(6, 6), 'warn');
  assert.equal(loadLevel(12, 6), 'crit');
});
