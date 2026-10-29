// Tests for the pure shouldClose() decision helper (worker-auto-close.js) — the owner, 2026-10-18 contract:
// close when ALL hold: startedBy is a non-empty, non-owner, non-dashboard, non-unknown value (a session that started it);
// name is not a manager session; priority is not P0/P1; last STATUS line is 'done'; no draft in input;
// not working, not scriptBusy, no background work, idle >= workerIdleMin; git clean (done-check would agree).
// Also covers the politeClose() async close path (claude /exit + confirm, mcode/codex Ctrl-C twice, kill fallback).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldClose, politeClose, createWorkerAutoClose, LEFTOVERS_WINDOW_MS } from '../worker-auto-close.js';

// A complete, ready-to-close facts object. Every test that exercises a single condition mutates one field.
const ok = () => ({
  name: 'r13d-mm', startedBy: 'r12-claude', priority: 'P2', lastStatusKind: 'done',
  idleMs: 25 * 60 * 1000, working: false, scriptBusy: false, backgroundWork: 0, draft: false,
  managerSessions: ['manager'], workerAutoClose: true, workerIdleMin: 20, doneCheckClean: true,
});

test('shouldClose: returns close:true when every condition holds', () => {
  const r = shouldClose(ok());
  assert.equal(r.close, true);
  assert.match(r.reason, /idle 25m/);
  assert.deepEqual(r.missing, []);
});

test('shouldClose: returns close:false and lists missing facts when fields are absent', () => {
  // Only `name` is truly required: the decision logic treats null / undefined as the field's empty value
  // (e.g. missing startedBy -> "owner-controlled") so a partially filled facts object still gives a real reason.
  const r = shouldClose({});
  assert.equal(r.close, false);
  assert.match(r.reason, /missing name/);
  assert.ok(r.missing.includes('name'));
  // When `name` is provided but other fields are absent, the decision runs and lists the missing ones.
  const r2 = shouldClose({ name: 'x' });
  assert.equal(r2.close, false);
  assert.ok(r2.missing.includes('startedBy'));
  assert.ok(r2.missing.includes('workerAutoClose'));
  assert.ok(r2.missing.includes('doneCheckClean'));
  assert.match(r2.reason, /workerAutoClose disabled/);
});

test('shouldClose: workerAutoClose=false is a hard off (config switch)', () => {
  const f = ok(); f.workerAutoClose = false;
  const r = shouldClose(f);
  assert.equal(r.close, false);
  assert.match(r.reason, /workerAutoClose disabled/);
});

test('shouldClose: owner / dashboard / unknown / empty startedBy are never closed (owner rule)', () => {
  for (const sb of ['owner', 'dashboard', 'unknown', '', null, undefined]) {
    const f = ok(); f.startedBy = sb;
    const r = shouldClose(f);
    assert.equal(r.close, false, `startedBy=${JSON.stringify(sb)} should not close`);
    assert.match(r.reason, /owner-controlled/);
  }
});

test('shouldClose: P0 / P1 priorities are owner-controlled and never closed', () => {
  for (const p of ['P0', 'P1']) {
    const f = ok(); f.priority = p;
    const r = shouldClose(f);
    assert.equal(r.close, false);
    assert.match(r.reason, /P[01]/);
  }
});

test('shouldClose: a name in managerSessions (default ["manager"]) is never closed', () => {
  const f = ok(); f.name = 'manager'; f.startedBy = 'someone-else';
  const r = shouldClose(f);
  assert.equal(r.close, false);
  assert.match(r.reason, /manager session/);
  // A name not in the list goes through.
  f.name = 'r13d-mm';
  assert.equal(shouldClose(f).close, true);
});

test('shouldClose: lastStatusKind must be "done"; any other status (or null) is not ready', () => {
  for (const k of [null, undefined, 'blocked', 'needs-owner', 'waiting', 'working', 'idle']) {
    const f = ok(); f.lastStatusKind = k;
    const r = shouldClose(f);
    assert.equal(r.close, false, `status=${k} should not close`);
    assert.match(r.reason, /last status is/);
  }
});

test('shouldClose: a draft in the input box is never closed (half-typed follow-up would be lost)', () => {
  const f = ok(); f.draft = true;
  const r = shouldClose(f);
  assert.equal(r.close, false);
  assert.match(r.reason, /draft in input/);
});

test('shouldClose: a running agent turn (working) is never closed', () => {
  const f = ok(); f.working = true;
  const r = shouldClose(f);
  assert.equal(r.close, false);
  assert.match(r.reason, /agent turn running/);
});

