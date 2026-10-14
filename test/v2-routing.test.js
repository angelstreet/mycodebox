// V2 phase 4: model registry + deterministic router (shadow). Covers T11, T12, T22 and the Phase 4 exit rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, loadRegistry, validateRegistryDoc, checkEffort, priceStatus } from '../orchestration/model-registry.js';
import { route, fallbackPlan, classifyWork, defaultCheckAction } from '../orchestration/router.js';

const NOW = Date.parse('2026-10-11T00:00:00Z');
const now = () => NOW;
const reg = () => loadRegistry({ now });
const task = (o = {}) => ({ task_id: 't-1', goal: 'add a retry helper function', risk_class: 'low', scope: ['lib/a.js'], ...o });
const R = (t, o = {}) => route(t, { registry: reg(), now, ...o });
const ids = (r) => r.candidates.map((c) => c.id);
const rejectedIds = (r) => Object.fromEntries(r.rejected.map((x) => [x.id, x.reason]));

test('registry: shipped models.json validates; PLACEHOLDER and missing price rows are unknown, never 0', () => {
  const r = reg();
  const by = Object.fromEntries(r.entries().map((e) => [e.id, e]));
  assert.deepEqual(by['claude:claude-sonnet-5-5'].price, { input: 2, output: 10 });
  assert.equal(by['minimax:MiniMax-M3'].price, null);        // PLACEHOLDER row
  assert.equal(by['codex:gpt-6-luna'].price, null);          // PLACEHOLDER row
  assert.equal(by['opencode:opencode-default'].price, null); // no row
  assert.equal(priceStatus(by['minimax:MiniMax-M3'], { now: NOW }), 'unknown');
});

test('registry: validation rejects unsupported effort per runtime, unknown capability, duplicates', () => {
  const m = (o) => ({ runtime: 'codex', provider: 'p', model: 'm', tier: 'standard', capabilities: ['code'], efforts: ['low'], ...o });
  assert.equal(validateRegistryDoc({ version: 1, models: [m()] }).ok, true);
  assert.match(validateRegistryDoc({ version: 1, models: [m({ efforts: ['max'] })] }).errors[0].message, /not supported by runtime codex/);
  assert.match(validateRegistryDoc({ version: 1, models: [m({ capabilities: ['telepathy'] })] }).errors[0].message, /unknown capability/);
  assert.match(validateRegistryDoc({ version: 1, models: [m(), m()] }).errors[0].message, /duplicate/);
  assert.match(validateRegistryDoc({ version: 1, models: [m({ runtime: 'nope' })] }).errors[0].message, /unknown runtime/);
  assert.throws(() => createRegistry({ version: 1, models: [m({ efforts: ['max'] })] }), (e) => e.code === 'E_REGISTRY_INVALID');
});

test('registry: effort is rejected, never translated', () => {
  const e = reg().get('claude:claude-haiku-4-5');
  assert.equal(checkEffort(e, 'medium').ok, true);
  assert.match(checkEffort(e, 'xhigh').reason, /unsupported by claude:claude-haiku-4-5/);
  assert.match(checkEffort(reg().get('codex:gpt-6-astra'), 'max').reason, /not a codex effort value/);
  assert.equal(checkEffort(e, null).ok, true);
});

test('registry probe: unavailable runtime is not routable; probe narrows efforts/models and overrides capabilities', () => {
  const r = reg().withProbes({
    codex: { available: false },
    claude: { available: true, models: ['claude-sonnet-5-5', 'claude-opus-5-5'], efforts: ['low', 'high'], features: { vision: false } },
    minimax: { available: 'unknown', features: { vision: true } },
  });
  assert.equal(r.get('codex:gpt-6-astra').routable, false);
  assert.match(r.get('codex:gpt-6-astra').unroutable_reason, /unavailable/);
  assert.equal(r.get('claude:claude-haiku-4-5').routable, false);                      // not in probe models
  assert.deepEqual(r.get('claude:claude-sonnet-5-5').efforts, ['low', 'high']);
  assert.equal(r.get('claude:claude-sonnet-5-5').capabilities.includes('vision'), false);
  assert.equal(r.get('minimax:MiniMax-M3').capabilities.includes('vision'), true);       // discovered
  assert.equal(r.get('minimax:MiniMax-M3').availability, 'unknown');
  assert.equal(reg().get('codex:gpt-6-astra').routable, true);                          // original untouched
});

