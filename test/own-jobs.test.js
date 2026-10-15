// Round 9 item 11: a session that waits on a job of its own is woken when the job ends; the harness flags what it cannot see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyStall } from '../stall.js';
import { jobRefs, waitsOnOwnJob, createOwnJobs, descendants, jobPids } from '../own-jobs.js';

const status = (line) => classifyStall({ plain: ['Started the final run.', line], state: 'done' });

test('STATUS blocked / waiting on a job of its own is own_job_wait (never a needs-you); owner and deploy waits keep their cases', () => {
  for (const l of ['STATUS: blocked - waiting on the final score_matrix run', 'STATUS: waiting: run 7 (pid 4242)', 'STATUS: waiting: /tmp/fake-run/out.log to finish', 'STATUS: blocked: export job running, resumes when it completes']) {
    const s = status(l);
    assert.equal(s.case, 'own_job_wait', l); assert.equal(s.answer, null);
  }
  assert.equal(status('STATUS: blocked: waiting for your decision on the schema').case, 'owner_decision');
  assert.equal(status('STATUS: blocked: tests fail on feat').case, 'owner_decision');
  assert.equal(status('STATUS: waiting: deploy d-42').case, 'waiting_deploy');
  assert.equal(status('STATUS: waiting: the owner go-ahead').case, 'waiting_deploy');
});
test('jobRefs / waitsOnOwnJob', () => {
  assert.deepEqual(jobRefs('waiting on pid 4242 and /tmp/fake-run/out.log nohup'), { deploy: null, pid: 4242, path: '/tmp/fake-run/out.log', run: null, detached: true });
  assert.equal(jobRefs('deploy 3f9a').deploy, '3f9a');
  assert.equal(jobRefs('run id: r-12').run, 'r-12');
  assert.equal(waitsOnOwnJob('are you ok with the run?'), false);
  assert.equal(waitsOnOwnJob('waiting for the owner approval of the run'), false);
});
test('process tree: children of the agent except shells and helpers', () => {
  const table = { children: new Map([[10, [11]], [11, [12, 13]], [13, [14]]]), args: new Map([[11, 'bash -c run'], [12, 'sleep 5'], [13, 'python3 score_matrix.py --run r-12'], [14, 'worker']]) };
  assert.deepEqual(descendants(10, table), [11, 12, 13, 14]);
  assert.deepEqual(jobPids(10, table), [13, 14]);
});

function harness(over = {}) {
  const proc = mkdtempSync(join(tmpdir(), 'fake-proc-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'fake-run-'));
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
    assert.match(s, /send: \(name, text\) => guardSendKeys\(name, text, true\)/);
  });
});
