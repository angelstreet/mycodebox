import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { createContextAdvisory, advisoryEvent, dueFindings, COOLDOWN_MS } from '../context-advisory.js';
import { createManagerEvents } from '../manager-events.js';
import { buildWaste } from '../usage/waste.js';

const NOW = 1_800_000_000_000;
const big = (session, trace) => Array.from({ length: 40 }, (_, i) => ({ agent: 'claude', session, label: session, trace, model: 'claude-opus', ts: NOW - 1000 - i, usage: { cache_read: 400e3, output: 900 }, cost: { total: 0.1 } }));

test('advisoryEvent says advisory, and the restart rule depends on who started the session', () => {
  const f = { kind: 'high-avg-context', id: 't1', session: 'w1', value: 420000, detail: 'avg context 420k per call over 40 calls', cost: 3 };
  const m = advisoryEvent(f, 'manager'), o = advisoryEvent(f, 'owner'), u = advisoryEvent(f);
  assert.equal(m.key, 'w1:context-advisory');
  assert.equal(m.priority, 'low');
  for (const e of [m, o, u]) { assert.match(e.body, /^Advisory/); assert.match(e.body, /natural stop/); }
  assert.match(m.title, /started by the manager/);
  assert.match(o.body, /do NOT restart.*never an owner-started session/);
  assert.match(o.title, /started by the owner/);
  assert.match(u.title, /starter unknown/);
  assert.equal(o.advisory.startedBy, 'owner');
});

test('dueFindings: only high-avg-context, live, outside the cooldown, one per id', () => {
  const fs = [{ kind: 'high-avg-context', id: 'a', session: 's1' }, { kind: 'high-avg-context', id: 'a', session: 's1' }, { kind: 'low-cache-hit', id: 'b', session: 's2' },
    { kind: 'high-avg-context', id: 'c', session: 'gone' }, { kind: 'high-avg-context', id: 'd', session: 's3' }];
  const due = dueFindings(fs, { d: NOW - 1000 }, NOW, { isLive: (n) => n !== 'gone' });
  assert.deepEqual(due.map((f) => f.id), ['a']);
  assert.deepEqual(dueFindings(fs, { a: NOW - COOLDOWN_MS - 1 }, NOW, {}).map((f) => f.id), ['a', 'c', 'd']);
});

test('tick: a real waste finding -> one manager event; repeated ticks do not repeat it; a restart of the server remembers', async () => {
  const dir = tmp('ghosty-ctxadv-');
  const waste = buildWaste([...big('w1', 'tr1'), ...big('mgr', 'tr2')], NOW);
  assert.ok(waste.findings.some((f) => f.kind === 'high-avg-context'));
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => ['mgr'], now: () => NOW });
  let t = NOW;
  const mk = () => createContextAdvisory({ stateDir: dir, getSummary: async () => ({ waste }), record: (e) => me.record(e), startedBy: (n) => (n === 'w1' ? 'owner' : 'manager'), now: () => t });
  const a = mk();
  assert.equal(await a.tick(), 2);   // mgr is offered too, but the feed drops the manager's own session
  t += 30e3; assert.equal(await a.tick(), 0);
  t += 3600e3; assert.equal(await mk().tick(), 0, 'state survives a restart');
  const lines = readFileSync(join(dir, 'manager-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'context-advisory');
  assert.equal(lines[0].session, 'w1');
  assert.equal(lines[0].advisory.startedBy, 'owner');
  assert.equal(lines[0].advisory.findingId, 'tr1');
  t = NOW + COOLDOWN_MS + 1; assert.equal(await mk().tick(), 2, 'after the cooldown it is offered again');
});

test('tick never throws when the summary is missing', async () => {
  const a = createContextAdvisory({ stateDir: tmp('ghosty-ctxadv-'), getSummary: async () => null, record: async () => { throw new Error('no'); } });
  assert.equal(await a.tick(), 0);
});

