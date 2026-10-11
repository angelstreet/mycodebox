// Re-verification of v2/04-routing after the F1-F14 fixes. Passing tests pin adversarial variants of the fixed
// findings; `{ todo: 'defect: ...' }` tests document what is still open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry } from '../orchestration/model-registry.js';
import { route, fallbackPlan } from '../orchestration/router.js';
import { check } from '../orchestration/budget.js';

const NOW = Date.parse('2026-10-11T00:00:00Z');
const now = () => NOW;
const reg = () => loadRegistry({ now });
const task = (o = {}) => ({ task_id: 't-v2', goal: 'add a retry helper function', risk_class: 'low', scope: ['lib/a.js'], ...o });
const R = (t, o = {}) => route(t, { registry: reg(), now, ...o });
const ids = (r) => r.candidates.map((c) => c.id);
const notAuto = (r) => r.auto_allowed === false && r.requires_approval === true;
const lax = () => ({ allow: true, needs_approval: false });

// ---------- variants of fixed findings (pass) ----------

test('verify2: risk variants (whitespace/case, non-string) never auto-route; critical variants deny', () => {
  assert.equal(R(task({ risk_class: '\tCritical\n' })).choice, null);
  for (const rc of [4, ['critical'], {}, '']) assert.ok(notAuto(R(task({ risk_class: rc }), { checkAction: lax })), JSON.stringify(rc));
});

test('verify2: forbidden text in object goal, title or definition_of_done denies, even with a lax checker', () => {
  for (const t of [task({ goal: { text: 'deploy to production' } }), task({ title: 'rotate the api key' }), task({ definition_of_done: ['pushed to main'] })]) {
    const r = R(t, { checkAction: lax });
    assert.equal(r.choice, null); assert.ok(notAuto(r));
  }
});

test('verify2: checker must return allow === true (1, "yes", old 2-arg shape all deny)', () => {
  assert.equal(R(task(), { checkAction: () => ({ allow: 1 }) }).choice, null);
  assert.equal(R(task(), { checkAction: () => ({ allow: 'yes' }) }).choice, null);
  // a pre-freeze (task, action) checker sees policy=null as its first arg and must not silently allow
  assert.equal(R(task(), { checkAction: (t) => (t && t.risk_class ? { allow: true } : { allow: false, reason: 'x' }) }).choice, null);
});

test('verify2: allowlist variants fail closed; unmapped or prototype privacy classes are unroutable', () => {
  assert.deepEqual(ids(R(task({ runtime_allowlist: [1, 2] }))), []);
  assert.deepEqual(ids(R(task({ runtime_allowlist: '' }))), []);
  assert.deepEqual(ids(R(task({ runtime_allowlist: {} }))), []);
  assert.ok(ids(R(task({ runtime_allowlist: [1, 'claude'] }))).every((i) => i.startsWith('claude:')));
  assert.deepEqual(ids(R(task({ privacy_class: '' }))), []);
  assert.deepEqual(ids(R(task({ privacy_class: '__proto__' }), { policy: { privacy_class_providers: {} } })), []);
  assert.deepEqual(ids(R(task({ privacy_class: 'p' }), { policy: { privacy_class_providers: { p: true } } })), []);
});

test('verify2: working-directory floor resists .. and sibling-prefix escapes; denied without roots', () => {
  const pol = { policy: { allowed_roots: ['/srv/w'] } };
  assert.equal(R(task({ cwd: '/srv/w/../etc' }), pol).choice, null);
  assert.equal(R(task({ worktree_path: '/srv/w2/x' }), pol).choice, null);
  assert.equal(R(task({ cwd: '/srv/w/x' })).choice, null);
  assert.ok(R(task({ cwd: '/srv/w/x' }), pol).choice);
});

test('verify2: error-class variants: unrecognised spellings go to approval, never switch', () => {
  const r = R(task());
  for (const ec of ['rate-limit', '429', 'unknown_error', '', null, 42, 'authorization', 'Secret_missing']) {
    const p = fallbackPlan(r, { error_class: ec, attempt: 3 });
    assert.equal(p.action, 'approval', String(ec)); assert.equal(p.next, null);
  }
  assert.equal(fallbackPlan(r, { error_class: ' RATE_LIMIT ', attempt: 3 }).action, 'switch');
});

test('verify2: budget variants: string estimate/ledger amounts and non-object policy stop under a cap', () => {
  assert.equal(check({ budget_policy: { max_usd: 5 } }, { entries: [{ usd: 1 }] }, { usd: '1' }).allow, false);
  assert.equal(check({ budget_policy: { max_usd: 5 } }, { entries: [{ usd: '1' }] }, { usd: 1 }).allow, false);
  assert.equal(check({ budget_policy: 'track' }, { entries: [] }, { usd: 1 }).allow, false);
  assert.equal(check({}, null, {}).allow, true);   // track mode never stops, even without a ledger
});

// ---------- still open (todo) ----------

test('defect: corrupt history (verified > attempts, negative errors) must not drive ranking', { todo: 'defect: metrics() trusts history counts; verified:500/attempts:5 gives quality 71.6 and errors:-50 reliability 8, so a fabricated record wins (T22)' }, () => {
  const history = { 'minimax:MiniMax-M3': { attempts: 5, verified: 500, errors: -50, total_usd: 1 } };
  const r = R(task(), { history });
  const c = r.candidates.find((x) => x.id === 'minimax:MiniMax-M3');
  assert.ok(c.quality <= 1 && c.reliability <= 1);
  assert.equal(c.history, false);
});

test('defect: a per-attempt cap with a missing/malformed ledger is unknown spend', { todo: 'defect: F8 fixed for whole-task caps only; per_attempt caps with ledger null or entries:"x" still allow' }, () => {
  for (const l of [null, { entries: 'x' }]) assert.equal(check({ budget_policy: { per_attempt: { max_usd: 2 } } }, l, { usd: 1, attempt_id: 'a1' }).allow, false);
});

test('defect: a malformed privacy_policy must not widen to every provider', { todo: 'defect: privacy_policy that is not an object (e.g. a string) is ignored, so every provider stays eligible' }, () => {
  assert.deepEqual(ids(R(task({ privacy_policy: 'anthropic-only' }))), []);
});

test('defect: retry_after_ms is bounded (no negative or unbounded delay)', { todo: 'defect: fallbackPlan passes retry_after_ms through unclamped: -1 retries immediately, 1e13 waits ~300 years' }, () => {
  const r = R(task());
  const d1 = fallbackPlan(r, { error_class: 'rate_limit', attempt: 0, retry_after_ms: -1 }).delay_ms;
  const d2 = fallbackPlan(r, { error_class: 'rate_limit', attempt: 0, retry_after_ms: 1e13 }).delay_ms;
  assert.ok(d1 > 0 && d2 <= 900000);
});
