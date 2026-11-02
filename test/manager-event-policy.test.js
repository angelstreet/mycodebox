// Manager event policy (scripts/manager-event-policy.js): merge defaults with the owner's copy, look a line up like the jq filter does,
// and suggest `ignore` only for kinds that woke the manager often and were never labelled needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergePolicy, policyOf, suggest, DEFAULT_FILE, VALUES } from '../scripts/manager-event-policy.js';

test('the shipped defaults parse, hold only known values, and mark the owner-facing kinds urgent', () => {
  const d = JSON.parse(readFileSync(DEFAULT_FILE, 'utf8'));
  const { policy, invalid } = mergePolicy(d, {});
  assert.deepEqual(invalid, []);
  for (const k of ['asks', 'needs-manager', 'hold', 'health', 'deploy:failed']) assert.equal(policy[k], 'urgent', k);
  assert.ok(!Object.keys(policy).some((k) => k.startsWith('_')), 'documentation keys are not policy');
  assert.ok(Object.values(policy).every((v) => VALUES.includes(v)));
});

test('mergePolicy: the owner wins per key, unknown values are reported and dropped, _keys are ignored', () => {
  const { policy, source, invalid } = mergePolicy({ asks: 'urgent', told: 'ignore', _doc: 'x' }, { told: 'pass', 'lease:nudge': 'ignore', bogus: 'maybe' });
  assert.deepEqual(policy, { asks: 'urgent', told: 'pass', 'lease:nudge': 'ignore' });
  assert.deepEqual(source, { asks: 'default', told: 'owner', 'lease:nudge': 'owner' });
  assert.deepEqual(invalid, ['owner:bogus=maybe']);
});

test('policyOf: kind:state before kind, default otherwise', () => {
  const policy = { deploy: 'pass', 'deploy:failed': 'urgent', lease: 'ignore' };
  assert.equal(policyOf(policy, { kind: 'deploy', state: 'failed' }), 'urgent');
  assert.equal(policyOf(policy, { kind: 'deploy', state: 'start' }), 'pass');
  assert.equal(policyOf(policy, { kind: 'lease', state: 'nudge' }), 'ignore');
  assert.equal(policyOf(policy, { kind: 'asks' }), 'default');
  assert.equal(policyOf(policy, null), 'default');
});

test('suggest: ignore only for a kind with >= min events, >= min labels and 0 needed; urgent / already-ignored kinds are never suggested', () => {
  const events = [], outcomes = [];
  const add = (kind, n, label, state = null) => { for (let i = 0; i < n; i++) { const key = `${kind}:${i}:${label}`; events.push({ key, kind, ...(state ? { state } : {}) }); if (label) outcomes.push({ type: 'wake_outcome', event_key: key, kind, label }); } };
  add('told', 25, 'not_needed');                 // never needed, often: suggest
  add('asks', 30, 'needed');                     // needed: never
  add('leftovers', 5, 'not_needed');             // too few: never
  add('lease', 40, 'not_needed', 'nudge');       // owner already ignores it: no suggestion
  add('bug', 30, null);                          // no labels at all: never (unknown is not "not needed")
  const rows = suggest({ events, outcomes, policy: { asks: 'urgent', 'lease:nudge': 'ignore' }, min: 20 });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.told.suggest, 'ignore');
  assert.equal(by.asks.suggest, null);
  assert.equal(by.leftovers.suggest, null);
  assert.equal(by['lease:nudge'].suggest, null);
  assert.equal(by['lease:nudge'].policy, 'ignore');
  assert.equal(by.bug.suggest, null);
  assert.deepEqual([by.told.events, by.told.needed, by.told.notNeeded], [25, 0, 25]);
  assert.equal(rows[0].key, 'lease:nudge', 'sorted by events, most first');
});
