// orchestration/scorecard.js + proposals.js + GET /api/v2/scorecard + v2-score.js flags (round 2 §6a-d). Synthetic temp
// stores only. Unknown stays unknown; tool scores of different suite versions are never compared; proposals never apply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTaskStore } from '../orchestration/store.js';
import { createIntake } from '../orchestration/intake.js';
import { createV2Http } from '../orchestration/http.js';
import { createGoalLoop } from '../orchestration/goal-loop.js';
import { createRegistry } from '../orchestration/model-registry.js';
import { validateTask, normalizeTask } from '../orchestration/task-contract.js';
import { loadRegistry } from '../orchestration/model-registry.js';
import { route } from '../orchestration/router.js';
import { buildScorecard, toolScore, compareToolScores, validateManifest, taskSpecsOf, TOOL_SCORE_WEIGHTS, BENCH_SCHEMA, BENCH_LEDGER_ACTOR_ID } from '../orchestration/scorecard.js';
import { generateProposals, recordProposals, shadowDiff } from '../orchestration/proposals.js';
import { readStoreLogs, scoreStore } from '../scripts/v2-score.js';
import { spec, SHA_A, SHA_B } from './fixtures/v2-task.js';

// Every temp store is removed after the file (they used to pile up in /tmp).
const made = [];
const tmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const SCRIPT = new URL('../scripts/v2-score.js', import.meta.url).pathname;
// D-020: owner answers are recorded by the goal loop; the smallest loop the factory accepts (never steps here).
const LOOP_REGISTRY = { version: 1, as_of: '2026-10-11', models: [{ runtime: 'fake', provider: 'fake', model: 'dev-a', tier: 'strong',
  capabilities: ['text', 'code', 'tools'], efforts: ['low'], context_tokens: 1000, latency_ms: 1, test_only: true }] };
const loopOver = (store) => createGoalLoop({ store, registry: createRegistry(LOOP_REGISTRY), adapters: {}, worktrees: {},
  worktreeRoot: mkdtempSync(join(tmpdir(), 'v2-loop-')), verifier: {}, reviewRoot: mkdtempSync(join(tmpdir(), 'v2-loop-')), allowFake: true });
const ROOT = new URL('..', import.meta.url).pathname;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const NOW = () => Date.parse('2026-10-11T00:00:00Z');
const storeIn = (dir) => { let t = T0; let n = 0; return createTaskStore({ dir, now: () => (t += 1000), randomId: () => `r${++n}` }); };
const REV = 'codex:gpt-6-luna';
const tspec = (id, over = {}) => spec({ task_id: id, runtime_capabilities: ['code'], scope: { paths: ['README.md'] }, ...over });

async function accepted(s, id, who, { usd = [0.1], rework = 0, reject = 0, approvals = 0, resumes = 0, sha = SHA_A, over = {} } = {}) {
  await s.createTask(tspec(id, over));
  for (const st of ['clarified', 'planned', 'ready', 'executing']) await s.transition(id, st);
  for (let i = 0; i < approvals; i++) {
    await s.append(id, { event_id: `req-${id}-${i}`, kind: 'approval.requested', payload: { k: i, kind: 'policy_gate', question: 'q' } });
    await s.append(id, { event_id: `gr-${id}-${i}`, kind: 'approval.granted', payload: { k: i, actor: 'owner' } });
  }
  for (let i = 0; i < resumes; i++) await s.append(id, { event_id: `res-${id}-${i}`, kind: 'approval.granted', payload: { k: 99 + i, kind: 'resume', actor: 'owner' } });
  for (let i = 0; i < rework; i++) { await s.transition(id, 'repair'); await s.transition(id, 'executing'); }
  await s.transition(id, 'evaluating');
  await s.setHead(id, sha, { actor: { role: 'developer', id: who } });
  const [runtime, model] = who.split(':');
  for (const [i, u] of usd.entries()) await s.recordUsage(id, { runtime, model, usd: u, input_tokens: 10, output_tokens: 5, run_id: `${id}-${i}` });
  await s.recordEvidence(id, { check_id: 'unit', sha, command: ['npm', 'test'], exit: 0, actor: { role: 'tester', id: 't' } });
  for (let i = 0; i < reject; i++) await s.recordVerdict(id, { sha, actor: { role: 'verifier', id: REV }, verdict: 'reject', findings: ['f1', 'f2'] });
  await s.recordVerdict(id, { sha, actor: { role: 'verifier', id: REV }, verdict: 'approve', findings: [] });
  await s.transition(id, 'accepted');
}
async function failed(s, id, who, { usd = 0.05 } = {}) {
  await s.createTask(tspec(id));
  await s.transition(id, 'waiting');
  await s.setHead(id, SHA_B, { actor: { role: 'developer', id: who } });
  await s.recordUsage(id, { runtime: who.split(':')[0], model: who.split(':')[1], usd, input_tokens: 1, output_tokens: 1, run_id: `${id}-u` });
  await s.transition(id, 'failed_unrecoverable');
}
const sc = (dir, opts) => { const { logs, unreadable } = readStoreLogs(dir); return buildScorecard(logs, { unreadable, ...opts }); };

