// E53: the metric-drop relief of E43 only accepted a present-tense drop word followed by a preposition, so a
// finished report that said the latency *dropped* (past tense) or named "a 3 percent drop" (the noun form) still
// woke the owner as a deletion question. The relief now reads all three shapes, and the guards that make a
// deletion a deletion stay in front of it: a data object, a count that went down, an imperative list item and a
// sentence without a metric noun or a unit are still deletions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, checkAction, restrictedTopics } from '../orchestration/policy.js';
import { forbiddenMatch, forbiddenTopics } from '../stall.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const policy = () => loadPolicy(REPO).policy;
const task = (goal) => ({ goal, scope: 'repo', definition_of_done: [] });
// The action is not read-only: only then is the task text read for restricted topics.
const check = (goal) => checkAction(policy(), task(goal), { class: 'execute' });
const classes = (text) => restrictedTopics(text, { protectedBranches: [] }).map((t) => t.class);

// A number that went down: not a topic, in any of the three shapes.
const METRIC = [
  'the cost drop to 12 ms', 'the latency drop by 40 percent', 'the error rate drop from 4.1 to 0.3',   // present tense (E43)
  'the latency dropped by 40 percent', 'the error rate dropped from 4.1 to 0.3', 'latency dropped to 8 ms',   // past tense (E53)
  'a 3 percent drop in throughput', 'a 12 ms drop in latency', 'a 3% drop in the error rate',   // the noun form (E53)
];
// A deletion: still a topic, in any of the three shapes.
const DESTRUCTIVE = [
  'drop the table', 'drop the staging database', 'delete the branch', 'remove the production data',
  'the row count dropped by 500', 'drop 500 rows', 'dropping 500 rows', 'prune the old images', 'truncate the table',
  'a 500 row drop',   // the noun form naming a data object is a deletion, not a number
];

test('E53: a number that went down is not a topic, in any of the three shapes', () => {
  for (const q of METRIC) {
    assert.equal(forbiddenMatch(q), null, q);
    assert.deepEqual(forbiddenTopics(q), [], q);
  }
});

test('E53: a deletion is still a topic, in any of the three shapes', () => {
  for (const q of DESTRUCTIVE) {
    assert.ok(forbiddenMatch(q), q);
    assert.ok(forbiddenTopics(q).length, q);
  }
});

test('E53: the V2 policy follows: a metric goal does not ask the owner', () => {
  for (const g of METRIC) {
    const r = check(g);
    assert.equal(r.needs_approval, false, `${g}: ${r.reason}`);
    assert.equal(r.allow, true, `${g}: ${r.reason}`);
    assert.ok(!r.classes.includes('destructive'), `${g}: ${JSON.stringify(r.classes)}`);
    assert.deepEqual(classes(g), [], g);
  }
});

test('E53: the V2 policy follows: a deletion goal still asks the owner', () => {
  for (const g of DESTRUCTIVE) {
    const r = check(g);
    assert.equal(r.needs_approval, true, g);
    assert.equal(r.allow, false, g);
    assert.ok(r.classes.includes('destructive'), `${g}: ${JSON.stringify(r.classes)}`);
  }
});

test('E53: the count rule survives: a count that went down is a deletion', () => {
  for (const q of ['the row count dropped by 500', 'drop 500 rows', 'dropping 500 rows', 'drop from 500 rows to 100',
    'the record count dropped by 500', 'a 500 row drop']) {
    assert.ok(forbiddenMatch(q), q);
  }
});

test('E53: the imperative list item guard survives', () => {
  for (const q of ['- drop 500 rows', '* drop the table', '1. drop the table']) {
    assert.ok(forbiddenMatch(q), q);
  }
});

test('E53: the relief is per occurrence, not per text', () => {
  for (const g of ['the cost drop to 12 ms and then drop the table', 'a 12 ms drop in latency and drop the staging database']) {
    const r = check(g);
    assert.equal(r.needs_approval, true, g);
    assert.ok(r.classes.includes('destructive'), JSON.stringify(r.classes));
    assert.equal(classes(g).filter((c) => c === 'destructive').length, 1, JSON.stringify(classes(g)));
  }
  // Only the destructive one is reported: the metric drop is not a topic.
  assert.deepEqual(forbiddenTopics('the cost drop to 12 ms and then drop the table'), ['drop']);
});

test('E53: a disguised spelling is read the same way', () => {
  for (const q of ['dr0p the table', 'd r o p the table', 'dr0p 500 rows']) {
    assert.ok(forbiddenMatch(q), q);
  }
  for (const q of ['the cost dr0p by 40 percent', 'a 3 percent dr0p in throughput']) {
    assert.equal(forbiddenMatch(q), null, q);
  }
});

test('E53: the E43 and E45 acceptance sets still hold', () => {
  for (const q of ['the tree settle drop from 20 s to ~3 s', 'latency drop by 40 percent after the fix',
    'the cost drop to 12 ms per call', 'error rate drop from 4.1 to 0.3 on every box',
    'throughput drop to 55 requests per second']) {
    assert.equal(forbiddenMatch(q), null, q);
  }
  for (const q of ['drop the table', 'drop table t3', 'drop 500 rows', 'drop from 500 rows to 100', 'drop the index',
    'drop the database', 'delete the old branch', 'remove the host from the list', 'prune the stale leases',
    'erase the tmp file']) {
    assert.ok(forbiddenMatch(q), q);
    assert.ok(forbiddenTopics(q).length, q);
  }
});
