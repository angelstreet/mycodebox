// Review fixes 16-18, 25: routing.history switch, unknown cost stays unknown, protected CI/deploy globs,
// opsToManager, shadow log rotation, security_reviewer validation. Fake data; temp dirs under the home directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dir = mkdtempSync(join(homedir(), 'fixscore-'));
process.env.GHOSTY_STATE_DIR = dir;
const { validatePolicy, policyWarnings, checkAction, loadPolicy } = await import('../orchestration/policy.js');
const { summarize } = await import('../scripts/v2-ledger.js');
const { attribute } = await import('../usage-window.js');
const { createRoutingShadow } = await import('../routing-shadow.js');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const BASE = { schema_version: 1, project_id: 'p', test_command: ['npm', 'test'], allowlists: { commands: [['npm', 'test']], paths: ['src'] }, approval_policy: { requires: [] } };

test('policy: routing.history is a boolean switch', () => {
  assert.deepEqual(validatePolicy({ ...BASE, routing: { history: false } }), []);
  assert.ok(validatePolicy({ ...BASE, routing: { history: 'no' } }).some((e) => e.path === 'routing.history'));
});

test('policy: security_reviewer must name a registry entry when ids are known', () => {
  assert.deepEqual(validatePolicy({ ...BASE, security_reviewer: 'fake:rev' }, { registryIds: ['fake:rev'] }), []);
  assert.ok(validatePolicy({ ...BASE, security_reviewer: 'nope:x' }, { registryIds: ['fake:rev'] }).some((e) => e.path === 'security_reviewer'));
  assert.ok(validatePolicy({ ...BASE, security_reviewer: 7 }).some((e) => e.path === 'security_reviewer'));
});

test('policy: CI/container/deploy globs are protected and a missing set warns', () => {
  assert.equal(policyWarnings(BASE).length, 1);
  const p = { ...BASE, protected_paths: ['.github', 'Dockerfile*', 'docker-compose*', 'deploy*', 'systemd'] };
  assert.deepEqual(policyWarnings(p), []);
  const t = { task_id: 't', goal: 'x' };
  for (const f of ['.github/workflows/ci.yml', 'Dockerfile.prod', 'docker-compose.yml', 'deploy-runner.js']) {
    assert.equal(checkAction(p, t, { class: 'edit', paths: [f] }).allow, false, f);
  }
  assert.equal(checkAction(p, t, { class: 'edit', paths: ['src/a.js'] }).allow, true);
});

test('the repo policy protects them and loads without a warning', () => {
  const r = loadPolicy(join(import.meta.dirname, '..'));
  assert.ok(r.ok); assert.deepEqual(r.warnings, []);
});

test('ledger: one unpriced verified record makes $/verified unknown', () => {
  const r = (o) => ({ model: 'm', verified: true, plan: null, costUsd: 1, latencyMs: 1, ...o });
  assert.equal(summarize([r({}), r({})], 'model')[0].costPerVerified, 1);
  assert.equal(summarize([r({}), r({ costUsd: null })], 'model')[0].costPerVerified, null);
});

test('attribute: an unpriced row makes cost unknown, not a partial sum', () => {
  const row = (ts, cost) => ({ ts, agent: 'claude', model: 'm', usage: { input: 1, output: 1 }, ...(cost ? { cost: { total: cost } } : {}) });
  assert.equal(attribute([row(5, 2), row(6, 3)], 0, 10).costUsd, 5);
  assert.equal(attribute([row(5, 2), row(6, 0)], 0, 10).costUsd, null);
});

test('routing shadow log rotates at maxBytes', () => {
  const sd = mkdtempSync(join(homedir(), 'fixscore-sh-'));
  try {
    const s = createRoutingShadow({ stateDir: sd, home: sd, maxBytes: 300 });
    for (let i = 0; i < 6; i++) s.note({ task_id: `t${i}`, entry: { id: 'a:b', model: 'b', runtime: 'a' } });
    assert.ok(existsSync(join(sd, 'routing-shadow.jsonl.1')));
    assert.ok(readFileSync(join(sd, 'routing-shadow.jsonl'), 'utf8').length < 3000);
  } finally { rmSync(sd, { recursive: true, force: true }); }
});

test('setManagerConfig accepts opsToManager', async () => {
  const m = await import('../manager.js');
  await m.setManagerConfig({ opsToManager: false });
  assert.equal(JSON.parse(readFileSync(join(dir, 'manager.json'), 'utf8')).opsToManager, false);
  await m.setManagerConfig({ opsToManager: true });
});
