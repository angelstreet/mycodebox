// GL14 / T39 / GL12: the full disposable-repo path through the real goal loop AND the real integration controller:
// intake -> task worktree -> several repair loops -> independent verifier -> integration staging on a disposable bare
// remote -> CI-equivalent gates on the exact merge SHA -> fake remote CI -> owner approval bound to that SHA ->
// merged, release verified, accepted. Synthetic data only; the trace is written under the test's temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createV2Http } from '../orchestration/http.js';
import { sandbox, world, mkOrigin, makeDelivery, fakeRemoteCi, states, loopDecisions, devRuns,
  GOOD, BAD, THROWS, GAMED, APPROVE, REJECT_GAMED } from './fixtures/v2-world.js';

const sb = sandbox('v2-acc-gl14-');
const OWNER = { role: 'owner', id: 'owner-1' };
const DELIVER = { review_policy: { mode: 'goal_loop', independent_review: true, deliver: true }, scope: { paths: ['src', 'test'] } };

function delivery({ dev, rev }) {
  const o = mkOrigin(sb);
  const ci = fakeRemoteCi(o);
  const box = {};
  const integrate = (...a) => box.hook(...a);
  integrate.reconcile = (...a) => box.hook.reconcile(...a);
  const env = world(sb, { repo: { dir: o.repo, sha: o.sha }, dev, rev, loopOpts: { integrate } });
  const c = makeDelivery(sb, o, { store: env.store, ci });   // orchestration/delivery.js over the real controller
  box.hook = c.integrate;
  box.hook.runs = c.runs;
  return { o, ci, env, c, hook: box.hook };
}
// The owner approves exactly what the controller asked for: the loop's request carries the delivery key
// integration:<action>:<repo>:<target>:<sha>, and the grant covers that key only.
async function ownerApproves(env, id, required) {
  const v = await env.view(id);
  const asked = v.decisions.filter((d) => d.loop?.patch?.approval).at(-1).loop.patch.approval;
  assert.deepEqual(asked.keys, [`integration:${required.action}:demo:${required.target}:${required.sha}`], 'the loop request names the exact action, repo, target and SHA');
  await env.loop.approve(id, { actor: OWNER, approval_ref: `owner-${required.action}-${required.sha.slice(0, 8)}`,
    grants: { classes: [required.class] } });
}
const lastRequired = (hook) => hook.runs.filter((r) => r.outcome === 'awaiting_approval').at(-1).required;

