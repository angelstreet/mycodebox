import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, TERMINAL, TRANSITIONS, SCHEMA_VERSION, MANDATORY_APPROVAL, canTransition, assertTransition, outcomeOf,
  validateTask, normalizeTask, narrowsParent, failureSignature, validateDecision, normalizeDecision,
} from '../orchestration/task-contract.js';
import { EVENT_KINDS, makeEvent, validateEvent } from '../orchestration/events.js';
import { spec, clock } from './fixtures/v2-task.js';

test('every transition outside the table throws E_ILLEGAL_TRANSITION; every listed one passes', () => {
  let illegal = 0;
  for (const from of STATES) {
    for (const to of STATES) {
      if (TRANSITIONS[from].includes(to)) { assert.equal(canTransition(from, to), true); assertTransition(from, to); continue; }
      illegal++;
      assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
      assert.throws(() => assertTransition(from, to), (e) => e.code === 'E_ILLEGAL_TRANSITION', `${from} -> ${to}`);
    }
  }
  assert.ok(illegal > 150);
  assert.throws(() => assertTransition('created', 'nonsense'), { code: 'E_ILLEGAL_TRANSITION' });
  assert.throws(() => assertTransition('bogus', 'created'), { code: 'E_ILLEGAL_TRANSITION' });
});

test('terminal states have no exits; cancelled is reachable from every non-terminal state', () => {
  for (const s of TERMINAL) assert.deepEqual(TRANSITIONS[s], []);
  for (const s of STATES.filter((x) => !TERMINAL.includes(x))) assert.ok(canTransition(s, 'cancelled'), s);
  // Spot checks against ARCHITECTURE §1.
  assert.ok(canTransition('evaluating', 'accepted'));
  assert.ok(!canTransition('executing', 'accepted'));
  assert.ok(!canTransition('created', 'executing'));
  assert.ok(canTransition('executing', 'unknown_external_effect'));
  assert.ok(!canTransition('evaluating', 'unknown_external_effect'));
});

test('outcomeOf derives the user-facing outcome', () => {
  assert.equal(outcomeOf('accepted'), 'done');
  assert.equal(outcomeOf('waiting'), 'waiting');
  assert.equal(outcomeOf('awaiting_approval'), 'needs_owner');
  assert.equal(outcomeOf('failed_unrecoverable'), 'unrecoverable');
  assert.equal(outcomeOf('cancelled'), 'cancelled');
  for (const s of ['created', 'clarified', 'planned', 'ready', 'executing', 'evaluating', 'repair', 'replan', 'integrating',
    'release_verifying', 'unknown_external_effect']) assert.equal(outcomeOf(s), 'not_yet_done', s);
  assert.throws(() => outcomeOf('completed'), { code: 'E_INVALID' });
});

test('normalizeTask fills documented defaults and never invents caps, deadlines or allowlists', () => {
  const { now, randomId } = clock();
  const t = normalizeTask(spec(), { now, randomId });
  assert.match(t.task_id, /^task-(c\d+-)?id0001$/);
  assert.equal(t.status, 'created');
  assert.equal(t.schema_version, SCHEMA_VERSION);
  assert.deepEqual(t.budget_policy, { mode: 'track' });
  assert.equal(t.priority, 'balanced');
  assert.equal(t.retry_strategy, 'evidence');
  assert.deepEqual(t.no_progress_policy, { same_signature: 3, strategy_changes_without_progress: 3 });
  assert.deepEqual(t.approval_policy.requires, [...MANDATORY_APPROVAL]);
  assert.equal(t.runtime_allowlist, null);
  assert.equal(t.model_allowlist, null);
  for (const k of ['deadline', 'max_usd', 'max_input_tokens', 'max_output_tokens', 'max_duration_ms']) assert.equal(k in t, false, k);
  assert.equal('max_usd' in t.budget_policy, false);
  assert.deepEqual(validateTask(t), { ok: true, errors: [] });
  // Input is not mutated; explicit values are kept; extra approval classes are kept and mandatory ones restored.
  const s = spec({ priority: 'quality', approval_policy: { requires: ['docs_publish'] } });
  const t2 = normalizeTask(s, { now, randomId });
  assert.equal(t2.priority, 'quality');
  assert.deepEqual(s.approval_policy.requires, ['docs_publish']);
  assert.ok(t2.approval_policy.requires.includes('docs_publish'));
  for (const c of MANDATORY_APPROVAL) assert.ok(t2.approval_policy.requires.includes(c));
});

