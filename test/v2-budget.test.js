// V2 phase 4: budget checks. Covers T13 (cap reached -> awaiting_approval, no more spend) and T22 (unknown stays unknown).
import test from 'node:test';
import assert from 'node:assert/strict';
import { check, summarize, remaining, normalizeBudgetPolicy } from '../orchestration/budget.js';

const entry = (o = {}) => ({ attempt_id: 'a1', kind: 'developer', usd: 1, input_tokens: 100, output_tokens: 50, duration_ms: 1000, ...o });
const T = (bp) => ({ task_id: 't', budget_policy: bp });

test('default track mode: never stops, even with huge or unknown spend; measured only', () => {
  const l = { entries: [entry({ usd: 9999 }), entry({ usd: null })] };
  for (const bp of [undefined, { mode: 'track' }]) {
    const r = check(T(bp), l, { usd: 1e6 });
    assert.equal(r.allow, true); assert.equal(r.state_hint, null);
    assert.match(r.reason, /track mode/);
  }
});

test('T13: cap reached -> awaiting_approval and no further spend; even a zero estimate is refused at the cap', () => {
  const l = { entries: [entry({ usd: 3 }), entry({ usd: 2, kind: 'verifier' })] };
  const r = check(T({ mode: 'track', max_usd: 5 }), l, { usd: 0 });
  assert.equal(r.allow, false); assert.equal(r.state_hint, 'awaiting_approval');
  assert.match(r.reason, /cap max_usd=5 reached/);
});

test('T13: estimate that would exceed the cap is refused before starting', () => {
  const r = check(T({ max_usd: 5 }), { entries: [entry({ usd: 3 })] }, { usd: 2.5 });
  assert.equal(r.allow, false); assert.match(r.reason, /would exceed/);
  assert.equal(check(T({ max_usd: 5 }), { entries: [entry({ usd: 3 })] }, { usd: 2 }).allow, true);   // exactly at cap after the step is ok
});

test('verifier and retry spend count against the whole-task cap', () => {
  const l = { entries: [entry({ usd: 1 }), entry({ kind: 'verifier', usd: 1.5 }), entry({ kind: 'retry', usd: 1.5 })] };
  const s = summarize(l);
  assert.equal(s.spent.usd, 4); assert.equal(s.by_kind.verifier.usd, 1.5); assert.equal(s.by_kind.retry.usd, 1.5);
  assert.equal(check(T({ max_usd: 5 }), l, { usd: 1.5 }).allow, false);
  assert.equal(remaining(T({ max_usd: 5 }), l).usd, 1);
});

test('token and duration caps are hard stops too', () => {
  const l = { entries: [entry({ input_tokens: 900, output_tokens: 400, duration_ms: 9000 })] };
  assert.match(check(T({ max_input_tokens: 1000 }), l, { input_tokens: 200 }).reason, /input_tokens.*would exceed/);
  assert.match(check(T({ max_output_tokens: 400 }), l, { output_tokens: 1 }).reason, /output_tokens.*reached/);
  assert.match(check(T({ max_duration_ms: 10000 }), l, { duration_ms: 2000 }).reason, /duration_ms.*would exceed/);
  assert.equal(check(T({ max_input_tokens: 5000, max_output_tokens: 5000, max_duration_ms: 99999 }), l, { input_tokens: 1, output_tokens: 1, duration_ms: 1 }).allow, true);
});

test('per-attempt cap uses the attempt own spend plus the estimate', () => {
  const bp = { per_attempt: { max_usd: 2 } };
  const l = { entries: [entry({ attempt_id: 'a1', usd: 1.5 }), entry({ attempt_id: 'a2', usd: 0.1 })] };
  assert.equal(check(T(bp), l, { usd: 1, attempt_id: 'a1' }).allow, false);
  assert.equal(check(T(bp), l, { usd: 1, attempt_id: 'a2' }).allow, true);
  assert.equal(check(T(bp), l, { usd: 2.5, attempt_id: 'new' }).allow, false);
});

test('T22: unknown spend with a cap -> awaiting_approval, reported unknown, never 0', () => {
  const l = { entries: [entry({ usd: null }), entry({ usd: null })] };
  const s = summarize(l);
  assert.equal(s.spent.usd, null); assert.deepEqual(s.unknown, ['usd']);
  const r = check(T({ max_usd: 100 }), l, { usd: 0.01 });
  assert.equal(r.allow, false); assert.equal(r.state_hint, 'awaiting_approval');
  assert.match(r.reason, /spend unknown/);
  assert.equal(r.spent.usd, null);
  assert.equal(remaining(T({ max_usd: 100 }), l).usd, null);
});

