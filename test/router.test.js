import test from 'node:test';
import assert from 'node:assert/strict';
import { POINTS, SUGGEST_ONLY, floor, ruleDefault, buildRequest, pick, decide } from '../router.js';

// ---- shared tiny helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- wake ----
test('wake: floor drops none of the four when nothing is critical and no forbidden topic', () => {
  const f = floor('wake', { event: { kind: 'stall' }, disk_pct: 40, quota: { claude: 30 } });
  assert.deepEqual(f.allowed, ['ignore', 'rules_handle', 'wake_cheap', 'wake_opus']);
  assert.equal(f.forced, null);
});
test('wake: p0_blocked keeps only wake_cheap + wake_opus', () => {
  const f = floor('wake', { event: { kind: 'stall', p0_blocked: true }, disk_pct: 40, quota: { claude: 30 } });
  assert.deepEqual(f.allowed, ['wake_cheap', 'wake_opus']);
});
test('wake: deploy failed keeps only wake_cheap + wake_opus', () => {
  const f = floor('wake', { event: { kind: 'deploy' }, deploy: { state: 'failed' }, disk_pct: 40, quota: { claude: 30 } });
  assert.deepEqual(f.allowed, ['wake_cheap', 'wake_opus']);
});
test('wake: disk_pct >= 95 keeps only wake_cheap + wake_opus', () => {
  const f = floor('wake', { event: { kind: 'stall' }, disk_pct: 96, quota: { claude: 30 } });
  assert.deepEqual(f.allowed, ['wake_cheap', 'wake_opus']);
});
test('wake: any quota value >= 95 keeps only wake_cheap + wake_opus', () => {
  const f = floor('wake', { event: { kind: 'stall' }, disk_pct: 40, quota: { claude: 30, mini: 96 } });
  assert.deepEqual(f.allowed, ['wake_cheap', 'wake_opus']);
});
test('wake: forbidden_topic removes rules_handle but leaves the rest', () => {
  const f = floor('wake', { event: { kind: 'stall', forbidden_topic: true }, disk_pct: 40, quota: { claude: 30 } });
  assert.deepEqual(f.allowed, ['ignore', 'wake_cheap', 'wake_opus']);
});
test('wake: ruleDefault is wake_opus when escalated', () => {
  assert.equal(ruleDefault('wake', { event: { escalated: true }, disk_pct: 30, quota: { claude: 30 } }), 'wake_opus');
});
test('wake: ruleDefault is rules_handle when not escalated', () => {
  assert.equal(ruleDefault('wake', { event: { kind: 'stall' }, disk_pct: 30, quota: { claude: 30 } }), 'rules_handle');
});
test('wake: ruleDefault falls back to first allowed when the rule pick is not in allowed', () => {
  // escalated=true would normally give wake_opus; p0_blocked allows only [wake_cheap, wake_opus] -> ruleDefault wakes the cheap one in the rule-only path,
  // but the requirement says: ruleDefault is wake_opus when escalated and must be inside allowed; else first allowed.
  // Here wake_opus IS inside allowed, so we get wake_opus.
  const facts = { event: { kind: 'stall', p0_blocked: true, escalated: true }, disk_pct: 30, quota: { claude: 30 } };
  assert.equal(ruleDefault('wake', facts), 'wake_opus');
  // non-escalated + p0_blocked: rules_handle is NOT inside allowed -> first allowed
  assert.equal(ruleDefault('wake', { event: { kind: 'stall', p0_blocked: true }, disk_pct: 30, quota: { claude: 30 } }), 'wake_cheap');
});