test('validateTask rejects missing required fields, unknown fields and weakened approvals', () => {
  const { now, randomId } = clock();
  const ok = normalizeTask(spec(), { now, randomId });
  const errs = (t) => validateTask(t).errors.map((e) => e.path);
  for (const k of ['goal', 'scope', 'prohibited_actions', 'definition_of_done', 'acceptance_checks', 'risk_class',
    'runtime_capabilities', 'privacy_policy', 'resources', 'dependencies', 'base_sha', 'approval_policy', 'created_by']) {
    const t = structuredClone(ok); delete t[k];
    assert.ok(errs(t).includes(k), k);
  }
  assert.ok(errs({ ...ok, aproval_policy: {} }).includes('aproval_policy'));
  assert.ok(errs({ ...ok, approval_policy: { requires: ['deploy'] } }).includes('approval_policy.requires'));
  assert.ok(errs({ ...ok, risk_class: 'tiny' }).includes('risk_class'));
  assert.ok(errs({ ...ok, base_sha: 'HEAD' }).includes('base_sha'));
  assert.ok(errs({ ...ok, status: 'completed' }).includes('status'));
  assert.ok(errs({ ...ok, created_by: { kind: 'robot', id: 'x' } }).includes('created_by'));
  assert.ok(errs({ ...ok, acceptance_checks: [{ ...ok.acceptance_checks[0], command: 'npm test' }] }).includes('acceptance_checks[0].command'));
  assert.ok(errs({ ...ok, acceptance_checks: [{ ...ok.acceptance_checks[0], required: false }] }).includes('acceptance_checks'));
  assert.ok(errs({ ...ok, budget_policy: { mode: 'cap' } }).includes('budget_policy'));
  assert.ok(errs({ ...ok, budget_policy: { mode: 'track', max_usd: 0 } }).includes('budget_policy.max_usd'));
  assert.deepEqual(validateTask(null).ok, false);
});

test('GL01: tasks from ui, api, schedule and agent get the same contract', () => {
  const { now, randomId } = clock();
  const shapes = ['ui', 'api', 'schedule', 'agent'].map((kind) => {
    const t = normalizeTask(spec({ created_by: { kind, id: `${kind}-1` } }), { now, randomId });
    assert.equal(validateTask(t).ok, true, kind);
    const { task_id, created_by, created_at, updated_at, ...rest } = t;
    return rest;
  });
  for (const s of shapes.slice(1)) assert.deepEqual(s, shapes[0]);
});

test('narrowsParent accepts narrowing and rejects every kind of weakening', () => {
  const { now, randomId } = clock();
  const parent = normalizeTask(spec({ runtime_allowlist: ['claude', 'codex'], excluded_paths: ['secrets'], risk_class: 'medium',
    budget_policy: { mode: 'cap', max_usd: 5 }, deadline: '2026-02-01T00:00:00Z', repository: 'fixture-repo',
    approval_policy: { requires: ['docs_publish'] } }), { now, randomId });
  const child = (over) => ({ ...structuredClone(parent), ...over });
  assert.deepEqual(narrowsParent(parent, child({ runtime_allowlist: ['claude'], risk_class: 'high',
    budget_policy: { mode: 'cap', max_usd: 2 }, prohibited_actions: [...parent.prohibited_actions, 'push_shared'],
    deadline: '2026-01-15T00:00:00Z' })), { ok: true, violations: [] });
  const bad = (over, field) => {
    const r = narrowsParent(parent, child(over));
    assert.equal(r.ok, false, field);
    assert.ok(r.violations.some((v) => v.field.startsWith(field)), `${field}: ${JSON.stringify(r.violations)}`);
  };
  bad({ runtime_allowlist: ['claude', 'opencode'] }, 'runtime_allowlist');
  bad({ runtime_allowlist: null }, 'runtime_allowlist');
  bad({ prohibited_actions: [] }, 'prohibited_actions');
  bad({ excluded_paths: [] }, 'excluded_paths');
  bad({ approval_policy: { requires: [...MANDATORY_APPROVAL] } }, 'approval_policy.requires');
  bad({ budget_policy: { mode: 'cap', max_usd: 6 } }, 'budget.max_usd');
  bad({ budget_policy: { mode: 'track' } }, 'budget.max_usd');
  bad({ risk_class: 'low' }, 'risk_class');
  bad({ deadline: '2026-03-01T00:00:00Z' }, 'deadline');
  bad({ deadline: undefined }, 'deadline');
  bad({ repository: 'other-repo' }, 'repository');
  bad({ privacy_policy: 'public' }, 'privacy_policy');
  // A parent deferring to project policy (null allowlist) lets a child pick any list.
  assert.equal(narrowsParent({ ...parent, runtime_allowlist: null }, child({ runtime_allowlist: ['fake'] })).ok, true);
});

