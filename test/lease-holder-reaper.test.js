// lease-holder-reaper: releases leases whose holder pid on this host is gone, never a live one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHolderReaper, watchable, procStartSec } from '../lease-holder-reaper.js';
import { tmp } from './helpers-tmp.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

// owner 2026-11-11: a grant to an idle codebox session that nobody used while others queue is released (the Mi held ~11 h)
import { unusedGrants } from '../lease-holder-reaper.js';
const NOW = (SINCE + 15 * 60) * 1000;      // 15 min after the grant
const grant = (o = {}) => ({ id: 'g1', mode: 'exclusive', agent: 'codebox:wall', since: SINCE, lastHeartbeatAt: new Date(SINCE * 1000).toISOString(), ...o });
const waiting = [{ id: 't-1', agent: 'kpi-androidtv', holders: [{ id: 'g1', agent: 'codebox:wall' }] }];
const idleBefore = () => ({ working: false, turnAt: SINCE * 1000 - 3600e3, promptAt: SINCE * 1000 - 3600e3 });

test('unusedGrants: idle session, no turn and no heartbeat since the grant, someone waits, past the grace -> listed', () => {
  const u = unusedGrants([grant()], waiting, { sessionNames: ['wall'], activityOf: idleBefore, now: NOW });
  assert.deepEqual(u.map((x) => [x.id, x.session, x.waiters]), [['g1', 'wall', ['kpi-androidtv']]]);
});

test('unusedGrants: in use, nobody waiting, inside the grace, unknown or working session, pin, bare agent -> never listed', () => {
  const base = { sessionNames: ['wall'], activityOf: idleBefore, now: NOW };
  const none = (rows, tickets = waiting, o = {}) => assert.deepEqual(unusedGrants(rows, tickets, { ...base, ...o }), []);
  none([grant({ lastHeartbeatAt: new Date((SINCE + 300) * 1000).toISOString() })]);                       // heartbeat / renew after the grant
  none([grant()], [], {});                                                                                 // nobody waits
  none([grant()], waiting, { now: (SINCE + 5 * 60) * 1000 });                                              // inside the 10 min grace
  none([grant()], waiting, { activityOf: () => null });                                                    // the reporter never saw it
  none([grant()], waiting, { activityOf: () => ({ working: true, turnAt: 0, promptAt: 1 }) });            // working
  none([grant()], waiting, { activityOf: () => ({ working: false, turnAt: (SINCE + 60) * 1000, promptAt: 0 }) });   // a turn after the grant
  none([grant()], waiting, { sessionNames: [] });                                                          // no such session (holder-gone covers it)
  none([grant({ mode: 'pin' })]); none([grant({ system: true })]); none([grant({ deploy_id: 'd' })]);
  none([grant({ agent: 'kpi-stb' })], [{ ...waiting[0], holders: [{ id: 'g1' }] }]);                        // a bare agent name: not a session
  none([grant()], waiting, { graceMs: 0 });                                                                // switched off
});

test('the reaper releases an unused grant on the 2nd poll with a reason naming the session and the waiter', async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return args[0] === 'list' ? { code: 0, stdout: JSON.stringify({ leases: [grant()], tickets: waiting }) } : { code: 0, stdout: 'released 1' }; };
  const r = createHolderReaper({ stateDir: tmp('hr-u-'), run, listSessionNames: async () => ['wall'], activityOf: idleBefore, now: () => NOW, unusedGraceMs: () => 10 * 60000, log: { log() {}, error() {} } });
  await r.poll();
  assert.equal(calls.filter((c) => c[0] === 'release').length, 0, 'first sighting');
  await r.poll();
  const rel = calls.filter((c) => c[0] === 'release');
  assert.equal(rel.length, 1);
  assert.deepEqual(rel[0].slice(0, 4), ['release', 'g1', '--by', 'lease-holder-reaper']);
  assert.match(rel[0][5], /^unused-grant: released lease g1: .*idle session wall.*kpi-androidtv waits$/);
});

// ---- idle release (owner 2026-11-11) ----
import { idleHolders } from '../lease-holder-reaper.js';
const NOW_MS = SINCE * 1000 + 60 * 60000;
const idleRow = (o = {}) => ({ id: 'i1', mode: 'exclusive', agent: 'codebox:sess', since: SINCE, ...o });
const act = (o = {}) => ({ turnAt: SINCE * 1000 + 5 * 60000, promptAt: SINCE * 1000 + 4 * 60000, working: false, ...o });
const idleOpts = (o = {}) => ({ sessionNames: ['sess'], activityOf: () => act(), now: NOW_MS, idleMs: 10 * 60000, ...o });

