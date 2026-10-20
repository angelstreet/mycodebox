// Independent verification of v2/02-task-core (3a4fb9e). Passing tests pin guards that hold; `todo` tests
// document defects found by the verifier and pass once the defect is fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskStore, actorKey } from '../orchestration/store.js';
import { loadPolicy, checkAction, restrictedTopics } from '../orchestration/policy.js';
import { narrowsParent, normalizeTask } from '../orchestration/task-contract.js';
import { spec, clock, SHA_A, SHA_B } from './fixtures/v2-task.js';
import { tmp as mkTmp } from './helpers-tmp.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkTmp('v2-verify-');
const open = (dir = tmp()) => createTaskStore({ dir, ...clock() });
const PATH = ['clarified', 'planned', 'ready', 'executing', 'evaluating'];
const toState = async (s, id, last = 'evaluating') => { for (const x of PATH.slice(0, PATH.indexOf(last) + 1)) await s.transition(id, x); };
const DEV = { role: 'developer', id: 'dev-agent-1' };
const VERIFIER = { role: 'verifier', id: 'verifier-agent-2' };
const pass = (s, id, sha = SHA_A, check_id = 'unit', exit = 0) =>
  s.recordEvidence(id, { check_id, sha, command: ['npm', 'test'], exit, actor: 'runner' });
const logOf = (dir, id) => readFileSync(join(dir, 'tasks', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// A task at evaluating with passing evidence on SHA_A by DEV; only the verdict is missing.
async function readyToAccept(s) {
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  await s.setHead(id, SHA_A, { actor: DEV });
  await pass(s, id);
  return id;
}
const UNMET = { code: 'E_ACCEPTANCE_UNMET' };

// ---- acceptance guard: what holds ----

test('verify: raw events cannot smuggle acceptance (string exit, foreign epoch, verdict/kind mismatch, bare pass signal)', async () => {
  const s = open();
  const id = await readyToAccept(s);
  await assert.rejects(s.append(id, { event_id: 'ev-s', kind: 'evidence.recorded', payload: { check_id: 'unit', sha: SHA_A, command: ['npm', 'test'], exit: '0', duration_ms: null, artifact: null, actor: 'runner' } }), { code: 'E_INVALID' });
  // Evidence for SHA_B recorded while the head is A, with a smuggled epoch: the store stamps its own epoch.
  await s.append(id, { event_id: 'ev-e', kind: 'evidence.recorded', payload: { check_id: 'unit', sha: SHA_B, command: ['npm', 'test'], exit: 0, duration_ms: null, artifact: null, actor: 'runner', epoch: 99 } });
  await s.setHead(id, SHA_B, { actor: DEV });
  await s.recordVerdict(id, { sha: SHA_B, actor: VERIFIER, verdict: 'approve', findings: [] });
  await assert.rejects(s.transition(id, 'accepted'), UNMET);
  await assert.rejects(s.append(id, { event_id: 'vf', kind: 'verification.failed', payload: { sha: SHA_B, actor: 'v9', verdict: 'approve', findings: [] } }), { code: 'E_INVALID_EVENT' });
  await s.append(id, { event_id: 'vp', kind: 'verification.passed', payload: {} });   // a signal, not a verdict
  await assert.rejects(s.transition(id, 'accepted'), UNMET);
  await assert.rejects(s.append(id, { event_id: 'done', kind: 'task.transitioned', payload: { to: 'accepted' } }), UNMET);
  assert.equal((await s.get(id)).status, 'evaluating');
});

test('verify: a verifier later recorded as a developer of the SHA loses independence; same-SHA setHead keeps evidence', async () => {
  const s = open();
  const id = await readyToAccept(s);
  await s.recordVerdict(id, { sha: SHA_A, actor: VERIFIER, verdict: 'approve', findings: [] });
  await s.setHead(id, SHA_A);   // same sha, no actor: nothing invalidated
  await s.setHead(id, SHA_A, { actor: VERIFIER });
  await assert.rejects(s.transition(id, 'accepted'), (e) => /self-approval/.test(e.message));
});

test('verify: acceptance needs an approve from an actor whose identity differs beyond case and whitespace', async () => {
  for (const actor of [{ role: 'verifier', id: 'DEV-AGENT-1' }, ' dev-agent-1 ', 'Dev-Agent-1']) {
    const s = open();
    const id = await readyToAccept(s);
    await s.recordVerdict(id, { sha: SHA_A, actor, verdict: 'approve', findings: [] });
    await assert.rejects(s.transition(id, 'accepted'), UNMET, JSON.stringify(actor));
  }
  assert.equal(actorKey(' A '), actorKey('a'));
});

test('verify: actors without an id cannot show independence', async () => {
  const s = open();
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id);
  await s.setHead(id, SHA_A, { actor: { role: 'developer', runtime: 'claude', model: 'm' } });
  await pass(s, id);
  await s.recordVerdict(id, { sha: SHA_A, actor: { role: 'verifier', runtime: 'claude', model: 'm' }, verdict: 'approve', findings: [] });
  await assert.rejects(s.transition(id, 'accepted'), UNMET);
});

// ---- dedup, seq, recovery ----

test('verify: same event_id with a different payload is dropped (first write wins) and seq stays dense', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  await s.append(id, { event_id: 'e1', kind: 'task.started', payload: { a: 1 } });
  assert.equal((await s.append(id, { event_id: 'e1', kind: 'task.cancelled', payload: {} })).applied, false);
  assert.equal((await s.get(id)).status, 'created');
  assert.deepEqual(logOf(dir, id).map((e) => e.seq), [1, 2]);
});

