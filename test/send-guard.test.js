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