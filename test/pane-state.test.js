// The live pane state (pane-state.js), as server.js pollOnce reads it each tick: waiting, working, idle, and the stop behind background
// subagents (owner 2026-11-27: a needs-owner turn stayed green while a subagent ran), with or without Claude's footer wording.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveState, findWaitReason } from '../pane-state.js';

const RULE = '─'.repeat(40);
const NEEDS = 'Mockup is ready.\n\nSTATUS: needs-owner: approve the map recording mockup [approve | change it]';
const turn = (text = NEEDS) => () => ({ text, at: 500 });
const box = [RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
const subagent = ['● Agent(Build virtual_stb device)', '  ⎿  ⠼ Running… (4m 12s · ↓ 9.1k tokens)'];
const footer = '✻ Waiting for 1 background agent to finish';
const base = { agent: 'claude', changeAt: 0, now: 100000 };
const st = (over) => liveState({ ...base, ...over });

test('offline, a permission prompt, a reported wait', () => {
  assert.equal(st({ offline: true, tail: [] }).state, 'offline');
  const w = st({ tail: ['Run the migration?', '❯ 1. Yes', '  2. No', 'Esc to cancel'] });
  assert.equal(w.state, 'waiting');
  assert.equal(w.waitReason, 'Run the migration?');
  assert.equal(findWaitReason(['all quiet']), null);
  assert.deepEqual(st({ tail: ['quiet', ...box], reportedWait: () => ({ message: 'Claude needs your permission' }) }), { state: 'waiting', waitReason: 'Claude needs your permission', spinning: false, behindAgents: false, doneGuess: null });
});

test('a spinner or a fresh pane change is working; a still pane is idle', () => {
  assert.equal(st({ tail: ['✻ Thinking… (12s · esc to interrupt)', ...box] }).state, 'working');
  assert.equal(st({ tail: ['✻ Thinking… (12s · esc to interrupt)', ...box] }).spinning, true);
  assert.equal(st({ tail: ['text', ...box], changeAt: 98000 }).state, 'working');
  assert.equal(st({ tail: ['text', ...box], changeAt: 98000 }).spinning, false);
  assert.equal(st({ tail: ['text', ...box] }).state, 'idle');
});

test('needs-owner turn + running subagent + footer: done, not working', () => {
  const r = st({ tail: [...NEEDS.split('\n'), ...subagent, footer, ...box], handedTurn: turn(), runningAgents: () => 1 });
  assert.deepEqual(r, { state: 'done', waitReason: null, spinning: false, behindAgents: true, doneGuess: 500 });
});

test('footer reworded or missing: the reporter agent count still makes it a stop, unless the main turn spins', () => {
  const tail = [...NEEDS.split('\n'), ...subagent, '✻ 1 subagent still working in the background', ...box];
  assert.equal(st({ tail, handedTurn: turn(), runningAgents: () => 1 }).state, 'done');
  assert.equal(st({ tail, handedTurn: turn(), runningAgents: () => 0 }).state, 'working');   // no footer, no count: the old rule
  const resumed = [...NEEDS.split('\n'), ...subagent, '✻ Reading the agent result… (3s · ↓ 1k tokens · esc to interrupt)', ...box];
  assert.equal(st({ tail: resumed, handedTurn: turn(), runningAgents: () => 1 }).state, 'working');
});

test('no hand-over turn (no STATUS line, a running line, or a newer prompt): the running agent stays green', () => {
  const tail = [...subagent, footer, ...box];
  for (const handedTurn of [() => null, turn('Agent started, will report.'), turn('STATUS: running: build agent — then ship')]) {
    const r = st({ tail, handedTurn, runningAgents: () => 1 });
    assert.equal(r.state, 'working');
    assert.equal(r.behindAgents, false);
  }
});

test('codex / minimax never read the reporter', () => {
  const r = st({ agent: 'codex', tail: [...subagent, footer], handedTurn: () => { throw new Error('read'); }, reportedWait: () => { throw new Error('read'); } });
  assert.equal(r.state, 'working');
});
