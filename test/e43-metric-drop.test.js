// E43: the destructive-verb guard read every "drop" as a deletion, so a number that went down woke the owner
// ("drop question - needs you" on a session whose turn was already over, 2026-10-23). A drop-family word is a
// metric when a preposition and a number follow it, the sentence names no data object, it is not the verb of an
// imperative list item, and the sentence carries a metric noun or a unit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forbiddenMatch, hardMatch, topicSplit, classifyStall, wouldSend, ownerFloorMatch, isPastNarrative } from '../stall.js';

const METRIC = [
  'the tree settle drop from 20 s to ~3 s',
  'latency drop by 40 percent after the fix',
  'the cost drop to 12 ms per call',
  'error rate drop from 4.1 to 0.3 on every box',
  'throughput drop to 55 requests per second',
];

test('E43: a metric drop is not a forbidden topic and not a hard one', () => {
  for (const q of METRIC) {
    assert.equal(forbiddenMatch(q), null, q);
    assert.equal(hardMatch(q, {}), null, q);
    assert.equal(hardMatch(q), null, q);
    assert.equal(topicSplit(q).hard, null, q);
    assert.equal(ownerFloorMatch(q), null, q);   // the routing floor must not wake the owner either
  }
});

test('E43: the deletion itself still blocks', () => {
  for (const q of ['drop the table', 'drop table t3', 'drop 500 rows', 'drop from 500 rows to 100',
    'drop the index', 'drop the database', 'delete the old branch', 'remove the host from the list',
    'prune the stale leases', 'erase the tmp file', 'drop to 12 tables']) {
    assert.ok(forbiddenMatch(q), q);
    assert.ok(hardMatch(q, {}), q);
    assert.ok(ownerFloorMatch(q), q);
  }
});

test('E43: the relief is per occurrence, not per text', () => {
  const q = 'the cost drop to 12 ms and then drop the table';
  assert.ok(forbiddenMatch(q), q);
  assert.ok(hardMatch(q, {}), q);
});

test('E43: a metric drop in a disguised spelling is still a metric, a disguised deletion still blocks', () => {
  assert.equal(forbiddenMatch('the cost dr0p to 12 ms'), null);
  assert.equal(forbiddenMatch('the cost d r o p to 12 ms'), null);
  assert.ok(forbiddenMatch('dr0p the table'), 'leet spelling of a deletion');
  assert.ok(forbiddenMatch('d r o p the table'), 'split spelling of a deletion');
  assert.ok(forbiddenMatch('drop fr0m 500 rows to 100'), 'leet spelling of a row deletion');
});

test('E43: the past tense is a metric too (E53) and the narrative relief still works', () => {
  // E43 pinned the past tense as unrelieved; E53 extended the relief to it ("the latency dropped by 40 percent").
  assert.equal(forbiddenMatch('dropped from 20 s to 3 s'), null, 'a past-tense metric drop is a metric too');
  assert.ok(forbiddenMatch('the table dropped by 500 rows'), 'a past-tense deletion still blocks');
  assert.equal(isPastNarrative('the settle dropped from 20 s to 3 s earlier'), true, 'a past narrative is still a narrative');
});

test('E43: the continue path (the relaxed text) is not woken by a metric drop', () => {
  const c = classifyStall({ plain: ['The tree settle drop from 20 s to ~3 s.', 'Shall I continue?'], state: 'done' });
  assert.equal(c.case, 'continue');
  assert.equal(c.forbidden, null);
  assert.equal(wouldSend(c).why, 'continue');
});

test('E43: a finished session whose closing text holds a metric drop is not escalated', () => {
  const c = classifyStall({ plain: ['All merged and the lease released.', 'The tree settle drop from 20 s to ~3 s.', 'STATUS: done'], state: 'done' });
  assert.equal(c.case, 'done');
  assert.equal(c.forbidden, null);
});

test('E43: the owner-facing reason names the topic instead of putting a bare verb in command position', () => {
  const manager = readFileSync(new URL('../manager.js', import.meta.url), 'utf8');
  assert.ok(!manager.includes('question — needs you'), 'the bare-verb reason is gone');
  assert.match(manager, /the topic is "\$\{w\.slice\(11\)\}" — needs you/);
});
