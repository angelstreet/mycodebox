// Round 14b: recorded attribution (manager runs, lane requests), flat plan, reviewer evidence, game-dispatch prompt_version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { attribute, flatPlan } from '../usage-window.js';
import { buildLedger, summarize } from '../scripts/v2-ledger.js';
import { createIntegrationLane } from '../integration-lane.js';
import { makeWorld } from './helpers-lane.js';

const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const tmp = () => mkdtempSync(join(homedir(), 'v2attr-'));
const row = (o) => ({ usage: { input: 10, output: 5, cache_read: 100 }, ...o });

test('flatPlan comes from the registry billing; flat rows have null cost and plan flat', () => {
  assert.ok(flatPlan('minimax', 'MiniMax-M3')); assert.ok(!flatPlan('claude', 'claude-opus-5-5'));
  const a = attribute([row({ ts: 5, agent: 'minimax', model: 'MiniMax-M3', cost: { total: 9 } })], 0, 10);
  assert.equal(a.costUsd, null); assert.equal(a.plan, 'flat'); assert.equal(a.tokensIn, 10); assert.equal(a.tokensOut, 5); assert.equal(a.tokens, 115);
  const b = attribute([row({ ts: 5, agent: 'claude', model: 'fake-big', cost: { total: 2 } })], 0, 10);
  assert.equal(b.costUsd, 2); assert.equal(b.plan, null);
  assert.equal(attribute([], 0, 10), null);
});

