import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sessionOfRequest, createFoundBugs } from '../found-bugs.js';
import { createVerifier } from '../orchestration/verifier.js';
import { checkListErrors } from '../orchestration/task-contract.js';
import { createTaskStore } from '../orchestration/store.js';
import { spec, clock } from './fixtures/v2-task.js';
import { tmp } from './helpers-tmp.js';

test('sessionOfRequest: a remote client always acts under its own mac-<client> name', () => {
  assert.equal(sessionOfRequest('laptop', 'dev-1'), 'dev-1@mac-laptop');
  assert.equal(sessionOfRequest('laptop', 'mac-laptop'), 'mac-laptop');
  assert.equal(sessionOfRequest('laptop', 'a@b c'), 'abc@mac-laptop');
  assert.equal(sessionOfRequest('laptop', ''), 'mac-laptop');
  assert.equal(sessionOfRequest('laptop', undefined), 'mac-laptop');
});

test('sessionOfRequest: a local caller keeps its session, unknown counts as none', () => {
  assert.equal(sessionOfRequest(null, 'dev-1'), 'dev-1');
  assert.equal(sessionOfRequest(null, 'unknown'), '');
  assert.equal(sessionOfRequest(null, undefined), '');
});

test('a remote client report is stored under its mac-<client> session', async () => {
  const seen = [];
  const fb = createFoundBugs({ stateDir: tmp('ghosty-fb-'), onNew: async (b) => { seen.push(b.session); } });
  const body = { title: 'x', session: 'dev-1' };
  body.session = sessionOfRequest('laptop', body.session);
  const r = await fb.add(body);
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['dev-1@mac-laptop']);
});

const good = { id: 'unit', command: ['node', '-v'], expect: { exit: 0 }, evidence_type: 'test', required: true };

test('check ids must be path-safe, already used ids still validate', () => {
  for (const id of ['unit', 'meets_goal', 'docs-check', 'a.b_c-1', 'X'.repeat(64)]) assert.deepEqual(checkListErrors([{ ...good, id }], 'c'), [], id);
  for (const id of ['../x', 'a/b', '.hidden', '-dash', 'a b', '', 'X'.repeat(65), 'a\\b']) assert.ok(checkListErrors([{ ...good, id }], 'c').some((e) => e.path === 'c[0].id'), id);
});

test('a task with an unsafe check id is refused', async () => {
  const bad = spec({ acceptance_checks: [{ ...good, id: '../x' }] });
  const store = createTaskStore({ dir: tmp('v2-id-'), ...clock() });
  await assert.rejects(store.createTask(bad), { code: 'E_INVALID_TASK' });
  await store.createTask(spec());
});

test('check artifact must be repo-relative', () => {
  for (const artifact of ['out/report.txt', 'report.txt']) assert.deepEqual(checkListErrors([{ ...good, artifact }], 'c'), [], artifact);
  for (const artifact of ['../x', 'a/../../x', '/etc/x', 'C:\\x', '']) assert.ok(checkListErrors([{ ...good, artifact }], 'c').some((e) => e.path === 'c[0].artifact'), artifact);
});

test('verifier logs stay under the artifact root', async () => {
  const dir = tmp('vf-root-');
  const artifactRoot = path.join(dir, 'artifacts');
  const v = createVerifier({ tmpRoot: dir, artifactRoot, timeoutMs: 10_000 });
  const evidence = [];
  const store = { recordEvidence: async (_id, e) => { evidence.push(e); } };
  const task = { task_id: 't-root', acceptance_checks: [{ id: '../../escaped', command: [process.execPath, '-e', 'console.log(1)'], expect: { exit: 0 }, required: true }] };
  await v.runChecks({ store, task, cwd: dir, sha: 'a'.repeat(40), epoch: 1, actor: { role: 'tester', id: 'verifier:deterministic' } });
  assert.equal(fs.existsSync(path.join(dir, 'escaped-0.log')), false);
  assert.equal(fs.existsSync(path.join(artifactRoot, 'escaped-0.log')), false);
  for (const e of evidence) assert.ok(e.artifact === null || String(e.artifact).startsWith(artifactRoot + path.sep));
  const ok = { ...task, task_id: 't-ok', acceptance_checks: [{ ...task.acceptance_checks[0], id: 'unit' }] };
  await v.runChecks({ store, task: ok, cwd: dir, sha: 'a'.repeat(40), epoch: 1, actor: { role: 'tester', id: 'verifier:deterministic' } });
  assert.ok(fs.existsSync(path.join(artifactRoot, 't-ok', 'a'.repeat(12), 'unit-0.log')));
});
