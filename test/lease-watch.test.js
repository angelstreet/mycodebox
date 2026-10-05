import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyHolders, createLeaseWatch, BY } from '../lease-watch.js';
import { deployWaits, leaseLines, p95 } from '../lease-stats.js';
import { classifyKey } from '../manager-events.js';
import { agentSession, machinesOf } from '../public/platforms.js';

const M = machinesOf('codebox-vm');
const NOW = 1_800_000_000_000;
const MIN = 60000;
const L = (o = {}) => ({ id: 'l1', env: 'node1-vpt', resource: 'vpt-pi1/device1', agent: 'codebox:TASK28-videos', kind: 'server', since: (NOW - 60 * MIN) / 1000, ...o });
const base = { sessionNames: ['TASK28-videos', 'manager'], knownNames: ['TASK28-videos', 'manager', 'TASK99-gone'], machines: M, now: NOW };
const one = (lease, extra = {}) => classifyHolders({ ...base, leases: [lease], ...extra })[0];

test('tolerant matching: dashes/case and a long unique prefix map to the session; short names do not', () => {
  const names = ['TASK28-videos', 'qualiai-pipeline', 'TASK5-companion'];
  assert.equal(agentSession('codebox:TASK-28-videos-sw', names, M), 'TASK28-videos');
  assert.equal(agentSession('codebox:task_28_videos', names, M), 'TASK28-videos');
  assert.equal(agentSession('codebox:qualiai', names, M), null);
  assert.equal(agentSession('codebox:TASK-5', names, M), null);
  assert.equal(agentSession('codebox:TASK28-videos', ['TASK28-videos-a', 'TASK28-videos-b'], M), null);   // ambiguous prefix: no guess
});

test('holder status: live / ended / remote / unknown / system', () => {
  assert.equal(one(L()).status, 'live');
  assert.equal(one(L({ agent: 'codebox:TASK-28-videos-sw' })).status, 'live');
  assert.equal(one(L({ agent: 'codebox:TASK99-gone' })).status, 'ended');
  assert.equal(one(L({ agent: 'codebox:never-existed-at-all' })).status, 'unknown');
  assert.equal(one(L({ agent: 'stb4-anchor-run' })).status, 'unknown');
  assert.equal(one(L({ agent: 'mac:TASK-36' })).status, 'remote');
  assert.equal(one(L({ agent: 'manager:deploy' })).status, 'system');
  assert.equal(one(L({ agent: 'update_core:x@y' })).status, 'system');
});

test('plan: ended -> release; idle server -> narrow; never release a live holder; host/young/working/no-signal -> nothing', () => {
  assert.deepEqual(one(L({ agent: 'codebox:TASK99-gone' })).plan, { type: 'release', reason: 'session-ended' });
  const idle = (turnAt, o = {}) => one(L(o), { activity: () => ({ turnAt, promptAt: 0, working: false }) });
  assert.equal(idle(NOW - 31 * MIN).plan.type, 'narrow');
  assert.equal(idle(NOW - 29 * MIN).plan, null);
  assert.equal(idle(NOW - 10 * 3600 * 1000).plan.type, 'narrow');              // idle for hours: still only narrowed, never released
  assert.equal(idle(NOW - 31 * MIN, { kind: 'host' }).plan, null);
  assert.equal(idle(NOW - 31 * MIN, { since: (NOW - MIN) / 1000 }).plan, null);   // claimed a minute ago
  assert.equal(one(L(), { activity: () => ({ turnAt: NOW - 90 * MIN, promptAt: NOW - 5 * MIN, working: true }) }).plan, null);
  assert.equal(one(L(), { activity: () => null }).plan, null);                  // reporter never saw it: no idleness claim
  assert.equal(one(L({ agent: 'codebox:TASK99-gone', since: (NOW - MIN) / 1000 })).plan, null);
});

function fake({ leases, names, events = [], activity = () => null, mode = 'live' }) {
  const calls = [], recorded = [];
  let cursor = 5;
  const run = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'list') return { code: 0, stdout: JSON.stringify({ leases }) };
    if (args[0] === 'events') { const after = Number(args[3]); const evs = events.filter((e) => e.line > after); return { code: 0, stdout: JSON.stringify({ next: after > 100 ? cursor : (evs.at(-1)?.line ?? after), events: evs }) }; }
    return { code: 0, stdout: 'ok' };
  };
  return { calls, recorded, run, names, leases, activity, mode };
}

