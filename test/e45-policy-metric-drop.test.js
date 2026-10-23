// E45: the V2 orchestration policy kept its own copy of the destructive-word list and scanned it directly, so the
// metric-drop relief of E43 never reached it: a goal that said "the cost drop to 12 ms" was escalated to the owner
// as a destructive topic. The policy now reads the manager's matcher (stall.js), which applies the relief per
// occurrence: a number that went down is not a topic, a deletion still is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, checkAction, restrictedTopics } from '../orchestration/policy.js';
import { forbiddenMatch, forbiddenTopics, windowJoins } from '../stall.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const policy = () => loadPolicy(REPO).policy;
const task = (goal) => ({ goal, scope: 'repo', definition_of_done: [] });
// The action is not read-only: only then is the task text read for restricted topics.
const check = (goal) => checkAction(policy(), task(goal), { class: 'execute' });
const classes = (text) => restrictedTopics(text, { protectedBranches: [] }).map((t) => t.class);

const METRIC = ['the cost drop to 12 ms', 'the latency drop by 40 percent', 'the error rate drop from 4.1 to 0.3'];
const DESTRUCTIVE = ['drop the table', 'drop the staging database', 'delete the branch', 'remove the production data'];

test('E45: a metric drop in a goal is not a destructive topic and does not ask the owner', () => {
  for (const g of METRIC) {
    const r = check(g);
    assert.equal(r.needs_approval, false, `${g}: ${r.reason}`);
    assert.equal(r.allow, true, `${g}: ${r.reason}`);
    assert.ok(!r.classes.includes('destructive'), `${g}: ${JSON.stringify(r.classes)}`);
    assert.deepEqual(classes(g), [], g);
  }
});

test('E45: a deletion in a goal still asks the owner', () => {
  for (const g of DESTRUCTIVE) {
    const r = check(g);
    assert.equal(r.needs_approval, true, g);
    assert.equal(r.allow, false, g);
    assert.ok(r.classes.includes('destructive'), `${g}: ${JSON.stringify(r.classes)}`);
  }
});

test('E45: the relief is per occurrence, not per text', () => {
  const g = 'the cost drop to 12 ms and then drop the table';
  const r = check(g);
  assert.equal(r.needs_approval, true, g);
  assert.ok(r.classes.includes('destructive'), JSON.stringify(r.classes));
  // Only the destructive one is reported: the metric drop is not a topic.
  assert.equal(classes(g).filter((c) => c === 'destructive').length, 1, JSON.stringify(classes(g)));
  assert.deepEqual(forbiddenTopics(g), ['drop'], JSON.stringify(forbiddenTopics(g)));
});

test('E45: every topic still counts, not only the first', () => {
  // The example in the policy's own comment: a deploy and a credentials grant.
  const got = classes('deploy the token from .env');
  assert.ok(got.includes('deploy'), JSON.stringify(got));
  assert.ok(got.includes('credentials'), JSON.stringify(got));
  const both = check('deploy the token from .env');
  assert.equal(both.needs_approval, true);
  assert.ok(both.classes.includes('deploy') && both.classes.includes('credentials'), JSON.stringify(both.classes));
});

test('E45: a disguised deletion in a goal still asks the owner', () => {
  for (const g of ['dr0p the table', 'd r o p the table']) {
    const r = check(g);
    assert.equal(r.needs_approval, true, `${g}: ${r.reason}`);
    assert.ok(r.classes.includes('destructive'), `${g}: ${JSON.stringify(r.classes)}`);
  }
});

test('E45: a metric drop in a disguised spelling is a metric too', () => {
  for (const g of ['the cost dr0p to 12 ms', 'the cost d r o p to 12 ms']) {
    assert.deepEqual(classes(g), [], `${g}: ${JSON.stringify(classes(g))}`);
    assert.equal(check(g).needs_approval, false, g);
  }
});

test('E45: the in-context join path carries the relief too', () => {
  // The window join of "dr op" reads "the cost drop to 12 ms": a metric, not a topic.
  const w = [...windowJoins('the cost dr op to 12 ms')].find((x) => /\bdrop\b/.test(x));
  assert.ok(w, 'the join produces a window');
  assert.deepEqual(forbiddenTopics(w, { spellings: false }), [], JSON.stringify(w));
  // ... and a join that really is a deletion still blocks.
  const d = [...windowJoins('dr op the table')].find((x) => /\bdrop\b/.test(x));
  assert.ok(d, 'the join produces a window');
  assert.deepEqual(forbiddenTopics(d, { spellings: false }), ['drop'], JSON.stringify(d));
  // The policy reads the same windows.
  assert.ok(classes('merge into ma in').includes('merge_protected'), JSON.stringify(classes('merge into ma in')));
});

test('E45: the push of a protected branch still needs both classes', () => {
  const got = classes('ship it: git push origin main --force');
  assert.ok(got.includes('push_shared'), JSON.stringify(got));
  assert.ok(got.includes('merge_protected'), JSON.stringify(got));
});

test('E45: the E43 acceptance set still holds', () => {
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