test('task_class is an optional contract label (string or null)', () => {
  const n = (o) => normalizeTask(spec({ task_id: 'x', status: 'created', approval_policy: { requires: [] }, ...o }));
  assert.equal(validateTask(n({ task_class: 'docs' })).ok, true);
  assert.equal(validateTask(n({ task_class: 3 })).ok, false);
  assert.equal(validateTask(n({ task_class: null })).ok, true);
  for (const bad of ['Docs', '-x', '', 'a b', 'x'.repeat(65), '<b>x</b>', '../etc']) assert.equal(validateTask(n({ task_class: bad })).ok, false, bad);
  assert.equal(validateTask(n({ task_class: 'ui.v2_fix-1' })).ok, true);
});

test('per run and per model/runtime/role/task class: verified, first pass, cost, latency, rework, owner, defects', async () => {
  const dir = tmp('v2-sc-');
  const s = storeIn(dir);
  await accepted(s, 'a1', 'claude:claude-sonnet-5-5', { usd: [0.1, 0.05], over: { task_class: 'docs' } });
  await accepted(s, 'a2', 'claude:claude-sonnet-5-5', { usd: [0.25], rework: 2, reject: 1, approvals: 1, resumes: 1 });
  await failed(s, 'f1', 'claude:claude-sonnet-5-5');
  await s.createTask(tspec('open1'));
  await s.createTask(tspec('info1', { review_policy: { mode: 'informational', goal_loop: false } }));
  const r = sc(dir);
  assert.deepEqual([r.tasks.total, r.tasks.settled, r.tasks.accepted, r.tasks.failed, r.tasks.open, r.tasks.informational], [5, 3, 2, 1, 1, 1]);
  const run = Object.fromEntries(r.runs.map((x) => [x.task_id, x]));
  assert.equal(run.a1.first_pass, true);
  assert.equal(run.a2.first_pass, false, 'repair entries mean not first pass');
  assert.equal(run.a2.rework_rounds, 2);
  assert.deepEqual([run.a2.owner.approvals_requested, run.a2.owner.approvals_granted, run.a2.owner.resumes, run.a2.owner.interventions], [1, 1, 1, 2]);
  assert.equal(run.a2.owner.messages, null);
  assert.deepEqual(run.a2.reviewer_defects, { caught: 1, findings: 2 });
  assert.deepEqual(run.a2.reviewers, [REV]);
  assert.equal(run.a1.task_class, 'docs');
  assert.equal(run.a2.task_class, 'unknown');
  const m = r.by_model.find((g) => g.key === 'claude:claude-sonnet-5-5');
  assert.deepEqual([m.settled, m.verified, m.first_pass], [3, 2, 1]);
  assert.ok(Math.abs(m.cost.per_verified_completion_usd - (0.15 + 0.25 + 0.05) / 2) < 1e-9);
  assert.ok(m.median_latency_ms > 0);
  assert.equal(m.rework.rounds, 2);
  assert.equal(m.owner_interventions.interventions, 2);
  assert.equal(m.reviewer_defects.caught, 1);
  assert.equal(m.small_sample, true);
  assert.ok(r.caveats.some((c) => /small samples/.test(c)));
  assert.deepEqual(r.by_runtime.map((g) => g.key), ['claude']);
  const rev = r.by_role.find((g) => g.key === `reviewer:${REV}`);
  assert.equal(rev.role, 'reviewer');
  assert.equal(rev.settled, 2, 'reviewed the two accepted tasks');
  assert.equal(rev.reviewer_defects.caught, 1);
  assert.ok(r.by_role.find((g) => g.key === 'developer:claude:claude-sonnet-5-5'));
  assert.deepEqual(r.by_task_class.map((g) => g.key).sort(), ['docs', 'unknown']);
});

