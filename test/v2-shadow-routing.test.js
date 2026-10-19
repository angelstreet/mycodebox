// Round 15: shadow scoring into routing + daily digest. Fake data only, temp state dirs under the home directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { classifyTaskType, recommend, buildDigest, parseSince, shadowThresholds } from '../scripts/v2-ledger.js';
import { createRoutingShadow } from '../routing-shadow.js';

const tmp = () => mkdtempSync(join(homedir(), 'v2shadow-'));
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const TH = { minVerified: 3, minAttempts: 4, regressionDrop: 0.2 };
const rec = (type, model, verified, tokens = 100, runtime = 'rt') => ({ type, model, runtime, verified, tokens, outcome: verified ? 'merged' : 'returned' });
const many = (type, model, ok, bad, tokens, runtime) => [...Array(ok).fill(0).map(() => rec(type, model, true, tokens, runtime)), ...Array(bad).fill(0).map(() => rec(type, model, false, tokens, runtime))];

test('classifyTaskType: precedence game_run > review > infra > small_fix > other, unknown is other', () => {
  const c = (o) => classifyTaskType(o);
  assert.equal(c({ source: 'game-dispatch' }), 'game_run');
  assert.equal(c({ text: 'league game run nightly' }), 'game_run');
  assert.equal(c({ role: 'reviewer', text: 'fix typo' }), 'review');
  assert.equal(c({ text: 'review-round-9' }), 'review');
  assert.equal(c({ text: 'v2/lease-fix-ttl' }), 'infra');   // infra wins over fix
  assert.equal(c({ role: 'operations', text: 'x' }), 'infra');
  assert.equal(c({ text: 'fix/button-typo' }), 'small_fix');
  assert.equal(c({ text: 'v2/r15-shadow-routing' }), 'other');
  assert.equal(c({}), 'other');
});

test('recommend: best verified rate, then fewer tokens per verified; thresholds gate it; unknown never recommended', () => {
  const rs = [...many('small_fix', 'A', 8, 2, 500), ...many('small_fix', 'B', 9, 1, 900), ...many('small_fix', 'C', 9, 1, 300),   // B and C tie at 90%: C has fewer tokens
    ...many('small_fix', 'unknown', 10, 0, 1), ...many('infra', 'A', 2, 0, 1), ...many('infra', 'B', 3, 5, 1)];
  const r = recommend(rs, TH);
  assert.equal(r.small_fix.recommended.model, 'C');
  assert.equal(r.small_fix.eligible, 3);   // A, B, C; 'unknown' excluded
  assert.equal(r.infra.recommended.model, 'B');   // A has 2 verified < 3: not eligible
  assert.equal(r.infra.eligible, 1);
});

test('recommend: insufficient data below either threshold, and for empty types', () => {
  const r = recommend([...many('review', 'A', 2, 0, 1), ...many('other', 'B', 5, 0, 1)], TH);
  assert.equal(r.review.recommended, null); assert.match(r.review.reason, /insufficient data/);
  assert.equal(r.other.recommended.model, 'B');
  assert.equal(recommend(many('other', 'B', 5, 0, 1), { ...TH, minAttempts: 6 }).other.recommended, null, 'attempts threshold alone blocks');
  assert.equal(recommend([], TH).game_run.recommended, null);
});

test('thresholds: env overrides, bad values fall back', () => {
  assert.deepEqual(shadowThresholds({}), { minVerified: 10, minAttempts: 15, regressionDrop: 0.2 });
  assert.equal(shadowThresholds({ GHOSTY_SHADOW_MIN_VERIFIED: '3' }).minVerified, 3);
  assert.equal(shadowThresholds({ GHOSTY_SHADOW_MIN_VERIFIED: 'x' }).minVerified, 10);
  assert.equal(parseSince('2h', 10 * 36e5), 8 * 36e5);
  assert.throws(() => parseSince('soon'));
});

function fixture() {
  const dir = tmp(), home = tmp(), now = Date.now(), H = 36e5;
  const run = (id, model, ok, agoH, task = 'fix typo') => ({ id, kind: 'minimax', worktree: `/fake/${id}`, task, startedAt: now - agoH * H, endedAt: now - agoH * H + 6e4, verdict: ok ? 'accepted' : 'rejected', usage: { model, runtime: 'minimax', tokens: 1000, costUsd: null, plan: 'flat' } });
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(run(`p${i}`, 'M-prev', true, 30 + i));            // previous window: 5/5
  for (let i = 0; i < 5; i++) rows.push(run(`c${i}`, 'M-prev', i < 2, 2 + i));           // current: 2/5 -> drop 0.6
  for (let i = 0; i < 2; i++) rows.push(run(`q${i}`, 'M-small', i === 0, 30 + i));        // previous 1/2
  for (let i = 0; i < 2; i++) rows.push(run(`r${i}`, 'M-small', false, 3 + i));           // current 0/2: drop but low sample
  writeFileSync(join(dir, 'manager-runs.jsonl'), jl(rows));
  const req = (id, state, agoH) => ({ id, repo: 'r', branch: 'fix/thing', session: 's', createdAt: new Date(now - agoH * H).toISOString(), endedAt: new Date(now - agoH * H + 6e4).toISOString(), state, pushed: state === 'merged', steps: [{ name: 'test', ok: state === 'merged' }], usage: { model: 'M-lane', runtime: 'claude', tokens: 10 } });
  mkdirSync(join(dir, 'integration'));
  writeFileSync(join(dir, 'integration', 'requests.jsonl'), jl([req('l1', 'merged', 40), req('l2', 'returned', 1)]));
  writeFileSync(join(dir, 'routing-shadow.jsonl'), jl([{ ts: now - H, agree: true }, { ts: now - H, agree: false }, { ts: now - H, agree: true }, { ts: now - H, agree: null }, { ts: now - 90 * H, agree: false }]));
  return { dir, home, now };
}

