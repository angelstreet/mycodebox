// Independent verification of v2/04-routing (router, registry, budget, wake ruleDefault). Passing tests pin behaviour
// the author's suite did not cover; `{ todo: 'defect: ...' }` tests document gaps found by the verifier (they fail
// today and are reported, not hidden).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRegistry, loadRegistry } from '../orchestration/model-registry.js';
import { route, fallbackPlan } from '../orchestration/router.js';
import { check } from '../orchestration/budget.js';
import { floor, ruleDefault } from '../router.js';

const NOW = Date.parse('2026-10-11T00:00:00Z');
const now = () => NOW;
const reg = () => loadRegistry({ now });
const task = (o = {}) => ({ task_id: 't-v', goal: 'add a retry helper function', risk_class: 'low', scope: ['lib/a.js'], ...o });
const R = (t, o = {}) => route(t, { registry: reg(), now, ...o });
const ids = (r) => r.candidates.map((c) => c.id);
const notAuto = (r) => r.auto_allowed === false && r.requires_approval === true;

// ---------- hard floors: covered behaviour ----------

test('verify: an async (Promise-returning) checker fails closed', () => {
  const r = R(task(), { checkAction: async () => ({ allow: true, needs_approval: false }) });
  assert.equal(r.choice, null); assert.ok(notAuto(r));
});

test('verify: fallback never leaves the floored candidate set, for every error class and attempt', () => {
  const t = task({ runtime_allowlist: ['claude', 'codex'], required_capabilities: ['tools'] });
  const r = R(t);
  const ok = new Set(ids(r));
  for (const ec of ['rate_limit', 'timeout', 'context_overflow', 'unavailable', 'crash', 'weird', undefined]) {
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const failed of [r.choice, ...ids(r)]) {
        const p = fallbackPlan(r, { error_class: ec, attempt, failed });
        if (p.next != null) assert.ok(ok.has(p.next), `${ec}/${attempt}/${failed} -> ${p.next}`);
        assert.equal(p.requires_approval, r.requires_approval);
      }
    }
  }
});

test('verify: approval requirement survives every fallback action', () => {
  const r = R(task(), { checkAction: () => ({ allow: true, needs_approval: true, reason: 'x' }) });
  for (const ec of ['rate_limit', 'timeout', 'context_overflow', 'unavailable', 'crash']) {
    for (let attempt = 0; attempt < 4; attempt++) assert.equal(fallbackPlan(r, { error_class: ec, attempt }).requires_approval, true);
  }
});

test('verify: an injected floor list never re-admits a rejected candidate through history or weights', () => {
  const history = { 'minimax:MiniMax-M3': { attempts: 100, verified: 100, errors: 0, total_usd: 0.01, latency_ms: 1 } };
  const r = R(task({ runtime_allowlist: ['claude'] }), { history, weights: { quality: 1, cost: 1, latency: 1, reliability: 1 } });
  assert.ok(ids(r).every((i) => i.startsWith('claude:')));
});

// ---------- wake ruleDefault (root router.js) ----------

test('verify: wake ruleDefault agrees with every wake fixture and never needs the first-allowed clamp', () => {
  const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/router-states.json', import.meta.url)), 'utf8'));
  const wake = fx.filter((s) => s.point === 'wake');
  assert.equal(wake.length, 10);
  for (const s of wake) {
    assert.equal(ruleDefault('wake', s.facts), s.expect, s.label);
    assert.ok(floor('wake', s.facts).allowed.includes(ruleDefault('wake', s.facts)), s.label);
  }
});

test('verify: a forbidden-topic wake default is never ignore/rules_handle, in any hot/cold combination', () => {
  for (const disk_pct of [10, 97]) for (const p0_blocked of [false, true]) for (const escalated of [false, true]) {
    const rd = ruleDefault('wake', { event: { kind: 'stall', forbidden_topic: true, p0_blocked, escalated }, disk_pct, quota: {} });
    assert.ok(['wake_cheap', 'wake_opus'].includes(rd), `${disk_pct}/${p0_blocked}/${escalated} -> ${rd}`);
  }
});

// ---------- defects (todo) ----------

test('defect: unknown/mis-cased/missing risk_class must not yield an automatic route', { todo: 'defect: risk_class outside the enum (CRITICAL, "critical ", missing, non-object task) is auto_allowed with no approval; critical denial is bypassed by case' }, () => {
  for (const t of [task({ risk_class: 'CRITICAL' }), task({ risk_class: 'critical ' }), task({ risk_class: undefined }), null, 'deploy to production']) {
    assert.ok(notAuto(R(t)), JSON.stringify(t));
  }
});

test('defect: forbidden topic in a non-string goal must still deny', { todo: 'defect: taskText drops non-string goal/title/description, so goal:["deploy to production"] bypasses the forbidden-topic floor' }, () => {
  assert.equal(R(task({ goal: ['deploy to production'] })).choice, null);
});

test('defect: empty or malformed allowlists must fail closed, not mean "unrestricted"', { todo: 'defect: list() turns [] / a string / an unmapped privacy_class into null = no restriction' }, () => {
  const only = (r) => ids(r);
  assert.deepEqual(only(R(task({ model_allowlist: [] }))), []);
  assert.deepEqual(only(R(task(), { policy: { provider_allowlist: [] } })), []);
  assert.ok(only(R(task({ runtime_allowlist: 'minimax' }))).every((i) => i.startsWith('minimax:')));
  assert.ok(only(R(task({ model_allowlist: 'MiniMax-M3' }))).every((i) => i === 'minimax:MiniMax-M3'));
  assert.deepEqual(only(R(task({ privacy_policy: { allowed_providers: [] } }))), []);
  // privacy class the policy does not map: unknown privacy must not widen to every provider
  const r = R(task({ privacy_class: 'secret' }), { policy: { privacy_class_providers: { private: ['anthropic'] } } });
  assert.ok(notAuto(r) || only(r).length === 0);
});