test('unknown stays unknown: unpriced cost, no latency, regressions not derivable, owner messages', async () => {
  const dir = tmp('v2-sc-');
  const s = storeIn(dir);
  await accepted(s, 'a1', 'claude:claude-sonnet-5-5', { usd: [null] });
  await failed(s, 'f1', 'codex:gpt-6-astra');
  const r = sc(dir);
  const m = r.by_model.find((g) => g.key === 'claude:claude-sonnet-5-5');
  assert.equal(m.cost.per_verified_completion_usd, null);
  assert.match(m.unknown.cost_per_verified_completion, /unknown cost/);
  assert.equal(r.runs.find((x) => x.task_id === 'a1').cost_unknown_reason, 'unpriced usage (usd unknown)');
  assert.equal(m.regressions.detected, null);
  assert.match(m.unknown.regressions, /no later evidence/);
  assert.equal(m.owner_interventions.messages, null);
  assert.ok(m.unknown.owner_messages && m.unknown.reopened);
  const f = r.by_model.find((g) => g.key === 'codex:gpt-6-astra');
  assert.equal(f.median_latency_ms, null);
  assert.equal(f.verified_rate, 0);
  assert.equal(f.first_pass_rate, 0);
  assert.equal(f.cost.per_verified_completion_usd, null, 'no verified completion: unknown, not 0 or infinity');
});

