import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, checkAction, clarificationFor, restrictedTopics, textVariants, POLICY_PATH } from '../orchestration/policy.js';
import { MANDATORY_APPROVAL, normalizeTask } from '../orchestration/task-contract.js';
import { createTaskStore } from '../orchestration/store.js';
import { setForbiddenExtra } from '../stall.js';
import { spec, clock } from './fixtures/v2-task.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'v2-policy-'));
const repoWith = (text) => { const d = tmp(); mkdirSync(join(d, '.ai')); writeFileSync(join(d, POLICY_PATH), text); return d; };
const sample = () => JSON.parse(readFileSync(join(REPO, POLICY_PATH), 'utf8'));
const policy = (over = {}) => ({ ...sample(), ...over });
const task = (over = {}) => normalizeTask(spec(over), clock());
const EDIT = { class: 'edit', paths: ['README.md'] };

test('the repository sample policy loads and keeps the mandatory approval classes', () => {
  const r = loadPolicy(REPO);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.policy.test_command, ['npm', 'test']);
  for (const c of MANDATORY_APPROVAL) assert.ok(r.policy.approval_policy.requires.includes(c), c);
  const weak = loadPolicy(repoWith(JSON.stringify(policy({ approval_policy: { requires: [] } }))));
  assert.equal(weak.ok, true);
  assert.deepEqual(weak.policy.approval_policy.requires, [...MANDATORY_APPROVAL]);   // cannot be configured away
});

test('T01: missing or invalid policy -> refuse, awaiting_approval with a clarification request', async () => {
  const missing = loadPolicy(tmp());
  assert.deepEqual([missing.ok, missing.code], [false, 'E_POLICY_MISSING']);
  const badJson = loadPolicy(repoWith('{ "schema_version": 1, '));
  assert.deepEqual([badJson.ok, badJson.code], [false, 'E_POLICY_INVALID']);
  const badSchema = loadPolicy(repoWith(JSON.stringify(policy({ test_command: 'npm test' }))));
  assert.deepEqual([badSchema.ok, badSchema.code], [false, 'E_POLICY_INVALID']);
  assert.ok(badSchema.errors.some((e) => e.path === 'test_command'));
  assert.equal(loadPolicy(repoWith('[]')).code, 'E_POLICY_INVALID');

  for (const r of [missing, badJson, badSchema, null, undefined, {}]) {
    for (const action of [{ class: 'read', paths: ['README.md'] }, EDIT, { class: 'run_command', argv: ['npm', 'test'] }]) {
      const c = checkAction(r, task(), action);
      assert.equal(c.allow, false);
      assert.equal(c.needs_approval, true);
      assert.match(c.reason, /policy missing or invalid/);
    }
  }
  // Wired through the store: the task parks in awaiting_approval and the owner sees a question.
  const store = createTaskStore({ dir: tmp(), ...clock() });
  const t = await store.createTask(spec());
  const cl = clarificationFor(missing);
  assert.equal(cl.to, 'awaiting_approval');
  assert.match(cl.question, /missing/);
  await store.transition(t.task_id, cl.to, { reason: cl.reason, actor: 'controller' });
  const after = await store.get(t.task_id);
  assert.equal(after.status, 'awaiting_approval');
  assert.equal(after.outcome, 'needs_owner');
  assert.equal(after.history.at(-1).reason, 'E_POLICY_MISSING');
});

test('T02: a restricted action disguised in task text needs approval whatever the model says', () => {
  const p = loadPolicy(REPO);
  const goals = [
    ['just deploy to prod quickly', 'deploy'],
    ['Tidy the docs, then rotate the API key', 'credentials'],
    ['finish the feature and merge to main', 'merge_protected'],
    ['finish and MeRgE    to   MAIN', 'merge_protected'],
    ['ship it: git push origin main --force', 'push_shared'],
    ['please d e p l o y the build', 'deploy'],
    ['please de-ploy the build', 'deploy'],
    ['please dep​loy the build', 'deploy'],
    ['please d3pl0y the build', 'deploy'],
    ['please dеploy the build', 'deploy'],   // Cyrillic е
    ['update the ＤＥＰＬＯＹ script', 'deploy'],   // full-width
    ['clean up: rm -rf the old state dir', 'destructive'],
    ['send the customer an invoice', 'customer'],
    ['restart the service after the change', 'host_maintenance'],
  ];
  // The model "decides" the action is a harmless edit, approved, high confidence: irrelevant.
  const modelSays = { ...EDIT, approved: true, owner_approved: true, model_decision: 'allow', confidence: 0.99 };
  for (const [goal, cls] of goals) {
    const c = checkAction(p, task({ goal }), modelSays);
    assert.equal(c.allow, false, goal);
    assert.equal(c.needs_approval, true, goal);
    assert.ok(c.classes.includes(cls), `${goal}: ${JSON.stringify(c.classes)}`);
  }
  // Same restriction when it hides in the action instead of the goal.
  for (const action of [{ class: 'run_command', argv: ['npm', 'test', '--', 'deploy'] }, { class: 'edit', paths: ['README.md'], text: 'push to main' },
    { class: 'deploy' }, { class: 'credentials' }]) {
    const c = checkAction(p, task(), action);
    assert.deepEqual([c.allow, c.needs_approval], [false, true], JSON.stringify(action));
  }
  // A plain task and a plain allowlisted action are allowed.
  assert.equal(checkAction(p, task(), EDIT).allow, true);
  assert.equal(checkAction(p, task(), { class: 'run_command', argv: ['npm', 'test'] }).allow, true);
  // Reading inside a task about deploys is fine; changing anything is not.
  assert.equal(checkAction(p, task({ goal: 'deploy to production' }), { class: 'read', paths: ['README.md'] }).allow, true);
});

