// Round 13 (d): a lease or deploy stop is a manager item, never an owner item (ops-ask.js, manager.js escalate, NEEDS YOU strip).
// Round 13 (2026-10-18): FORBIDDEN_RE is the AUTO-ANSWER SAFETY FILTER (restored exactly as on main -- never auto-answered).
// OWNER_FLOOR is the NARROWER, ROUTING-ONLY set the manager uses to decide OWNER-vs-MANAGER escalation. ops-ask uses
// OWNER_FLOOR for the routing decision: a stop whose text touches an OWNER_FLOOR topic escalates to the OWNER; any
// other FORBIDDEN_RE topic (deploy, push, merge, sudo, migration, generated app secrets, unit files, reboot) escalates
// to the MANAGER (the manager's merge / deploy evaluation owns it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { join } from 'node:path';
import { opsAsk, isLeaseOrDeployAsk } from '../ops-ask.js';
import { forbiddenMatch as forbiddenMatchForTest, ownerFloorMatch as ownerFloorForTest } from '../stall.js';
import { isOwnersTurn, buildQueue } from '../public/ask-model.js';
import { tmp } from './helpers-tmp.js';

const dir = tmp('ghosty-opsask-');
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const m = await import('../manager.js');
const pushes = [], items = [];
await m.initManager({ onOwnerNeeded: (s) => pushes.push(s), onManagerItem: (it) => items.push(it) });
await m.setManagerConfig({ aiTriage: 'off', routerShadow: false, wakeShadow: false, autoSend: false });