test('verify: an explicit seq cannot push the log past a representable integer', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  await s.append(id, { event_id: 'big', kind: 'task.started', seq: Number.MAX_SAFE_INTEGER }).catch(() => {});
  await s.append(id, { event_id: 'n1', kind: 'task.started' }).catch(() => {});
  await s.append(id, { event_id: 'n2', kind: 'task.started' }).catch(() => {});
  const seqs = logOf(dir, id).map((e) => e.seq);
  assert.equal(new Set(seqs).size, seqs.length, `duplicate seq on disk: ${seqs}`);
  assert.deepEqual((await open(dir).recover()).corrupt, []);
});

test('verify: recover() called while a write is queued does not duplicate seq', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  await Promise.allSettled([s.append(id, { event_id: 'w1', kind: 'task.started' }), s.recover(), s.append(id, { event_id: 'w2', kind: 'task.started' })]);
  await s.append(id, { event_id: 'w3', kind: 'task.started' });
  assert.deepEqual(logOf(dir, id).map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual((await open(dir).recover()).corrupt, []);
});

test('verify: a task with a corrupt log is marked as such in reads, not shown as a healthy partial state', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  await s.transition(id, 'clarified');
  await s.transition(id, 'planned');
  const p = join(dir, 'tasks', id, 'events.jsonl');
  const lines = readFileSync(p, 'utf8').split('\n');
  writeFileSync(p, [lines[0], 'garbage', lines[1], lines[2], ''].join('\n'));
  const s2 = open(dir);
  await s2.recover();
  const v = await s2.get(id);
  assert.ok(v.store_error || v.corrupt || v.outcome === 'unknown', `view: ${JSON.stringify({ status: v.status, outcome: v.outcome })}`);
});

