// Round 9 item 11: a session that waits on a job of its own is woken when the job ends; the harness flags what it cannot see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';

import { join } from 'node:path';
import { classifyStall } from '../stall.js';
import { jobRefs, waitsOnOwnJob, hasRef, createOwnJobs, descendants, jobPids } from '../own-jobs.js';
import { tmp } from './helpers-tmp.js';

const status = (line) => classifyStall({ plain: ['Started the final run.', line], state: 'done' });

test('STATUS blocked / waiting on a job of its own is own_job_wait (never a needs-you); owner and deploy waits keep their cases', () => {
  // only a concrete pid / log path / run id makes it the session's own job (round 9 review): words alone keep the old case, flagged for the live-child check
  for (const l of ['STATUS: waiting: run 7 (pid 4242)', 'STATUS: waiting: /tmp/fake-run/out.log to finish', 'STATUS: blocked: export job running, pid 31337, resumes when it completes', 'STATUS: waiting: run id: r-12']) {
    const s = status(l);
    assert.equal(s.case, 'own_job_wait', l); assert.equal(s.answer, null);
  }
  for (const l of ['STATUS: blocked - waiting on the final score_matrix run', 'STATUS: blocked: waiting for the CI run to finish', 'STATUS: blocked: the nightly job on prod must finish before I can merge', 'STATUS: blocked: tests running in the other session']) {
    const s = status(l);
    assert.equal(s.case, 'owner_decision', l); assert.equal(s.jobNoun, true, l);
  }
  assert.equal(status('STATUS: blocked: waiting for your decision on the schema').case, 'owner_decision');
  assert.equal(status('STATUS: blocked: tests fail on feat').case, 'owner_decision');
  assert.equal(status('STATUS: waiting: deploy d-42').case, 'waiting_deploy');
  assert.equal(status('STATUS: waiting: the owner go-ahead').case, 'waiting_deploy');
});
test('jobRefs / waitsOnOwnJob', () => {
  assert.deepEqual(jobRefs('waiting on pid 4242 and /tmp/fake-run/out.log nohup'), { deploy: null, pid: 4242, path: '/tmp/fake-run/out.log', run: null, watcher: null, integration: null, detached: true });
  assert.equal(jobRefs('deploy 3f9a').deploy, '3f9a');
  assert.equal(jobRefs('run id: r-12').run, 'r-12');
  assert.equal(waitsOnOwnJob('are you ok with the run?'), false);
  assert.equal(waitsOnOwnJob('waiting for the owner approval of the run'), false);
});

