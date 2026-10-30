// Owner rule 2026-10-30 (bug-9e811bf0): a session is NEVER auto-closed by ghosty. shouldClose() always says no, the tick is a
// no-op whatever manager.json says, and server.js does not start the loop. politeClose() is kept as a helper and tested here.
// Old contract (2026-10-18), now dead:
// close when ALL hold: startedBy is a non-empty, non-owner, non-dashboard, non-unknown value (a session that started it);
// name is not a manager session; priority is not P0/P1; last STATUS line is 'done'; no draft in input;
// not working, not scriptBusy, no background work, idle >= workerIdleMin; git clean (done-check would agree).
// Also covers the politeClose() async close path (claude /exit + confirm, mcode/codex Ctrl-C twice, kill fallback).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldClose, politeClose, createWorkerAutoClose, LEFTOVERS_WINDOW_MS } from '../worker-auto-close.js';

const ready = () => ({
  name: 'r13d-mm', startedBy: 'r12-claude', priority: 'P2', lastStatusKind: 'done',
  idleMs: 25 * 60 * 1000, working: false, scriptBusy: false, backgroundWork: 0, draft: false,
  managerSessions: ['manager'], workerAutoClose: true, workerIdleMin: 20, doneCheckClean: true,
});

test('shouldClose: never closes, even when every old condition holds and the config says on', () => {
  const r = shouldClose(ready());
  assert.equal(r.close, false);
  assert.match(r.reason, /automatic close removed/);
});

test('createWorkerAutoClose: the tick never closes or even lists sessions, workerAutoClose:true is ignored', async () => {
  let read = false, polite = 0;
  const w = createWorkerAutoClose({
    listCandidates: async () => { read = true; return [{ ...ready(), agent: 'claude' }]; },
    polite: async () => { polite++; return {}; },
    record: async () => {},
    config: () => ({ workerAutoClose: true, workerIdleMin: 20, managerSessions: ['manager'] }),
  });
  const r = await w.tick();
  assert.equal(r.mode, 'off');
  assert.equal(read, false);
  assert.equal(polite, 0);
  assert.deepEqual(r.closed, []);
});

test('createWorkerAutoClose: start() schedules nothing', async () => {
  let read = false;
  const w = createWorkerAutoClose({ listCandidates: async () => { read = true; return []; }, config: () => ({ workerAutoClose: true }) });
  w.start(1);
  await new Promise((r) => setTimeout(r, 30));
  w.stop();
  assert.equal(read, false);
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