test('T11: capability absent (vision) -> rejected with reason, compatible fallback offered', () => {
  const r = R(task({ required_capabilities: ['vision'] }));
  const rej = rejectedIds(r);
  assert.match(rej['codex:gpt-6-astra'], /missing capability: vision/);
  assert.match(rej['minimax:MiniMax-M3'], /missing capability: vision/);
  assert.ok(ids(r).every((i) => i.startsWith('claude:')));
  assert.ok(r.choice.startsWith('claude:'));
  assert.ok(r.fallback.length >= 1 && r.fallback.every((f) => ids(r).includes(f.id)));
});

test('T11: effort xhigh unsupported -> those entries rejected with reason; supported ones stay', () => {
  const r = R(task({ effort: 'xhigh' }));
  assert.match(rejectedIds(r)['claude:claude-haiku-4-5'], /effort "xhigh" unsupported/);
  assert.match(rejectedIds(r)['minimax:MiniMax-M3'], /effort "xhigh"/);
  assert.match(rejectedIds(r)['codex:gpt-6-luna'], /unsupported/);
  assert.ok(ids(r).includes('claude:claude-opus-5-5') && ids(r).includes('codex:gpt-6-astra'));
  assert.ok(r.fallback.length > 0);
});

test('T11: runtime unavailable by probe -> rejected, others offered; all unavailable -> no choice, waiting', () => {
  const r1 = route(task(), { registry: reg().withProbes({ claude: { available: false } }), now });
  assert.match(rejectedIds(r1)['claude:claude-sonnet-5-5'], /unavailable/);
  assert.ok(r1.choice && !r1.choice.startsWith('claude:'));
  const down = Object.fromEntries(['claude', 'codex', 'opencode', 'minimax'].map((k) => [k, { available: false }]));
  const r2 = route(task(), { registry: reg().withProbes(down), now });
  assert.equal(r2.choice, null);
  assert.equal(r2.state_hint, 'waiting');
  assert.equal(r2.decision.chosen, 'needs_owner');
});

test('allowlists: runtime, provider/privacy and model allowlists are hard floors', () => {
  const r = R(task({ runtime_allowlist: ['claude', 'codex'] }), { policy: { provider_allowlist: ['anthropic'] } });
  assert.ok(ids(r).every((i) => i.startsWith('claude:')));
  assert.match(rejectedIds(r)['minimax:MiniMax-M3'], /runtime minimax not in runtime allowlist/);
  assert.match(rejectedIds(r)['codex:gpt-6-astra'], /provider openai not in provider\/privacy allowlist/);
  const r2 = R(task({ privacy_class: 'private' }), { policy: { privacy_class_providers: { private: ['anthropic'] } } });
  assert.ok(ids(r2).every((i) => i.startsWith('claude:')));
  const r3 = R(task({ model_allowlist: ['MiniMax-M3'] }));
  assert.deepEqual(ids(r3), ['minimax:MiniMax-M3']);
});

test('context floor: too small or unknown context size is rejected', () => {
  const r = R(task({ context_tokens_estimate: 300000 }));
  assert.match(rejectedIds(r)['claude:claude-haiku-4-5'], /context 200000 < required 300000/);
  assert.match(rejectedIds(r)['opencode:opencode-default'], /context size unknown/);
  assert.ok(ids(r).includes('claude:claude-sonnet-5-5'));
});

test('risk floor: high risk excludes light tier; test-only runtime never routed unless allowed', () => {
  const r = R(task({ risk_class: 'high' }), { checkAction: () => ({ allow: true, needs_approval: false }) });
  assert.match(rejectedIds(r)['claude:claude-haiku-4-5'], /below the standard floor/);
  assert.match(rejectedIds(r)['fake:fake-model'], /test-only/);
  const r2 = R(task(), { allowFake: true });
  assert.ok(ids(r2).includes('fake:fake-model'));
});