test('shouldClose: a script-driven pane (scriptBusy) is never closed (typing would land in bash input)', () => {
  const f = ok(); f.scriptBusy = true;
  const r = shouldClose(f);
  assert.equal(r.close, false);
  assert.match(r.reason, /script driving pane/);
});

test('shouldClose: any background work (crons / mcode workers) keeps the session alive', () => {
  const f = ok(); f.backgroundWork = 2;
  const r = shouldClose(f);
  assert.equal(r.close, false);
  assert.match(r.reason, /2 background work/);
  // A single cron is also not idle.
  f.backgroundWork = 1;
  assert.equal(shouldClose(f).close, false);
});

test('shouldClose: idleMs below workerIdleMin is not idle enough; exactly at the threshold is', () => {
  let f = ok(); f.idleMs = 19 * 60 * 1000; f.workerIdleMin = 20;
  assert.equal(shouldClose(f).close, false);
  assert.match(shouldClose(f).reason, /19m < 20m/);
  f.idleMs = 20 * 60 * 1000;
  assert.equal(shouldClose(f).close, true);
  // A custom workerIdleMin of 30 holds at 25.
  f.workerIdleMin = 30; f.idleMs = 25 * 60 * 1000;
  assert.equal(shouldClose(f).close, false);
  f.idleMs = 30 * 60 * 1000;
  assert.equal(shouldClose(f).close, true);
});

test('shouldClose: doneCheckClean=false means git disagrees (uncommitted, unmerged); the session is not closed', () => {
  const f = ok(); f.doneCheckClean = false;
  const r = shouldClose(f);
  assert.equal(r.close, false);
  assert.match(r.reason, /git not clean/);
});

// politeClose() — the async close path. Every test injects its own tmux/sendKeys hooks; no real tmux, no real sessions.

function recordingHooks({ alive = true, processAlive = true, promptText = '', confirmThrows = false } = {}) {
  const calls = { sendKeys: [], killTmux: 0, sleepMs: 0 };
  const result = {
    sendKeys: async (n, keys, enter) => { calls.sendKeys.push({ n, keys, enter }); },
    tmuxSessionAlive: async (n) => alive,
    paneHasProcess: async (n) => processAlive,
    killTmux: async (n) => { calls.killTmux++; },
    sleep: async (ms) => { calls.sleepMs += ms; },
    onPrompt: async (n) => {
      if (/Exit and stop tasks/.test(promptText)) { if (confirmThrows) throw new Error('confirmed'); else return; }
      throw new Error('no prompt yet');
    },
  };
  return { hooks: result, calls };
}

test('politeClose: claude sends /exit, confirms "Exit and stop tasks", then kills when process is gone', async () => {
  // Process becomes not-alive after the first send + sleep: the second paneHasProcess check is false, so kill is skipped.
  let checks = 0;
  const { hooks, calls } = recordingHooks({ alive: true, promptText: 'Exit and stop tasks' });
  hooks.paneHasProcess = async () => { checks++; return checks <= 1; };   // gone after the first check
  const r = await politeClose({ name: 'r1', agent: 'claude', ...hooks });
  assert.equal(calls.sendKeys[0].keys, '/exit');
  assert.equal(calls.sendKeys[0].enter, true);
  assert.ok(calls.sendKeys.length >= 1);
  assert.ok(r.steps.includes('sent-/exit'));
  assert.ok(r.steps.includes('process-gone'));
  assert.equal(r.killed, false, 'no kill needed when the process already left');
});

test('politeClose: claude with a still-alive process is hard-killed after the exit prompt times out', async () => {
  const { hooks, calls } = recordingHooks({ alive: true, processAlive: true, promptText: 'something else' });
  // Make sleep fast so the test does not take 30 s.
  const realSleep = hooks.sleep;
  hooks.sleep = async (ms) => { await realSleep(Math.min(ms, 5)); };
  const r = await politeClose({ name: 'r2', agent: 'claude', ...hooks });
  assert.ok(r.steps.includes('sent-/exit'));
  assert.equal(r.killed, true, 'process is still alive, so kill is the last step');
  assert.equal(calls.killTmux, 1);
});

test('politeClose: mcode sends Ctrl-C twice with 1.5 s between, then kills when the process is still alive', async () => {
  const { hooks, calls } = recordingHooks({ alive: true, processAlive: true });
  const r = await politeClose({ name: 'r3', agent: 'mcode', ...hooks });
  assert.equal(calls.sendKeys.length, 2);
  assert.equal(calls.sendKeys[0].keys, 'C-c');
  assert.equal(calls.sendKeys[1].keys, 'C-c');
  assert.equal(calls.sendKeys[0].enter, false);
  assert.ok(calls.sleepMs >= 2 * 1500, `expected >= 3 s of sleeps, got ${calls.sleepMs} ms`);
  assert.equal(r.killed, true);
  assert.ok(r.steps.includes('sent-C-c-1'));
  assert.ok(r.steps.includes('sent-C-c-2'));
  assert.ok(r.steps.includes('kill-tmux'));
});

