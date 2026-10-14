import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topicSplit, hardMatch, forbiddenMatch, FORBIDDEN_RE, pushMatch, deployMatch, mergeMatch } from '../stall.js';

test('push topic: a plain push of a branch, push to main, push a tag', () => {
  for (const x of ['push feat?', 'git push origin feat', 'push to main', 'git push -u origin feature', 'merge X into main and push main']) {
    const t = topicSplit(x);
    assert.ok(t.push, x); assert.equal(t.hard, null, x);
  }
});

test('push stays hard: force, lease, mirror, delete, +ref, :ref, prod / staging / live, rewrite, amend, filter', () => {
  for (const x of ['git push --force', 'push -f origin feat', 'git push --force-with-lease', 'git push --mirror', 'git push origin --delete old', 'push origin +main', 'git push origin :old-branch',
    'push origin HEAD:production', 'push --tags', 'Push the tag v1.2 to origin?', 'push the tag v1.2.0', 'push to prod', 'push to production', 'push to staging', 'push to live', 'rewrite history', 'amend the last commit on main then push', 'run filter-branch', 'git filter-repo']) {
    const t = topicSplit(x);
    assert.equal(t.push, null, `${x}: no push topic`);
    assert.ok(t.hard, `${x}: hard`);
    assert.ok(hardMatch(x, { pushPresent: true, mergePresent: true, deployPresent: true }), `${x}: hard whatever is exempt`);
  }
});