test('detection: lease and deploy asks, owner floor (round 13: only owner list), mixed and unrelated questions', () => {
  const od = (question, extra = {}) => ({ case: 'owner_decision', question, ...extra });
  assert.equal(opsAsk({ case: 'waiting_deploy', question: 'waits for deploy d-42', deployHint: { id: 'd-42' } }), 'deploy');
  assert.equal(opsAsk(od('deploy main to env-a once the lease frees? [1 yes 2 wait]', { status: 'needs-owner' })), 'lease');
  assert.equal(opsAsk(od('lease on env-a/server is held by codebox:other', { status: 'blocked' })), 'lease');
  assert.equal(opsAsk(od('Should I deploy to env-a?')), 'deploy');
  assert.equal(opsAsk(od('Should I restart the backend service via update_core?')), 'deploy');
  assert.equal(opsAsk(od('Is the deploy queue empty, may I approve my deploy?')), 'deploy');
  // round 13: only money, customers, shared_data_delete, owner-held credentials, physical stay in OWNER_FLOOR.
  // Migrations, deploy, push, merge, sudo / systemctl, generated secrets: all manager items (routing = manager).
  assert.equal(opsAsk(od('Deploy main to env-a and drop the old table?')), null, 'drop table stays in OWNER_FLOOR (shared_data_delete)');
  assert.equal(opsAsk({ case: 'waiting_deploy', question: 'waits for a deploy; also delete the old branch' }), null, 'delete the old branch is shared_data_delete: owner item');
  assert.equal(opsAsk(od('Should I deploy with sudo?')), null, 'sudo is a §15 hard topic: it stays with the owner (review finding 8)');
  assert.equal(opsAsk(od('Deploy and use the api key from the vault?')), null, 'third-party api key IS in OWNER_FLOOR (owner-held credential)');
  assert.equal(opsAsk(od('Run the destructive migrations on deploy?')), null, 'a migration is a §15 hard topic: owner');
  assert.equal(opsAsk(od('Should I restart the ghosty service?')), null, 'a service unit is a §15 hard topic: owner');
  for (const q of ['Deploy main to env-a and force-push the release tag?', 'Deploy and run the destructive production migration?', 'Deploy and edit /etc/sudoers?', 'Deploy and publish the npm package?']) {
    assert.equal(opsAsk(od(q)), null, q);
    assert.equal(opsAsk(od(q, { topics: { hard: 'x' } })), null, `${q} (topics given)`);
  }
  // unrelated or mixed
  assert.equal(opsAsk(od('Which database should I use, A or B?')), null);
  assert.equal(opsAsk(od('Should I deploy? Also which color for the button?')), null);
  assert.equal(opsAsk(od('Should I sign the lease for the new office?')), null);
  assert.equal(opsAsk({ case: 'permission', question: 'deploy?' }), null);
  assert.equal(isLeaseOrDeployAsk(null), false);
});

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => (existsSync(join(dir, 'stalls.jsonl')) ? readFileSync(join(dir, 'stalls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
async function stop(name, body) {
  tick(name, 'working', ['busy'], 0); tick(name, 'done', pane(body), 1000); tick(name, 'done', pane(body), 2500);
  const end = Date.now() + 4000;
  while (Date.now() < end) { const e = log().find((r) => r.type === 'escalated' && r.session === name); if (e) return e; await wait(25); }
  throw new Error(`no escalation for ${name}`);
}

test('waiting_deploy and a lease needs-owner become manager items: record, event hook, no owner push', async () => {
  const a = await stop('wd', 'Queued the deploy.\nSTATUS: waiting: deploy d-42');
  assert.equal(a.target, 'manager'); assert.equal(a.kind, 'deploy');
  const b = await stop('lq', 'Everything is ready.\nSTATUS: needs-owner: deploy main to env-a once the lease frees? [1 yes 2 wait]');
  assert.equal(b.target, 'manager');
  assert.deepEqual(pushes, []);
  assert.deepEqual(items.map((i) => i.session).sort(), ['lq', 'wd']);
  assert.equal(m.stallOf('lq').escalatedTo, 'manager');
});

test('a hard-floor deploy question and an unrelated question stay owner items', async () => {
  const a = await stop('hf', 'Ready.\nSTATUS: needs-owner: deploy main to env-a and drop the old table?');
  assert.notEqual(a.target, 'manager');
  const b = await stop('pq', 'The schema change is ready.\nShould I rename the column or keep both?\nSTATUS: needs-owner: rename or keep both?');
  assert.notEqual(b.target, 'manager');
  assert.ok(pushes.includes('hf') && pushes.includes('pq'), JSON.stringify(pushes));
  assert.equal(m.stallOf('pq').escalatedTo, 'owner');
  assert.equal(items.length, 2);
});

test('NEEDS YOU skips manager items (isOwnersTurn / buildQueue)', () => {
  const st = (escalatedTo, state = 'waiting') => ({ state, triage: { state: 'done' }, stall: { case: 'owner_decision', question: 'q?', escalatedTo } });
  assert.equal(isOwnersTurn(st('owner')), true);
  assert.equal(isOwnersTurn(st('manager')), false);
  assert.equal(isOwnersTurn(st('manager', 'done')), false);
  assert.equal(isOwnersTurn(st(null, 'done')), true);
  assert.deepEqual(buildQueue({ a: st('manager'), b: st('owner') }, {}, [{ name: 'a' }, { name: 'b' }]).map((x) => x.name), ['b']);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /escalatedTo !== 'manager' && \(stateOf/);   // the strip itself filters the same way
});

// ---- round 13 (2026-10-18, owner rule): the five representative cases ------------------------
// FORBIDDEN_RE is the AUTO-ANSWER SAFETY FILTER (restored exactly as on main -- catches every topic it caught before).
// OWNER_FLOOR is the NARROWER, ROUTING-ONLY set the manager uses to decide OWNER-vs-MANAGER escalation. ops-ask uses
// OWNER_FLOOR for the routing decision: a stop whose text touches an OWNER_FLOOR topic escalates to the OWNER; any
// other FORBIDDEN_RE topic (deploy, push, merge, sudo, migration, generated app secrets) escalates to the MANAGER.
test('round 13 case 1: "apply migration 0018 to Neon" -- FORBIDDEN_RE catches it; OWNER_FLOOR does not (routing = manager)', () => {
  const od = (question, extra = {}) => ({ case: 'owner_decision', question, ...extra });
  // ops-ask still needs a lease or deploy topic to mark it as a manager item; the manager item routing is what
  // the deploy evaluation handles in production. In the unit test we verify the ROUTING floor no longer escalates
  // it to the owner (OWNER_FLOOR does not match migration).
  assert.equal(opsAsk(od('Apply the destructive migration 0018 to Neon now?', { status: 'needs-owner' })), null,
    'migration alone is not lease / deploy; the manager item routing comes from the deploy evaluation in production');
  // The routing floor (OWNER_FLOOR) does not reject it (migration is not an owner topic):
  assert.equal(ownerFloorForTest('Apply the destructive migration 0018 to Neon now?'), null,
    'migration is NOT in OWNER_FLOOR (round 13) -- routing treats it as a manager item');
  // But the safety filter (FORBIDDEN_RE) DOES catch it -- never auto-answered.
  assert.ok(safetyFloorForTest('Apply the destructive migration 0018 to Neon now?'),
    'migration IS in FORBIDDEN_RE (the safety filter) -- never auto-answered');
});

test('round 13 case 2: "set CRON_SECRET (generate)" -- OWNER_FLOOR drops it (generated-secret exception); FORBIDDEN_RE catches "the cron secret" but not the placeholder name "CRON_SECRET"', () => {
  // The generated-secret exception drops the credentials part of OWNER_FLOOR: routing no longer escalates a
  // generated app secret ("set CRON_SECRET (generate)", placeholder names like CRON_/JWT_/APP_/SESSION_/INTERNAL_/
  // DB_/DATABASE_) to the owner -- it is a manager decision.
  //
  // FORBIDDEN_RE matches `\bsecret\b` (word boundaries). "CRON_SECRET" has underscores, so the word boundary at
  // the start of SECRET is between `_` (word) and `S` (word) -- no boundary. The safety filter does NOT catch a
  // placeholder name on its own. It DOES catch "the cron secret" (standalone "secret" with word boundaries).
  // That is the intended division: the safety filter is a plain-word floor; the generated-secret routing
  // exception is a OWNER_FLOOR-only affordance.
  const od = (question, extra = {}) => ({ case: 'owner_decision', question, ...extra });
  assert.equal(ownerFloorForTest('Set CRON_SECRET (generate a new value) and roll the service?'), null,
    'a generated app secret is a manager decision; the credentials part of OWNER_FLOOR is dropped by the generated-secret exception');
  assert.equal(safetyFloorForTest('Set CRON_SECRET (generate a new value) and roll the service?'), null,
    'a placeholder name like CRON_SECRET has no word boundary around "secret" -- the safety filter does not match it');
  assert.ok(safetyFloorForTest('Plan: rotate the cron secret.'),
    '"the cron secret" (standalone "secret" with word boundaries) IS in FORBIDDEN_RE -- the safety filter catches it');
  // A real third-party credential still matches OWNER_FLOOR (routing = owner).
  assert.ok(ownerFloorForTest('Rotate the Stripe API key now?'),
    'real third-party credential rotation IS in OWNER_FLOOR -- routing escalates to the owner');
});

test('round 13 case 3: "rotate the Stripe API key" is an owner item (BOTH floors catch it)', () => {
  const od = (question, extra = {}) => ({ case: 'owner_decision', question, ...extra });
  assert.equal(opsAsk(od('Rotate the Stripe API key now?')), null, 'owner item, not a manager item');
  assert.ok(ownerFloorForTest('Rotate the Stripe API key now?'),
    'third-party credential rotation IS in OWNER_FLOOR -- routing escalates to the owner');
  assert.ok(safetyFloorForTest('Rotate the Stripe API key now?'),
    'third-party credential rotation IS in FORBIDDEN_RE -- the safety filter blocks auto-answering');
});

test('round 13 case 4: "buy a domain" is an owner item (BOTH floors catch it)', () => {
  const od = (question, extra = {}) => ({ case: 'owner_decision', question, ...extra });
  assert.equal(opsAsk(od('Buy a domain today?')), null, 'owner item, not a manager item');
  assert.ok(ownerFloorForTest('Buy a domain today?'),
    'a purchase IS in OWNER_FLOOR -- routing escalates to the owner');
  assert.ok(safetyFloorForTest('Buy a domain today?'),
    'a purchase IS in FORBIDDEN_RE -- the safety filter blocks auto-answering');
});

test('round 13 case 5: "STATUS: needs-manager: pick option 1 or 2" is always a manager item, regardless of topic', () => {
  const final = { case: 'owner_decision', question: 'Pick option 1 or 2', status: 'needs-manager' };
  assert.equal(opsAsk(final), 'lease', 'needs-manager status makes ops-ask return non-null regardless of the text topic');
  // It also beats the OWNER_FLOOR: even "drop the old table" with needs-manager is a manager item.
  assert.equal(opsAsk({ ...final, question: 'drop the old table' }), 'lease',
    'needs-manager bypasses OWNER_FLOOR (the text topic is irrelevant)');
});

function safetyFloorForTest(text) {
  // Thin wrapper: is this caught by the AUTO-ANSWER SAFETY FILTER (FORBIDDEN_RE)?
  return forbiddenMatchForTest(text);
}

test('merge_wait is a manager item of kind merge, unless a hard word keeps it with the owner', () => {
  assert.equal(opsAsk({ case: 'merge_wait', question: 'your merge decision on PR #22', status: 'waiting', topics: { merge: 'merge' } }), 'merge');
  assert.equal(opsAsk({ case: 'merge_wait', question: 'merge PR #22 with a force-push', status: 'needs-owner', topics: { merge: 'merge', hard: 'force-push' } }), null);
});