// ---- builder ----
test('builder: floor keeps all four when touches are app-only on a private repo', () => {
  const f = floor('builder', { work: { touches: ['app'], repo_public: false } });
  assert.deepEqual(f.allowed, ['minimax', 'codex', 'sonnet', 'opus']);
  assert.equal(f.forced, null);
});
test('builder: floor drops minimax + codex when touches include infra/deploy/secrets/migrations', () => {
  for (const t of ['infra', 'deploy', 'secrets', 'migrations']) {
    const f = floor('builder', { work: { touches: [t], repo_public: false } });
    assert.deepEqual(f.allowed, ['sonnet', 'opus'], `touches=${t}`);
  }
});
test('builder: floor drops minimax + codex when repo_public AND touches include security', () => {
  const f = floor('builder', { work: { touches: ['security'], repo_public: true } });
  assert.deepEqual(f.allowed, ['sonnet', 'opus']);
});
test('builder: floor keeps minimax + codex when public repo but touches is not security', () => {
  const f = floor('builder', { work: { touches: ['app'], repo_public: true } });
  assert.deepEqual(f.allowed, ['minimax', 'codex', 'sonnet', 'opus']);
});
test('builder: floor forces opus when p0_product_decision', () => {
  const f = floor('builder', { work: { touches: ['app'], repo_public: false, p0_product_decision: true } });
  assert.equal(f.forced, 'opus');
  assert.ok(f.allowed.includes('opus'));
});
const SMALL = { files_est: 3, lines_est: 200 };
test('builder: ruleDefault is minimax only for a small specific change, else sonnet', () => {
  assert.equal(ruleDefault('builder', { work: { touches: ['app'], repo_public: false, ...SMALL } }), 'minimax');
  assert.equal(ruleDefault('builder', { work: { touches: ['app'], repo_public: false, ...SMALL, spec_clear: true } }), 'minimax');
  assert.equal(ruleDefault('builder', { work: { touches: ['secrets'], repo_public: false, ...SMALL } }), 'sonnet', 'infra floor wins');
  const no = (extra) => ruleDefault('builder', { work: { touches: ['app'], repo_public: false, ...SMALL, ...extra } });
  assert.equal(no({ files_est: 4 }), 'sonnet');
  assert.equal(no({ lines_est: 201 }), 'sonnet');
  assert.equal(no({ ui_wiring: true }), 'sonnet');
  assert.equal(no({ stateful: true }), 'sonnet');
  assert.equal(no({ spec_clear: false }), 'sonnet');
  assert.equal(ruleDefault('builder', { work: { touches: ['app'], repo_public: false } }), 'sonnet', 'no size estimate -> not known to be small');
});

// ---- reviewer ----
test('reviewer: floor keeps all four on a private repo with no auth touch', () => {
  const f = floor('reviewer', { work: { touches: ['app'], repo_public: false } });
  assert.deepEqual(f.allowed, ['none', 'haiku', 'sonnet', 'opus']);
});
test('reviewer: floor drops none + haiku when repo_public', () => {
  const f = floor('reviewer', { work: { touches: ['app'], repo_public: true } });
  assert.deepEqual(f.allowed, ['sonnet', 'opus']);
});
test('reviewer: floor drops none + haiku when touches include auth (even on a private repo)', () => {
  const f = floor('reviewer', { work: { touches: ['auth'], repo_public: false } });
  assert.deepEqual(f.allowed, ['sonnet', 'opus']);
});
test('reviewer: ruleDefault is sonnet', () => {
  assert.equal(ruleDefault('reviewer', { work: { touches: ['app'], repo_public: false } }), 'sonnet');
  assert.equal(ruleDefault('reviewer', { work: { touches: ['auth'], repo_public: true } }), 'sonnet');
});

// ---- retry ----
test('retry: floor keeps all three when reject.round < 2', () => {
  const f = floor('retry', { reject: { round: 1 } });
  assert.deepEqual(f.allowed, ['retry_same_with_notes', 'step_up_one', 'owner']);
});
test('retry: floor removes retry_same_with_notes when reject.round >= 2', () => {
  for (const r of [2, 3, 7]) {
    const f = floor('retry', { reject: { round: r } });
    assert.deepEqual(f.allowed, ['step_up_one', 'owner'], `round=${r}`);
  }
});
test('retry: ruleDefault is step_up_one', () => {
  assert.equal(ruleDefault('retry', { reject: { round: 1 } }), 'step_up_one');
  assert.equal(ruleDefault('retry', { reject: { round: 5 } }), 'step_up_one');
});

// ---- model ----
test('model: floor keeps all four options, never forces', () => {
  const f = floor('model', {});
  assert.deepEqual(f.allowed, ['keep', 'sonnet', 'opus', 'hold']);
  assert.equal(f.forced, null);
});
test('model: ruleDefault is keep', () => {
  assert.equal(ruleDefault('model', {}), 'keep');
});
test('model: appears in SUGGEST_ONLY', () => {
  assert.ok(SUGGEST_ONLY.has('model'));
});