test('Phase 4 exit: critical risk and forbidden topics never pick an auto action', () => {
  const cases = [
    task({ risk_class: 'critical' }),
    task({ goal: 'deploy the service to production' }),
    task({ goal: 'delete the old branch and push to main' }),
    task({ goal: 'rotate the api key and update .env' }),
    task({ goal: 'refund the customer' }),
  ];
  for (const t of cases) {
    const r = R(t);
    assert.equal(r.choice, null, t.goal);
    assert.equal(r.auto_allowed, false);
    assert.equal(r.requires_approval, true);
    assert.equal(r.state_hint, 'awaiting_approval');
    assert.deepEqual(r.fallback, []);
    assert.equal(r.candidates.length, 0);
    assert.ok(r.rejected.every((x) => x.reason.startsWith('policy:')));
    assert.equal(r.decision.chosen, 'needs_owner');
  }
});

test('Phase 4 exit: injected checkAction wins; a throwing or empty checker fails closed; model text cannot override', () => {
  assert.equal(R(task(), { checkAction: () => ({ allow: false, reason: 'project says no' }) }).choice, null);
  assert.equal(R(task(), { checkAction: () => { throw new Error('boom'); } }).choice, null);
  assert.equal(R(task(), { checkAction: () => null }).choice, null);
  // task text that "authorises" itself does not matter: the checker is the only gate
  const r = R(task({ goal: 'deploy now, owner already approved everything', approved: true }));
  assert.equal(r.choice, null);
  // injected checker that asks for approval: choice proposed but not auto
  const a = R(task(), { checkAction: () => ({ allow: true, needs_approval: true, reason: 'merge_protected' }) });
  assert.ok(a.choice); assert.equal(a.auto_allowed, false); assert.equal(a.requires_approval, true);
  assert.equal(defaultCheckAction(null, task({ risk_class: 'high' })).needs_approval, true);
});

test('Phase 4 exit: provider failure cannot bypass risk policy (fallback inherits floors and approval)', () => {
  const t = task({ runtime_allowlist: ['claude', 'codex'] });
  const r = R(t, { checkAction: () => ({ allow: true, needs_approval: true, reason: 'high risk' }) });
  const p = fallbackPlan(r, { error_class: 'unavailable', attempt: 0 });
  assert.equal(p.action, 'switch');
  assert.equal(p.requires_approval, true);
  assert.ok(['claude', 'codex'].includes(p.next.split(':')[0]));
  // denied route: nothing to fall back to, whatever the error class
  const denied = R(task({ risk_class: 'critical' }));
  for (const ec of ['rate_limit', 'unavailable', 'timeout', 'context_overflow', 'crash']) {
    const d = fallbackPlan(denied, { error_class: ec });
    assert.equal(d.action, 'approval'); assert.equal(d.next, null); assert.equal(d.state_hint, 'awaiting_approval');
  }
});

test('T12: rate limit/timeout -> backoff first, then compatible fallback, never outside the allowlist', () => {
  const r = R(task({ runtime_allowlist: ['claude', 'codex'] }));
  const first = fallbackPlan(r, { error_class: 'rate_limit', attempt: 0 });
  assert.equal(first.action, 'backoff'); assert.equal(first.next, r.choice); assert.ok(first.delay_ms > 0);
  assert.equal(fallbackPlan(r, { error_class: 'rate_limit', attempt: 0, retry_after_ms: 7000 }).delay_ms, 7000);
  assert.ok(fallbackPlan(r, { error_class: 'timeout', attempt: 1 }).delay_ms > first.delay_ms);
  const sw = fallbackPlan(r, { error_class: 'rate_limit', attempt: 2 });
  assert.equal(sw.action, 'switch');
  assert.notEqual(sw.next.split(':')[0], r.choice.split(':')[0]);   // another provider
  assert.ok(['claude', 'codex'].includes(sw.next.split(':')[0]));
  for (const f of r.fallback) assert.ok(['claude', 'codex'].includes(f.id.split(':')[0]));
  // single-runtime allowlist: nothing to switch to -> waiting, never an outside runtime
  const one = R(task({ runtime_allowlist: ['minimax'], model_allowlist: ['MiniMax-M3'] }));
  const w = fallbackPlan(one, { error_class: 'rate_limit', attempt: 5 });
  assert.equal(w.action, 'wait'); assert.equal(w.next, null); assert.equal(w.state_hint, 'waiting');
});

