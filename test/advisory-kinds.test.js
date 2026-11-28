import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADVISORY_KINDS, MANAGER_ADVISORY_KINDS, isAdvisoryKind } from '../advisory-kinds.js';
import { KIND, SUB_KIND, MGR_KIND, advisoryEvent } from '../context-advisory.js';
import { createManagerEvents } from '../manager-events.js';
import { tmp } from './helpers-tmp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-11-28T10:00:00.000Z';

test('every kind context-advisory.js can build is in the shared list', () => {
  const kinds = [
    advisoryEvent({ kind: 'high-avg-context', id: 't', session: 's', value: 4e5, detail: 'd' }, 'owner', NOW),
    advisoryEvent({ kind: 'subagent-heavy', id: 't', session: 's', value: 1, detail: 'd' }, 'owner', NOW),
    advisoryEvent({ kind: 'high-avg-context', id: 't', session: 's', value: 4e5, detail: 'd' }, 'self', NOW),
  ].map((e) => e.key.split(':').pop());
  for (const k of kinds) assert.ok(ADVISORY_KINDS.includes(k), `${k} missing from advisory-kinds.js`);
  assert.deepEqual([KIND, SUB_KIND, MGR_KIND].sort(), [...ADVISORY_KINDS].sort());
});

test('the wake filter regex (manager-event-filter.sh) names exactly the advisory kinds', () => {
  const sh = readFileSync(join(ROOT, 'scripts/manager-event-filter.sh'), 'utf8');
  const alt = sh.match(/def notice:[^\n]*test\("\^\(([^)]*)\)\$/)[1].split('|');
  for (const k of ADVISORY_KINDS) assert.ok(alt.includes(k), `${k} is not deferred by manager-event-filter.sh`);
  const extra = alt.filter((k) => /-advisory$/.test(k) && !ADVISORY_KINDS.includes(k));
  assert.deepEqual(extra, [], 'the filter defers an advisory kind advisory-kinds.js does not know');
});

test('manager-events keeps the payload of every advisory kind and drops others about a manager session', async () => {
  const dir = tmp('adv-kinds-');
  const ev = createManagerEvents({ stateDir: dir, managerSessions: () => ['mgr'] });
  const feed = () => { try { return readFileSync(join(dir, 'manager-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  for (const k of ADVISORY_KINDS) {
    const about = MANAGER_ADVISORY_KINDS.includes(k) ? 'mgr' : 'w1';
    await ev.record({ key: `${about}:${k}`, title: 't', body: 'Advisory x', priority: 'low', advisory: { findingId: 'f', k } });
    const row = feed().find((r) => r.key === `${about}:${k}`);
    assert.ok(row, `${k} was dropped`);
    assert.equal(row.kind, k);
    assert.deepEqual(row.advisory, { findingId: 'f', k }, `${k} lost its payload`);
  }
  assert.ok(isAdvisoryKind('context-advisory') && !isAdvisoryKind('waiting'));
  const n = feed().length;
  await ev.record({ key: 'mgr:context-advisory', title: 't', body: 'Advisory x', priority: 'low', advisory: {} });
  assert.equal(feed().length, n, 'a context advisory about a manager session must stay dropped');
});

test('lastFired: newest row per advisory kind, null when never, and how far back the feed reaches', async () => {
  const { lastFired } = await import('../context-advisory.js');
  const rows = [
    { at: '2026-11-26T08:00:00Z', kind: 'waiting', session: 'x' },
    { at: '2026-11-27T10:00:00Z', kind: 'context-advisory', session: 'a' },
    { at: '2026-11-28T09:00:00Z', kind: 'context-advisory', session: 'b' },
    { at: '2026-11-27T12:00:00Z', kind: 'subagent-advisory', session: 'c' },
    { bad: true }, null,
  ];
  const r = lastFired(rows);
  assert.deepEqual(r.kinds['context-advisory'], { at: '2026-11-28T09:00:00Z', session: 'b' });
  assert.deepEqual(r.kinds['subagent-advisory'], { at: '2026-11-27T12:00:00Z', session: 'c' });
  assert.equal(r.kinds['manager-restart-advisory'], null);
  assert.deepEqual(Object.keys(r.kinds).sort(), [...ADVISORY_KINDS].sort());
  assert.equal(r.since, '2026-11-26T08:00:00Z');
  assert.deepEqual(lastFired([]).since, null);
});
