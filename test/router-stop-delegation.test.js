import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { POINTS, STOP_V1, STOP_FLOOR_TOPICS, floor, ruleDefault, buildRequest, pick, decide } from '../router.js';

// ---- floors forced (no call) for every touches entry ----
for (const topic of STOP_FLOOR_TOPICS) {
  test(`stop: touches "${topic}" forces escalate with a reason naming it`, () => {
    const f = floor('stop', { case: 'owner_decision', touches: [topic] });
    assert.equal(f.forced, 'escalate', `topic=${topic}`);
    assert.ok(f.allowed.includes('escalate'));
    assert.match(f.reasons.join(' '), new RegExp(topic));
  });
}
test('stop: multiple touches entries still force escalate and name every one', () => {
  const f = floor('stop', { case: 'owner_decision', touches: ['money', 'credentials'] });
  assert.equal(f.forced, 'escalate');
  assert.match(f.reasons.join(' '), /money/);
  assert.match(f.reasons.join(' '), /credentials/);
});
test('stop: touches that are not in STOP_FLOOR_TOPICS are ignored by the floor', () => {
  const f = floor('stop', { case: 'owner_decision', touches: ['app', 'random'] });
  assert.equal(f.forced, null);
  assert.deepEqual(f.allowed, ['answer', 'escalate']);
});
test('stop: touches entry coexists with today\'s floors (case=permission wins first)', () => {
  const f = floor('stop', { case: 'permission', touches: ['merge_main'] });
  assert.equal(f.forced, 'escalate');
  // case reason wins because permission is checked first
  assert.match(f.reasons.join(' '), /permission/);
});
test('stop: forbidden_topic + touches still forces escalate (only one reason needed)', () => {
  const f = floor('stop', { case: 'owner_decision', forbidden_topic: true, touches: ['money'] });
  assert.equal(f.forced, 'escalate');
  assert.match(f.reasons.join(' '), /forbidden topic/);
});

// ---- ruleDefault table (no call, no forced floor) ----
// facts shape that keeps the floor non-forced: forbidden_topic unset, case != permission/
// owner_action/waiting_deploy, touches empty.
const RULE_DEFAULT_CASES = [
  // [label, facts, expected]
  ['continue -> answer', { case: 'continue' }, 'answer'],
  ['done -> escalate', { case: 'done' }, 'escalate'],
  ['owner_decision -> escalate (no delegation)', { case: 'owner_decision' }, 'escalate'],
  ['menu_recommended -> escalate (no delegation)', { case: 'menu_recommended' }, 'escalate'],
  ['recommended + reversible -> answer', { case: 'owner_decision', recommended: true, reversible: true }, 'answer'],
  ['recommended + NOT reversible -> escalate', { case: 'owner_decision', recommended: true, reversible: false }, 'escalate'],
  ['reversible without recommended -> escalate', { case: 'owner_decision', reversible: true }, 'escalate'],
  ['own_cleanup -> answer', { case: 'owner_decision', own_cleanup: true }, 'answer'],
  ['delegated -> answer (case irrelevant)', { case: 'owner_decision', delegated: true }, 'answer'],
  ['delegated + done -> answer', { case: 'done', delegated: true }, 'answer'],
  ['delegated + continue -> answer (ruleDefault still answer)', { case: 'continue', delegated: true }, 'answer'],
  ['delegated but forbidden -> forced escalate (floor wins, ruleDefault still answer)', { case: 'owner_decision', delegated: true, forbidden_topic: true }, 'answer'],
];
for (const [label, facts, expected] of RULE_DEFAULT_CASES) {
  test(`stop: ruleDefault: ${label}`, () => {
    assert.equal(ruleDefault('stop', facts), expected);
  });
}