test('failureSignature ignores ANSI, durations, hex ids, line:col and temp paths', () => {
  const a = failureSignature({ test: '\x1b[31m✖ store recovers torn tail (12.5ms)\x1b[0m', errorClass: 'AssertionError at /tmp/v2-abc123/store.test.js:41:7' });
  const b = failureSignature({ test: '✖ store recovers torn tail (3ms)', errorClass: 'AssertionError at /tmp/v2-zz9/store.test.js:88:12' });
  assert.equal(a, b);
  const c = failureSignature({ test: 'run deadbeef42 failed after 2.5 s', errorClass: 'Error 0x7ffe12 id 3f2a9c1e-1d2b-4c3d-9e8f-0a1b2c3d4e5f' });
  const d = failureSignature({ test: 'run 9c8b7a6f51 failed after 30 s', errorClass: 'Error 0x1 id 00000000-1111-2222-3333-444444444444' });
  assert.equal(c, d);
  assert.notEqual(a, failureSignature({ test: 'store recovers torn tail', errorClass: 'TypeError' }));
  assert.notEqual(a, failureSignature({ test: 'another test', errorClass: 'AssertionError' }));
  assert.match(failureSignature({}), /<unknown test> :: <unknown error>/);
});

test('events: makeEvent fills the envelope, validateEvent rejects bad kinds and fields', () => {
  const { now, randomId } = clock();
  const e = makeEvent({ task_id: 't1', kind: 'task.started', payload: { x: 1 } }, { now, randomId });
  assert.deepEqual(Object.keys(e).sort(), ['attempt_id', 'causation_id', 'event_id', 'kind', 'model', 'payload', 'provider',
    'run_id', 'runtime', 'schema_version', 'seq', 'task_id', 'timestamp'].sort());
  assert.match(e.event_id, /^evt-(c\d+-)?id0001$/);
  assert.equal(validateEvent(e).ok, true);
  assert.equal(validateEvent(e, { requireSeq: true }).ok, false);
  assert.equal(validateEvent({ ...e, seq: 1 }, { requireSeq: true }).ok, true);
  assert.equal(validateEvent({ ...e, kind: 'task.exploded' }).ok, false);
  assert.equal(validateEvent({ ...e, extra: 1 }).ok, false);
  assert.equal(validateEvent({ ...e, seq: 0 }).ok, false);
  assert.throws(() => makeEvent({ task_id: 't', kind: 'task.started', bogus: 1 }), { code: 'E_INVALID_EVENT' });
  for (const k of ['task.created', 'action.attempted', 'action.confirmed', 'action.unknown', 'usage.recorded']) assert.ok(EVENT_KINDS.includes(k));
});

test('decision records follow §9', () => {
  const { now, randomId } = clock();
  const d = normalizeDecision({ kind: 'route', question: 'which runtime?', alternatives: [{ option: 'fake', pros: ['cheap'], cons: [] }],
    chosen: 'fake', expected_effect: 'test passes', rationale: 'deterministic', actor: { role: 'manager', runtime: null, model: null },
    reversible: true, rollback: 'route to another runtime' }, { task_id: 't1', now, randomId });
  assert.deepEqual(validateDecision(d), { ok: true, errors: [] });
  assert.equal(d.confidence, null);
  const bad = (over, path) => assert.ok(validateDecision({ ...d, ...over }).errors.some((e) => e.path.startsWith(path)), path);
  bad({ alternatives: [] }, 'alternatives');
  bad({ confidence: 1.5 }, 'confidence');
  bad({ reversible: 'yes' }, 'reversible');
  bad({ rollback: null }, 'rollback');
  bad({ actor: { runtime: 'x' } }, 'actor.role');
});
