// The done check re-reads main right before it tells a session "git disagrees", and says nothing for a branch the lane is merging
// (2026-11-28: token-audit-followup-20261128 was told "1 commit not on main (814bc38)" at 09:49:21 while its lane request was running;
// the lane merged it at 09:49:59, and the manager and the session then said different things).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDoneCheck } from '../done-check.js';

// One worktree /w/feat on branch feat/x. `repo.merged` flips what `git log base...HEAD` shows; a fetch can flip it (the lane merged meanwhile).
function fakeRepo(repo) {
  return async (cwd, args) => {
    repo.calls.push(args[0]);
    if (args[0] === 'fetch') { repo.fetches++; if (repo.mergeOnFetch && repo.fetches >= repo.mergeOnFetch) repo.merged = true; return ''; }
    if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return args[2] === '--git-dir' ? '/r/.git/worktrees/feat\n' : '/r/.git\n';
    if (args[0] === 'rev-parse' && args[1] === '-q') { if (args[3] === 'origin/main') return 'abc\n'; throw new Error('no ref'); }
    if (args[0] === 'rev-parse') return 'feat/x\n';
    if (args[0] === 'log') return repo.merged ? '' : '814bc38\tdocs: x\n';
    if (args[0] === 'merge-tree') throw new Error('conflict');
    return '';
  };
}

function harness(t, repo, { lane = [], clock }) {
  const dir = mkdtempSync(join(tmpdir(), 'done-check-fresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent = [], events = [];
  const w = createDoneCheck({ stateDir: dir, git: fakeRepo(repo), mode: () => 'live', log: { error() {} }, now: () => clock.t,
    listDone: async () => [{ name: 'token-audit', cwd: '/w/feat', text: 'STATUS: done — x' }],
    lanePendingOf: async () => lane,
    pressure: () => ({ loadPerCore: 0.2, ramAvailPct: 60 }),
    send: async (n, text) => { if (/git disagrees/.test(text)) sent.push([n, text]); }, record: async (e) => { if (/^done-check:/.test(e.key)) events.push(e.key); } });
  return { w, sent, events };
}

test('fresh: the facts are re-fetched right before the message and a merge that landed meanwhile stops it', async (t) => {
  const clock = { t: 60 * 60e3 };
  const repo = { calls: [], fetches: 0, merged: false, mergeOnFetch: 2 };   // the second fetch sees the lane's merge
  const h = harness(t, repo, { clock });
  // the scan fetches, then reads the log; the message would go out 2 min later (slow host): the re-read fetches again and sees main has it
  let first = true;
  const push = repo.calls.push.bind(repo.calls);
  repo.calls.push = (x) => { if (x === 'log' && first) { first = false; clock.t += 2 * 60e3; } return push(x); };
  const realTick = h.w.tick;
  const r = await realTick();
  assert.equal(repo.fetches, 2, 'one fetch to scan, one fresh fetch before sending');
  assert.equal(h.sent.length, 0, 'main has the commit now: no "git disagrees"');
  assert.equal(h.events.length, 0, 'and no manager event');
  assert.deepEqual(r.findings, []);
});

test('fresh: a branch with a queued or running lane request is on its way, not a disagreement', async (t) => {
  const clock = { t: 60 * 60e3 };
  const repo = { calls: [], fetches: 0, merged: false };
  const h = harness(t, repo, { clock, lane: [{ id: 'int-1', branch: 'feat/x', state: 'running' }] });
  const r = await h.w.tick();
  assert.equal(h.sent.length, 0);
  assert.deepEqual(r.findings, []);
});

test('fresh: a lane request for another branch does not hide this one', async (t) => {
  const clock = { t: 60 * 60e3 };
  const repo = { calls: [], fetches: 0, merged: false };
  const h = harness(t, repo, { clock, lane: [{ id: 'int-2', branch: 'fix/other', state: 'queued' }] });
  await h.w.tick();
  assert.equal(repo.fetches, 1, 'the scan fetch is under a minute old: no second fetch');
  assert.equal(h.sent.length, 1, 'a real disagreement is still told');
  assert.match(h.sent[0][1], /1 commit\(s\) on feat\/x not on main \(814bc38\)/);
});