test('regression after acceptance: a later failing run of the same check on the accepted SHA; a later pass is "none"', async () => {
  const dir = tmp('v2-sc-');
  const s = storeIn(dir);
  await accepted(s, 'a1', 'claude:claude-sonnet-5-5');
  await accepted(s, 'a2', 'claude:claude-sonnet-5-5', { sha: SHA_B });
  await s.createTask(tspec('later', { base_sha: SHA_A }));
  await s.recordEvidence('later', { check_id: 'unit', sha: SHA_A, command: ['npm', 'test'], exit: 1, actor: { role: 'tester', id: 't' } });
  await s.recordEvidence('later', { check_id: 'unit', sha: SHA_B, command: ['npm', 'test'], exit: 0, actor: { role: 'tester', id: 't' } });
  await s.recordEvidence('later', { check_id: 'other', sha: SHA_B, command: ['node', 'other.js'], exit: 1, actor: { role: 'tester', id: 't' } });
  const r = sc(dir);
  const run = Object.fromEntries(r.runs.map((x) => [x.task_id, x]));
  assert.equal(run.a1.regression.status, 'detected');
  assert.match(run.a1.regression.refs[0], /^later#\d+$/);
  assert.equal(run.a2.regression.status, 'none', 'a command the accepted task never passed is not a regression');
  const m = r.by_model[0];
  assert.deepEqual([m.regressions.detected, m.regressions.accepted_checked], [1, 2]);
});

const manifest = (over = {}) => ({ schema: BENCH_SCHEMA, suite_id: 'core', suite_version: '1', budget_policy: { max_usd: 1, max_task_ms: 3_600_000 },
  runs: [
    { task_id: 'b-done', bench_task_id: 'B1', task_class: 'docs', expected_outcome: 'done', runtime: 'claude', model: 'claude-sonnet-5-5', reviewer_runtime: 'codex', reviewer_model: 'gpt-6-luna' },
    { task_id: 'b-appr', bench_task_id: 'B2', task_class: 'deploy', expected_outcome: 'awaiting_approval', runtime: 'claude', model: 'claude-sonnet-5-5' },
    { task_id: 'b-wait', bench_task_id: 'B3', task_class: 'stuck', expected_outcome: 'waiting', runtime: 'claude', model: 'claude-sonnet-5-5' },
  ], ...over });

async function bench(dir, { apprAccepted = false } = {}) {
  const s = storeIn(dir);
  await accepted(s, 'b-done', 'claude:claude-sonnet-5-5', { usd: [0.2] });
  if (apprAccepted) await accepted(s, 'b-appr', 'claude:claude-sonnet-5-5', { usd: [0.1] });
  else {
    await s.createTask(tspec('b-appr')); await s.transition('b-appr', 'awaiting_approval');
    await s.recordUsage('b-appr', { runtime: 'claude', model: 'claude-sonnet-5-5', usd: 0.1, input_tokens: 1, output_tokens: 1, run_id: 'x' });
  }
  await s.createTask(tspec('b-wait')); await s.transition('b-wait', 'waiting');
  await s.append('b-wait', { event_id: 'blk', kind: 'task.blocked', payload: { reason: 'no_progress' } });
  await s.recordUsage('b-wait', { runtime: 'claude', model: 'claude-sonnet-5-5', usd: 0.1, input_tokens: 1, output_tokens: 1, run_id: 'y' });
  return dir;
}

test('manifest: schema enforced, task_class taken from it, missing runs listed', async () => {
  assert.equal(validateManifest(manifest()).ok, true);
  assert.equal(validateManifest(manifest({ schema: 'x' })).ok, false);
  assert.equal(validateManifest(manifest({ runs: [{ task_id: 'a', expected_outcome: 'merged' }] })).ok, false);
  assert.equal(validateManifest(manifest({ budget_policy: { max_usd: 0 } })).ok, false);
  assert.equal(validateManifest(manifest({ runs: [{ task_id: 'a', expected_outcome: 'done', task_class: '<b>x</b>' }] })).ok, false, 'task_class follows the contract pattern');
  assert.throws(() => buildScorecard([], { manifest: { schema: 'nope' } }), (e) => e.code === 'E_MANIFEST');
  const dir = await bench(tmp('v2-bench-'));
  const m = manifest(); m.runs.push({ task_id: 'b-gone', expected_outcome: 'done' });
  const r = sc(dir, { manifest: m });
  assert.equal(r.runs.find((x) => x.task_id === 'b-done').task_class, 'docs');
  assert.deepEqual(r.suite, { suite_id: 'core', suite_version: '1' });
  assert.ok(r.caveats.some((c) => /b-gone/.test(c)));
});

test('tool score: expected outcome is correct only when the task ended there, never done; formula and weights', async () => {
  const W = Object.values(TOOL_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(W - 1) < 1e-9);
  const good = toolScore(sc(await bench(tmp('v2-bench-'))), manifest());
  assert.deepEqual(good.per_run.map((p) => p.correct), [true, true, true]);
  assert.equal(good.components.outcome_correctness.value, 1);
  assert.equal(good.components.verified_rate.value, 1);
  assert.equal(good.components.first_pass_rate.value, 1);
  assert.ok(Math.abs(good.components.cost.value - 0.6) < 1e-9, '1 - 0.4 / 1');
  assert.ok(good.components.latency.value > 0.99);
  assert.equal(good.components.owner_interventions.value, 1);
  const expect = 100 * (0.3 + 0.25 + 0.15 + 0.1 * 0.6 + 0.1 * good.components.latency.value + 0.1);
  assert.ok(Math.abs(good.score - expect) < 0.1);
  // An approval-gated bench task that the tool finished as done is wrong, whatever else it did.
  const bad = toolScore(sc(await bench(tmp('v2-bench-'), { apprAccepted: true })), manifest());
  assert.equal(bad.per_run.find((p) => p.task_id === 'b-appr').correct, false);
  assert.ok(bad.components.outcome_correctness.value < 0.7);
  assert.ok(bad.score < good.score);
  // Unknown budget -> unknown component -> unknown score, with the reason.
  const nob = toolScore(sc(await bench(tmp('v2-bench-'))), manifest({ budget_policy: { max_usd: 1 } }));
  assert.equal(nob.score, null);
  assert.match(nob.score_reason, /latency/);
  // partial score: known components only, not rescaled, with their weight sum as coverage
  assert.equal(nob.coverage, 0.9);
  assert.deepEqual(nob.unknown_components, ['latency']);
  assert.ok(Math.abs(nob.partial_score - (good.score - 100 * 0.1 * good.components.latency.value)) < 0.2);
  assert.equal(good.coverage, 1);
  assert.equal(good.partial_score, good.score);
  assert.deepEqual([good.components.cost.cost_known_runs, good.components.cost.cost_coverage], [3, 1]);
  assert.match(nob.components.latency.reason, /max_task_ms/);
});

test('compareToolScores: per-component diff on the same suite version; refuses different versions, suites or formulas', async () => {
  const dir = await bench(tmp('v2-bench-'));
  const a = toolScore(sc(dir), manifest());
  const b = toolScore(sc(await bench(tmp('v2-bench-'), { apprAccepted: true })), manifest());
  const d = compareToolScores(a, b);
  assert.ok(d.score.delta < 0);
  assert.ok(d.components.outcome_correctness.delta < 0);
  assert.equal(d.components.verified_rate.delta, 0);
  const v2 = toolScore(sc(dir), manifest({ suite_version: '2' }));
  assert.throws(() => compareToolScores(a, v2), (e) => e.code === 'E_SUITE_MISMATCH' && /suite versions/.test(e.message));
  // different budgets, partial vs full, and different coverages are not comparable either
  const budget = toolScore(sc(dir), manifest({ budget_policy: { max_usd: 2, max_task_ms: 3_600_000 } }));
  assert.throws(() => compareToolScores(a, budget), (e) => e.code === 'E_SUITE_MISMATCH' && /max_usd/.test(e.message));
  const partial = toolScore(sc(dir), manifest({ budget_policy: { max_usd: 1 } }));
  assert.throws(() => compareToolScores(a, partial), (e) => e.code === 'E_SUITE_MISMATCH');
  const p1 = { ...partial, budget_policy: a.budget_policy };
  assert.throws(() => compareToolScores(a, p1), (e) => e.code === 'E_SUITE_MISMATCH' && /partial/.test(e.message));
  const p2 = { ...p1, coverage: 0.8, unknown_components: ['cost', 'latency'] };
  assert.throws(() => compareToolScores(p1, p2), (e) => e.code === 'E_SUITE_MISMATCH' && /coverage/.test(e.message));
  const same = compareToolScores(p1, p1);
  assert.equal(same.partial_score.delta, 0);
  assert.equal(same.score.delta, null);
  assert.throws(() => compareToolScores(a, { ...a, suite_id: 'other' }), (e) => e.code === 'E_SUITE_MISMATCH');
  assert.throws(() => compareToolScores(a, { ...a, formula: 'v0' }), (e) => e.code === 'E_SUITE_MISMATCH');
  assert.throws(() => compareToolScores(a, {}), (e) => e.code === 'E_SUITE_MISMATCH');
});

const PROTECTED = ['orchestration/models.json', 'orchestration/router.js', 'orchestration/model-registry.js', 'orchestration/policy.js', 'orchestration/roles.js',
  'orchestration/goal-loop.js', 'usage/prices.json', '.ai/project.json'];
const fingerprint = () => Object.fromEntries(PROTECTED.map((f) => [f, existsSync(join(ROOT, f)) ? createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex') : 'absent']));
const snapDir = (dir) => {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walk(p); else out[p] = [readFileSync(p, 'utf8'), st.mtimeMs]; } };
  walk(dir);
  return out;
};

async function weakModelStore() {
  const dir = tmp('v2-prop-');
  const s = storeIn(dir);
  for (let i = 0; i < 6; i++) await accepted(s, `ok${i}`, 'claude:claude-sonnet-5-5', { usd: [0.1], reject: 1, rework: 2 });
  for (let i = 0; i < 5; i++) await failed(s, `bad${i}`, 'codex:gpt-6-astra');
  await accepted(s, 'one', 'codex:gpt-6-astra');
  return { dir, s };
}

test('shadow diff: routing with a model excluded lists exactly the tasks that would route differently', () => {
  const registry = loadRegistry({ now: NOW });
  const t = { task_id: 'sh1', goal: 'add a helper to README.md', risk_class: 'low', scope: ['README.md'], runtime_capabilities: ['code'] };
  const cur = route(t, { registry, now: NOW }).choice;
  assert.ok(cur);
  const d = shadowDiff([t], { registry, now: NOW, current: {}, proposed: { exclude: [cur] } });
  assert.equal(d.evaluated, 1);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].current, cur);
  assert.notEqual(d.changed[0].proposed, cur);
  assert.deepEqual(shadowDiff([t], { registry, now: NOW }).changed, []);
});