test('digest: per model window vs previous, regressions with caveats, lane return after green, shadow agreement', () => {
  const { dir, home, now } = fixture();
  try {
    const d = buildDigest({ stateDir: dir, home, now, thresholds: TH });
    const m = Object.fromEntries(d.models.map((x) => [x.model, x]));
    assert.deepEqual([m['M-prev'].attempts, m['M-prev'].verified, m['M-prev'].previous.attempts, m['M-prev'].previous.verified], [5, 2, 5, 5]);
    assert.equal(m['M-prev'].caveat, null);
    assert.match(m['M-small'].caveat, /low sample/);
    const rd = d.regressions.filter((r) => r.kind === 'rate-drop');
    assert.deepEqual(rd.map((r) => r.model).sort(), ['M-lane', 'M-prev', 'M-small']);
    assert.equal(rd.find((r) => r.model === 'M-prev').caveat, null);
    assert.match(rd.find((r) => r.model === 'M-small').caveat, /low sample/);
    const lr = d.regressions.filter((r) => r.kind === 'lane-return-after-green');
    assert.equal(lr.length, 1); assert.equal(lr[0].id, 'l2'); assert.equal(lr[0].previousGreen, 'l1');
    assert.deepEqual([d.shadow.entries, d.shadow.comparable, d.shadow.agree, d.shadow.noRecommendation], [4, 3, 2, 1]);
    assert.ok(Math.abs(d.shadow.agreementRate - 2 / 3) < 1e-9); assert.match(d.shadow.caveat, /low sample/);
    assert.equal(d.recommendations.length, 5);
    // read-only: nothing new in the state dir
    assert.ok(!existsSync(join(dir, 'digest.json')));
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('digest CLI: --digest --json and text, --since duration', () => {
  const { dir, home } = fixture();
  try {
    const env = { ...process.env, GHOSTY_STATE_DIR: dir, HOME: home };
    const j = spawnSync('node', ['scripts/v2-ledger.js', '--digest', '--json', '--since', '24h'], { env, encoding: 'utf8' });
    assert.equal(j.status, 0, j.stderr);
    const d = JSON.parse(j.stdout);
    assert.ok(d.models.length && d.shadow && d.window.since);
    const t = spawnSync('node', ['scripts/v2-ledger.js', '--digest'], { env, encoding: 'utf8' });
    assert.match(t.stdout, /per model/); assert.match(t.stdout, /shadow agreement/);
    assert.notEqual(spawnSync('node', ['scripts/v2-ledger.js', '--digest', '--since', 'soon'], { env, encoding: 'utf8' }).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('routing shadow logger: records chosen next to recommended, dedupes, caches the ledger, never throws', () => {
  const { dir, home } = fixture();
  const env = { GHOSTY_SHADOW_MIN_VERIFIED: '3', GHOSTY_SHADOW_MIN_ATTEMPTS: '4' };
  try {
    const sh = createRoutingShadow({ stateDir: dir, home, env });
    const entry = { id: 'minimax:other', runtime: 'minimax', model: 'Other-Model' };
    assert.equal(sh.note({ task_id: 't1', text: 'fix typo in readme', entry, key: 'sha1' }), undefined);
    sh.note({ task_id: 't1', text: 'fix typo in readme', entry, key: 'sha1' });   // same live choice: not logged twice
    const lines = readFileSync(join(dir, 'routing-shadow.jsonl'), 'utf8').trim().split('\n').slice(-1).map((l) => JSON.parse(l));
    const l = lines[0];
    assert.equal(l.type, 'small_fix'); assert.equal(l.chosen.model, 'Other-Model'); assert.equal(l.recommended.model, 'M-prev'); assert.equal(l.agree, false);
    assert.equal(l.task_id, 't1'); assert.ok(l.samples.recommended.attempts >= 4); assert.match(l.reason, /best verified rate/);
    assert.equal(readFileSync(join(dir, 'routing-shadow.jsonl'), 'utf8').trim().split('\n').length, 5 + 1, 'fixture had 5 lines; one new');
    sh.note({ task_id: 't2', role: 'reviewer', text: 'x', entry: { id: 'e', model: 'M-prev', runtime: 'minimax' } });
    const l2 = JSON.parse(readFileSync(join(dir, 'routing-shadow.jsonl'), 'utf8').trim().split('\n').pop());
    assert.equal(l2.type, 'review'); assert.equal(l2.recommended, null); assert.equal(l2.agree, null); assert.match(l2.reason, /insufficient data/);
    // failure path: unwritable state dir and junk input never throw
    const errs = [];
    const bad = createRoutingShadow({ stateDir: join(dir, 'manager-runs.jsonl', 'sub'), home, env, onError: (e) => errs.push(e) });
    assert.doesNotThrow(() => bad.note({ task_id: 'x', text: 'fix', entry }));
    assert.doesNotThrow(() => bad.note(undefined)); assert.doesNotThrow(() => bad.note({ entry: null })); assert.doesNotThrow(() => bad.note({ entry: {}, text: { toString() { throw new Error('boom'); } } }));
    assert.ok(errs.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
