import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callerOf, deleteVerdict } from '../session-delete-guard.js';
import { appendJsonLine, oneJsonLine } from '../jsonl-append.js';
import { classifyTrigger } from '../manager-wakes.js';
import { ownerStepIns } from '../scorecard.js';

test('caller defaults to unknown, header is a fallback', () => {
  assert.equal(callerOf(null, null), 'unknown');
  assert.equal(callerOf('', 'mgr'), 'mgr');
  assert.equal(callerOf('owner'), 'owner');
});

test('clean session: anyone may delete (and it is recorded elsewhere)', () => {
  assert.equal(deleteVerdict({ name: 's', by: 'unknown', facts: {} }).allow, true);
});

test('open ask, lease or unmerged work refuse an unknown or unrelated caller', () => {
  const facts = { openAsk: true, leases: ['L1'], unmerged: true };
  const v = deleteVerdict({ name: 's', by: 'unknown', startedBy: 'mgr', facts });
  assert.equal(v.allow, false);
  assert.equal(v.reasons.length, 3);
  assert.equal(deleteVerdict({ name: 's', by: 'other-session', startedBy: 'mgr', facts }).allow, false);
});

test('owner and the spawning agent may delete', () => {
  const facts = { openAsk: true };
  assert.equal(deleteVerdict({ name: 's', by: 'owner', facts }).allow, true);
  assert.equal(deleteVerdict({ name: 's', by: 'mgr', startedBy: 'mgr', facts }).allow, true);
});

test('a generic starter label never counts as the spawner', () => {
  for (const sb of ['unknown', 'cbsession', 'dashboard']) assert.equal(deleteVerdict({ name: 's', by: sb, startedBy: sb, facts: { unmerged: true } }).allow, false);
});

test('appendJsonLine: valid object lines only, repairs a torn tail', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'jl-')), 'a.jsonl');
  writeFileSync(f, '{"a":1}\n{"torn":');
  appendJsonLine(f, { b: 2 });
  appendJsonLine(f, '{"c":3}');
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.slice(-2).map((l) => JSON.parse(l)), [{ b: 2 }, { c: 3 }]);
  assert.throws(() => oneJsonLine('{bad'), /not valid JSON/);
  assert.throws(() => oneJsonLine('[1]'), /object/);
  assert.throws(() => oneJsonLine('"x"'), /object/);
  assert.equal(readFileSync(f, 'utf8').split('\n').filter(Boolean).length, 4);
});

test('kick and lane wakes are not owner wakes', () => {
  const h = (text) => ({ type: 'user', origin: { kind: 'human' }, message: { content: text } });
  assert.equal(classifyTrigger(h('Fresh start of the AI manager (nightly restart')), 'kick');
  assert.equal(classifyTrigger(h('Integration int-1a2b: merged main.')), 'lane');
  assert.equal(classifyTrigger(h('what is the status?')), 'owner');
});

test('ownerStepIns counts only answered owner stops in the window', () => {
  const r = (by, at, resolution = 'answered') => ({ by, at, resolution });
  const recs = [r('owner', '2026-11-10T10:00:00Z'), r('owner-voice', '2026-11-10T11:00:00Z'), r('manager', '2026-11-10T12:00:00Z'), r('unknown', '2026-11-10T12:00:00Z'), r('owner', '2026-11-10T13:00:00Z', 'superseded'), r('owner', '2026-11-12T10:00:00Z')];
  assert.equal(ownerStepIns(recs, Date.parse('2026-11-10T00:00:00Z'), Date.parse('2026-11-11T00:00:00Z')), 2);
});
