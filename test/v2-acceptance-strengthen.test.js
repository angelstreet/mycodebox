// Rows the independent verifier marked WEAK, strengthened: T09 (bounded fix/review/abort), GL09 (credentials and
// push/merge silence), GL12 (reopen after a crash and after an integration merge conflict revalidates on the current
// SHA). Real git, fake runtimes, the delivery bridge over the real controller on a disposable bare remote.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, world, mkOrigin, makeDelivery, fakeRemoteCi, states, loopDecisions, devRuns,
  GOOD, BAD, APPROVE } from './fixtures/v2-world.js';

const sb = sandbox('v2-acc-strong-');
const OWNER = { role: 'owner', id: 'owner-1' };
const DELIVER = { review_policy: { mode: 'goal_loop', independent_review: true, deliver: true }, scope: { paths: ['src', 'test'] } };

function delivery(opts) {
  const o = mkOrigin(sb);
  const ci = fakeRemoteCi(o);
  const box = {};
  const integrate = (...a) => box.hook(...a);
  integrate.reconcile = (...a) => box.hook.reconcile(...a);
  const env = world(sb, { repo: { dir: o.repo, sha: o.sha }, ...opts, loopOpts: { integrate, ...(opts.loopOpts || {}) } });
  const c = makeDelivery(sb, o, { store: env.store, ci });
  box.hook = c.integrate;
  return { o, ci, env, c };
}
const lastRequired = (c) => c.runs.filter((r) => r.next === 'awaiting_approval' && r.required).at(-1).required;
const approve = (env, id, req) => env.loop.approve(id, { actor: OWNER, approval_ref: `ok-${req.action}-${req.sha.slice(0, 8)}`, grants: { classes: [req.class] } });

// ---- T09 ------------------------------------------------------------------------------------------------------------

test('T09: a unit test that keeps failing never completes: targeted repairs, forced strategy changes, no review of a failing SHA, a bounded no-progress stop, and the owner can abort', async () => {
  const env = world(sb, { dev: [BAD], rev: [APPROVE] });
  const task = await env.submit();
  const r = await env.loop.run(task.task_id);
  assert.equal(r.state, 'waiting');
  let v = await env.view(task.task_id);
  assert.ok(!states(v).includes('accepted'));
  await assert.rejects(env.store.transition(task.task_id, 'accepted', { actor: 'x' }));
  assert.ok(v.evidence.length >= 2 && v.evidence.every((e) => e.exit !== 0), 'every check run failed');
  assert.equal(devRuns(env, task.task_id, 'reviewer').length, 0, 'a failing SHA is never sent to review');
  assert.ok(loopDecisions(v, 'repair').length >= 1, 'fix: targeted repairs with feedback');
  assert.ok(loopDecisions(v, 'strategy_change').length >= 1, 'repeated identical failure changes strategy');
  assert.equal(loopDecisions(v, 'no_progress').length, 1, 'bounded: suspended with a diagnosis');
  const runs = env.devStarts();
  env.advance(30 * 24 * 3600_000);
  for (let i = 0; i < 3; i++) assert.equal((await env.loop.step(task.task_id)).transitioned, false);
  assert.equal(env.devStarts(), runs, 'no runaway: time alone starts nothing');
  // Abort: the owner cancels; nothing runs afterwards and the outcome is truthful.
  await env.loop.cancel(task.task_id, { actor: OWNER, reason: 'stop trying' });
  assert.equal((await env.loop.step(task.task_id)).terminal, true);
  v = await env.view(task.task_id);
  assert.deepEqual([v.status, v.outcome], ['cancelled', 'cancelled']);
  assert.equal(env.devStarts(), runs);
});

// ---- GL09 -----------------------------------------------------------------------------------------------------------