// ---- stop ----
// facts shape: { session, agent, case, priority, forbidden_topic, closing_text (<= 1500 chars), proposed_reply }
test('stop: floor keeps both options and does not force on a plain owner_decision', () => {
  const f = floor('stop', { session: 's1', agent: 'claude', case: 'owner_decision' });
  assert.deepEqual(f.allowed, ['answer', 'escalate']);
  assert.equal(f.forced, null);
});
test('stop: forbidden_topic forces escalate regardless of case', () => {
  for (const c of ['continue', 'done', 'owner_decision', 'stopped_short', 'menu_recommended', 'permission']) {
    const f = floor('stop', { case: c, forbidden_topic: true });
    assert.equal(f.forced, 'escalate', `forbidden_topic + case=${c}`);
    assert.ok(f.allowed.includes('escalate'));
  }
});
test('stop: case=permission forces escalate', () => {
  const f = floor('stop', { case: 'permission' });
  assert.equal(f.forced, 'escalate');
  assert.match(f.reasons.join(' '), /permission/);
});
test('stop: case=owner_action forces escalate', () => {
  const f = floor('stop', { case: 'owner_action' });
  assert.equal(f.forced, 'escalate');
  assert.match(f.reasons.join(' '), /owner_action/);
});
test('stop: case=waiting_deploy forces escalate', () => {
  const f = floor('stop', { case: 'waiting_deploy' });
  assert.equal(f.forced, 'escalate');
  assert.match(f.reasons.join(' '), /waiting_deploy/);
});
test('stop: case=continue does NOT force; ruleDefault is answer', () => {
  const f = floor('stop', { case: 'continue' });
  assert.equal(f.forced, null);
  assert.equal(ruleDefault('stop', { case: 'continue' }), 'answer');
});
test('stop: ruleDefault is escalate for anything that is not continue (conservative)', () => {
  for (const c of ['done', 'owner_decision', 'menu_recommended', 'stopped_short', 'error', 'background_wait', 'unknown', undefined]) {
    const facts = c ? { case: c } : {};
    assert.equal(ruleDefault('stop', facts), 'escalate', `case=${c}`);
  }
});
test('stop: forbidden_topic forces escalate even when case=continue (ruleDefault is just a fallback, the floor wins)', () => {
  const f = floor('stop', { case: 'continue', forbidden_topic: true });
  assert.equal(f.forced, 'escalate');
  // ruleDefault is intentionally a pure function of `case` (per spec): forbidden_topic only moves the floor.
  assert.equal(ruleDefault('stop', { case: 'continue', forbidden_topic: true }), 'answer');
  // But the end-to-end pick collapses to the forced escalate.
  const out = pick('stop', { case: 'continue', forbidden_topic: true },
    { success: true, answers: { choice: { choice: 'answer', confidence: 0.99 } } });
  assert.equal(out.choice, 'escalate');
  assert.equal(out.source, 'forced');
});
test('stop: pick collapses to forced escalate when forbidden_topic', () => {
  const out = pick('stop', { case: 'continue', forbidden_topic: true },
    { success: true, answers: { choice: { choice: 'answer', confidence: 0.99 } } });
  assert.equal(out.choice, 'escalate');
  assert.equal(out.source, 'forced');
  assert.equal(out.confidence, 1);
});
test('stop: pick takes Jev answer when confidence >= threshold and choice is allowed', () => {
  const out = pick('stop', { case: 'owner_decision' },
    { success: true, answers: { choice: { choice: 'answer', confidence: 0.95 } } });
  assert.equal(out.choice, 'answer');
  assert.equal(out.source, 'jev');
});
test('stop: pick falls back to rule default (escalate) when Jev says nothing useful', () => {
  const out = pick('stop', { case: 'owner_decision' }, null);
  assert.equal(out.choice, 'escalate');
  assert.equal(out.source, 'rule');
});
test('stop: buildRequest uses text.decision.manager and stops choices inside allowed', () => {
  const body = buildRequest('stop', { case: 'owner_decision' }, { teamId: 't' });
  assert.equal(body.usage, 'text.decision.manager');
  assert.deepEqual(Object.keys(body.questions.choice.criteria).sort(), ['answer', 'escalate']);
});
test('stop: buildRequest returns null when the floor forces escalate (permission case)', () => {
  const body = buildRequest('stop', { case: 'permission' }, { teamId: 't' });
  assert.equal(body, null);
});

// ---- POINTS shape ----
test('POINTS: each entry has usage, options, instructions, ruleDefault, floor', () => {
  for (const [name, def] of Object.entries(POINTS)) {
    assert.equal(typeof def.usage, 'string', `${name}.usage`);
    assert.equal(typeof def.options, 'object', `${name}.options`);
    for (const [id, crit] of Object.entries(def.options)) {
      assert.equal(typeof crit, 'string', `${name}.options.${id}`);
      assert.ok(crit.length > 0, `${name}.options.${id} is empty`);
    }
    assert.equal(typeof def.instructions, 'string', `${name}.instructions`);
    assert.equal(typeof def.ruleDefault, 'function', `${name}.ruleDefault`);
    assert.equal(typeof def.floor, 'function', `${name}.floor`);
  }
});