test('poll: first run primes the event cursor; later events become lease:* records; ended is released only on the 2nd poll', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-'));
  const f = fake({ leases: [L({ agent: 'codebox:TASK99-gone' }), L({ id: 'l2', agent: 'codebox:TASK28-videos' }), L({ id: 'l3', agent: 'mac:x' })], names: ['TASK28-videos', 'manager'],
    events: [{ line: 6, ts: 1, event: 'released', id: 'zz', env: 'node1-vpt', resources: ['vpt-pi3'], agent: 'codebox:x', by: 'session-end', reason: 'session-ended', purpose: 'p' }] });
  const w = createLeaseWatch({ stateDir: dir, run: f.run, machines: M, listSessionNames: async () => f.names, activityOf: f.activity, record: async (e) => f.recorded.push(e), now: () => NOW, log: { log() {}, error() {} } });
  await w.load?.();
  w.state().known = ['TASK99-gone'];
  await w.poll();
  assert.equal(f.recorded.length, 0);                                       // primed, no replay
  assert.ok(!f.calls.some((c) => c.startsWith('release')));                 // strike 1
  await w.poll();
  assert.deepEqual(f.recorded.map((e) => e.key), ['lease:released']);
  const rel = f.calls.filter((c) => c.startsWith('release'));
  assert.equal(rel.length >= 1, true);
  assert.match(rel[0], new RegExp(`^release l1 --by ${BY} --reason session-ended$`));
  assert.ok(!f.calls.some((c) => /l2|l3/.test(c) && /^(release|narrow)/.test(c)));       // live and remote untouched
  const log = (await readFile(join(dir, 'lease-actions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log[0].by, BY); assert.equal(log[0].action, 'release'); assert.equal(log[0].dryRun, false);
});

test('poll: dry mode acts on nothing but logs; an empty tmux list never releases anything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-'));
  const f = fake({ leases: [L({ agent: 'codebox:TASK99-gone' })], names: ['TASK28-videos'] });
  let mode = 'dry';
  const w = createLeaseWatch({ stateDir: dir, run: f.run, machines: M, listSessionNames: async () => f.names, mode: () => mode, now: () => NOW, log: { log() {}, error() {} } });
  w.state().known = ['TASK99-gone'];
  await w.poll(); await w.poll(); await w.poll();
  assert.ok(!f.calls.some((c) => /^(release|narrow)/.test(c)));
  assert.equal(JSON.parse((await readFile(join(dir, 'lease-actions.jsonl'), 'utf8')).trim().split('\n')[0]).dryRun, true);
  mode = 'live'; f.names = [];                                              // tmux failure: listSessions() returns []
  await w.poll(); await w.poll(); await w.poll();
  assert.ok(!f.calls.some((c) => /^(release|narrow)/.test(c)));
});

test('poll: idle server lease is narrowed, counted unknown holders are exposed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-'));
  const f = fake({ leases: [L(), L({ id: 'u1', agent: 'weird-name' })], names: ['TASK28-videos'], activity: () => ({ turnAt: NOW - 45 * MIN, promptAt: 0, working: false }) });
  const w = createLeaseWatch({ stateDir: dir, run: f.run, machines: M, listSessionNames: async () => f.names, activityOf: f.activity, now: () => NOW, log: { log() {}, error() {} } });
  const s = await w.poll();
  assert.ok(f.calls.includes(`narrow l1 --kind host --by ${BY} --reason idle 45 min (no finished turn)`));
  assert.equal(s.unknown, 1);
  assert.equal(w.state().days[new Date(NOW).toISOString().slice(0, 10)].unknownMax, 1);
});

test('manager-events: lease:* keys classify as kind lease', () => {
  assert.deepEqual(classifyKey('lease:narrowed'), { kind: 'lease', state: 'narrowed' });
});

test('lease-stats: p95 of request->start, blocked minutes only for deploys a lease held back', () => {
  assert.equal(p95([1, 2, 3, 4, 100]), 100);
  const t = NOW / 1000;
  const rows = [
    { event: 'request', id: 'a', ts: t - 3600, approved: true }, { event: 'start', id: 'a', ts: t - 3600 + 60 },
    { event: 'request', id: 'b', ts: t - 1800, approved: false }, { event: 'approve', id: 'b', ts: t - 1700 }, { event: 'start', id: 'b', ts: t - 1700 + 1200 },
    { event: 'request', id: 'old', ts: t - 9 * 86400, approved: true }, { event: 'start', id: 'old', ts: t - 9 * 86400 + 5 },
  ];
  const w = deployWaits(rows, [{ kind: 'deploy', deployId: 'b', blockedBy: ['lease'] }], NOW - 86400e3, NOW);
  assert.deepEqual(w, { deploys: 2, p95Min: 20, blockedCount: 1, blockedMinutes: 20 });
  assert.match(leaseLines(w, w, { last: 0, unknownMax: 2 }).join('\n'), /p95 20 min.*1 deploys \/ 20 min[\s\S]*now 0, max today 2/);
});