test('GL14/T39: intake -> worktree -> repair loops -> independent verifier -> integration on a disposable remote -> gates -> remote CI -> SHA-bound owner approval -> accepted; machine-readable trace', async () => {
  // Two failing implementations, one test-gaming patch the reviewer rejects, then the real fix.
  const { o, ci, env, c, hook } = delivery({ dev: [BAD, THROWS, GAMED, GOOD], rev: [REJECT_GAMED, APPROVE] });
  const before = o.head();
  const task = await env.submit(DELIVER, { source: 'ui' });
  const id = task.task_id;

  // Run 1: repairs, review, hand-off; gates green; CI has never seen the SHA: publishing the candidate needs the owner.
  let r = await env.loop.run(id);
  assert.equal(r.state, 'awaiting_approval');
  const push = lastRequired(hook);
  assert.deepEqual([push.action, push.class, push.target], ['push', 'push_shared', 'v2int/main']);
  assert.equal(o.head('v2int/main'), null, 'nothing published without approval');
  for (let i = 0; i < 3; i++) { env.advance(7 * 24 * 3600_000); assert.equal((await env.loop.step(id)).transitioned, false, 'silence is not approval'); }
  await ownerApproves(env, id, push);
  // Run 2: candidate published; CI pending -> waiting (D-007), then success; the merge needs its own approval.
  r = await env.loop.run(id);
  assert.equal(r.state, 'awaiting_approval');
  const merge = lastRequired(hook);
  assert.deepEqual([merge.action, merge.class, merge.target, merge.sha], ['merge', 'merge_protected', 'main', push.sha]);
  assert.equal(o.head('v2int/main'), push.sha);
  assert.equal(o.head(), before, 'main untouched until the merge approval');
  // The owner decides in the dashboard: the V2 HTTP layer shows the request bound to the integration SHA, not the
  // developer head, and records a grant carrying the request's key.
  const api = createV2Http({ store: env.store, intake: env.intake });
  const http = (method, pathname, body) => api.handle({ method, pathname, readBody: async () => body });
  const board = (await http('GET', '/api/v2/tasks')).body;
  const queued = board.approvals.find((a) => a.task_id === id);
  const mkey = `integration:merge:demo:main:${merge.sha}`;
  assert.deepEqual([queued.sha, queued.keys, queued.classes], [merge.sha, [mkey], ['merge_protected']], 'the approval queue names the integration SHA and its key');
  assert.match(queued.question, new RegExp(merge.sha));
  const devHead = (await env.view(id)).head_sha;
  assert.notEqual(devHead, merge.sha);
  assert.equal((await http('POST', `/api/v2/tasks/${id}/approve`, { action_id: queued.action_id, sha: devHead })).body.code, 'E_SHA_MISMATCH', 'approving the developer head does not approve the merge');
  const ok = await http('POST', `/api/v2/tasks/${id}/approve`, { action_id: queued.action_id, sha: merge.sha, reason: 'merge reviewed' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  r = await env.loop.run(id);
  assert.equal(r.state, 'accepted');
  // The UI read model of the finished task (orchestration/http.js detail).
  const ui = (await http('GET', `/api/v2/tasks/${id}`)).body.task;
  assert.deepEqual([ui.state, ui.outcome, ui.delivery], ['accepted', 'done', { requested: true, integrated: true, label: 'integrated' }]);
  assert.deepEqual(ui.acceptance_checks.map((x) => [x.id, x.status, x.latest_evidence.sha]), [['unit', 'passing_on_head', ui.head_sha]]);
  assert.ok(ui.verdicts.some((x) => x.current && x.verdict === 'approve' && x.sha === ui.head_sha));
  assert.ok(ui.verdicts.some((x) => !x.current && x.verdict === 'reject'), 'the rejected SHA is shown as not current');
  for (const k of ['repair', 'integration_result', 'accept']) assert.ok(ui.decisions.some((d) => d.kind === k), `decision ${k} shown`);
  assert.deepEqual(ui.leases.effects.filter((e) => ['push', 'merge'].includes(e.kind)).map((e) => [e.kind, e.phase]), [['push', 'confirmed'], ['merge', 'confirmed']]);
  assert.deepEqual(ui.history.slice(-2).map((h) => h.to), ['release_verifying', 'accepted']);
  assert.equal(ui.usage.usd, null, 'unknown cost shown as unknown');
  assert.equal(ui.pending_approval, null);

  const v = await env.view(id);
  const S = merge.sha;
  const devSha = v.head_sha;
  // Repair loops: four developer runs, the first three rejected by tests or by the independent reviewer.
  assert.equal(env.devStarts(), 4);
  assert.deepEqual(loopDecisions(v, 'repair').length, 3);
  const unit = v.evidence.filter((e) => e.check_id === 'unit');
  assert.equal(new Set(unit.map((e) => e.sha)).size, 4, 'checks ran on each developer SHA');
  assert.ok(unit.filter((e) => e.sha !== devSha).some((e) => e.exit !== 0));
  assert.ok(unit.some((e) => e.sha === devSha && e.exit === 0));
  // Independent verifier: rejected the gamed SHA, approved the final one; never the developer runtime.
  const devEntries = new Set(devRuns(env, id).map((x) => x.entry));
  assert.deepEqual(v.verdicts.map((x) => x.verdict), ['reject', 'approve']);
  assert.ok(v.verdicts.every((x) => !devEntries.has(x.actor.id)));
  assert.equal(v.verdicts.at(-1).sha, devSha);
  // Integration: the merge commit has exactly main-before and the developer SHA as parents; gates ran on S.
  assert.equal(o.head(), S);
  assert.deepEqual(o.parents(S), [before, devSha]);
  assert.ok(v.evidence.some((e) => e.check_id === 'integration:unit' && e.sha === S && e.exit === 0));
  assert.deepEqual(v.effects.filter((e) => ['push', 'merge'].includes(e.kind)).map((e) => [e.kind, e.phase]), [['push', 'confirmed'], ['merge', 'confirmed']]);
  assert.ok(v.effects.every((e) => e.phase === 'confirmed'));
  // CI was pending once and green on the exact SHA before the merge; the approvals name that SHA.
  const seq = ci.log.filter((x) => x.sha === S).map((x) => x.status).filter((x, i, a) => x !== a[i - 1]);
  assert.deepEqual(seq, ['missing', 'pending', 'success'], 'never merged on missing or pending CI');
  const merged = hook.runs.find((x) => x.outcome === 'merged');
  assert.deepEqual(merged.manifest.approvals.map((x) => [x.action, x.sha, x.target]), [['merge', S, 'main']]);
  assert.deepEqual(merged.manifest.leases.map((l) => l.resource), ['repo:demo:integration', 'repo:demo:main']);
  // Lifecycle through delivery.
  const st = states(v);
  for (const s of ['clarified', 'planned', 'ready', 'executing', 'evaluating', 'repair', 'integrating', 'awaiting_approval', 'waiting', 'release_verifying', 'accepted']) assert.ok(st.includes(s), s);
  assert.ok(v.history.some((h) => h.from === 'waiting' && h.to === 'integrating'), 'CI pending parks in waiting and resumes integrating');
  assert.equal(v.outcome, 'done');
  // The controller's own transitions were proposals; the loop applied each of them, in order, as the single writer.
  assert.deepEqual([...new Set(c.wanted().filter((w) => w.task_id === id && w.to !== 'integrating').map((w) => w.to))], ['awaiting_approval', 'waiting', 'release_verifying']);
  assert.ok(v.history.every((h) => h.actor === 'goal-loop'), 'every task transition was written by the loop itself');
  assert.equal(new Set(env.events(id).map((e) => e.event_id)).size, env.events(id).length, 'no duplicate event');

  // Machine-readable trace (synthetic), then read back and assert.
  const trace = {
    schema: 'mycodebox.v2.gl14-trace/1', synthetic: true, task_id: id, created_by: v.created_by, final_state: v.status, outcome: v.outcome,
    states: st, developer_runs: devRuns(env, id).map((x) => x.entry), reviewer_runs: devRuns(env, id, 'reviewer').map((x) => x.entry),
    evidence: v.evidence.map((e) => ({ check_id: e.check_id, sha: e.sha, exit: e.exit })), verdicts: v.verdicts.map((x) => ({ sha: x.sha, actor: x.actor.id, verdict: x.verdict })),
    decisions: v.decisions.map((d) => ({ kind: d.kind, chosen: d.chosen })),
    integration: hook.runs.map((x) => ({ outcome: x.outcome, integration_sha: x.integration_sha ?? null, required: x.required ?? null,
      target_sha_before: x.manifest?.rounds?.at(-1)?.target_sha ?? null, remote_ci: x.manifest?.rounds?.at(-1)?.remote_ci?.status ?? null })),
    remote: { main_before: before, main_after: o.head(), candidate: o.head('v2int/main'), merge_parents: o.parents(S) },
    ci: ci.log, effects: v.effects.map((e) => ({ kind: e.kind, phase: e.phase })), usage_totals: v.usage_totals,
    ui: { state: ui.state, outcome: ui.outcome, delivery: ui.delivery, checks: ui.acceptance_checks.map((x) => ({ id: x.id, status: x.status })),
      decisions: ui.decisions.length, approval_shown: { sha: queued.sha, keys: queued.keys } },
  };
  const out = path.join(sb.TMP, 'gl14-trace.json');
  fs.writeFileSync(out, `${JSON.stringify(trace, null, 1)}\n`);
  if (process.env.V2_TRACE_DIR) fs.copyFileSync(out, path.join(process.env.V2_TRACE_DIR, 'gl14-trace.json'));
  const back = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(back.final_state, 'accepted');
  assert.equal(back.developer_runs.length, 4);
  assert.deepEqual(back.integration.map((x) => x.outcome), ['awaiting_approval', 'ci_blocked', 'awaiting_approval', 'merged']);
  assert.ok(back.integration.every((x) => x.integration_sha === S), 'one integration SHA across every run');
  assert.deepEqual(back.remote, { main_before: before, main_after: S, candidate: S, merge_parents: [before, devSha] });
  assert.equal(back.usage_totals.usd, null, 'unknown spend stays unknown');
  assert.deepEqual([back.ui.state, back.ui.delivery.label, back.ui.approval_shown.sha], ['accepted', 'integrated', S]);
  assert.ok(!JSON.stringify(back).includes(sb.TMP), 'no local paths in the trace');
});

test('GL12/T28: integration branch with new upstream commits: the approved SHA goes stale, gates and CI rerun on the rebuilt SHA, a fresh approval is required', async () => {
  const { o, env, hook } = delivery({ dev: [GOOD], rev: [APPROVE] });
  const task = await env.submit(DELIVER);
  const id = task.task_id;
  assert.equal((await env.loop.run(id)).state, 'awaiting_approval');
  await ownerApproves(env, id, lastRequired(hook));                     // candidate push of S1
  assert.equal((await env.loop.run(id)).state, 'awaiting_approval');
  const m1 = lastRequired(hook);
  assert.equal(m1.action, 'merge');
  const S1 = m1.sha;
  await ownerApproves(env, id, m1);                                     // the owner approves S1 ...
  const up = o.upstream('NOTES.md', 'upstream change\n');               // ... but main moves before the merge runs
  const r = await env.loop.run(id);
  assert.equal(r.state, 'awaiting_approval', 'the approval for S1 does not cover the rebuilt SHA');
  const p2 = lastRequired(hook);
  const S2 = p2.sha;
  assert.notEqual(S2, S1);
  assert.deepEqual([p2.action, p2.target], ['push', 'v2int/main'], 'the rebuilt SHA is a new candidate: CI has not seen it');
  assert.equal(o.head(), up, 'nothing merged on the stale approval');
  const v1 = await env.view(id);
  assert.ok(v1.evidence.some((e) => e.check_id === 'integration:unit' && e.sha === S2 && e.exit === 0), 'gates reran on the rebuilt SHA');
  await ownerApproves(env, id, p2);
  assert.equal((await env.loop.run(id)).state, 'awaiting_approval');
  const m2 = lastRequired(hook);
  assert.deepEqual([m2.action, m2.sha, m2.target], ['merge', S2, 'main'], 'green CI on S2, and a merge approval for S2 is required');
  await ownerApproves(env, id, m2);
  assert.equal((await env.loop.run(id)).state, 'accepted');
  const v = await env.view(id);
  assert.equal(v.status, 'accepted');
  assert.equal(o.head(), S2);
  assert.deepEqual(o.parents(S2), [up, v.head_sha]);
  const merged = hook.runs.find((x) => x.outcome === 'merged');
  assert.deepEqual(merged.manifest.approvals.filter((x) => x.action === 'merge').map((x) => x.sha), [S2]);
  assert.ok(hook.runs.every((x) => x.outcome !== 'merged' || x.integration_sha === S2));
});