test('politeClose: codex is treated like mcode (Ctrl-C twice)', async () => {
  const { hooks, calls } = recordingHooks({ alive: true, processAlive: false });   // process gone after the C-c pair
  const r = await politeClose({ name: 'r4', agent: 'codex', ...hooks });
  assert.equal(calls.sendKeys.length, 2);
  assert.equal(calls.sendKeys[0].keys, 'C-c');
  assert.equal(calls.sendKeys[1].keys, 'C-c');
  assert.equal(r.killed, false);
  assert.ok(r.steps.includes('process-gone'));
});

test('politeClose: a missing tmux session is a no-op (no send, no kill)', async () => {
  const { hooks, calls } = recordingHooks({ alive: false, processAlive: false });
  const r = await politeClose({ name: 'gone', agent: 'claude', ...hooks });
  assert.equal(calls.sendKeys.length, 0);
  assert.equal(calls.killTmux, 0);
  assert.deepEqual(r.steps, ['no-tmux']);
});

test('politeClose: "other" agent family is treated like mcode/codex (Ctrl-C twice)', async () => {
  const { hooks, calls } = recordingHooks({ alive: true, processAlive: false });
  const r = await politeClose({ name: 'r5', agent: 'other', ...hooks });
  assert.equal(calls.sendKeys.length, 2);
  assert.equal(calls.sendKeys[0].keys, 'C-c');
  assert.ok(r.steps.includes('process-gone'));
});

test('createWorkerAutoClose: tick gathers facts, calls shouldClose, then politeClose; events recorded', async () => {
  // Two candidates: a closable one and one that fails the idle test (only 5 m idle).
  const calls = { polite: 0, records: [] };
  const w = createWorkerAutoClose({
    listCandidates: async () => [
      { name: 'r13d-mm', startedBy: 'r12', priority: 'P2', lastStatusKind: 'done', idleMs: 25 * 60 * 1000,
        working: false, scriptBusy: false, backgroundWork: 0, draft: false, doneCheckClean: true, agent: 'mcode' },
      { name: 'r14-mm', startedBy: 'r12', priority: 'P2', lastStatusKind: 'done', idleMs: 5 * 60 * 1000,
        working: false, scriptBusy: false, backgroundWork: 0, draft: false, doneCheckClean: true, agent: 'claude' },
    ],
    polite: async () => { calls.polite++; return { name: 'x', agent: 'mcode', steps: ['sent-C-c-1', 'process-gone'], killed: false }; },
    record: async (e) => { calls.records.push(e); },
    config: () => ({ workerAutoClose: true, workerIdleMin: 20, managerSessions: ['manager'] }),
  });
  const r = await w.tick();
  assert.equal(r.checked, 2);
  assert.equal(r.mode, 'live');
  assert.equal(calls.polite, 1, 'only the ready candidate is closed');
  assert.equal(calls.records.length, 1);
  assert.equal(calls.records[0].key, 'worker-auto-closed:r13d-mm');
  assert.equal(r.closed.length, 1);
  assert.equal(r.closed[0].name, 'r13d-mm');
  assert.equal(r.closed[0].startedBy, 'r12');
  // The other candidate is in `skipped` with its reason.
  const skip = r.skipped.find((s) => s.name === 'r14-mm');
  assert.ok(skip, 'r14-mm should appear in skipped');
  assert.match(skip.reason, /idle 5m < 20m/);
});

test('createWorkerAutoClose: workerAutoClose=false short-circuits the tick (mode off, no candidates read)', async () => {
  let read = false;
  const w = createWorkerAutoClose({
    listCandidates: async () => { read = true; return []; },
    record: async () => {},
    config: () => ({ workerAutoClose: false, workerIdleMin: 20, managerSessions: ['manager'] }),
  });
  const r = await w.tick();
  assert.equal(r.mode, 'off');
  assert.equal(read, false, 'off mode must not enumerate sessions');
});

