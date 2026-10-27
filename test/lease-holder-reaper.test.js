// lease-holder-reaper: releases leases whose holder pid on this host is gone, never a live one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHolderReaper, watchable, procStartSec } from '../lease-holder-reaper.js';
import { tmp } from './helpers-tmp.js';

const SINCE = 1793134000;
const row = (o = {}) => ({ id: 'aaaa1111', mode: 'exclusive', agent: 'codebox:TASK-168-4242', since: SINCE, ...o });
function harness(rows, procs = { 4242: SINCE - 100 }) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'list') return { code: 0, stdout: JSON.stringify({ leases: rows.cur }), stderr: '' };
    return { code: 0, stdout: 'released 1', stderr: '' };
  };
  const r = createHolderReaper({ stateDir: tmp('hr-'), run, startOf: (p) => procs[p] ?? null, log: { log() {}, error() {} } });
  return { r, calls, procs, releases: () => calls.filter((c) => c[0] === 'release') };
}

test('dead agent-name pid is released on the 2nd poll, after it was seen alive; reason carries the pid', async () => {
  const rows = { cur: [row()] };
  const h = harness(rows);
  await h.r.poll(); assert.equal(h.releases().length, 0);
  delete h.procs[4242];
  await h.r.poll(); assert.equal(h.releases().length, 0, 'first dead poll');
  await h.r.poll();
  const rel = h.releases();
  assert.equal(rel.length, 1);
  assert.deepEqual(rel[0].slice(0, 4), ['release', 'aaaa1111', '--by', 'lease-holder-reaper']);
  assert.match(rel[0][5], /^holder-gone: released stale lease aaaa1111: holder pid 4242 is gone$/);
});

test('a name pid never seen alive is not trusted (free-form number in a name)', async () => {
  const h = harness({ cur: [row({ agent: 'codebox:job-77' })] }, {});
  for (let i = 0; i < 4; i++) await h.r.poll();
  assert.equal(h.releases().length, 0);
});

test('explicit holder_pid on this host needs no arming; a reused pid (started after the lease) is dead', async () => {
  const os = await import('node:os');
  const h = harness({ cur: [row({ agent: 'codebox:disp', holder_pid: 4242, holder_host: os.hostname() })] }, { 4242: SINCE + 500 });
  await h.r.poll(); await h.r.poll();
  assert.equal(h.releases().length, 1);
});

test('live holder, other host, mac agent, pin, system, deploy and pid-less leases are never released', async () => {
  const os = await import('node:os');
  const rows = { cur: [
    row({ id: 'l1' }),
    row({ id: 'l2', agent: 'codebox:x', holder_pid: 4242, holder_host: 'proxmox' }),
    row({ id: 'l3', agent: 'mac:laptop-4242' }),
    row({ id: 'l4', mode: 'pin' }),
    row({ id: 'l5', system: true }),
    row({ id: 'l6', deploy_id: 'd1' }),
    row({ id: 'l7', agent: 'codebox:plain' }),
    row({ id: 'l8', agent: 'codebox:y', holder_pid: 4242, holder_host: os.hostname() }),
  ] };
  const h = harness(rows, { 4242: SINCE - 5 });
  for (let i = 0; i < 4; i++) await h.r.poll();
  assert.equal(h.releases().length, 0);
});

test('an agent whose name is a live dashboard session is skipped', () => {
  assert.equal(watchable([row({ agent: 'codebox:TASK-168-4242' })], { sessionNames: ['TASK-168-4242'] }).length, 0);
});

test('procStartSec reads start time from /proc/<pid>/stat and /proc/stat', () => {
  const files = { '/proc/9/stat': '9 (my (cmd)) S ' + Array.from({ length: 18 }, (_, i) => (i === 18 - 1 ? 0 : i)).join(' ') + ' 5000 0', '/proc/stat': 'cpu 1\nbtime 1000\n' };
  const parts = '9 (a b) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 1 1'.split(' ');
  const rf = (f) => (f === '/proc/9/stat' ? parts.join(' ') : files[f]);
  assert.equal(procStartSec(9, { readFile: rf }), 1050);
  assert.equal(procStartSec(8, { readFile: () => { throw new Error('ENOENT'); } }), null);
});