test('verify: __proto__ keys in persisted JSON never pollute prototypes; prototype-named ids are rejected or inert', async () => {
  const dir = tmp();
  const s = open(dir);
  const { task_id: id } = await s.createTask(spec());
  const dec = JSON.parse(`{"decision_id":"d1","task_id":"${id}","ts":"2026-01-01T00:00:00Z","kind":"k","question":"q","alternatives":[{"option":"a","pros":[],"cons":[]}],"chosen":"a","evidence":[],"expected_effect":"e","rationale":"r","actor":{"role":"m","runtime":null,"model":null},"confidence":null,"policy_ref":null,"reversible":false,"rollback":null,"__proto__":{"polluted":true}}`);
  const env = (seq, kind, payload, extra = '') => `{"event_id":"pp${seq}","task_id":"${id}","run_id":null,"attempt_id":null,"seq":${seq},"schema_version":1,"timestamp":"2026-01-01T00:00:00Z","runtime":null,"provider":null,"model":null,"kind":"${kind}","causation_id":null,"payload":${JSON.stringify(payload)}${extra}}\n`;
  appendFileSync(join(dir, 'tasks', id, 'events.jsonl'), env(2, 'decision.recorded', dec) + env(3, 'task.started', {}, ',"__proto__":{"polluted2":true}'));
  const r = await open(dir).recover();
  assert.equal(({}).polluted, undefined);
  assert.equal(({}).polluted2, undefined);
  assert.equal(r.corrupt.length, 1);   // the envelope-level __proto__ is an unknown field
  await assert.rejects(s.createTask(spec({ task_id: '__proto__' })), { code: 'E_INVALID_TASK' });
  const t = await s.createTask(spec({ task_id: 'constructor' }));
  await s.transition(t.task_id, 'clarified');
  assert.equal((await s.get('constructor')).status, 'clarified');
  assert.equal(Object.prototype.phase, undefined);
});

test('verify: effect ids that are Object.prototype names are usable', async () => {
  const s = open();
  const { task_id: id } = await s.createTask(spec());
  await toState(s, id, 'executing');
  await s.recordEffect(id, { effect_id: 'constructor', idempotency_key: 'k1', kind: 'push', phase: 'attempted' });
  assert.equal(Object.prototype.phase, undefined);
});

test('verify: policy snapshot immutability compares content, not a caller-supplied hash', async () => {
  const s = open();
  const { task_id: id } = await s.createTask(spec());
  await s.snapshotPolicy(id, { v: 1 }, { run_id: 'r1' });
  const { hash } = (await s.get(id)).policy_snapshot;
  await s.append(id, { event_id: 'ps2', kind: 'policy.snapshot', payload: { run_id: 'r1', hash, policy: { v: 'other' } } }).catch(() => {});
  assert.deepEqual((await s.get(id)).policy_snapshot.policy, { v: 1 });
});

test('verify: task.created cannot be appended to an existing or unknown task; task ids cannot escape the store dir', async () => {
  const s = open();
  const t = await s.createTask(spec());
  await assert.rejects(s.append(t.task_id, { event_id: 'c2', kind: 'task.created', payload: { task: { ...t, status: 'accepted' } } }), { code: 'E_EXISTS' });
  await assert.rejects(s.append('new-id', { event_id: 'c3', kind: 'task.created', payload: { task: {} } }), { code: 'E_NOT_FOUND' });
  for (const task_id of ['a/../../x', 'a\\..\\x', '..', '.hidden', 'x'.repeat(129), 'sp ace']) {
    await assert.rejects(s.createTask(spec({ task_id })), { code: 'E_INVALID_TASK' }, task_id);
  }
});

// ---- policy ----

test('verify: a task allowlist cannot widen the project allowlist', () => {
  const p = loadPolicy(REPO);
  const t = normalizeTask(spec({ runtime_allowlist: ['evil-cli'], model_allowlist: ['m-evil'] }), clock());
  assert.equal(checkAction(p, t, { class: 'run_agent', runtime: 'evil-cli' }).allow, false);
  const p2 = loadPolicy(REPO);
  p2.policy.allowlists.models = ['m-1'];
  assert.equal(checkAction(p2, t, { class: 'run_agent', model: 'm-evil' }).allow, false);
});

