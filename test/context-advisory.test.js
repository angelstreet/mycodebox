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