test('job refs: real STATUS lines waiting on a GitHub Actions run / a watcher task are the session\'s own job, not a manager deploy stop', () => {
  const A = 'dispatch 39512799794 on dfddba379 (testcase subroutes added to ALLOW_404); poll will resume when API Route Sweep completes.';
  const B = 'API Route Sweep on 39512799794 (dfddba379) in_progress since 23:19:34Z; poll will resume when it completes.';
  const C = 'the 19:00 CoC run for the live proof of BUG-0725 (watcher bg_1a2b284f, run ff3606fe still going)';
  for (const [t, run, watcher] of [[A, '39512799794', null], [B, '39512799794', null], [C, 'ff3606fe', 'bg_1a2b284f']]) {
    assert.equal(waitsOnOwnJob(t, 'waiting'), true, t);
    const r = jobRefs(t);
    assert.equal(hasRef(r), true, t); assert.equal(r.run, run, t); assert.equal(r.watcher, watcher, t);
    const s = status(`STATUS: waiting: ${t}`);
    assert.equal(s.case, 'own_job_wait', t); assert.equal(s.answer, null, t);
  }
  // every other way an id is written
  assert.equal(jobRefs('workflow run 98765432101 queued').run, '98765432101');
  assert.equal(jobRefs('https://github.com/o/r/actions/runs/39512799794 is green').run, '39512799794');
  assert.equal(jobRefs('run 3f9a1b2 still going').run, '3f9a1b2');
  assert.equal(jobRefs('run facade is over').run, null, 'an ordinary word is not a run id');
  assert.equal(jobRefs('watcher bg_1a2b284f is quiet').watcher, 'bg_1a2b284f');
  assert.equal(jobRefs('bg_1a2b284f still going').watcher, 'bg_1a2b284f');
  // never a run id: a date or time, a version, a percentage, a size, a number in a URL path, a compact date-time
  for (const t of ['in_progress since 2026-10-20T23:19:34Z', 'sweep is 12 percent done', 'log grew to 39512799794 bytes', 'https://ci.example.com/builds/39512799794 finished', 'version 2026.10.20-89466 is live', 'watcher since 202610202319']) assert.equal(jobRefs(t).run, null, t);
  // still not own jobs: the owner, a question, a review, credentials
  for (const t of ['waiting for the owner to approve deploy 3 of the CI run', 'are you ok with the run?', 'waiting for review', 'blocked: need credentials']) assert.equal(waitsOnOwnJob(t, 'waiting'), false, t);
  assert.equal(status('STATUS: waiting: deploy 3f9a still running').case, 'waiting_deploy', '^deploy stays the deploy case');
});
test('process tree: children of the agent except shells and helpers', () => {
  const table = { children: new Map([[10, [11]], [11, [12, 13]], [13, [14]]]), args: new Map([[11, 'bash -c run'], [12, 'sleep 5'], [13, 'python3 score_matrix.py --run r-12'], [14, 'worker']]) };
  assert.deepEqual(descendants(10, table), [11, 12, 13, 14]);
  assert.deepEqual(jobPids(10, table), [13, 14]);
});

function harness(over = {}) {
  const proc = tmp('fake-proc-');
  const sent = [], feed = [], logs = [];
  let t = 1_700_000_000_000;
  const state = { waiting: true, canSend: true, deploys: {}, table: { children: new Map(), args: new Map() }, agent: 10 };
  const jobs = createOwnJobs({
    now: () => t, procRoot: proc, table: async () => state.table, agentPid: async () => state.agent,
    deployState: (id) => state.deploys[id] || null, stillWaiting: () => state.waiting, canSend: () => state.canSend,
    send: async (s, text) => { sent.push({ s, text }); }, record: async (e) => { feed.push(e); }, log: (r) => logs.push(r), stableMin: 5, ...over,
  });
  const live = (pid, st = 'S') => { mkdirSync(join(proc, String(pid)), { recursive: true }); writeFileSync(join(proc, String(pid), 'stat'), `${pid} (python3) ${st} 1 1 1`); };
  const die = (pid) => rmSync(join(proc, String(pid)), { recursive: true, force: true });
  return { jobs, sent, feed, logs, state, live, die, advance: (ms) => { t += ms; }, proc, now: () => t };
}