test('createWorkerAutoClose: a polite throw is logged and the session is in `skipped`', async () => {
  const w = createWorkerAutoClose({
    listCandidates: async () => [
      { name: 'r13d-mm', startedBy: 'r12', priority: 'P2', lastStatusKind: 'done', idleMs: 25 * 60 * 1000,
        working: false, scriptBusy: false, backgroundWork: 0, draft: false, doneCheckClean: true, agent: 'mcode' },
    ],
    polite: async () => { throw new Error('tmux gone'); },
    record: async () => {},
    config: () => ({ workerAutoClose: true, workerIdleMin: 20, managerSessions: ['manager'] }),
  });
  const r = await w.tick();
  assert.equal(r.closed.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /tmux gone/);
});

test('createWorkerAutoClose: an owner-started candidate never reaches polite (the listCandidates pre-filter or shouldClose skips it)', async () => {
  // The factory's listCandidates is what server.js builds: the decision helper is the safety net.
  // Even if an owner candidate sneaks in, shouldClose must say no.
  let polite = 0;
  const w = createWorkerAutoClose({
    listCandidates: async () => [
      { name: 'owner-sess', startedBy: 'owner', priority: 'P2', lastStatusKind: 'done', idleMs: 25 * 60 * 1000,
        working: false, scriptBusy: false, backgroundWork: 0, draft: false, doneCheckClean: true, agent: 'claude' },
    ],
    polite: async () => { polite++; return { name: 'x', agent: 'claude', steps: [], killed: false }; },
    record: async () => {},
    config: () => ({ workerAutoClose: true, workerIdleMin: 20, managerSessions: ['manager'] }),
  });
  const r = await w.tick();
  assert.equal(polite, 0, 'owner-started is never closed even if a caller passes it in');
  assert.equal(r.closed.length, 0);
  assert.equal(r.skipped[0].reason.includes('owner-controlled'), true);
});

// bug-8cddcf53: a done STATUS must not close a session that still has open work.
test('shouldClose: task doc with open rows keeps the session open', () => {
  const r = shouldClose({ ...ok(), openRows: 6 });
  assert.equal(r.close, false);
  assert.equal(r.openWork, true);
  assert.match(r.reason, /6 open row/);
  assert.equal(shouldClose({ ...ok(), openRows: 0 }).close, true);
});

test('shouldClose: a recent leftovers event keeps the session open, an old one does not', () => {
  const r = shouldClose({ ...ok(), leftoversAgeMs: 90 * 60 * 1000 });
  assert.equal(r.close, false);
  assert.match(r.reason, /leftovers event 90m ago/);
  assert.equal(shouldClose({ ...ok(), leftoversAgeMs: LEFTOVERS_WINDOW_MS + 1 }).close, true);
  assert.equal(shouldClose({ ...ok(), leftoversAgeMs: null }).close, true);
});

test('shouldClose: closing text saying something was not verified / not done keeps the session open', () => {
  for (const t of ['I did not verify the page in a browser', 'not yet deployed', "haven't tested it on the device", 'unverified in prod', 'did not finish G4']) {
    const r = shouldClose({ ...ok(), lastStatusText: t });
    assert.equal(r.close, false, t);
    assert.equal(r.openWork, true, t);
  }
  assert.equal(shouldClose({ ...ok(), lastStatusText: 'STATUS: done, tests pass, merged, deployed' }).close, true);
});

test('createWorkerAutoClose: a kept-open session is recorded once with its reason, a finished one still closes', async () => {
  const records = []; let closed = 0;
  const w = createWorkerAutoClose({
    listCandidates: async () => [
      { name: 'resume-task182', startedBy: 'mgr', priority: 'P2', lastStatusKind: 'done', idleMs: 24 * 60000, working: false, scriptBusy: false,
        backgroundWork: 0, draft: false, doneCheckClean: true, agent: 'claude', openRows: 6 },
      { name: 'finished', startedBy: 'mgr', priority: 'P2', lastStatusKind: 'done', idleMs: 24 * 60000, working: false, scriptBusy: false,
        backgroundWork: 0, draft: false, doneCheckClean: true, agent: 'claude', openRows: 0, leftoversAgeMs: null, lastStatusText: 'STATUS: done' },
    ],
    polite: async () => { closed++; return { steps: [], killed: false }; },
    record: async (e) => { records.push(e); },
    config: () => ({ workerAutoClose: true, workerIdleMin: 20, managerSessions: ['manager'] }),
    log: { info() {}, error() {} },
  });
  const r = await w.tick();
  assert.equal(closed, 1);
  assert.deepEqual(records.map((e) => e.key), ['worker-auto-close-kept:resume-task182', 'worker-auto-closed:finished']);
  assert.match(records[0].body, /6 open row/);
  assert.match(r.skipped.find((s) => s.name === 'resume-task182').reason, /open row/);
});
