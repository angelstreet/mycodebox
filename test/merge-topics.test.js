import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenMatch, topicSplit, hardMatch, mergeMatch } from '../stall.js';

test('forbiddenMatch still flags a merge into main', () => {
  assert.ok(forbiddenMatch('merge into main'));
  assert.ok(forbiddenMatch('Shall I push to main?'));
});
test('topicSplit separates merge from deploy', () => {
  const t = topicSplit('merge task90-open and deploy once the host frees?');
  assert.equal(t.merge, 'merge');
  assert.equal(t.deploy, 'deploy');   // round 8: a deploy is its own topic (decided by the manager), not hard
  assert.equal(t.hard, null);
});
test('merge and the push that lands it are not hard', () => {
  assert.equal(topicSplit('merge X into main and push main?').hard, null);
  assert.equal(topicSplit('merge X, then git push').hard, null);
});
test('a push without a merge stays hard', () => {
  assert.ok(hardMatch('push main?'));
  assert.ok(hardMatch('git push now'));
  assert.equal(topicSplit('git push now').push, 'push');   // round 8: the push topic is decided by the manager, not hard
});
test('force-push, reset --hard, rebase main stay hard with a merge', () => {
  assert.ok(topicSplit('force-push main after the merge?').hard);
  assert.ok(topicSplit('merge X then reset --hard').hard);
  assert.ok(topicSplit('merge X then rebase onto main').hard);
});
test('split spelling still finds the merge topic', () => {
  assert.ok(topicSplit('mer ge into main').merge);
  assert.ok(mergeMatch('merging it'));
  assert.equal(mergeMatch('emerge'), null);
});
test('delete after merging is hard', () => {
  assert.ok(topicSplit('delete the branch after merging').hard);
});

test('classifyStall carries topics for the same text it checks for forbidden', async () => {
  const { classifyStall } = await import('../stall.js');
  const RULE = '─'.repeat(40);
  const plain = ['merge task90-open and deploy once the host frees?', '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE];
  const s = classifyStall({ plain, raw: plain, state: 'done' });
  assert.equal(s.topics.merge, 'merge');
  assert.equal(s.topics.deploy, 'deploy');
  assert.equal(s.topics.hard, null);
  assert.ok(s.forbidden);
});

test('B2: force-push and history rewrites stay hard when a merge is in the text', () => {
  for (const x of ['git push --force', 'push -f', 'git push --force-with-lease', 'push origin +main', 'git push origin :old-branch', 'push origin HEAD:production',
    'rewrite history', 'amend the last commit on main then push', 'run filter-branch', 'run git filter-repo', 'push to prod', 'push to production', 'push to staging', 'push to live', 'git push origin feat']) {
    if (x !== 'git push origin feat') assert.ok(topicSplit(`merge feat and ${x}`).hard, x);   // round 8: a plain push of a branch is the push topic
    assert.ok(hardMatch(x, { mergePresent: true }), x);
  }
  for (const x of ['push main', 'git push', 'git push origin main', 'git push origin master and then stop', 'push to main']) assert.equal(topicSplit(`merge feat, then ${x}?`).hard, null, x);
});

test('R2-5: git push -u origin main is the landing, -u origin feature is not', () => {
  for (const x of ['git push -u origin main', 'git push --set-upstream origin main']) assert.equal(topicSplit(`merge feat, then ${x}?`).hard, null, x);
  for (const x of ['git push -u origin feature', 'git push --set-upstream origin feature']) { assert.ok(hardMatch(x, { mergePresent: true }), x); assert.equal(topicSplit(`merge feat, then ${x}?`).push, 'push', x); }
});