// ---- buildRequest ----
test('buildRequest: shape, log, profile, timeout, team_id, refs.source, refs.point, state, questions.choice.criteria are allowed-only', () => {
  const facts = { work: { touches: ['app'], repo_public: false, ...SMALL } };
  const body = buildRequest('builder', facts, { teamId: 'team-x', refs: { session: 's1' } });
  assert.equal(body.usage, 'text.decision.route');
  assert.equal(body.profile, 'jev');
  assert.equal(body.log, true);
  assert.equal(body.timeout_s, 20);
  assert.equal(body.team_id, 'team-x');
  assert.equal(body.refs.source, 'ghosty-router');
  assert.equal(body.refs.point, 'builder');
  assert.equal(body.refs.session, 's1');
  assert.equal(body.refs.rule_default, 'minimax');
  assert.deepEqual(body.refs.floor, []);
  assert.deepEqual(JSON.parse(body.state), facts);
  assert.deepEqual(Object.keys(body.questions.choice.criteria).sort(), ['codex', 'minimax', 'opus', 'sonnet']);
});
test('buildRequest: criteria only lists allowed options (secret-touch case)', () => {
  const body = buildRequest('builder', { work: { touches: ['secrets'], repo_public: false } }, { teamId: 't' });
  assert.deepEqual(Object.keys(body.questions.choice.criteria).sort(), ['opus', 'sonnet']);
});
test('buildRequest: returns null when the floor forces a pick (P0 product decision -> opus)', () => {
  const body = buildRequest('builder', { work: { touches: ['app'], p0_product_decision: true } }, { teamId: 't' });
  assert.equal(body, null);
});
test('buildRequest: floor reasons ride on refs.floor', () => {
  const body = buildRequest('wake', { event: { kind: 'stall', p0_blocked: true }, disk_pct: 40, quota: { claude: 30 } }, { teamId: 't' });
  assert.match(body.refs.floor.join(' '), /p0 blocked/);
});
test('buildRequest: rule_default on refs is the clamped rule default', () => {
  // builder touches=secrets: minimax not allowed -> rule_default clamped to sonnet
  const body = buildRequest('builder', { work: { touches: ['secrets'], repo_public: false } }, { teamId: 't' });
  assert.equal(body.refs.rule_default, 'sonnet');
});

// ---- pick ----
test('pick: returns source=forced when the floor forced a pick', () => {
  const out = pick('builder', { work: { touches: ['app'], p0_product_decision: true } }, { success: true, answers: { choice: { choice: 'minimax', confidence: 0.9 } } });
  assert.equal(out.choice, 'opus');
  assert.equal(out.source, 'forced');
  assert.equal(out.confidence, 1);
});
test('pick: uses the Jev reply when success, choice is allowed, and confidence >= threshold', () => {
  const out = pick('builder', { work: { touches: ['app'], repo_public: false } },
    { success: true, answers: { choice: { choice: 'sonnet', confidence: 0.9 } } });
  assert.equal(out.choice, 'sonnet');
  assert.equal(out.source, 'jev');
});
test('pick: falls back to rule default when jevJson is null', () => {
  const out = pick('builder', { work: { touches: ['app'], repo_public: false, ...SMALL } }, null);
  assert.equal(out.choice, 'minimax');
  assert.equal(out.source, 'rule');
});
test('pick: falls back to rule default when success=false', () => {
  const out = pick('builder', { work: { touches: ['app'], repo_public: false, ...SMALL } },
    { success: false, answers: { choice: { choice: 'sonnet', confidence: 0.99 } } });
  assert.equal(out.source, 'rule');
  assert.equal(out.choice, 'minimax');
});
test('pick: falls back to rule default when confidence < threshold', () => {
  const out = pick('builder', { work: { touches: ['app'], repo_public: false, ...SMALL } },
    { success: true, answers: { choice: { choice: 'sonnet', confidence: 0.5 } } }, { threshold: 0.7 });
  assert.equal(out.source, 'rule');
  assert.equal(out.choice, 'minimax');
});
test('pick: falls back to rule default when the choice is not in allowed', () => {
  // Jev is told only minimax/codex/sonnet/opus are allowed; if it answers minimax but the floor dropped minimax, we fall back.
  const out = pick('builder', { work: { touches: ['secrets'], repo_public: false } },
    { success: true, answers: { choice: { choice: 'minimax', confidence: 0.95 } } });
  assert.equal(out.source, 'rule');
  assert.equal(out.choice, 'sonnet');
});
test('pick: choice and ruleDefault are always exposed on the result', () => {
  const out = pick('wake', { event: { kind: 'stall' }, disk_pct: 30, quota: { claude: 30 } }, null);
  assert.equal(typeof out.ruleDefault, 'string');
  assert.ok(Array.isArray(out.allowed));
});

