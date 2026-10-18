// Send guard: typing into a pane must be refused for any non-owner actor when the
// pane runs no claude / codex / minimax process. The decision lives in api-extras.js
// (shouldRefuse) so the policy is testable without booting the server; server.js wraps
// it with liveAgentOf() to read the live process tree.

import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRefuse, agentFromArgs, DEFAULT_ACTOR } from '../api-extras.js';

// --- shouldRefuse: the pure policy assertAgentPane applies in server.js. ---

test('owner is always allowed, even when the pane runs no agent', () => {
  assert.equal(shouldRefuse({ by: 'owner', live: null }), null);
  assert.equal(shouldRefuse({ by: 'owner', live: { agent: 'claude', cmd: 'claude' } }), null);
  assert.equal(shouldRefuse({ by: 'owner', live: { agent: 'minimax', cmd: 'mcode' } }), null);
});

test('manager-agent is refused when the pane runs no agent process', () => {
  const r = shouldRefuse({ by: 'manager-agent', live: null });
  assert.ok(r, 'expected a refusal reason');
  assert.match(r, /no claude\/codex\/minimax/i);
});

test('manager-agent is allowed when an agent process is alive in the pane', () => {
  assert.equal(shouldRefuse({ by: 'manager-agent', live: { agent: 'claude', cmd: 'claude' } }), null);
  assert.equal(shouldRefuse({ by: 'manager-agent', live: { agent: 'codex', cmd: 'codex' } }), null);
  assert.equal(shouldRefuse({ by: 'manager-agent', live: { agent: 'minimax', cmd: 'minimax-code' } }), null);
});

test("'manager' (auto answers / resumes) is refused on a non-agent pane", () => {
  const r = shouldRefuse({ by: 'manager', live: null });
  assert.ok(r);
  assert.match(r, /no claude\/codex\/minimax/i);
});

test("DEFAULT_ACTOR is 'owner'", () => {
  assert.equal(DEFAULT_ACTOR, 'owner');
});

// --- scriptBusy: typing into a script-driven pane (claude -p / mcode exec / sleep under bash)
// lands in the terminal input and gets read by bash as commands. Non-owner senders must be
// refused even when the pane also has an interactive agent process somewhere in the tree.
test('owner is allowed into a script-busy pane (Ghosty is also a terminal)', () => {
  assert.equal(shouldRefuse({ by: 'owner', live: { agent: 'claude', cmd: 'claude' }, scriptBusy: true }), null);
  assert.equal(shouldRefuse({ by: 'owner', live: null, scriptBusy: true }), null);
});

test('non-owner is refused on a script-busy pane, even when an agent is alive', () => {
  const r = shouldRefuse({ by: 'manager-agent', live: { agent: 'claude', cmd: 'claude' }, scriptBusy: true });
  assert.ok(r, 'expected a refusal reason');
  assert.match(r, /script/i);
  const r2 = shouldRefuse({ by: 'manager', live: { agent: 'claude', cmd: 'claude' }, scriptBusy: true });
  assert.ok(r2);
  assert.match(r2, /script/i);
});

test('non-owner is allowed on a live, non-script-busy pane', () => {
  assert.equal(shouldRefuse({ by: 'manager-agent', live: { agent: 'claude', cmd: 'claude' }, scriptBusy: false }), null);
  assert.equal(shouldRefuse({ by: 'manager', live: { agent: 'claude', cmd: 'claude' }, scriptBusy: false }), null);
});

test('scriptBusy defaults to false (backwards compatible)', () => {
  // existing call sites that pass only { by, live } must keep working unchanged
  assert.equal(shouldRefuse({ by: 'manager-agent', live: { agent: 'claude', cmd: 'claude' } }), null);
  const r = shouldRefuse({ by: 'manager-agent', live: null });
  assert.ok(r);
  assert.match(r, /no claude\/codex\/minimax/i);
});

// --- agentFromArgs: the underlying matcher the guard relies on. assertAgentPane
// calls liveAgentOf() -> processTable() -> agentFromTree() -> agentFromArgs(); the
// last is the function that decides whether a single `ps` line names an agent.
// Tests pin down the cases that matter for the guard.

test('agentFromArgs: a bare agent binary matches', () => {
  assert.deepEqual(agentFromArgs('claude'), { agent: 'claude', cmd: 'claude' });
  assert.deepEqual(agentFromArgs('codex'), { agent: 'codex', cmd: 'codex' });
  assert.deepEqual(agentFromArgs('minimax-code'), { agent: 'minimax', cmd: 'minimax-code' });
  assert.deepEqual(agentFromArgs('mcode'), { agent: 'minimax', cmd: 'mcode' });
});

test('agentFromArgs: an agent under a wrapper (node, python) still matches', () => {
  // basename() of the wrapped argline is what AGENT_BINS sees — keep these paths realistic.
  assert.deepEqual(agentFromArgs('node /usr/local/bin/claude --foo'), { agent: 'claude', cmd: 'claude' });
  assert.deepEqual(agentFromArgs('python3 /usr/local/bin/codex'), { agent: 'codex', cmd: 'codex' });
  assert.deepEqual(agentFromArgs('/usr/bin/env node ./minimax-code'), { agent: 'minimax', cmd: 'minimax-code' });
});