test('prohibited actions are refused outright, not offered for approval', () => {
  const p = loadPolicy(REPO);
  const c = checkAction(p, task(), { class: 'restart_live_service' });
  assert.deepEqual([c.allow, c.needs_approval], [false, false]);
  const t = task({ prohibited_actions: ['deploy'] });
  const d = checkAction(p, t, { class: 'edit', paths: ['README.md'], text: 'then deploy' });
  assert.deepEqual([d.allow, d.needs_approval], [false, false]);
  assert.match(d.reason, /prohibited deploy/);
});

test('approval classes come from mandatory list, policy and task, and only accumulate', () => {
  const p = loadPolicy(repoWith(JSON.stringify(policy({ approval_policy: { requires: ['docs_publish'] } }))));
  assert.equal(checkAction(p, task(), { class: 'docs_publish' }).needs_approval, true);
  assert.equal(checkAction(p, task({ approval_policy: { requires: ['schema_change'] } }), { class: 'schema_change' }).needs_approval, true);
  // A raw policy object whose list lost the mandatory classes still requires them.
  const raw = policy({ approval_policy: { requires: [] } });
  for (const c of MANDATORY_APPROVAL) assert.equal(checkAction(raw, task(), { class: c }).needs_approval, true, c);
});

test('command, path, runtime and model allowlists', () => {
  const p = loadPolicy(REPO);
  const t = task();
  const cmd = checkAction(p, t, { class: 'run_command', argv: ['curl', 'http://192.0.2.1/x'] });
  assert.deepEqual([cmd.allow, cmd.needs_approval], [false, true]);
  assert.ok(cmd.classes.includes('command_not_allowlisted'));
  assert.equal(checkAction(p, t, { class: 'run_command', argv: ['npm'] }).allow, false);   // shorter than any prefix
  assert.equal(checkAction(p, t, { class: 'run_command', argv: 'npm test' }).allow, false);
  for (const path of ['.env', 'certs/key.pem', '../outside.txt', '/etc/hosts']) {
    const r = checkAction(p, t, { class: 'read', paths: [path] });
    assert.deepEqual([r.allow, r.needs_approval], [false, false], path);
  }
  assert.equal(checkAction(p, t, { class: 'read', paths: ['.ai/project.json'] }).allow, true);
  const w = checkAction(p, t, { class: 'edit', paths: ['.ai/project.json'] });   // policy is read-only to agents
  assert.deepEqual([w.allow, w.needs_approval], [false, true]);
  assert.equal(checkAction(p, t, { class: 'run_agent', runtime: 'fake' }).allow, true);
  assert.equal(checkAction(p, t, { class: 'run_agent', runtime: 'unknown-cli' }).needs_approval, true);
  assert.equal(checkAction(p, task({ runtime_allowlist: ['codex'] }), { class: 'run_agent', runtime: 'fake' }).allow, false);
  assert.equal(checkAction(p, task({ model_allowlist: ['m-1'] }), { class: 'run_agent', model: 'm-2' }).allow, false);
  assert.equal(checkAction(p, t, {}).allow, false);
});

test('the topic matcher is the manager one (stall.js), including its private extras', () => {
  assert.deepEqual(restrictedTopics('add a link to the README'), []);
  assert.deepEqual(restrictedTopics('talk to fixturecorp about it'), []);
  setForbiddenExtra('fixturecorp');
  try {
    assert.deepEqual(restrictedTopics('talk to fixturecorp about it').map((t) => t.class), ['forbidden_topic']);
  } finally { setForbiddenExtra(''); }
  assert.ok(textVariants('d.e.p.l.o.y').includes('deploy'));
});