test('fallback taxonomy: context overflow, unavailable, permission/auth/deploy', () => {
  const r = R(task());
  assert.equal(fallbackPlan(r, { error_class: 'context_overflow', attempt: 0 }).action, 'compact');
  const small = R(task({ model_allowlist: ['claude-haiku-4-5', 'claude-sonnet-5-5'] }), {});
  const big = fallbackPlan(small, { error_class: 'context_overflow', failed: 'claude:claude-haiku-4-5', attempt: 1 });
  assert.equal(big.action, 'switch'); assert.equal(big.next, 'claude:claude-sonnet-5-5');
  const none = fallbackPlan(R(task({ model_allowlist: ['claude-sonnet-5-5'] })), { error_class: 'context_overflow', attempt: 1 });
  assert.equal(none.action, 'replan');
  assert.equal(fallbackPlan(r, { error_class: 'unavailable' }).action, 'switch');
  for (const ec of ['permission', 'auth', 'credentials', 'deploy']) {
    const p = fallbackPlan(r, { error_class: ec });
    assert.equal(p.action, 'approval'); assert.equal(p.next, null); assert.equal(p.state_hint, 'awaiting_approval');
  }
});

test('T22: unknown/placeholder/stale pricing is never $0 and never ranked cheapest', () => {
  const r = R(task());
  const unknown = r.candidates.filter((c) => c.cost_est_usd == null);
  assert.ok(unknown.length >= 2);
  for (const c of r.candidates) assert.notEqual(c.cost_est_usd, 0);
  assert.ok(unknown.every((c) => c.cost_basis === 'unknown'));
  assert.match(r.rationale.join(' '), /never treated as cheapest or \$0/);
  // equal quality (same tier): the known-cost entry must beat the unknown-cost one
  const doc = { version: 1, models: [
    { runtime: 'claude', provider: 'a', model: 'claude-sonnet-5-5', tier: 'standard', capabilities: ['code'], efforts: [], context_tokens: 1000, latency_ms: 10 },
    { runtime: 'minimax', provider: 'b', model: 'MiniMax-M3', tier: 'standard', capabilities: ['code'], efforts: [], context_tokens: 1000, latency_ms: 10, billing: 'per_token' },   // a priced, not subscription, entry
  ] };
  const prices = { as_of: '2026-10-03', models: { 'claude-sonnet-5-5': { input: 2, output: 10, as_of: '2026-10-03', source: 'x' }, 'MiniMax-M3': { input: 0, output: 0, source: 'PLACEHOLDER x' } } };
  const eq = route(task(), { registry: createRegistry(doc, { prices }), now });
  assert.equal(eq.choice, 'claude:claude-sonnet-5-5');
  assert.equal(eq.candidates[1].cost_est_usd, null);
  // also when listed first / ids sort first
  doc.models.reverse();
  assert.equal(route(task(), { registry: createRegistry(doc, { prices }), now }).choice, 'claude:claude-sonnet-5-5');
});

test('T22: stale price (older than the max age) is treated as unknown for ranking', () => {
  const doc = { version: 1, models: [{ runtime: 'claude', provider: 'a', model: 'claude-sonnet-5-5', tier: 'standard', capabilities: ['code'], efforts: [], context_tokens: 1000, latency_ms: 10 }] };
  const prices = { as_of: '2025-01-01', models: { 'claude-sonnet-5-5': { input: 2, output: 10, as_of: '2025-01-01', source: 'x' } } };
  const r = route(task(), { registry: createRegistry(doc, { prices }), now });
  assert.equal(r.candidates[0].cost_est_usd, null);
  assert.equal(r.candidates[0].cost_basis, 'stale_price');
  assert.equal(priceStatus(createRegistry(doc, { prices }).get('claude:claude-sonnet-5-5'), { now: NOW }), 'stale');
});

test('ranking: history (verified rate, cost per verified completion) beats priors; thin history is ignored', () => {
  const history = {
    'codex:gpt-6-astra': { attempts: 20, verified: 19, errors: 0, total_usd: 20, latency_ms: 1000, },
    'claude:claude-opus-5-5': { attempts: 20, verified: 4, errors: 8, total_usd: 80, latency_ms: 1000 },
    'claude:claude-sonnet-5-5': { attempts: 2, verified: 2, errors: 0, total_usd: 0.1 },   // too thin
  };
  const r = R(task(), { history });
  assert.equal(r.choice, 'codex:gpt-6-astra');
  const so = r.candidates.find((c) => c.id === 'claude:claude-sonnet-5-5');
  assert.equal(so.history, false);
  assert.equal(r.candidates.find((c) => c.id === 'codex:gpt-6-astra').cost_basis, 'history');
  assert.match(r.rationale.join(' '), /No meaningful history/);
});