test('partially unknown spend is a lower bound and still blocks under a cap', () => {
  const l = { entries: [entry({ usd: 1 }), entry({ usd: undefined })] };
  assert.equal(summarize(l).spent.usd, 1);
  assert.equal(summarize(l).spent.usd_unknown_entries, 1);
  assert.equal(check(T({ max_usd: 100 }), l, { usd: 1 }).allow, false);
});

test('unknown estimate with a cap possibly exceeds -> awaiting_approval; no cap -> fine', () => {
  const r = check(T({ max_usd: 10 }), { entries: [entry({ usd: 1 })] }, { usd: null });
  assert.equal(r.allow, false); assert.match(r.reason, /estimate unknown, may exceed/);
  assert.equal(check(T({ max_usd: 10 }), { entries: [entry({ usd: 1 })] }, {}).allow, false);
  assert.equal(check(T({ max_usd: 10 }), { entries: [] }, { usd: 1 }).allow, true);
  // a cap on one dimension does not block on another dimension's unknown
  assert.equal(check(T({ max_usd: 10 }), { entries: [entry({ usd: 1, input_tokens: null })] }, { usd: 1 }).allow, true);
});

test('quota: exhausted -> waiting with backoff; unknown -> distinguished, only a warning', () => {
  const ex = check(T({ mode: 'track' }), { entries: [] }, { usd: 1 }, { quota: { status: 'exhausted', retry_after_ms: 60000 } });
  assert.equal(ex.allow, false); assert.equal(ex.state_hint, 'waiting'); assert.equal(ex.backoff_ms, 60000); assert.equal(ex.quota, 'exhausted');
  const unk = check(T({ mode: 'track' }), { entries: [] }, { usd: 1 }, { quota: { status: 'unknown' } });
  assert.equal(unk.allow, true); assert.equal(unk.quota, 'unknown'); assert.ok(unk.warnings.some((w) => /quota unknown/.test(w)));
  assert.equal(check(T(), { entries: [] }, {}, { quota: { status: 'ok' } }).quota, 'ok');
  assert.equal(check(T(), { entries: [] }, {}).quota, 'unknown');
  // exhausted wins over a passing budget; a budget stop still reports awaiting_approval when quota is ok
  assert.equal(check(T({ max_usd: 1 }), { entries: [entry({ usd: 1 })] }, { usd: 1 }, { quota: { status: 'ok' } }).state_hint, 'awaiting_approval');
});

test('policy normalisation drops non-numeric caps (no accidental 0 cap) and is deterministic', () => {
  assert.deepEqual(normalizeBudgetPolicy({ mode: 'track', max_usd: null, max_input_tokens: 'x' }), { mode: 'track' });
  assert.deepEqual(normalizeBudgetPolicy(null), { mode: 'track' });
  const a = check(T({ max_usd: 5 }), { entries: [entry()] }, { usd: 1 });
  assert.deepEqual(a, check(T({ max_usd: 5 }), { entries: [entry()] }, { usd: 1 }));
});

test('F13: cap reached wins over exhausted quota (awaiting_approval, not waiting)', () => {
  const r = check(T({ max_usd: 1 }), { entries: [entry({ usd: 1 })] }, { usd: 1 }, { quota: { status: 'exhausted' } });
  assert.equal(r.state_hint, 'awaiting_approval');
  assert.equal(check(T({ max_usd: 10 }), { entries: [entry({ usd: 1 })] }, { usd: 1 }, { quota: { status: 'exhausted' } }).state_hint, 'waiting');
});

test('F6: malformed caps (string, NaN, negative, bad per_attempt, non-object policy) stop', () => {
  for (const bp of [{ max_usd: '5' }, { max_duration_ms: NaN }, { max_usd: -1 }, { per_attempt: 'x' }, { per_attempt: { max_usd: 'a' } }, 'cap']) {
    const r = check(T(bp), { entries: [] }, { usd: 1 });
    assert.equal(r.allow, false, JSON.stringify(bp)); assert.equal(r.state_hint, 'awaiting_approval');
  }
});
