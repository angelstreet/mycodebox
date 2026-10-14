import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topicSplit, hardMatch, forbiddenMatch, FORBIDDEN_RE, pushMatch, deployMatch } from '../stall.js';

test('push topic: a plain push of a branch, push to main, push a tag', () => {
  for (const x of ['push feat?', 'git push origin feat', 'push to main', 'git push -u origin feature', 'push --tags', 'push the tag v1.2.0', 'merge X into main and push main']) {
    const t = topicSplit(x);
    assert.ok(t.push, x); assert.equal(t.hard, null, x);
  }
});

test('push stays hard: force, lease, mirror, delete, +ref, :ref, prod / staging / live, rewrite, amend, filter', () => {
  for (const x of ['git push --force', 'push -f origin feat', 'git push --force-with-lease', 'git push --mirror', 'git push origin --delete old', 'push origin +main', 'git push origin :old-branch',
    'push origin HEAD:production', 'push to prod', 'push to production', 'push to staging', 'push to live', 'rewrite history', 'amend the last commit on main then push', 'run filter-branch', 'git filter-repo']) {
    const t = topicSplit(x);
    assert.equal(t.push, null, `${x}: no push topic`);
    assert.ok(t.hard, `${x}: hard`);
    assert.ok(hardMatch(x, { pushPresent: true, mergePresent: true, deployPresent: true }), `${x}: hard whatever is exempt`);
  }
});

test('deploy topic: deploy words, ship / release / promote to prod, go live, restart the service', () => {
  for (const x of ['deploy to env-a', 'redeploy it', 'run update_core.sh', 'rollout the frontend', 'roll out to staging', 'ship it to production', 'release to prod', 'promote to live', 'go live', 'restart the ghosty service', 'restart the server', 'restart the frontend', 'restart the backend', 'restart the host', 'restart the daemon']) {
    const t = topicSplit(x);
    assert.ok(t.deploy, x); assert.equal(t.hard, null, x);
  }
});

test('deploy hard parts: systemctl / pm2, unit files, publishing, terraform, kill prod', () => {
  for (const x of ['systemctl restart ghosty', 'systemctl stop nginx', 'pm2 restart api', 'restart the unit file', 'publish the package', 'terraform apply', 'kill the prod server']) {
    assert.ok(topicSplit(x).hard, x);
    assert.equal(topicSplit(x).deploy && /systemctl|pm2/.test(x) ? 'deploy beside systemctl' : null, null, `${x}: no deploy topic next to systemctl / pm2`);
  }
});

test('hard floor without merge / push / deploy: deletes, credentials, money, customers, migrations', () => {
  for (const x of ['delete the old branch', 'rotate the api key', 'use the password', 'pay the invoice', 'email the customer', 'run the migration', 'drop the table', 'wipe the cache']) {
    assert.ok(topicSplit(x).hard, x);
    assert.ok(topicSplit(`merge X, push and deploy to env-a, and ${x}`).hard, `mixed: ${x}`);
  }
});

test('mixed: merge, push and deploy together are three topics and no hard one', () => {
  assert.deepEqual(topicSplit('merge feat into main, push and deploy to env-a?'), { merge: 'merge', push: 'push', deploy: 'deploy', hard: null });
  const t = topicSplit('merge and delete the old branch?');
  assert.equal(t.merge, 'merge'); assert.match(t.hard, /delete/);
});

test('round-7 signatures keep working: hardMatch(text, { mergePresent }) and the unchanged FORBIDDEN_RE', () => {
  assert.ok(hardMatch('push main?'));
  assert.equal(hardMatch('merge X then git push', { mergePresent: true }), null);
  assert.ok(hardMatch('git push origin feat', { mergePresent: true }), 'a merge alone does not exempt a push of another ref');
  assert.equal(hardMatch('git push origin feat', { pushPresent: true }), null);
  assert.ok(forbiddenMatch('deploy it'));
  assert.ok(FORBIDDEN_RE.test('git push now') && FORBIDDEN_RE.test('restart the ghosty service') && FORBIDDEN_RE.test('push --tags'));
  assert.equal(pushMatch('push to prod'), null); assert.equal(deployMatch('systemctl restart x'), null);
});