test('subagent-heavy finding -> its own advisory key with the narrow-prompt brief', () => {
  const f = { kind: 'subagent-heavy', id: 'x1', session: 'ui-audit', value: 59, detail: 'subagents read 590M of 1046M context tokens (59%)', cost: 12 };
  assert.equal(dueFindings([f], {}, 1).length, 1);
  const ev = advisoryEvent(f, 'owner');
  assert.equal(ev.key, 'ui-audit:subagent-advisory');
  assert.match(ev.body, /narrow prompt/);
  assert.equal(ev.priority, 'low');
});

test('manager session over 300k -> restart-yourself advisory with the handover-line step', () => {
  const f = { kind: 'high-avg-context', id: 'm1', session: 'manager', value: 340000, detail: 'avg context 340k per call over 120 calls' };
  const ev = advisoryEvent(f, 'self');
  assert.equal(ev.key, 'manager:manager-restart-advisory');
  assert.match(ev.body, /natural stop/);
  assert.match(ev.body, /manager-handover\.log/);
  assert.match(ev.body, /manager-fresh\.sh/);
  assert.equal(ev.priority, 'low');
  assert.match(readFileSync(new URL('../scripts/manager-fresh.sh', import.meta.url), 'utf8'), /manager-handover\.log/);
});

// 2026-11-28: the restart-yourself advisory never reached the manager. Faithful path: the manager's own traces -> buildWaste -> tick with
// the server's startedBy wiring -> the real manager-events feed with the live manager sessions. The feed used to drop it as "own session".
test('manager over 300k: waste finding -> tick -> the manager feed keeps the restart advisory, once per cooldown', async () => {
  const dir = tmp('ghosty-ctxadv-mgr-');
  const waste = buildWaste(big('manager', 'trm'), NOW);
  assert.ok(waste.findings.some((f) => f.kind === 'high-avg-context' && f.session === 'manager'));
  const mgrs = ['mm-manager', 'manager'];
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => mgrs, now: () => NOW });
  let t = NOW;
  const a = createContextAdvisory({ stateDir: dir, getSummary: async () => ({ waste }), record: (e) => me.record(e), now: () => t,
    startedBy: (n) => (mgrs.includes(n) ? 'self' : 'unknown') });
  assert.equal(await a.tick(), 1);
  t += 30e3; assert.equal(await a.tick(), 0, 'not repeated inside the cooldown');
  const lines = readFileSync(join(dir, 'manager-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].key, 'manager:manager-restart-advisory');
  assert.equal(lines[0].kind, 'manager-restart-advisory');
  assert.equal(lines[0].advisory.kind, 'manager-restart');
  assert.equal(lines[0].advisory.findingId, 'trm');
});

test('the own-session drop still holds for the manager\'s other events', async () => {
  const dir = tmp('ghosty-ctxadv-mgr2-');
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => ['manager'], now: () => NOW });
  assert.equal(await me.record({ key: 'manager:context-advisory', title: 'x', body: 'y' }), false);
});

test('tick end to end: the manager-restart and subagent advisories reach the feed (the manager session is not dropped for its own restart advisory)', async () => {
  const dir = tmp('ghosty-ctxadv2-');
  const me = createManagerEvents({ stateDir: dir, managerSessions: () => ['mgr'], now: () => NOW });
  const waste = { findings: [
    { kind: 'high-avg-context', id: 'a1', session: 'mgr', value: 350000, detail: 'avg context 350k per call over 80 calls' },
    { kind: 'subagent-heavy', id: 'a2', session: 'w9', value: 61, detail: 'subagents read 60M of 100M context tokens (61%)' }] };
  const a = createContextAdvisory({ stateDir: dir, getSummary: async () => ({ waste }), record: (e) => me.record(e), startedBy: (n) => (n === 'mgr' ? 'self' : 'owner'), now: () => NOW });
  assert.equal(await a.tick(), 2);
  const lines = readFileSync(join(dir, 'manager-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind).sort(), ['manager-restart-advisory', 'subagent-advisory']);
  assert.ok(lines.every((l) => l.advisory && l.advisory.findingId));
});