test('deploy topic: deploy words, ship / release / promote to prod, go live, restart the service', () => {
  for (const x of ['deploy to env-a', 'redeploy it', 'run update_core.sh', 'rollout the frontend', 'roll out to staging', 'ship it to production', 'release to prod', 'promote to live', 'go live']) {
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

// ---- round 8 review fixes ----
test('R8-2: a noun mention is not a request: only an ask to perform it is a deploy / push topic', () => {
  const noun = topicSplit('Should the deploy queue page also show the env-a name?');
  assert.equal(noun.deploy, null); assert.ok(noun.hard, 'a deploy word that is not an ask stays in the hard floor');
  const notif = topicSplit('Should I add push notifications to the app?');
  assert.equal(notif.push, null);
  for (const x of ['Should I deploy main to env-a?', 'Shall I push the branch?', 'Want me to deploy it?', 'ready to deploy', 'Deploy X to env-a?', 'Push it?', 'merge X and deploy once the host frees?', 'Can I push feat now?']) {
    const t = topicSplit(x); assert.ok(t.deploy || t.push, x); assert.equal(t.hard, null, x);
  }
  assert.equal(topicSplit('Should I show deploy status on the page?').deploy, null);
  assert.equal(topicSplit('Should I update the deploy script?').deploy, null);
});

test('R8-6a: a bare restart of a service is hard, not a deploy topic; the ghosty service is never a deploy target', () => {
  for (const x of ['Shall I restart the ghosty service?', 'Shall I restart the server?', 'restart the daemon', 'restart the host']) {
    assert.equal(topicSplit(x).deploy, null, x); assert.ok(topicSplit(x).hard, x);
  }
  assert.ok(topicSplit('Shall I deploy it and restart the ghosty service?').hard, 'ghosty stays hard beside a deploy');
  assert.equal(topicSplit('Shall I deploy it and restart the server?').hard, null, 'a restart rides along with a deploy word');
});

test('R8-6b: sudoers, unit files, reboot, schema tools and database resets are hard everywhere (FORBIDDEN_RE grew)', () => {
  for (const x of ['add the deploy user to sudoers', 'edit /etc/sudoers.d/deploy', 'run visudo', 'Deploy it and reboot the host', 'sudo apt update', 'shutdown the box', 'run alembic upgrade head', 'prisma migrate deploy', 'rails db:migrate', 'run flyway', 'reset the database', 're-create the schema',
    'The unit file is written at /etc/systemd/system/x.service', 'systemctl enable x', 'systemctl daemon-reload']) {
    assert.ok(forbiddenMatch(x), `forbidden: ${x}`);
    assert.ok(topicSplit(`Shall I merge, push and deploy and ${x}?`).hard, `hard even with all topics decided: ${x}`);
  }
});

test('R8-r3-3: request-form gaps are topics; noun forms stay non-topics', () => {
  for (const x of ['Should I request a deploy of main to env-a?', 'Shall I queue the deploy?', 'Should I kick off a deploy to env-a?', 'Please trigger the deploy', 'Want me to run the deploy?', 'Should I retry the deploy?',
    'Should this be deployed to env-a?', 'Do you want it deployed?', 'Do you want a deploy to env-a?', 'Is it ok if I push?', 'Should this be pushed?', 'Do you want it pushed?']) {
    const t = topicSplit(x); assert.ok(t.deploy || t.push, x); assert.equal(t.hard, null, x);
  }
  for (const x of ['Should the deploy queue page show the env-a name?', 'Should I show the deployed version?', 'I deployed the fix. Should I continue?', 'Should the push notification page list it?', 'Is it deployed? Should I check?']) {
    const t = topicSplit(x); assert.equal(t.deploy, null, x); assert.equal(t.push, null, x);
  }
});

test('R8-r3-3: merges follow the same request-form rule', () => {
  assert.equal(topicSplit('Should the merge policy page also list the conflicting files?').merge, null);
  assert.equal(topicSplit('Should the merge queue show the branch?').merge, null);
  for (const x of ['Should I merge feat into main?', 'Shall we merge it?', 'say whether to merge task90-open?', 'Should this be merged?', 'merge feat, then push']) assert.ok(topicSplit(x).merge, x);
  assert.equal(mergeMatch('emerge'), null);
});

test('R8-r4: "run / queue / retry the deploy <noun>" is a noun: no topic, the stall stays hard', () => {
  for (const x of ['Should I run the deploy tests?', 'Should I queue the deploy job page refactor?', 'Should I retry the deploy check?', 'Should I start the deploy script?']) {
    const t = topicSplit(x); assert.equal(t.deploy, null, x); assert.ok(t.hard, `${x}: hard`);
  }
  for (const x of ['Should I retry the failed deploy to env-a?', 'Should I run the deploy?', 'Should I queue the deploy now?', 'Should I retry the deploy again?', 'Should I request a deploy of main to env-a?', 'Should I run the deploy for env-a?']) {
    const t = topicSplit(x); assert.ok(t.deploy, x); assert.equal(t.hard, null, x);
  }
});

test('R8-r4 (Fable N5): past tenses and more verbs of the delete / credential / money groups are forbidden and hard', () => {
  for (const x of ['The old backups will be deleted first.', 'The cache was removed.', 'dropped the column', 'Tables are being dropped', 'wiped the volume', 'truncated the log', 'it overwritten the file', 'purged the queue', 'pruned the images', 'we rotated the keys', 'the token was revoked', 'The invoice was paid.']) {
    assert.ok(forbiddenMatch(x), `forbidden: ${x}`);
    assert.ok(topicSplit(`merge, push and deploy; ${x}`).hard, `hard: ${x}`);
  }
  assert.ok(topicSplit('Should the old data be deleted and feat be merged into main?').hard, 'the deletion is hard while the merge is a topic');
  assert.ok(topicSplit('Should the old data be deleted and feat be merged into main?').merge);
});

test('R8-r4 (Fable N5): a stop that mentions a past-tense deletion or payment is never auto-continued', async () => {
  const { classifyStall, wouldSend } = await import('../stall.js');
  const RULE = '─'.repeat(40);
  const run = (body) => { const plain = [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE]; const s = classifyStall({ plain, raw: plain, state: 'done' }); return { s, w: wouldSend(s) }; };
  for (const body of ['Shall I continue? The old backups will be deleted first.', 'The invoice was paid; continue?']) {
    const { s, w } = run(body);
    assert.ok(s.forbidden, body); assert.equal(w.send, null, body);
  }
});

test('R8 final review: passive rotation and erase / destroy / nuke are forbidden, never auto-continued', async () => {
  const { classifyStall, wouldSend } = await import('../stall.js');
  const RULE = '─'.repeat(40);
  const run = (body) => { const plain = [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE]; const st = classifyStall({ plain, raw: plain, state: 'done' }); return { st, w: wouldSend(st) }; };
  for (const body of ['Done. The tokens were rotated.\n\nShall I continue?', 'Done. The signing keys were rotated overnight.\n\nShall I continue?',
    'Shall I continue? I erased the old logs.', 'Shall I continue? The old records were destroyed.', 'Shall I continue? I nuked the cache dir.']) {
    const { st, w } = run(body);
    assert.ok(st.forbidden, body); assert.equal(w.send, null, body);
  }
});