test('agentFromArgs: shells and sleep do not match any agent', () => {
  // The bug we are guarding against: `ps` line "bash" or "sleep 100" must come back
  // null so liveAgentOf() reports "no agent" and the guard refuses non-owner sends.
  assert.equal(agentFromArgs('bash'), null);
  assert.equal(agentFromArgs('sleep 100'), null);
  assert.equal(agentFromArgs('bash -c "ls"'), null);
  assert.equal(agentFromArgs('zsh'), null);
  assert.equal(agentFromArgs(''), null);
});

// --- Loop-wait helpers (paneBackgroundOf, scriptBusyOf) ---
// Display-only signals for the green "working" badge: MiniMax/Codex footers that don't
// go through the Claude Stop hook, and script-wrapped `claude -p` / `sleep` children.

import { paneBackgroundOf, scriptBusyOf } from '../api-extras.js';

test('paneBackgroundOf: a MiniMax "Tasks · 1 background active" footer counts', () => {
  const lines = [
    '─ Worked for 2m 13s ───',
    '   › hi',
    '   ◐ Tasks · 1 background active',
    '',
  ];
  assert.equal(paneBackgroundOf(lines), true);
});

test('paneBackgroundOf: a Codex "Running 14min50s" spinner line counts', () => {
  const lines = [
    'some earlier output',
    '   ⠇ Running 14min50s',
    '   › ',
  ];
  assert.equal(paneBackgroundOf(lines), true);
});

test('paneBackgroundOf: a plain idle prompt does not count', () => {
  const lines = [
    '─ Worked for 1m 23s ───',
    '   › hi',
  ];
  assert.equal(paneBackgroundOf(lines), false);
});

test('paneBackgroundOf: empty / non-array input is safe (returns false)', () => {
  assert.equal(paneBackgroundOf([]), false);
  assert.equal(paneBackgroundOf(null), false);
  assert.equal(paneBackgroundOf(undefined), false);
  assert.equal(paneBackgroundOf('not an array'), false);
});

test('paneBackgroundOf: the signal is only read off the last ~6 non-blank lines', () => {
  // an old "background active" line in scrollback must not count when more than 6 non-blank lines sit below it
  const lines = [
    '   ◐ Tasks · 1 background active',
    'a',
    'b',
    'c',
    'd',
    'e',
    'f',
    'g',
    '   › hi',
  ];
  assert.equal(paneBackgroundOf(lines), false);
});

const mkTable = (rows) => { // rows: [pid, ppid, args]
  const children = new Map(), args = new Map();
  for (const [pid, ppid, a] of rows) { args.set(pid, a); if (!children.has(ppid)) children.set(ppid, []); children.get(ppid).push(pid); }
  return { children, args, rss: new Map() };
};

test('scriptBusyOf: a script-wrapped `claude -p` child counts', () => {
  const t = mkTable([
    [1, 0, 'tmux pane shell'],
    [2, 1, 'bash /home/u/run.sh'],
    [3, 2, '/home/u/.local/bin/claude -p "do the thing"'],
  ]);
  assert.equal(scriptBusyOf(1, t), true);
});

test('scriptBusyOf: a `claude --print` child counts', () => {
  const t = mkTable([[1, 0, 'bash'], [2, 1, 'claude --print "summary"']]);
  assert.equal(scriptBusyOf(1, t), true);
});

test('scriptBusyOf: a `sleep` under a bash script counts', () => {
  const t = mkTable([[1, 0, 'bash /home/u/wait.sh'], [2, 1, 'sleep 60']]);
  assert.equal(scriptBusyOf(1, t), true);
});

test('scriptBusyOf: a bare bash prompt does not count', () => {
  const t = mkTable([[1, 0, 'bash']]);
  assert.equal(scriptBusyOf(1, t), false);
});

test('scriptBusyOf: an interactive claude REPL does not count (the guard already labels it as the agent)', () => {
  const t = mkTable([[1, 0, 'bash'], [2, 1, '/home/u/.local/bin/claude --dangerously-skip-permissions']]);
  assert.equal(scriptBusyOf(1, t), false);
});

test('scriptBusyOf: bad / missing input is safe (returns false)', () => {
  assert.equal(scriptBusyOf(0, mkTable([[1, 0, 'bash']])), false);
  assert.equal(scriptBusyOf(null, mkTable([[1, 0, 'bash']])), false);
  assert.equal(scriptBusyOf(1, null), false);
  assert.equal(scriptBusyOf(1, { children: new Map(), args: new Map() }), false);
});

test('scriptBusyOf: walks the tree breadth-first to depth 8', () => {
  // a claude -p that is 5 levels deep must still be found
  const t = mkTable([
    [1, 0, 'bash'],
    [2, 1, 'bash'],
    [3, 2, 'bash'],
    [4, 3, 'bash'],
    [5, 4, 'bash'],
    [6, 5, 'claude -p "deep"'],
  ]);
  assert.equal(scriptBusyOf(1, t), true);
});