test('GL09: credentials need explicit authorization whatever the goal says; an agent asking for a secret is gated, a denial continues without it; silence never authorizes', async () => {
  const a = world(sb);
  const ta = await a.submit({ goal: 'Implement add(a, b) in src/math.js, then rotate the API key used by CI' });
  assert.equal((await a.loop.run(ta.task_id)).state, 'awaiting_approval');
  const req = a.events(ta.task_id).find((e) => e.kind === 'approval.requested');
  assert.ok(req.payload.classes.includes('credentials'), JSON.stringify(req.payload.classes));
  for (let i = 0; i < 4; i++) { a.advance(7 * 24 * 3600_000); assert.equal((await a.loop.step(ta.task_id)).transitioned, false); }
  assert.equal(a.devStarts(), 0, 'nothing ran on a credentials goal without approval');
  assert.equal((await a.view(ta.task_id)).outcome, 'needs_owner');

  const ask = [{ op: 'emit', event: { type: 'action_request', class: 'read', text: 'print the GitHub access token stored in .env' } }, ...GOOD];
  const b = world(sb, { dev: [ask, GOOD], rev: [APPROVE] });
  const tb = await b.submit();
  assert.equal((await b.loop.run(tb.task_id)).state, 'awaiting_approval');
  const q = b.events(tb.task_id).find((e) => e.kind === 'approval.requested' && e.payload.run_id);
  assert.ok(q.payload.classes.includes('credentials'), JSON.stringify(q.payload.classes));
  for (let i = 0; i < 3; i++) { b.advance(7 * 24 * 3600_000); assert.equal((await b.loop.step(tb.task_id)).transitioned, false); }
  await b.loop.deny(tb.task_id, { actor: OWNER, reason: 'no secrets for tasks' });
  assert.equal((await b.loop.run(tb.task_id)).state, 'accepted', 'denied action is skipped, the goal itself is reached');
  assert.ok(!b.events(tb.task_id).some((e) => e.kind === 'approval.granted'), 'never granted');
});

test('GL09: protected push and merge stay unapplied through owner silence; a denial ends the delivery with the remote untouched', async () => {
  const { o, env, c } = delivery({ dev: [GOOD], rev: [APPROVE] });
  const before = o.head();
  const id = (await env.submit(DELIVER)).task_id;
  assert.equal((await env.loop.run(id)).state, 'awaiting_approval');
  for (let i = 0; i < 4; i++) { env.advance(7 * 24 * 3600_000); assert.equal((await env.loop.step(id)).transitioned, false); }
  assert.equal(o.head('v2int/main'), null, 'no candidate push on silence');
  await approve(env, id, lastRequired(c));
  assert.equal((await env.loop.run(id)).state, 'awaiting_approval');
  assert.equal(lastRequired(c).action, 'merge');
  for (let i = 0; i < 4; i++) { env.advance(7 * 24 * 3600_000); assert.equal((await env.loop.step(id)).transitioned, false); }
  assert.equal(o.head(), before, 'no merge on silence');
  await env.loop.deny(id, { actor: OWNER, reason: 'not this release' });
  assert.equal((await env.loop.step(id)).state, 'failed_unrecoverable');
  assert.equal(o.head(), before);
  const v = await env.view(id);
  assert.deepEqual(v.effects.filter((e) => e.kind === 'merge'), [], 'no merge was ever attempted');
});

// ---- GL12 -----------------------------------------------------------------------------------------------------------