test('defect: forbidden-topic and critical floors must hold even with a lax injected checker', { todo: 'defect: router applies forbidden/critical only inside defaultCheckAction; an injected checker returning {allow:true} (or allow:"no") routes them automatically' }, () => {
  const lax = () => ({ allow: true, needs_approval: false });
  assert.ok(notAuto(R(task({ goal: 'deploy the service to production' }), { checkAction: lax })));
  assert.ok(notAuto(R(task({ risk_class: 'critical' }), { checkAction: lax })));
  assert.equal(R(task(), { checkAction: () => ({ allow: 'no' }) }).choice, null);
});

test('defect: a foreign `failed` id is never echoed back as `next`', { todo: 'defect: backoff/compact/retry return next=failed without checking it is a floored candidate, so a caller-supplied id outside the allowlist is retried' }, () => {
  const r = R(task({ runtime_allowlist: ['claude'] }));
  for (const ec of ['rate_limit', 'timeout', 'context_overflow', 'crash']) {
    const p = fallbackPlan(r, { error_class: ec, attempt: 0, failed: 'minimax:MiniMax-M3' });
    assert.ok(p.next == null || ids(r).includes(p.next), `${ec} -> ${p.next}`);
  }
});

test('defect: secrets/credential/policy-class failures must never fall back automatically', { todo: 'defect: NO_FALLBACK is exact-match {permission,auth,credentials,deploy}; secrets, credential, Permission, policy, forbidden, auth_expired, deploy_failed fall to the default branch and switch' }, () => {
  const r = R(task());
  assert.equal(r.requires_approval, false);
  for (const ec of ['secrets', 'secret', 'credential', 'Permission', 'DEPLOY', 'policy', 'forbidden', 'approval', 'auth_expired', 'deploy_failed']) {
    const p = fallbackPlan(r, { error_class: ec, attempt: 1 });
    assert.equal(p.action, 'approval', ec); assert.equal(p.next, null, ec);
  }
});

test('defect: a malformed explicit cap must not silently become track mode', { todo: 'defect: normalizeBudgetPolicy drops max_usd:"5" / NaN, so an owner cap is ignored and spend is unbounded' }, () => {
  const l = { entries: [{ usd: 100 }] };
  assert.equal(check({ budget_policy: { max_usd: '5' } }, l, { usd: 100 }).allow, false);
  assert.equal(check({ budget_policy: { max_usd: NaN } }, l, { usd: 100 }).allow, false);
});

test('defect: unknown spend under a per-attempt cap must go to awaiting_approval', { todo: 'defect: attemptSpend sums only known entries; unknown spend in the attempt counts as 0 under per_attempt caps' }, () => {
  const r = check({ budget_policy: { per_attempt: { max_usd: 2 } } }, { entries: [{ attempt_id: 'a1', usd: null }, { attempt_id: 'a1', usd: 1.9 }] }, { usd: 0.05, attempt_id: 'a1' });
  assert.equal(r.allow, false); assert.equal(r.state_hint, 'awaiting_approval');
});

test('defect: a missing/malformed ledger under a cap is unknown spend, not $0', { todo: 'defect: summarize() treats ledger null / entries:"x" as zero entries, spent 0, so a capped task proceeds without observed spend' }, () => {
  for (const l of [null, undefined, { entries: 'x' }]) assert.equal(check({ budget_policy: { max_usd: 5 } }, l, { usd: 1 }).allow, false);
});

test('defect: negative spend or estimates cannot buy headroom under a cap', { todo: 'defect: negative usd in the ledger or estimate is accepted and lowers the total' }, () => {
  assert.equal(check({ budget_policy: { max_usd: 5 } }, { entries: [{ usd: 4 }] }, { usd: -100 }).allow, false);
  assert.equal(check({ budget_policy: { max_usd: 5 } }, { entries: [{ usd: -100 }, { usd: 50 }] }, { usd: 1 }).allow, false);
});

test('defect: a zero historical spend is not a verified $0 cost', { todo: 'defect: history total_usd:0 with verified>0 gives cost_est_usd 0 (basis history), ranked cheapest' }, () => {
  const r = R(task(), { history: { 'minimax:MiniMax-M3': { attempts: 10, verified: 10, errors: 0, total_usd: 0 } } });
  assert.notEqual(r.candidates.find((c) => c.id === 'minimax:MiniMax-M3').cost_est_usd, 0);
});

test('defect: an explicit $0 registry price is not a known price', { todo: 'defect: validateRegistryDoc accepts price {input:0,output:0}; with a fresh price_as_of it ranks as $0' }, () => {
  const doc = { version: 1, models: [{ runtime: 'minimax', provider: 'm', model: 'MiniMax-M3', tier: 'standard', capabilities: ['code'], efforts: [], context_tokens: 1000, price: { input: 0, output: 0 }, price_as_of: '2026-10-10' }] };
  const r = route(task(), { registry: createRegistry(doc), now });
  assert.notEqual(r.candidates[0].cost_est_usd, 0);
});

test('defect: a non-numeric context estimate must not skip the context floor', { todo: 'defect: context_tokens_estimate:"900000" is ignored, so every model passes the context floor' }, () => {
  const r = R(task({ context_tokens_estimate: '900000' }));
  assert.ok(!ids(r).includes('claude:claude-haiku-4-5'));
});

test('defect: non-iterable capability lists fail closed instead of throwing', { todo: 'defect: required_capabilities:{} throws TypeError from route() instead of returning a no-route result' }, () => {
  const r = R(task({ required_capabilities: { vision: true } }));
  assert.equal(r.choice, null);
});

