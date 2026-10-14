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
  assert.equal(t.hard, 'deploy');
});
test('merge and the push that lands it are not hard', () => {
  assert.equal(topicSplit('merge X into main and push main?').hard, null);
  assert.equal(topicSplit('merge X, then git push').hard, null);
});
test('a push without a merge stays hard', () => {
  assert.ok(hardMatch('push main?'));
  assert.ok(topicSplit('git push now').hard);
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
  assert.equal(s.topics.hard, 'deploy');
  assert.ok(s.forbidden);
});
