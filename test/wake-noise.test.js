// False manager wakes (2026-10-28): real STATUS lines from manager-events.jsonl. Waiting on a tracked job is no ask or deploy stop,
// hardware/owner-blocked leftovers are not doable, a limit banner is not an ask; true needs-manager / blocked / deploy asks still wake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall } from '../stall.js';
import { opsAsk } from '../ops-ask.js';
import { leftoversOf, pushableItems } from '../done-leftovers.js';
import { waitsOnOwnJob, jobRefs, hasRef } from '../job-refs.js';

const RULE = '─'.repeat(60);
const stall = (status) => classifyStall({ plain: ['⏺ ' + status, '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'], raw: null, state: 'done' });

const WAITS = [
  'STATUS: waiting · 18-minute 4-tab btel run on vpt-lenovo4 with the new re-login (task bopcjbp73); then',
  'STATUS: waiting · stb4 lease grant for the watchlist probe, task ba6a9tc24',
  'STATUS: waiting · round 1 VOD then radio on stb4, task bxyyl8k83',
  'STATUS: waiting · ledger poll b4mriuil9 (server and vpt-pi1 at 90486 or later), then push batch 9 (dfffb910d, merge only)',
  "STATUS: waiting · integration int-mvrtyz31da8983 (the owner-only rows above are what's left)",
  'STATUS: waiting · login watcher (task b115ie8ir, host-clone-2, owner SMS login pending)',
  'STATUS: waiting · integration int-mvrw67tac63a07 — bugs: fixed running-job answer (bug-9b0144b7)',
  'STATUS: waiting · periodic stream wall deployments on vpt-wise1 (6d113ec6), vpt-lenovo1 (e683a21b),',
  'STATUS: waiting · VOD then radio live runs on stb4, task bq07slcrw',
];
for (const w of WAITS) {
  test(`A/B: tracked-job wait is own_job_wait, not an ask or deploy stop: ${w.slice(10, 70)}`, () => {
    const s = stall(w);
    assert.equal(s.case, 'own_job_wait');
    assert.equal(opsAsk(s), null);
  });
}

test('B: a real deploy / approval wait keeps its deploy item', () => {
  assert.equal(opsAsk(stall('STATUS: waiting · deploy request for server scope, needs the go-ahead')), 'deploy');
  assert.equal(waitsOnOwnJob('integration int-mvrw67tac63a07, waiting for your approval', 'waiting'), false);
});

test('a wait that also carries a real owner ask still escalates', () => {
  const s = stall('STATUS: waiting · integration int-mvqv41kdaa9835 (also needs-owner: add secrets PRIMEVIDEO_EMAIL, PRIMEVIDEO_PASSWORD for the logged-in Prime Video half)');
  assert.notEqual(s.case, 'own_job_wait');
});

test('true positives: needs-manager, needs-owner and blocked still wake', () => {
  assert.equal(stall('STATUS: needs-manager: file docs/openrouter-voice-off ff1c46b97').case, 'needs_manager');
  assert.equal(stall('STATUS: needs-owner · approve the rename table [1 yes all / 2 no]').case, 'owner_decision');
  assert.equal(stall("STATUS: blocked · Amazon's checkpoint page keeps host-clone-2's browser off the shop").case, 'owner_decision');
  assert.equal(jobRefs('no ids here, just words').run, null);
  assert.equal(hasRef(jobRefs('task blocked')), false);
});

test('C: hardware / owner-blocked leftovers are not doable', () => {
  const t = (items) => `done\n\nLeft to do:\n${items.map((i) => `- ${i}`).join('\n')}\n\nSTATUS: done — merged`;
  assert.equal(pushableItems(t(["Hardware: the vpt-mf1 .env can't be checked until the box is reachable"])), null);
  assert.equal(pushableItems(t(['blocked (hardware): vpt-pi3 offline'])), null);
  assert.equal(pushableItems(t(['blocked (owner): SMS code'])), null);
  assert.equal(pushableItems(t(['owner-blocked: web test account'])), null);
  assert.equal(pushableItems(t(['hardware-blocked: stb4 power'])), null);
  assert.deepEqual(pushableItems(t(['Hardware: the box', 'add the doc line'])), ['add the doc line']);
  assert.ok(leftoversOf(t(['Hardware: the box'])).ownerOnly.length === 1);
});

test('D: a usage-limit banner is a stall of case error, which the manager does not turn into an ask', () => {
  const s = classifyStall({ plain: ['⏺ working', '', '× Error  Usage limit reached.', RULE, '❯ ', RULE], raw: null, state: 'done' });
  assert.equal(s.case, 'error');
  assert.match(s.question, /Usage limit reached/);
});

test('a blocked status naming a scheduled deployment is still an owner decision', () => {
  assert.equal(stall('STATUS: blocked · the smoke re-runs need a quiet web host. `host-clone-1` is locked by the scheduled `game_pokemon` deployment (9a5067e5)').case, 'owner_decision');
});