// ---- criteria text contains the delegation language ----
test('stop: buildRequest answer criteria states the delegation in plain words', () => {
  const body = buildRequest('stop', { case: 'owner_decision' }, { teamId: 't' });
  assert.ok(body, 'floor did not force escalate on plain owner_decision');
  const a = body.questions.choice.criteria.answer;
  const e = body.questions.choice.criteria.escalate;
  // delegation in plain words
  assert.match(a, /design or scope choice with a recommended, reversible option/);
  assert.match(a, /session's own files/);
  assert.match(a, /continuing planned work/);
  // owner-only floors listed on escalate
  assert.match(e, /money or cost beyond plan/);
  assert.match(e, /credentials or secrets/);
  assert.match(e, /customers/);
  assert.match(e, /deleting shared data/);
  assert.match(e, /database migrations/);
  assert.match(e, /merges to main/);
  assert.match(e, /restarts or deploys/);
  assert.match(e, /choice between directions with no recommendation/);
});
test('stop: instructions mention the owner\'s delegation', () => {
  assert.match(POINTS.stop.instructions, /delegation/);
});
test('stop: floor forced by touches -> buildRequest returns null (no call)', () => {
  const body = buildRequest('stop', { case: 'owner_decision', touches: ['merge_main'] }, { teamId: 't' });
  assert.equal(body, null);
});
test('stop: decide with touches entry returns forced=escalate and does not call post', async () => {
  let called = 0;
  const out = await decide('stop', { case: 'owner_decision', touches: ['money'] }, {
    post: async () => { called++; return { success: true, answers: { choice: { choice: 'answer', confidence: 0.99 } } }; },
    teamId: 't',
  });
  assert.equal(out.choice, 'escalate');
  assert.equal(out.source, 'forced');
  assert.equal(called, 0);
});

// ---- STOP_V1 (frozen copy) for replay parity ----
test('STOP_V1: today\'s stop floors (forbidden_topic / permission / etc.) still force escalate', () => {
  for (const c of ['permission', 'owner_action', 'waiting_deploy']) {
    const f = STOP_V1.floor({ case: c });
    assert.equal(f.forced, 'escalate', `case=${c}`);
  }
  const f2 = STOP_V1.floor({ case: 'continue', forbidden_topic: true });
  assert.equal(f2.forced, 'escalate');
});
test('STOP_V1: today\'s stop ruleDefault is escalate (except case=continue)', () => {
  assert.equal(STOP_V1.ruleDefault({ case: 'continue' }), 'answer');
  assert.equal(STOP_V1.ruleDefault({ case: 'owner_decision' }), 'escalate');
  assert.equal(STOP_V1.ruleDefault({ case: 'menu_recommended' }), 'escalate');
});
test('STOP_V1: today\'s stop floors do NOT trigger on touches (replay comparison baseline)', () => {
  // The whole point of the delegation update is that today's stop ignores touches entries
  // like 'money' / 'merge_main' / 'credentials'. STOP_V1 must reproduce that.
  for (const topic of STOP_FLOOR_TOPICS) {
    const f = STOP_V1.floor({ case: 'owner_decision', touches: [topic] });
    assert.equal(f.forced, null, `STOP_V1: topic=${topic} must NOT force`);
  }
});

// ---- fixtures: stop-delegation.json ----
test('fixtures/stop-delegation: every case agrees with floor + ruleDefault against expect', async () => {
  const url = new URL('./fixtures/stop-delegation.json', import.meta.url);
  const cases = JSON.parse(await readFile(url, 'utf8'));
  assert.ok(cases.length >= 30, `expected ~30 cases, got ${cases.length}`);
  const counts = { answer: 0, escalate: 0 };
  for (const c of cases) {
    assert.ok(c.id && c.facts && c.expect, `case ${JSON.stringify(c).slice(0, 60)} missing id/facts/expect`);
    assert.ok(['answer', 'escalate'].includes(c.expect), `case ${c.id} expect must be answer|escalate`);
    counts[c.expect]++;
    const f = floor('stop', c.facts);
    if (f.forced) {
      assert.equal(f.forced, c.expect, `case ${c.id}: floor forced "${f.forced}", expected "${c.expect}"`);
    } else {
      assert.ok(f.allowed.includes(c.expect), `case ${c.id}: expected "${c.expect}" not in allowed ${JSON.stringify(f.allowed)}`);
      const rd = ruleDefault('stop', c.facts);
      // When the rule default disagrees with expect, it must still be inside allowed.
      assert.ok(f.allowed.includes(rd), `case ${c.id}: rule default "${rd}" not in allowed`);
    }
  }
  assert.ok(counts.answer >= 10, `expected >=10 delegated answers, got ${counts.answer}`);
  assert.ok(counts.escalate >= 10, `expected >=10 escalate cases, got ${counts.escalate}`);
});
test('fixtures/stop-delegation: UNSAFE check -- no case expecting escalate may pick answer in ruleDefault', async () => {
  const url = new URL('./fixtures/stop-delegation.json', import.meta.url);
  const cases = JSON.parse(await readFile(url, 'utf8'));
  let unsafe = 0;
  for (const c of cases) {
    if (c.expect !== 'escalate') continue;
    const f = floor('stop', c.facts);
    if (f.forced) continue;        // a forced floor wins, not the rule default
    const rd = ruleDefault('stop', c.facts);
    if (rd === 'answer') unsafe++;
  }
  assert.equal(unsafe, 0, `expected escalate cases must not have ruleDefault=answer (UNSAFE=${unsafe})`);
});
test('fixtures/stop-delegation: delegated answer cases are not floored by touches', async () => {
  const url = new URL('./fixtures/stop-delegation.json', import.meta.url);
  const cases = JSON.parse(await readFile(url, 'utf8'));
  for (const c of cases) {
    if (c.expect !== 'answer') continue;
    const f = floor('stop', c.facts);
    assert.equal(f.forced, null, `delegated answer case ${c.id} must not be forced escalate: ${f.reasons.join(' / ')}`);
    assert.equal(ruleDefault('stop', c.facts), 'answer', `delegated answer case ${c.id} must ruleDefault=answer`);
  }
});

// ---- pick integration: delegated answer gets the answer treatment even with low jev confidence ----
test('stop: delegated facts (recommended+reversible) -> ruleDefault=answer and floor not forced', () => {
  const facts = { case: 'owner_decision', recommended: true, reversible: true, delegated: true };
  const f = floor('stop', facts);
  assert.equal(f.forced, null);
  assert.equal(ruleDefault('stop', facts), 'answer');
  // pick with no jev reply -> falls back to ruleDefault=answer
  const out = pick('stop', facts, null);
  assert.equal(out.choice, 'answer');
  assert.equal(out.source, 'rule');
});
test('stop: touches=money forces escalate even with recommended+reversible', () => {
  const facts = { case: 'owner_decision', recommended: true, reversible: true, delegated: true, touches: ['money'] };
  const f = floor('stop', facts);
  assert.equal(f.forced, 'escalate');
  assert.match(f.reasons.join(' '), /money/);
});