test('idleHolders: an idle live session is listed with its idle minutes; the reference is the newest of grant / turn / heartbeat', () => {
  const [u] = idleHolders([idleRow()], idleOpts());
  assert.equal(u.session, 'sess'); assert.equal(u.idleMin, 55);
  assert.equal(idleHolders([idleRow({ lastHeartbeatAt: new Date(NOW_MS - 3 * 60000).toISOString() })], idleOpts()).length, 0, 'recent heartbeat = in use');
  assert.equal(idleHolders([idleRow()], idleOpts({ activityOf: () => act({ turnAt: NOW_MS - 2 * 60000 }) })).length, 0, 'recent turn');
});
test('idleHolders: never working, unknown, closed, pinned, system, deploy, pid or mac holders', () => {
  const rows = [idleRow({ id: 'a', agent: 'codebox:gone' }), idleRow({ id: 'b', mode: 'pin' }), idleRow({ id: 'c', system: true }), idleRow({ id: 'd', deploy_id: 'x' }), idleRow({ id: 'e', holder_pid: 5, holder_host: 'proxmox' }), idleRow({ id: 'f', agent: 'mac:laptop' })];
  assert.equal(idleHolders(rows, idleOpts()).length, 0);
  assert.equal(idleHolders([idleRow()], idleOpts({ activityOf: () => act({ working: true }) })).length, 0);
  assert.equal(idleHolders([idleRow()], idleOpts({ activityOf: () => null })).length, 0);
  assert.equal(idleHolders([idleRow()], idleOpts({ idleMs: 0 })).length, 0);
});
function idleHarness(mode, hasLiveJob = async () => false) {
  const calls = [], told = [];
  const run = async (a) => { calls.push(a); return a[0] === 'list' ? { code: 0, stdout: JSON.stringify({ leases: [idleRow()] }), stderr: '' } : { code: 0, stdout: 'released 1', stderr: '' }; };
  const dir = tmp('hr-');
  const r = createHolderReaper({ stateDir: dir, run, listSessionNames: async () => ['sess'], activityOf: () => act(), now: () => NOW_MS, idleReleaseMs: () => 10 * 60000, idleMode: () => mode, hasLiveJob, notify: async (s, t) => { told.push([s, t]); }, log: { log() {}, error() {} } });
  return { r, calls, told, dir, rel: () => calls.filter((c) => c[0] === 'release') };
}
test('idle release live: 2nd poll releases, journals, tells the session how to claim again', async () => {
  const h = idleHarness('live');
  await h.r.poll(); assert.equal(h.rel().length, 0);
  await h.r.poll(); assert.equal(h.rel().length, 1);
  assert.match(h.rel()[0][5], /^idle-release: released lease i1: session sess idle at its prompt 55 min/);
  assert.match(h.told[0][1], /vpt-lease claim <env> --any <group> --wait/);
  const j = readFileSync(join(h.dir, 'lease-actions.jsonl'), 'utf8');
  assert.match(j, /"type":"idle-release"/); assert.match(j, /"dryRun":false/);
});
test('idle release dry (default): journals dryRun once, never releases or tells', async () => {
  const h = idleHarness('dry');
  for (let i = 0; i < 5; i++) await h.r.poll();
  assert.equal(h.rel().length, 0); assert.equal(h.told.length, 0);
  const lines = readFileSync(join(h.dir, 'lease-actions.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1); assert.match(lines[0], /"dryRun":true/);
});
test('idle release: a live background job, or an unknown one, blocks it; mode off does nothing', async () => {
  const busy = idleHarness('live', async () => true);
  for (let i = 0; i < 4; i++) await busy.r.poll();
  assert.equal(busy.rel().length, 0);
  const unk = idleHarness('live', async () => { throw new Error('ps failed'); });
  for (let i = 0; i < 4; i++) await unk.r.poll();
  assert.equal(unk.rel().length, 0);
  const off = idleHarness('off');
  for (let i = 0; i < 4; i++) await off.r.poll();
  assert.equal(off.rel().length, 0);
});

test('idleHolders: a CLI claim carries holder_pid on this host and is still idle-released (2026-11-13 production proof); another host is not', () => {
  assert.equal(idleHolders([idleRow({ holder_pid: 2214285, holder_host: 'codebox', holder_src: 'claim' })], idleOpts({ host: 'codebox' })).length, 1);
  assert.equal(idleHolders([idleRow({ holder_pid: 9, holder_host: 'proxmox' })], idleOpts({ host: 'codebox' })).length, 0);
});