test('weights/priority are configurable', () => {
  const cheap = R(task(), { weights: { quality: 0, cost: 1, latency: 0, reliability: 0 } });
  // known cheapest: a subscription model (near-zero marginal cost, D-025); unknown costs last
  assert.ok(['minimax:MiniMax-M3', 'minimax:MiniMax-M3.1-Flash-Preview'].includes(cheap.choice));
  assert.equal(R(task({ runtime_allowlist: ['claude', 'codex'] }), { weights: { quality: 0, cost: 1, latency: 0, reliability: 0 } }).choice, 'claude:claude-haiku-4-5');
  assert.ok(cheap.candidates.slice(-3).every((c) => c.cost_est_usd == null || c.cost_est_usd > 0));
  const q = R(task({ priority: 'quality' }));
  assert.ok(['claude:claude-opus-5-5', 'codex:gpt-6-astra'].includes(q.choice));
});

test('classification: types, unknown needs discovery with capped confidence', () => {
  const k = (goal) => classifyWork(task({ goal })).type;
  assert.equal(k('research the options and compare them'), 'research');
  assert.equal(k('fix the crash in the parser'), 'debugging');
  assert.equal(k('write unit tests for the queue'), 'test');
  assert.equal(k('responsive layout for the settings page'), 'ui');
  assert.equal(k('update the README'), 'docs');
  assert.equal(k('review the sandbox and permission model'), 'security');
  assert.equal(k('implement a rate limiter'), 'coding');
  const u = classifyWork(task({ goal: 'make it nicer' }));
  assert.equal(u.type, 'unknown'); assert.equal(u.needs_discovery, true);
  const r = R(task({ goal: 'make it nicer' }));
  assert.ok(r.confidence <= 0.3);
  assert.match(r.rationale.join(' '), /needs a discovery step/);
});

test('output shape and §9 decision record; confidence is conservative without history', () => {
  const r = R(task());
  for (const k of ['choice', 'candidates', 'rejected', 'rationale', 'confidence', 'fallback', 'decision']) assert.ok(k in r, k);
  assert.equal(r.mode, 'shadow');
  const d = r.decision;
  for (const k of ['decision_id', 'task_id', 'ts', 'kind', 'question', 'alternatives', 'chosen', 'evidence', 'expected_effect', 'rationale', 'actor', 'confidence', 'policy_ref', 'reversible', 'rollback']) assert.ok(k in d, k);
  assert.equal(d.chosen, r.choice); assert.equal(d.kind, 'route'); assert.equal(d.ts, '2026-10-11T00:00:00.000Z');
  assert.match(d.expected_effect, /shadow/);
  assert.ok(r.confidence <= 0.6);
});

test('shadow only: any other mode throws E_NOT_LIVE', () => {
  assert.throws(() => route(task(), { registry: reg(), mode: 'live' }), (e) => e.code === 'E_NOT_LIVE');
});

test('determinism: same inputs -> deep-equal output, input objects unmutated', () => {
  const t = task({ required_capabilities: ['vision'], effort: 'high' });
  const snap = JSON.stringify(t);
  const history = { 'claude:claude-opus-5-5': { attempts: 9, verified: 8, errors: 1, total_usd: 9 } };
  const a = R(t, { history }); const b = R(t, { history });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(t), snap);
  assert.equal(a.decision.decision_id, b.decision.decision_id);
});

test('F4: checkAction is called with the frozen signature (policy, task, action)', () => {
  let seen;
  const policy = { id: 'p1', version: 7 };
  const t = task();
  const r = R(t, { policy, checkAction: (...a) => { seen = a; return { allow: true, needs_approval: false }; } });
  assert.equal(seen[0], policy); assert.equal(seen[1], t); assert.equal(seen[2].kind, 'route');
  assert.equal(r.decision.policy_ref, 'policy@7');
});