test('manager-run end records model, runtime, tokens and cost of the run window, plus the review', () => {
  const dir = tmp();
  try {
    const env = { ...process.env, GHOSTY_STATE_DIR: dir };
    const run = (...a) => spawnSync('node', ['scripts/manager-run.js', ...a], { env, encoding: 'utf8' });
    const id = run('start', '--kind', 'minimax', '--worktree', '/fake/wt-9', '--task', 'x').stdout.trim();
    writeFileSync(join(dir, 'usage-ledger.jsonl'), jl([
      row({ ts: Date.now(), cwd: '/fake/wt-9', agent: 'minimax', model: 'MiniMax-M3', cost: null }),
      row({ ts: Date.now() + 1, cwd: '/fake/other', agent: 'minimax', model: 'MiniMax-M3', cost: null }),
    ]));
    const out = JSON.parse(run('end', id, '--verdict', 'accepted', '--review', 'pass').stdout);
    assert.equal(out.review, 'pass');
    assert.deepEqual([out.usage.model, out.usage.runtime, out.usage.tokens, out.usage.costUsd, out.usage.plan], ['MiniMax-M3', 'minimax', 115, null, 'flat']);
    assert.notEqual(run('end', id, '--review', 'maybe').status, 0);
    assert.notEqual(run('end', 'nope').status, 0);
    // the ledger prefers the recorded fields and does not mark them approximate
    const { records } = buildLedger({ stateDir: dir, home: join(dir, 'h') });
    const m = records.find((r) => r.id === id);
    assert.equal(m.model, 'MiniMax-M3'); assert.equal(m.attribution, 'recorded'); assert.equal(m.approximate, false);
    assert.equal(m.plan, 'flat'); assert.equal(m.costUsd, null); assert.equal(m.tokensIn, 10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('old records fall back to the time window and are marked approximate; reviewer evidence counts', () => {
  const dir = tmp(), T0 = Date.parse('2026-01-01T00:00:00Z');
  try {
    mkdirSync(join(dir, 'integration'), { recursive: true });
    writeFileSync(join(dir, 'usage-ledger.jsonl'), jl([row({ ts: T0 + 6e4, cwd: '/fake/wt-1', agent: 'minimax', model: 'MiniMax-M3' })]));
    writeFileSync(join(dir, 'manager-runs.jsonl'), jl([
      { id: 'old', kind: 'minimax', worktree: '/fake/wt-1', startedAt: T0 }, { id: 'old', endedAt: T0 + 9e4, verdict: 'accepted' },
      { id: 'rv', kind: 'other', worktree: '/fake/wt-2', startedAt: T0 }, { id: 'rv', endedAt: T0 + 9e4, verdict: null, review: 'pass' },
      { id: 'rf', kind: 'other', worktree: '/fake/wt-3', startedAt: T0 }, { id: 'rf', endedAt: T0 + 9e4, verdict: 'accepted', review: 'fail' },
    ]));
    const green = [{ name: 'test', ok: true }];
    const q = (id, review) => ({ id, repo: 'r', branch: id, session: 's', state: 'merged', createdAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 6e4).toISOString(), steps: green, pushed: true, ...(review ? { review } : {}), usage: { model: 'fake-big', runtime: 'claude', tokens: 50, tokensIn: 30, tokensOut: 20, costUsd: 1.5, plan: null } });
    writeFileSync(join(dir, 'integration', 'requests.jsonl'), jl([q('lp', { pass: true, source: 'floor' }), q('lf', { pass: false, source: 'floor' })]));
    const { records } = buildLedger({ stateDir: dir, home: join(dir, 'h') });
    const by = (id) => records.find((r) => r.id === id);
    assert.equal(by('old').attribution, 'time-window'); assert.equal(by('old').approximate, true); assert.equal(by('old').plan, 'flat');
    assert.equal(by('rv').verified, true); assert.equal(by('rv').evidence, 'reviewer pass');
    assert.equal(by('rf').verified, false); assert.equal(by('rf').evidence, 'reviewer fail');
    assert.equal(by('lp').verified, true); assert.match(by('lp').evidence, /review pass/); assert.equal(by('lp').costUsd, 1.5); assert.equal(by('lp').approximate, false);
    assert.equal(by('lf').verified, false);
    // flat plan: no $/verified, tokens per verified shown
    const mm = summarize(records, 'model').find((g) => g.model === 'MiniMax-M3');
    assert.equal(mm.costPerVerified, null); assert.equal(mm.costUsd, null); assert.ok(mm.flatPlanAttempts >= 1); assert.ok(mm.tokensPerVerified > 0);
    const big = summarize(records, 'model').find((g) => g.model === 'fake-big');
    assert.equal(big.costPerVerified, 3);   // 1.5 + 1.5 priced, one verified metered
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('game-dispatch model and prompt_version are carried; --by prompt_version groups', () => {
  const dir = tmp(), home = join(dir, 'home');
  try {
    mkdirSync(join(home, '.cache', 'game-dispatch'), { recursive: true });
    writeFileSync(join(home, '.cache', 'game-dispatch', 'runs.jsonl'), jl([
      { job: 'j', game: 'g', task_id: 'a', started: 1000, ended: 1060, status: 'completed', script_result_id: 'x', model: 'fake-mini', prompt_version: 'p1@abc' },
      { job: 'j', game: 'g', task_id: 'b', started: 2000, ended: 2060, status: 'failed', model: 'fake-mini', prompt_version: 'p2@def' },
      { job: 'k', game: 'g', task_id: 'c', started: 3000, ended: 3060, status: 'completed', script_result_id: 'x', model: 'none', prompt_version: '-' },
    ]));
    const { records } = buildLedger({ stateDir: join(dir, 's'), home });
    assert.equal(records.find((r) => r.id === 'a').promptVersion, 'p1@abc');
    const g = summarize(records, 'prompt_version');
    assert.deepEqual(g.map((x) => x.prompt_version).sort(), ['none', 'p1@abc', 'p2@def']);
    const out = spawnSync('node', ['scripts/v2-ledger.js', '--by', 'prompt_version', '--state-dir', join(dir, 's')], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.equal(out.status, 0, out.stderr); assert.match(out.stdout, /p1@abc/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lane records the session usage window and the merge review on the request', async () => {
  const stateDir = tmp(), w = makeWorld(); w.branch('f1', { 'a.js': '1\n' }); w.branch('f2', { 'b.js': '1\n' });
  try {
    const now = Date.now();
    writeFileSync(join(stateDir, 'usage-ledger.jsonl'), jl([
      row({ ts: now - 3e5, label: 's1', agent: 'claude', model: 'fake-big', cost: { total: 3 } }),
      row({ ts: now - 3e5, label: 'other', agent: 'claude', model: 'fake-big', cost: { total: 99 } }),
    ]));
    const lane = createIntegrationLane({ stateDir, config: { repos: { 'env-a': w.cfg() } }, pollMs: 1, sleep: () => new Promise((r) => setTimeout(r, 1)) });
    lane.start();
    const q1 = lane.enqueue({ repo: 'env-a', branch: 'f1', session: 's1' });
    const r1 = await lane.wait(q1.id, 30000);
    assert.equal(r1.state, 'merged', JSON.stringify(r1));
    assert.deepEqual([r1.usage.model, r1.usage.runtime, r1.usage.costUsd, r1.usage.tokens], ['fake-big', 'claude', 3, 115]);
    assert.equal(r1.review.pass, true); assert.equal(r1.review.source, 'floor');
    // second request of the same session: window starts at the first request, so the old row is not charged again
    const r2 = await lane.wait(lane.enqueue({ repo: 'env-a', branch: 'f2', session: 's1' }).id, 30000);
    assert.equal(r2.usage, null);
    const noSession = await lane.wait(lane.enqueue({ repo: 'env-a', branch: 'f2' }).id, 30000);
    assert.equal(noSession.usage ?? null, null);
    assert.ok(readFileSync(join(stateDir, 'integration', 'requests.jsonl'), 'utf8').includes('"usage"'));
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