// ---- decide ----
test('decide: never throws when post rejects; returns the rule default', async () => {
  const out = await decide('builder', { work: { touches: ['app'], repo_public: false, ...SMALL } }, {
    post: async () => { throw new Error('boom'); },
    teamId: 't',
  });
  assert.equal(out.choice, 'minimax');
  assert.equal(out.source, 'rule');
});
test('decide: never throws when post returns null; returns the rule default', async () => {
  const out = await decide('builder', { work: { touches: ['app'], repo_public: false, ...SMALL } }, {
    post: async () => null,
    teamId: 't',
  });
  assert.equal(out.choice, 'minimax');
  assert.equal(out.source, 'rule');
});
test('decide: uses the Jev reply when post returns a good one', async () => {
  const seen = [];
  const out = await decide('builder', { work: { touches: ['app'], repo_public: false, ...SMALL } }, {
    post: async (body) => { seen.push(body); return { success: true, decision_id: 'd-1', answers: { choice: { choice: 'sonnet', confidence: 0.95 } } }; },
    teamId: 'team-z',
    refs: { session: 's1' },
  });
  assert.equal(out.choice, 'sonnet');
  assert.equal(out.source, 'jev');
  assert.equal(out.decision_id, 'd-1');
  assert.equal(seen[0].refs.session, 's1');
  assert.equal(seen[0].team_id, 'team-z');
});
test('decide: returns source=forced (no post call) when the floor forces a pick', async () => {
  let called = 0;
  const out = await decide('builder', { work: { touches: ['app'], p0_product_decision: true } }, {
    post: async () => { called++; return { success: true, answers: { choice: { choice: 'minimax', confidence: 0.99 } } }; },
    teamId: 't',
  });
  assert.equal(out.source, 'forced');
  assert.equal(out.choice, 'opus');
  assert.equal(called, 0);
});
test('decide: when post is missing, returns the rule default (no throw)', async () => {
  const out = await decide('builder', { work: { touches: ['app'], repo_public: false, ...SMALL } }, { teamId: 't' });
  assert.equal(out.source, 'rule');
  assert.equal(out.choice, 'minimax');
});
test('decide: threshold is honored end-to-end', async () => {
  const out = await decide('builder', { work: { touches: ['app'], repo_public: false, ...SMALL } }, {
    post: async () => ({ success: true, answers: { choice: { choice: 'sonnet', confidence: 0.5 } } }),
    threshold: 0.9,
  });
  assert.equal(out.source, 'rule');
  assert.equal(out.choice, 'minimax');
});

// ---- fixtures smoke test (10 per point across all points) ----
test('fixtures: every entry agrees with ruleDefault + floor against the expected option', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const url = await import('node:url');
  const file = url.fileURLToPath(new URL('./fixtures/router-states.json', import.meta.url));
  const states = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(states.length, Object.keys(POINTS).length * 10, `expected ${Object.keys(POINTS).length * 10} fixture states (10 per point)`);
  const counts = {};
  for (const s of states) {
    counts[s.point] = (counts[s.point] || 0) + 1;
    assert.ok(POINTS[s.point], `fixture uses unknown point: ${s.point}`);
    assert.ok(POINTS[s.point].options[s.expect], `fixture ${s.point}/${s.label} expects option "${s.expect}" that does not exist`);
    const f = floor(s.point, s.facts);
    if (f.forced) {
      assert.equal(f.forced, s.expect, `fixture ${s.point}/${s.label}: floor forced "${f.forced}", expected "${s.expect}"`);
    } else {
      assert.ok(f.allowed.includes(s.expect), `fixture ${s.point}/${s.label}: expected "${s.expect}" not in allowed ${JSON.stringify(f.allowed)}`);
      // Jev would be told only the allowed set; rule default must agree with the fixture's expectation OR
      // the fixture picks a different in-allowed option (rule default is just a fallback when Jev says nothing).
      const rd = ruleDefault(s.point, s.facts);
      assert.ok(f.allowed.includes(rd), `fixture ${s.point}/${s.label}: rule default "${rd}" not in allowed`);
    }
  }
  for (const p of Object.keys(POINTS)) assert.equal(counts[p], 10, `point "${p}" should have 10 fixture states, has ${counts[p] || 0}`);
});