test('verify: sample .ai/project.json does not allowlist arbitrary execution via rg --pre or edits under .git', () => {
  const p = loadPolicy(REPO);
  const t = normalizeTask(spec(), clock());
  assert.equal(checkAction(p, t, { class: 'run_command', argv: ['rg', '--pre', 'sh', 'x'] }).allow, false);
  assert.equal(checkAction(p, t, { class: 'edit', paths: ['.git/hooks/pre-commit'] }).allow, false);
});

test('verify: path checks hold (traversal, absolute, ./ prefix, case, near-miss prefixes)', () => {
  const p = loadPolicy(REPO);
  const t = normalizeTask(spec(), clock());
  for (const path of ['README.md/../.env', '..', '/etc/passwd', 'C:\\x', '\\\\srv\\x']) {
    const r = checkAction(p, t, { class: 'read', paths: [path] });
    assert.deepEqual([r.allow, r.needs_approval], [false, false], path);
  }
  assert.equal(checkAction(p, t, { class: 'read', paths: ['./.env'] }).allow, false);
  assert.equal(checkAction(p, t, { class: 'edit', paths: ['.ai2/x'] }).allow, true);   // not under .ai
  assert.equal(checkAction(p, t, { class: 'edit', paths: ['.ai'] }).needs_approval, true);
  assert.equal(checkAction(p, t, { class: 'read', paths: ['.env.production'] }).allow, false);   // credentials topic
});

test('verify: T02 cheap splits and protected-branch names are caught', () => {
  for (const [text, cls] of [['please de ploy it', 'deploy'], ['dep loy the build', 'deploy'], ['merge into master', 'merge_protected'], ['npm publish', 'push_shared']]) {
    assert.ok(restrictedTopics(text).some((x) => x.class === cls), text);
  }
});

test('verify: T02 matcher catches the documented obfuscations (regression pin for the verifier probe set)', () => {
  const want = { 'd-e-p-l-o-y': 'deploy', 'd e p l o y': 'deploy', 'de_ploy': 'deploy', 'dep\u200bloy': 'deploy', 'release to prod': 'deploy', pr0d: 'deploy',
    'push to m-a-i-n': 'merge_protected', 'force push': 'push_shared', 'DROP TABLE users': 'destructive', 'rotate keys': 'credentials', 'the a p i k e y': 'credentials',
    '\uFF21\uFF30\uFF29 \uFF2B\uFF25\uFF39': 'credentials', 'set up billing': 'money', 'the cust0mer': 'customer', D3PL0Y: 'deploy', 'd\u0435ploy': 'deploy' };
  for (const [text, cls] of Object.entries(want)) assert.ok(restrictedTopics(text).some((x) => x.class === cls), text);
  assert.deepEqual(restrictedTopics('add a link to the README'), []);
});

// ---- subtasks ----

test('verify: a child cannot widen runtime_capabilities beyond its parent', () => {
  const parent = normalizeTask(spec({ runtime_capabilities: ['edit'] }), clock());
  assert.equal(narrowsParent(parent, { ...parent, runtime_capabilities: ['edit', 'shell', 'network'] }).ok, false);
});

test('verify: conflicting top-level and budget_policy caps are rejected or reconciled', () => {
  const parent = normalizeTask(spec({ budget_policy: { mode: 'cap', max_usd: 5 } }), clock());
  const child = { ...parent, budget_policy: { mode: 'cap', max_usd: 2 }, max_usd: 50 };
  assert.equal(narrowsParent(parent, child).ok, false);
});

test('verify: narrowing holds for missing child fields (inherit is not assumed)', () => {
  const parent = normalizeTask(spec({ runtime_allowlist: ['claude'], excluded_paths: ['secrets'], deadline: '2026-02-01T00:00:00Z' }), clock());
  const { runtime_allowlist, excluded_paths, deadline, prohibited_actions, approval_policy, ...bare } = parent;
  const r = narrowsParent(parent, bare);
  assert.equal(r.ok, false);
  for (const f of ['runtime_allowlist', 'excluded_paths', 'deadline', 'prohibited_actions', 'approval_policy.requires']) assert.ok(r.violations.some((v) => v.field === f), f);
});
