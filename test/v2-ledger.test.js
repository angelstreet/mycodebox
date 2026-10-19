import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildLedger, summarize } from '../scripts/v2-ledger.js';

const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (min) => new Date(T0 + min * 6e4).toISOString();
const step = (name, ok) => ({ name, ok });
const green = [step('merge', true), step('test', true), step('push', true)];

function fixture() {
  const root = mkdtempSync(join(homedir(), 'v2ledger-'));
  const state = join(root, 'state'), home = join(root, 'home');
  mkdirSync(join(state, 'integration'), { recursive: true }); mkdirSync(join(home, '.cache', 'game-dispatch'), { recursive: true });
  const req = (id, branch, state_, min, extra = {}) => ({ id, repo: 'fake-repo', branch, session: 'sess-a', state: state_, createdAt: at(min), endedAt: at(min + 2), steps: green, pushed: true, ...extra });
  writeFileSync(join(state, 'integration', 'requests.jsonl'), jl([
    req('r1', 'b1', 'running', 10, { endedAt: null }), req('r1', 'b1', 'returned', 10, { reason: 'tests red', steps: [step('test', false)] }),   // last wins
    req('r2', 'b1', 'merged', 20),                                  // verified, one rework before it
    req('r3', 'b2', 'merged', 30, { alreadyMerged: true }),         // merged but not tested by the lane
    req('r4', 'b3', 'queued', 40, { endedAt: null }),               // open: not an attempt
  ]));
  writeFileSync(join(state, 'usage-ledger.jsonl'), jl([
    { ts: T0 + 5 * 6e4, label: 'sess-a', agent: 'claude', model: 'fake-big', usage: { input: 1, output: 1 }, cost: { total: 2 } },
    { ts: T0 + 15 * 6e4, label: 'sess-a', agent: 'claude', model: 'fake-big', usage: { input: 1, output: 1 }, cost: { total: 4 } },
    { ts: T0 + 6 * 6e4, cwd: '/fake/wt-1', agent: 'minimax', model: 'fake-mini', usage: { input: 5, output: 5 } },
  ]));
  writeFileSync(join(state, 'manager-runs.jsonl'), jl([
    { id: 'm1', kind: 'minimax', worktree: '/fake/wt-1', startedAt: T0, by: 'x' }, { id: 'm1', endedAt: T0 + 10 * 6e4, verdict: 'fixed' },
    { id: 'm2', kind: 'minimax', worktree: '/fake/wt-2', startedAt: T0 }, { id: 'm2', endedAt: T0 + 5 * 6e4, verdict: 'rejected' },
    { id: 'm3', kind: 'other', worktree: '/fake/wt-3', startedAt: T0 },   // never closed, older than 6 h at test time: unverified attempt
  ]));
  writeFileSync(join(home, '.cache', 'game-dispatch', 'runs.jsonl'), jl([
    { job: 'j1', game: 'g', task_id: 't1', started: T0 / 1e3, ended: T0 / 1e3 + 60, status: 'failed', model: 'none', error: 'x' },
    { job: 'j1', game: 'g', task_id: 't2', started: T0 / 1e3 + 100, ended: T0 / 1e3 + 220, status: 'completed', script_result_id: 'fake', model: 'none' },
    { job: 'j2', game: 'g', task_id: 't3', started: T0 / 1e3, ended: T0 / 1e3 + 5, status: 'completed', model: 'none' },   // no script result
  ]));
  return { root, state, home };
}
const snapshot = (d) => readdirSync(d, { recursive: true }).map((f) => `${f}:${statSync(join(d, f)).mtimeMs}`).sort().join('|');

test('ledger: per-source verification, rework, attribution', () => {
  const { root, state, home } = fixture();
  try {
    const before = snapshot(root);
    const { records, skipped } = buildLedger({ stateDir: state, home });
    assert.equal(snapshot(root), before, 'read-only');
    assert.deepEqual(skipped, []);
    const by = (id) => records.find((r) => r.id === id);
    assert.ok(!by('r4'));                                   // queued: open
    assert.equal(by('r1').outcome, 'returned'); assert.equal(by('r1').verified, false); assert.equal(by('r1').reworkEvent, true);
    assert.equal(by('r2').verified, true); assert.equal(by('r2').rework, 1);
    assert.equal(by('r2').model, 'fake-big'); assert.equal(by('r2').costUsd, 4);   // window (prev request, this one]
    assert.equal(by('r3').verified, false); assert.match(by('r3').evidence, /already merged/);
    assert.equal(by('m1').verified, true); assert.equal(by('m1').model, 'fake-mini'); assert.equal(by('m1').costUsd, null); assert.equal(by('m1').rework, 1);
    assert.equal(by('m2').verified, false); assert.equal(by('m3').outcome, 'no-verdict');
    assert.equal(by('t1').verified, false); assert.equal(by('t2').verified, true); assert.equal(by('t2').rework, 1);
    assert.equal(by('t3').verified, false); assert.equal(by('t3').evidence, 'completed without script result');
    const m = summarize(records, 'model').find((g) => g.model === 'fake-big');
    assert.equal(m.attempts, 2); assert.equal(m.verified, 1); assert.equal(m.costPerVerified, 6);   // all priced attempts / verified
    assert.equal(summarize(records, 'source').length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ledger: missing sources are skipped, --since filters', () => {
  const root = mkdtempSync(join(homedir(), 'v2ledger-'));
  try {
    const r = buildLedger({ stateDir: join(root, 'none'), home: join(root, 'nohome') });
    assert.deepEqual(r.records, []);
    assert.deepEqual(r.skipped.map((s) => s.source).sort(), ['game-dispatch', 'lane', 'manager', 'usage-ledger']);
    const f = fixture();
    try { assert.equal(buildLedger({ stateDir: f.state, home: f.home, since: T0 + 25 * 6e4 }).records.filter((x) => x.source === 'lane').length, 1); }
    finally { rmSync(f.root, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