test('GL12: reopened after a controller crash, the task revalidates against the current worktree SHA: stale evidence and review never count', async () => {
  let crash = true;
  const env = world(sb, { dev: [GOOD], rev: [APPROVE, APPROVE] });
  env.reopen((s) => ({ ...s, recordVerdict: async (...a) => { if (crash) throw Object.assign(new Error('controller died during review'), { code: 'E_TEST_CRASH' }); return s.recordVerdict(...a); } }));
  const task = await env.submit();
  await assert.rejects(env.loop.run(task.task_id), { code: 'E_TEST_CRASH' });
  const v0 = await env.view(task.task_id);
  const sha1 = v0.head_sha;
  assert.ok(v0.evidence.some((e) => e.sha === sha1 && e.exit === 0), 'checks had passed on SHA1 before the crash');
  // While the controller is down, the task branch moves (someone commits in the worktree).
  const wt = env.wt(task.task_id);
  fs.writeFileSync(path.join(wt, 'src', 'extra.js'), 'export const extra = 2;\n');
  sb.sh(wt, 'add', '.'); sb.sh(wt, '-c', 'user.name=Other', '-c', 'user.email=other@example.invalid', 'commit', '-q', '-m', 'during the outage');
  const sha2 = sb.sh(wt, 'rev-parse', 'HEAD');
  crash = false;
  env.reopen();
  await env.loop.recover();
  assert.equal((await env.loop.run(task.task_id)).state, 'accepted');
  const v = await env.view(task.task_id);
  assert.equal(v.head_sha, sha2);
  assert.ok(loopDecisions(v, 'revalidate_sha').length >= 1, 'the SHA change was detected and recorded');
  assert.ok(v.evidence.some((e) => e.sha === sha2 && e.exit === 0), 'checks reran on the current SHA');
  assert.deepEqual(v.verdicts.map((x) => x.sha), [sha2], 'no verdict on the stale SHA counts or exists');
});

test('GL12: reopened after an integration merge conflict, the repaired SHA is re-verified and re-integrated; nothing from the conflicting SHA carries over', async () => {
  const { o, env, c } = delivery({ dev: [GOOD, GOOD], rev: [APPROVE, APPROVE] });
  const id = (await env.submit(DELIVER)).task_id;
  let up = null;
  // Upstream changes the same line while the first SHA is under review: its integration will conflict.
  env.ad.hooks.onRev = () => { if (!up) up = o.upstream('src/math.js', "export const add = () => { throw new Error('upstream rewrite'); };\n"); };
  // The developer's repair run resolves the conflict by merging the target into the task branch (keeping its add()).
  env.ad.hooks.onDev = () => {
    if (env.devStarts() !== 2) return;
    const wt = env.wt(id);
    sb.sh(wt, 'fetch', '-q', 'origin');
    sb.sh(wt, '-c', 'user.name=Dev User', '-c', 'user.email=dev@example.invalid', 'merge', '-q', '-X', 'ours', '-m', 'merge target', 'origin/main');
  };
  const r1 = await env.loop.run(id, { until: ['awaiting_approval'] });
  assert.equal(r1.state, 'awaiting_approval');
  const conflict = c.runs.find((x) => x.item_state === 'returned');
  assert.ok(conflict, JSON.stringify(c.runs.map((x) => [x.run_outcome, x.item_state])));
  assert.equal(conflict.next, 'repair');
  assert.deepEqual(conflict.feedback.detail.files, ['src/math.js']);
  const prompt2 = env.ad.log.dev[1].prompt;
  assert.match(prompt2, /src\/math\.js/, 'the conflict files reached the developer');
  const v1 = await env.view(id);
  const sha1 = v1.verdicts[0].sha;
  const sha2 = v1.head_sha;
  assert.notEqual(sha2, sha1);
  assert.ok(v1.evidence.some((e) => e.check_id === 'unit' && e.sha === sha2 && e.exit === 0), 'checks reran on the repaired SHA');
  assert.ok(v1.verdicts.some((x) => x.sha === sha2 && x.verdict === 'approve'), 'independent review reran on the repaired SHA');
  for (let i = 0; i < 4 && (await env.view(id)).status === 'awaiting_approval'; i++) {
    await approve(env, id, lastRequired(c));
    await env.loop.run(id, { until: ['accepted', 'awaiting_approval'] });
  }
  const v = await env.view(id);
  assert.equal(v.status, 'accepted');
  const S = o.head();
  assert.deepEqual(o.parents(S), [up, sha2], 'the merge is of the repaired SHA onto the moved target');
  const merged = c.runs.find((x) => x.item_state === 'merged' && x.manifest);
  assert.deepEqual(merged.manifest.items.map((i) => i.source_sha), [sha2], 'the conflicting SHA was never integrated');
  assert.ok(v.evidence.some((e) => e.check_id === 'integration:unit' && e.sha === S && e.exit === 0));
});