test('F12: working-directory floor (inside an allowed root, no roots configured = deny); numeric-string context is parsed', () => {
  const pol = { allowed_roots: ['/srv/wt'] };
  assert.ok(R(task({ cwd: '/srv/wt/t-1' }), { policy: pol }).choice);
  assert.equal(R(task({ cwd: '/srv/wt/../etc' }), { policy: pol }).choice, null);
  assert.equal(R(task({ cwd: '/srv/wt-evil' }), { policy: pol }).choice, null);
  assert.equal(R(task({ cwd: 'relative/dir' }), { policy: pol }).choice, null);
  assert.equal(R(task({ worktree: '/srv/wt/x' })).choice, null);
  assert.match(R(task({ context_tokens_estimate: 'lots' })).rejected[0].reason, /malformed context_tokens_estimate/);
  assert.ok(!ids(R(task({ context_tokens_estimate: '300000' }))).includes('claude:claude-haiku-4-5'));
});

test('F5/F13: unknown error class -> approval; quota exhausted -> wait', () => {
  const r = R(task());
  assert.equal(fallbackPlan(r, { error_class: 'banana' }).action, 'approval');
  assert.equal(fallbackPlan(r, { error_class: 'unknown' }).action, 'approval');
  const q = fallbackPlan(r, { error_class: 'quota_exhausted', attempt: 1 });
  assert.equal(q.action, 'wait'); assert.equal(q.next, null); assert.equal(q.state_hint, 'waiting');
});

test('F10: free is only known when explicitly flagged', () => {
  const m = (o) => ({ runtime: 'minimax', provider: 'm', model: 'MiniMax-M3', tier: 'standard', capabilities: ['code'], efforts: [], context_tokens: 1000, price: { input: 0, output: 0 }, price_as_of: '2026-10-10', billing: 'per_token', ...o });
  assert.equal(route(task(), { registry: createRegistry({ version: 1, models: [m({ free: true })] }), now }).candidates[0].cost_est_usd, 0);
  assert.equal(route(task(), { registry: createRegistry({ version: 1, models: [m()] }), now }).candidates[0].cost_est_usd, null);
  assert.equal(validateRegistryDoc({ version: 1, models: [m({ price: { input: -1, output: 1 } })] }).ok, false);
});

test('R5: exclude:null and a circular goal give clean no-route results, not throws', () => {
  const r1 = R(task(), { exclude: null });
  assert.equal(r1.choice, null); assert.equal(r1.auto_allowed, false);
  const circ = { toString() { return 'x'; } }; circ.self = circ;
  const r2 = R(task({ goal: circ }));
  assert.equal(r2.choice, null); assert.equal(r2.requires_approval, true);
});

test('R5: a future price_as_of is stale (unknown cost)', () => {
  const doc = { version: 1, models: [{ runtime: 'claude', provider: 'a', model: 'claude-sonnet-5-5', tier: 'standard', capabilities: ['code'], efforts: [], context_tokens: 1000, price: { input: 1, output: 1 }, price_as_of: '2027-01-01' }] };
  const reg1 = createRegistry(doc);
  assert.equal(priceStatus(reg1.get('claude:claude-sonnet-5-5'), { now: NOW }), 'stale');
  assert.equal(route(task(), { registry: reg1, now }).candidates[0].cost_est_usd, null);
});

test('R1: inconsistent history is ignored and the rationale says so', () => {
  const bad = [{ attempts: 5, verified: 6, errors: 0 }, { attempts: 5, verified: 1, errors: -1 }, { attempts: 5.5, verified: 1 }, { attempts: 10, verified: 5, errors: 11 }, { attempts: 10, verified: 5, total_usd: -3 }];
  for (const h of bad) {
    const r = R(task(), { history: { 'minimax:MiniMax-M3': h } });
    assert.equal(r.candidates.find((c) => c.id === 'minimax:MiniMax-M3').history, false, JSON.stringify(h));
    assert.match(r.rationale.join(' '), /inconsistent .* ignored/);
  }
});

test('working-directory floor resolves symlinks with an injected realpath, lexical otherwise', () => {
  const pol = { allowed_roots: ['/srv/wt'] };
  const rp = (p) => (p === '/srv/wt/link' ? '/etc' : p);
  assert.equal(R(task({ cwd: '/srv/wt/link' }), { policy: pol }).choice !== null, true);            // lexical: inside
  assert.equal(R(task({ cwd: '/srv/wt/link' }), { policy: pol, realpath: rp }).choice, null);        // symlink escapes
  assert.equal(R(task({ cwd: '/srv/wt/ok' }), { policy: pol, realpath: rp }).choice !== null, true);
  assert.equal(R(task({ cwd: '/srv/wt/gone' }), { policy: pol, realpath: () => { throw new Error('ENOENT'); } }).choice, null);
});