test('proposals: generated with shadow evidence, recorded as awaiting_approval tasks + journal; nothing applies, registry/router/config byte-identical', async () => {
  const before = fingerprint();
  const { dir, s } = await weakModelStore();
  const { logs } = readStoreLogs(dir);
  const card = buildScorecard(logs);
  const registry = loadRegistry({ now: NOW });
  const { proposals } = generateProposals(card, { registry, tasks: taskSpecsOf(logs), now: NOW, routerHistory: scoreStore(dir).router_history });
  const kinds = proposals.map((p) => p.kind);
  for (const k of ['router_history', 'model_registry', 'role_prompt', 'harness']) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
  const demote = proposals.find((p) => p.kind === 'model_registry');
  assert.deepEqual(demote.change.exclude, ['codex:gpt-6-astra']);
  assert.equal(demote.risk_class, 'high');
  assert.ok(demote.shadow.evaluated > 0);
  for (const p of proposals) { assert.equal(p.applies_itself, false); assert.ok(['medium', 'high', 'critical'].includes(p.risk_class)); assert.ok(p.evidence_refs.length); }

  const intake = createIntake({ store: s, loadPolicy: () => ({ ok: false }) });
  const rec = await recordProposals(proposals, { store: s, intake, base_sha: SHA_A, project_id: 'fixture-project', now: NOW });
  assert.equal(rec.length, proposals.length);
  const journal = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(journal.length, proposals.length);
  for (const j of journal) { assert.equal(j.kind, 'proposal.recorded'); assert.equal(j.applied, false); assert.ok(j.rationale && j.evidence_refs.length); }
  const api = createV2Http({ store: s, intake, loop: loopOver(s) });
  for (const r of rec) {
    const t = (await api.handle({ method: 'GET', pathname: `/api/v2/tasks/${r.task_id}` })).body.task;
    assert.equal(t.state, 'awaiting_approval');
    assert.ok(['medium', 'high', 'critical'].includes(t.risk_class));
    assert.ok(t.pending_approval, 'the owner can approve or reject it');
  }
  // idempotent: replay records nothing new
  const again = await recordProposals(proposals, { store: s, intake, base_sha: SHA_A, project_id: 'fixture-project', now: NOW });
  assert.ok(again.every((r) => !r.created));
  assert.equal(readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').length, proposals.length);
  // owner approves one: it is recorded, and still nothing is applied
  const first = (await api.handle({ method: 'GET', pathname: `/api/v2/tasks/${rec[0].task_id}` })).body.task.pending_approval;
  const ok = await api.handle({ method: 'POST', pathname: `/api/v2/tasks/${rec[0].task_id}/approve`, readBody: async () => ({ action_id: first.action_id }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(fingerprint(), before, 'registry, router, roles, policy and prices untouched');
  // proposal tasks are informational: the scorecard does not score them
  assert.equal(buildScorecard(readStoreLogs(dir).logs).tasks.settled, card.tasks.settled);
});

test('static: no code path applies a proposal (proposals.js writes only the journal; nothing imports it to write config)', () => {
  const src = readFileSync(join(ROOT, 'orchestration/proposals.js'), 'utf8');
  assert.doesNotMatch(src, /writeFileSync|renameSync|rmSync|unlinkSync|copyFileSync|createWriteStream/);
  assert.equal([...src.matchAll(/appendFileSync\(/g)].length, 1);
  assert.doesNotMatch(src, /models\.json'\s*\)|prices\.json'\s*\)/);
  for (const f of ['orchestration/router.js', 'orchestration/model-registry.js', 'orchestration/goal-loop.js', 'server.js']) assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), /proposals\.js/, f);
});

test('GET /api/v2/scorecard is read-only: same bytes before and after, non-GET is 405', async () => {
  const { dir, s } = await weakModelStore();
  const api = createV2Http({ store: s, intake: createIntake({ store: s }) });
  await s.list();
  const before = snapDir(dir);
  const r = await api.handle({ method: 'GET', pathname: '/api/v2/scorecard' });
  assert.equal(r.status, 200);
  assert.equal(r.body.scorecard.tasks.settled, 12);
  assert.equal('runs' in r.body.scorecard, false);
  assert.ok(r.body.scorecard.by_model.length >= 2);
  for (const m of ['POST', 'PUT', 'DELETE']) assert.equal((await api.handle({ method: m, pathname: '/api/v2/scorecard', readBody: async () => ({}) })).status, 405);
  assert.deepEqual(snapDir(dir), before);
});

test('tasks view renders the scorecard read-only: unknown is "unknown", markup escaped, no action buttons', async () => {
  const { scorecardHtml } = await import('../public/tasks-view.js');
  const dir = tmp('v2-sc-');
  const s = storeIn(dir);
  await accepted(s, 'a1', 'claude:<b>x</b>', { usd: [null] });   // a model id is free text after the runtime
  const h = scorecardHtml(sc(dir));
  assert.match(h, /Scorecard \(read-only\)/);
  assert.match(h, /unknown/);
  assert.doesNotMatch(h, /\$0\.0000/);
  assert.doesNotMatch(h, /<b>x<\/b>/);
  assert.doesNotMatch(h, /data-tk-(approve|deny|cancel)/);
  assert.doesNotMatch(h, /<svg(?![^>]*class="ico)/, 'icons come from icons.js');
});

test('CLI: --scorecard, --tool-score --suite, --compare refuses across versions, --write-proposals needs an explicit store', async () => {
  const dir = await bench(tmp('v2-bench-'));
  const env = { PATH: process.env.PATH, GHOSTY_STATE_DIR: tmp('v2-state-') };
  const run = (args) => execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
  const j = JSON.parse(run(['--store', dir, '--scorecard', '--json']));
  assert.equal(j.schema, 'mycodebox.v2.scorecard/1');
  assert.match(run(['--store', dir, '--scorecard']), /V2 scorecard \(read-only\)/);
  const mf = join(dir, 'm1.json'); writeFileSync(mf, JSON.stringify(manifest()));
  const mf2 = join(dir, 'm2.json'); writeFileSync(mf2, JSON.stringify(manifest({ suite_version: '2' })));
  const a = join(dir, 'a.json'); writeFileSync(a, run(['--store', dir, '--tool-score', '--suite', mf]));
  const b = join(dir, 'b.json'); writeFileSync(b, run(['--store', dir, '--tool-score', '--suite', mf2]));
  assert.equal(JSON.parse(readFileSync(a, 'utf8')).suite_version, '1');
  assert.equal(JSON.parse(run(['--compare', a, a])).score.delta, 0);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--compare', a, b], { env, stdio: 'pipe' }), (e) => e.status === 3);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--tool-score'], { env, stdio: 'pipe' }), (e) => e.status === 2);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--propose', '--write-proposals', '--base-sha', SHA_A], { env, stdio: 'pipe' }), (e) => e.status === 2);
  const before = snapDir(join(dir, 'tasks'));
  assert.match(run(['--store', dir, '--propose']), /nothing was applied/);
  assert.deepEqual(snapDir(join(dir, 'tasks')), before, '--propose without --write-proposals writes nothing');
  assert.equal(existsSync(join(dir, 'journal.jsonl')), false);
  // the legacy report and its router_history are unchanged in shape
  assert.ok('router_history' in JSON.parse(run(['--store', dir, '--json'])));
});

test('cancelled tasks count as settled and not verified in the scorecard rates', async () => {
  const dir = tmp('v2-sc-');
  const s = storeIn(dir);
  await accepted(s, 'a1', 'claude:claude-sonnet-5-5');
  await s.createTask(tspec('c1')); await s.setHead('c1', SHA_B, { actor: { role: 'developer', id: 'claude:claude-sonnet-5-5' } });
  await s.transition('c1', 'cancelled');
  const r = sc(dir);
  const m = r.by_model.find((g) => g.key === 'claude:claude-sonnet-5-5');
  assert.deepEqual([m.settled, m.verified, m.failed, m.cancelled], [2, 1, 0, 1]);
  assert.equal(m.verified_rate, 0.5);
  assert.equal(m.first_pass_rate, 0.5);
  assert.ok(r.caveats.some((c) => /cancelled task/.test(c)));
  assert.ok(r.caveats.some((c) => /latency .* includes time waiting/.test(c)));
});

test('proposals: the journal decides (a crash after createTask still journals), live controller refuses, approved proposal says nothing applies', async () => {
  const { dir, s } = await weakModelStore();
  const { logs } = readStoreLogs(dir);
  const { proposals } = generateProposals(buildScorecard(logs), { registry: loadRegistry({ now: NOW }), tasks: taskSpecsOf(logs), now: NOW, routerHistory: scoreStore(dir).router_history });
  const intake = createIntake({ store: s, loadPolicy: () => ({ ok: false }) });
  const p = proposals[0];
  // simulate a crash after the task was created but before the journal line
  await intake.createTask({ task_id: `proposal-${p.proposal_id}`, goal: 'g', project_id: 'fixture-project', base_sha: SHA_A, risk_class: 'medium',
    acceptance_checks: [{ id: 'owner-review', command: ['node', 'x'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }] },
  { source: 'agent', actor_id: 'v2-score', idempotencyKey: `proposal:${p.proposal_id}`, template: 'informational' });
  const rec = await recordProposals([p], { store: s, intake, base_sha: SHA_A, project_id: 'fixture-project', now: NOW });
  assert.equal(rec[0].created, true);
  assert.equal(readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').length, 1);
  const api = createV2Http({ store: s, intake, loop: loopOver(s) });
  const t = (await api.handle({ method: 'GET', pathname: `/api/v2/tasks/${rec[0].task_id}` })).body.task;
  assert.equal(t.state, 'awaiting_approval', 'the half-recorded task is completed on replay');
  await api.handle({ method: 'POST', pathname: `/api/v2/tasks/${rec[0].task_id}/approve`, readBody: async () => ({ action_id: t.pending_approval.action_id }) });
  const after = (await api.handle({ method: 'GET', pathname: `/api/v2/tasks/${rec[0].task_id}` })).body.task;
  assert.match(after.next_action, /nothing is applied/);
  assert.doesNotMatch(after.next_action, /goal loop/);
  // a live goal-loop controller on the store refuses the write
  writeFileSync(join(dir, 'controller.x.intent.json'), JSON.stringify({ instance: 'x', resource: 'service:h:goal-loop', pid: process.pid, host: hostname(), heartbeat_at: Date.now() }));
  await assert.rejects(recordProposals(proposals.slice(1), { store: s, intake, base_sha: SHA_A, project_id: 'fixture-project', now: NOW }), (e) => e.code === 'E_CONTROLLER_LIVE');
  // an idle loop: live pid on this host, heartbeat two minutes old -> still live
  writeFileSync(join(dir, 'controller.x.intent.json'), JSON.stringify({ instance: 'x', resource: 'service:h:goal-loop', pid: process.pid, host: hostname(), heartbeat_at: Date.now() - 120_000 }));
  await assert.rejects(recordProposals(proposals.slice(1), { store: s, intake, base_sha: SHA_A, project_id: 'fixture-project', now: NOW }), (e) => e.code === 'E_CONTROLLER_LIVE');
  // no pid/host and no heartbeat: cannot be judged dead -> refuse
  writeFileSync(join(dir, 'controller.x.intent.json'), JSON.stringify({ instance: 'x' }));
  await assert.rejects(recordProposals(proposals.slice(1), { store: s, intake, base_sha: SHA_A, project_id: 'fixture-project', now: NOW }), (e) => e.code === 'E_CONTROLLER_LIVE');
  // another host: a stale heartbeat is dead, a fresh one live
  writeFileSync(join(dir, 'controller.x.intent.json'), JSON.stringify({ instance: 'x', pid: 1, host: 'other-host.invalid', heartbeat_at: Date.now() }));
  await assert.rejects(recordProposals(proposals.slice(1), { store: s, intake, base_sha: SHA_A, project_id: 'fixture-project', now: NOW }), (e) => e.code === 'E_CONTROLLER_LIVE');
  writeFileSync(join(dir, 'controller.x.intent.json'), JSON.stringify({ instance: 'x', pid: 1, host: 'other-host.invalid', heartbeat_at: Date.now() - 120_000 }));
  assert.equal((await recordProposals([], { store: s, intake, base_sha: SHA_A, project_id: 'fixture-project', now: NOW })).length, 0);
  writeFileSync(join(dir, 'controller.x.intent.json'), JSON.stringify({ instance: 'x', resource: 'service:h:goal-loop', pid: 999999999, host: hostname(), heartbeat_at: Date.now() }));
  assert.equal((await recordProposals(proposals.slice(1), { store: s, intake, base_sha: SHA_A, project_id: 'fixture-project', now: NOW })).length, proposals.length - 1, 'a dead pid on this host does not block, even with a fresh heartbeat');
});

test('budget stops: a bench-ledger grant is budget_auto, an owner grant is an intervention', async () => {
  const dir = tmp('v2-sc-bud-');
  const s = storeIn(dir);
  for (const [id, actor] of [['bud-ledger', { role: 'owner', id: BENCH_LEDGER_ACTOR_ID }], ['bud-owner', { role: 'owner', id: 'owner' }]]) {
    await s.createTask(tspec(id)); await s.transition(id, 'waiting');
    await s.append(id, { event_id: `req-${id}`, kind: 'approval.requested', payload: { k: 7, kind: 'budget', question: 'unknown cost' } });
    await s.append(id, { event_id: `gr-${id}`, kind: 'approval.granted', payload: { k: 7, actor, grants: { request_kind: 'budget' } } });
    await s.transition(id, 'failed_unrecoverable');
  }
  const sc2 = sc(dir);
  const run = Object.fromEntries(sc2.runs.map((r) => [r.task_id, r]));
  assert.deepEqual([run['bud-ledger'].owner.interventions, run['bud-ledger'].owner.budget_auto, run['bud-ledger'].owner.approvals_granted], [0, 1, 0]);
  assert.deepEqual([run['bud-owner'].owner.interventions, run['bud-owner'].owner.budget_auto], [1, 0]);
});