test('a pid named in the STATUS line: polled in /proc, woken once when it ends (zombie counts as ended)', async () => {
  const h = harness();
  h.live(4242);
  const r = await h.jobs.watch('sess-a', { text: 'final score_matrix run (pid 4242)', stopAt: 'stop1' });
  assert.equal(r.kind, 'pid'); assert.equal(r.detached, false);
  assert.deepEqual(await h.jobs.tick(), []); assert.equal(h.sent.length, 0);
  assert.match(await h.jobs.progressOf('sess-a'), /still running \(pid 4242\)/);
  h.live(4242, 'Z');
  const woke = await h.jobs.tick();
  assert.equal(woke.length, 1);
  assert.match(h.sent[0].text, /^your job \(pid 4242\) finished at \d\d:\d\d UTC, continue$/);
  assert.deepEqual(await h.jobs.tick(), []); assert.equal(h.sent.length, 1);   // once
  assert.ok(h.logs.some((l) => l.type === 'own_job_wake' && l.session === 'sess-a'));
});
test('no reference in the line: the pane process tree is the job; waits for all children', async () => {
  const h = harness();
  h.state.table = { children: new Map([[10, [11]], [11, [12]]]), args: new Map([[11, 'bash -c x'], [12, 'python3 score_matrix.py']]) };
  h.live(12);
  const r = await h.jobs.watch('sess-b', { text: 'waiting on the final score_matrix run', stopAt: 's' });
  assert.equal(r.kind, 'tree');
  assert.equal((await h.jobs.tick()).length, 0);
  h.die(12);
  assert.equal((await h.jobs.tick()).length, 1);
});
test('a log file: ends when its mtime stops changing for N minutes, sooner with a completion marker', async () => {
  const h = harness();
  const dir = tmp('fake-run-');
  const log = join(dir, 'out.log');
  writeFileSync(log, 'step 1\nstep 2\n');
  const sec = h.now() / 1000;
  utimesSync(log, sec, sec);
  const r = await h.jobs.watch('sess-c', { text: `waiting on ${log}`, cwd: dir, stopAt: 's' });
  assert.equal(r.kind, 'log');
  assert.equal((await h.jobs.tick()).length, 0);
  h.advance(3 * 60e3);
  assert.equal((await h.jobs.tick()).length, 0);   // quiet 3 min < 5
  h.advance(2.5 * 60e3);
  assert.equal((await h.jobs.tick()).length, 1);   // quiet 5.5 min
  const h2 = harness();
  const log2 = join(dir, 'done.log'); writeFileSync(log2, 'all 12 passed\n'); const s2 = h2.now() / 1000; utimesSync(log2, s2, s2);
  await h2.jobs.watch('sess-d', { text: `waiting on ${log2}`, cwd: dir, stopAt: 's' });
  h2.advance(90e3);
  assert.equal((await h2.jobs.tick()).length, 1);   // marker + 1.5 min quiet
  const none = await harness().jobs.watch('sess-e', { text: 'waiting on /etc/passwd.log', cwd: dir, stopAt: 's' });
  assert.equal(none.kind, null);   // outside cwd / tmp / home is not read
});
test('a deploy id: the deploy runner state decides', async () => {
  const h = harness();
  h.state.deploys['3f9a'] = { state: 'running' };
  const r = await h.jobs.watch('sess-f', { text: 'deploy 3f9a', stopAt: 's' });
  assert.equal(r.kind, 'deploy');
  assert.equal((await h.jobs.tick()).length, 0);
  h.state.deploys['3f9a'] = { state: 'done', finished: h.now() };
  assert.equal((await h.jobs.tick()).length, 1);
  assert.match(h.sent[0].text, /^your deploy 3f9a finished at/);
});
test('detached jobs and unidentified jobs are flagged in the feed; the session moving on, a draft or a pause stops the wake', async () => {
  const h = harness();
  const d = await h.jobs.watch('sess-g', { text: 'waiting: nohup python3 run.py & (pid 777)', stopAt: 's' });
  assert.equal(d.detached, true); assert.equal(h.feed.length, 1); assert.match(h.feed[0].title, /sess-g waits on a job the harness cannot see/);
  const u = await h.jobs.watch('sess-h', { text: 'waiting on the nightly run', stopAt: 's' });
  assert.equal(u.kind, null); assert.equal(h.feed.length, 2);
  const h2 = harness();
  h2.live(500); await h2.jobs.watch('sess-i', { text: 'pid 500', stopAt: 's' }); h2.die(500);
  h2.state.canSend = false; assert.equal((await h2.jobs.tick()).length, 0); assert.equal(h2.sent.length, 0);
  h2.state.canSend = true; h2.state.waiting = false; assert.equal((await h2.jobs.tick()).length, 0); assert.equal(h2.jobs._watched.size, 0);
  assert.equal(h2.sent.length, 0);
});
test('the send is the guarded two-call sendKeys of server.js (paste, then Enter): own-jobs only calls it once with the text', () => {
  const src = (p) => import('node:fs').then((fs) => fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
  return src('../server.js').then((s) => {
    assert.match(s, /paste-buffer[\s\S]{0,200}if \(enter\)[\s\S]{0,200}'send-keys', '-t', tgt\(session\), 'Enter'/);
    assert.match(s, /send: async \(name, text\) => \{ await guardSendKeys\(name, text, true\); countSent\(name\); \}/);
  });
});

test('review: never-seen pid is unseeable (flagged, never woken); seen-then-gone wakes; the send re-checks stillWaiting and canSend', async () => {
  const h = harness();
  const r = await h.jobs.watch('far', { text: 'pid 4242 on host-b to finish', stopAt: 's' });   // not alive on this host
  assert.equal(h.feed.length, 1); assert.match(h.feed[0].body, /not running on this host/);
  assert.equal((await h.jobs.tick()).length, 0); assert.equal(h.sent.length, 0); void r;
  // the session moves on between the state read and the send
  const h2 = harness();
  h2.live(600); await h2.jobs.watch('late', { text: 'pid 600', stopAt: 's' }); h2.die(600);
  let calls = 0; const j = createOwnJobs({ procRoot: h2.proc, stillWaiting: () => ++calls < 2, send: async () => { throw new Error('must not send'); }, canSend: () => true });
  h2.live(601); await j.watch('late2', { text: 'pid 601', stopAt: 's' }); h2.die(601);
  assert.deepEqual(await j.tick(), []);
  // hasLiveChild: helpers do not count; a child counts when its command line holds a specific word of the STATUS, or it started after the turn began
  const tb = { children: new Map([[10, [11, 12]]]), args: new Map([[11, 'sleep 5'], [12, 'python3 score_matrix.py']]) };
  const h3 = harness({ table: async () => tb });
  assert.equal(await h3.jobs.hasLiveChild('x', { text: 'waiting on the final score_matrix run' }), true);
  assert.equal(await h3.jobs.hasLiveChild('x', { text: 'waiting for the CI run to finish' }), false, 'someone else\'s child process');
  const h5 = harness({ table: async () => tb, startedAt: async () => new Map([[12, 2_000_000]]) });
  assert.equal(await h5.jobs.hasLiveChild('x', { text: 'waiting for the CI run', turnStart: 1_000_000 }), true, 'started after the turn began');
  assert.equal(await h5.jobs.hasLiveChild('x', { text: 'waiting for the CI run', turnStart: 3_000_000 }), false, 'older than the turn');
  const h4 = harness({ table: async () => ({ children: new Map([[10, [11]]]), args: new Map([[11, 'sleep 5']]) }) });
  assert.equal(await h4.jobs.hasLiveChild('x', { text: 'sleep 5' }), false);
});

// Regression 2026-10-21: three `atlas-faq` alerts said "waits on a job the harness cannot see — its job runs
// detached (nohup / setsid / disown / &)". Every one was wrong. A `bg_<id>` handle is the agent harness's OWN
// background task; the harness owns it and wakes the session, so ghosty must neither flag it nor try to watch it.
// The pane text also matched DETACHED_RE incidentally (the pane echoes commands that contain `&` / `tmux new-session -d`),
// which is why the message blamed detachment.
const BG_LINES = [
  'smoke check atlas_chat run (task bg_147d1f4b-c747-47fc-a5ba-e7ff71c79432, log: smoke one FAQ question — won\'t poll; harness will wake me when done.',
  'smoke check v2 (atlas_chat on patched deploy; task bg_8e48277d-ba6e-4a4f-94de-41411ef0b9fe).',
  'STATUS: waiting: integration patch feat/task-152-faq-impl (task bg_c4673138-959d-4ded-aaeb-fbaea62761e8).',
];
test('a harness bg_ task is recognised as its own job kind and never flagged as unseen', async () => {
  for (const text of BG_LINES) {
    const h = harness();
    const r = await h.jobs.watch('atlas-faq', { text, stopAt: 's' });
    assert.equal(r.kind, 'task', text);
    assert.equal(r.harnessOwned, true, text);
    assert.equal(r.detached, false, text);          // not detached: the harness owns it
    assert.equal(r.unseen, false, text);
    assert.equal(h.feed.length, 0, `no "cannot see" alert for: ${text}`);
    assert.ok(h.logs.some((l) => l.type === 'own_job_watch' && l.harnessOwned === true), 'logged as harness-owned');
  }
});
test('a harness task is never woken or typed into: the agent\'s own harness does that', async () => {
  const h = harness();
  await h.jobs.watch('atlas-faq', { text: BG_LINES[1], stopAt: 's' });
  h.advance(60 * 60 * 1000);
  assert.deepEqual(await h.jobs.tick(), [], 'no wake');
  assert.equal(h.sent.length, 0, 'nothing typed into the session');
});
test('detachment in the PANE text does not condemn a harness task (the pane echoes commands with & )', async () => {
  const h = harness();
  const pane = '$ tmux new-session -d -s helper sleep 600\n$ python3 run.py & disown';
  const r = await h.jobs.watch('atlas-faq', { text: BG_LINES[2], stopAt: 's', paneText: pane });
  assert.equal(r.kind, 'task');
  assert.equal(r.detached, false, 'DETACHED_RE matched the pane text, not the job');
  assert.equal(h.feed.length, 0);
});
test('a genuinely detached job is still flagged (the fix does not weaken the real rule)', async () => {
  const h = harness();
  const r = await h.jobs.watch('sess-det', { text: 'waiting: nohup python3 run.py & (pid 777)', stopAt: 's' });
  assert.equal(r.detached, true);
  assert.equal(h.feed.length, 1);
  assert.match(h.feed[0].title, /sess-det waits on a job the harness cannot see/);
  // and an unidentified wait is still flagged too
  const h2 = harness();
  const u = await h2.jobs.watch('sess-unknown', { text: 'waiting on the nightly run', stopAt: 's' });
  assert.equal(u.kind, null); assert.equal(h2.feed.length, 1);
});
test('a bg_ task is not mistaken for a run id, and an integration id still wins when both are named', async () => {
  assert.equal(jobRefs(BG_LINES[1]).run, null, 'bg_ is a task handle, not a GitHub run id');
  assert.equal(jobRefs('integration int-abc123 (task bg_147d1f4b)').integration, 'int-abc123');
  const h = harness();
  const r = await h.jobs.watch('sess-int', { text: 'integration int-abc123 (task bg_147d1f4b)', stopAt: 's' });
  assert.equal(r.kind, 'integration', 'the lane request is what ghosty can actually watch');
});

test('STATUS waiting on integration <id> or deploy <id> is never flagged as detached, even when the pane text mentions nohup / setsid / &', async () => {
  const h = harness();
  const pane = 'A nohup, setsid or & in the STATUS line still flags: tmux new-session -d';
  const r = await h.jobs.watch('sess-lane', { text: 'integration int-mvij4wgiaf120b', stopAt: 's', paneText: pane });
  assert.equal(r.kind, 'integration'); assert.equal(r.detached, false);
  assert.equal(h.feed.length, 0, 'no job:unseen event for a lane request');
  const dep = await h.jobs.watch('sess-dep', { text: 'deploy 3f9a', stopAt: 's', paneText: pane });
  assert.equal(dep.kind, 'deploy'); assert.equal(dep.detached, false); assert.equal(h.feed.length, 0, 'no event for a deploy-queue entry either');
  const d = await h.jobs.watch('sess-nohup', { text: 'waiting: nohup ./run.sh & (pid 777)', stopAt: 's', paneText: pane });
  assert.equal(d.detached, true); assert.equal(h.feed.length, 1, 'a real detached job still flags');
  const u = await h.jobs.watch('sess-noref', { text: 'waiting on the nightly run', stopAt: 's', paneText: pane });
  assert.equal(u.kind, null); assert.equal(h.feed.length, 2, 'no reference at all still flags');
});
