import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topicSplit, hardMatch, forbiddenMatch, FORBIDDEN_RE, pushMatch, deployMatch, mergeMatch, ownerFloorMatch, OWNER_FLOOR_RE } from '../stall.js';

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
  for (const x of ['delete the old branch', 'rotate the api key', 'use the password', 'pay the invoice', 'email the customer', 'run the destructive migration', 'drop the table', 'wipe the cache']) {
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
  assert.equal(deployMatch('systemctl restart x'), null);   // "systemctl restart x" is a bare restart, not a deploy ask (push to prod / push to main are command forms and are detected as push topics; the noun form is covered by the safety filter)
});

// Round 3 (2026-10-18, owner-ask-narrow): deployMatch must keep its SERVICE_CTL_RE guard back. systemctl / pm2 are
// hard commands; they must never be reported as a deploy topic by the manager (the safety filter catches them as
// forbidden, and a deploy topic would route them to the manager as a deploy instead of a forbidden hard floor).
test('round 3: deployMatch("systemctl restart vpt-server") is null (SERVICE_CTL_RE guard restored, as on main)', () => {
  // On main, deployMatch is `(matchWith(SERVICE_CTL_RE, text) ? null : requested(text, DEPLOY_RE))`. With the guard
  // restored, systemctl / pm2 commands are filtered out and deployMatch returns null -- the safety filter
  // (FORBIDDEN_RE / hardMatch) catches them, not the deploy topic.
  assert.equal(deployMatch('systemctl restart vpt-server'), null,
    'systemctl restart is a SERVICE_CTL command, not a deploy topic (SERVICE_CTL_RE guard must be in place)');
  assert.equal(deployMatch('systemctl restart ghosty'), null, 'systemctl restart ghosty is a SERVICE_CTL command');
  assert.equal(deployMatch('systemctl stop nginx'), null, 'systemctl stop is a SERVICE_CTL command');
  assert.equal(deployMatch('pm2 restart api'), null, 'pm2 restart is a SERVICE_CTL command');
  // And FORBIDDEN_RE still catches the same systemctl / pm2 commands -- the safety filter is the hard gate.
  assert.ok(forbiddenMatch('systemctl restart vpt-server'), 'FORBIDDEN_RE catches systemctl restart vpt-server');
  assert.ok(FORBIDDEN_RE.test('systemctl restart vpt-server'), 'FORBIDDEN_RE.test catches systemctl restart vpt-server');
  assert.ok(forbiddenMatch('pm2 restart api'), 'FORBIDDEN_RE catches pm2 restart');
});

// Round 3: the safety filter (FORBIDDEN_RE) must still match push to main, update_core, sudo, migration, systemctl restart.
test('round 3: FORBIDDEN_RE (the safety filter) still matches push-to-main / update_core / sudo / migration / systemctl restart', () => {
  for (const q of [
    'push to main now',
    'git push origin main',
    'update_core main --host',
    'sudo apt install foo',
    'apply the destructive migration',
    'run the destructive migration on the db',
    'systemctl restart vpt-server',
    'systemctl stop nginx',
    'pm2 restart api',
  ]) {
    assert.ok(forbiddenMatch(q), `FORBIDDEN_RE must catch "${q}" (the safety filter blocks auto-answering)`);
    assert.ok(FORBIDDEN_RE.test(q), `FORBIDDEN_RE.test must catch "${q}"`);
  }
});

// Round 3: OWNER_FLOOR must match the three representative owner items: rotate a third-party key, buy a domain, delete shared data.
test('round 3: OWNER_FLOOR matches "rotate the Stripe API key", "buy a domain", "delete the shared bucket" (routing = owner)', () => {
  for (const q of [
    'rotate the Stripe API key',
    'buy a domain today',
    'delete the shared bucket',
  ]) {
    assert.ok(ownerFloorMatch(q), `OWNER_FLOOR must catch "${q}" -- routing escalates to the owner`);
    assert.ok(OWNER_FLOOR_RE.test(q), `OWNER_FLOOR_RE.test must catch "${q}"`);
  }
});

// Round 3: OWNER_FLOOR must NOT match manager items: migrations and generated app secrets.
// "set CRON_SECRET (generate)" has no word boundary around "secret" (underscore is a word char), so the default
// OWNER_FLOOR_RE already does not match it. "apply migration 0018" has no credentials / money / delete / physical
// at all, so neither ownerFloorMatch nor OWNER_FLOOR_RE matches it. "generate a JWT secret" has a standalone
// "secret" with word boundaries -- the default OWNER_FLOOR_RE.test matches it, but ownerFloorMatch applies the
// generated-secret exception and returns null. Both surfaces are tested separately below.
test('round 3: ownerFloorMatch drops "apply migration 0018" and "set CRON_SECRET (generate)" (routing = manager)', () => {
  for (const q of [
    'apply migration 0018 to Neon',
    'set CRON_SECRET (generate a new value)',
    'generate a JWT secret',
  ]) {
    assert.equal(ownerFloorMatch(q), null, `ownerFloorMatch must NOT match "${q}" -- routing treats it as a manager item (generated-secret exception applies where needed)`);
  }
});

test('round 3: OWNER_FLOOR_RE (the default regex, no generated-secret exception) does NOT match "apply migration 0018" or "set CRON_SECRET (generate)"', () => {
  // OWNER_FLOOR_RE is the plain regex without the generated-secret exception. "set CRON_SECRET (generate)" has no
  // word boundary around "secret" (the underscore is a word character), so it does not match the credentials
  // pattern. "apply migration 0018" has no credentials / money / delete / physical at all.
  for (const q of [
    'apply migration 0018 to Neon',
    'set CRON_SECRET (generate a new value)',
  ]) {
    assert.equal(OWNER_FLOOR_RE.test(q), false, `OWNER_FLOOR_RE.test must NOT match "${q}"`);
  }
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

test('R8 final Fable: present-tense and noun forms of the hard verbs are forbidden, never auto-continued', async () => {
  const { classifyStall, wouldSend } = await import('../stall.js');
  const RULE = '─'.repeat(40);
  const run = (body) => { const plain = [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE]; const st = classifyStall({ plain, raw: plain, state: 'done' }); return { st, w: wouldSend(st) }; };
  for (const body of ['Shall I continue? The script deletes the old backups first.', 'Shall I continue? The cleanup step removes the data directory.',
    'Shall I continue? The job drops the users table nightly.', 'Shall I continue? Removal of the old backups comes first.',
    'Shall I continue? It wipes the volume.', 'Shall I continue? The hook revokes the old token.', 'Shall I continue? It pays the open bill.']) {
    const { st, w } = run(body);
    assert.ok(st.forbidden, body); assert.equal(w.send, null, body);
  }
});
