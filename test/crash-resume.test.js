import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrashResumeCommand, crashLineOf, decideCrashResume, createCrashResumer } from '../crash-resume.js';

const base = 'claude --dangerously-skip-permissions';
const state = (extra = {}) => ({ name: 'pane', tmuxName: 'pane', base, model: 'opus', claudeSessionId: 'sid', shellForeground: true, agent: null, scriptBusy: false, input: '', lines: ['x', 'launch.sh: line 3: 123 Aborted  env claude --model opus --remote-control real-name -n real-name ', 'bash$'], ...extra });

test('strict detection ignores regex text in a live manager pane', () => {
  assert.equal(crashLineOf(['text /line 3: +\\d+ (Aborted|Segmentation fault|Killed)\\s/']), null);
  assert.equal(decideCrashResume({ state: state({ name: 'manager' }), consecutiveNoAgent: 2, managerSessions: ['manager'] }).ok, false);
});

test('live agent with an Aborted word is never a crash', () => {
  assert.equal(decideCrashResume({ state: state({ agent: 'claude', lines: ['Aborted in a discussion'] }), consecutiveNoAgent: 2 }).reason, 'agent-alive');
});

test('requires exact job message, shell, and two absent polls', () => {
  assert.equal(decideCrashResume({ state: state(), consecutiveNoAgent: 1 }).reason, 'agent-not-absent-twice');
  // "Aborted" only counts when it is the whole line (see the bare abort test below), not inside text.
  assert.equal(decideCrashResume({ state: state({ lines: ['Aborted while reading the agent log', 'bash$'] }), consecutiveNoAgent: 2 }).reason, 'no-exact-job-message');
  assert.equal(decideCrashResume({ state: state({ shellForeground: false }), consecutiveNoAgent: 2 }).reason, 'not-shell');
});

test('bare abort with no wrapper job line is a crash of this session', () => {
  const d = decideCrashResume({ state: state({ lines: ['Aborted (core dumped)', 'bash$'] }), consecutiveNoAgent: 2 });
  assert.equal(d.ok, true);
  assert.equal(d.bare, true);
  assert.deepEqual(d.crash, { name: 'pane', model: 'opus', line: 'Aborted (core dumped)' });
  assert.equal(d.command, `${base} --model opus --remote-control 'pane' -n 'pane' --resume sid`);
});

test('bare abort still needs two absent polls, a dead shell and a live cwd', () => {
  const lines = ['Aborted', 'bash$'];
  assert.equal(decideCrashResume({ state: state({ lines }), consecutiveNoAgent: 1 }).reason, 'agent-not-absent-twice');
  assert.equal(decideCrashResume({ state: state({ lines, agent: 'claude' }), consecutiveNoAgent: 2 }).reason, 'agent-alive');
  assert.equal(decideCrashResume({ state: state({ lines, shellForeground: false }), consecutiveNoAgent: 2 }).reason, 'not-shell');
  assert.equal(decideCrashResume({ state: state({ lines, cwd: '/work/tree (deleted)' }), consecutiveNoAgent: 2 }).reason, 'cwd-gone');
});

test('builds resume with real remote name, model, base, and id', () => {
  assert.equal(buildCrashResumeCommand({ base, crash: { name: 'real-name', model: 'sonnet' }, model: 'opus', claudeSessionId: 'sid' }), "claude --dangerously-skip-permissions --model opus --remote-control 'real-name' -n 'real-name' --resume sid");
});

test('resumer sends literal text then Enter separately and throttles', async () => {
  const calls = [], events = [];
  const r = createCrashResumer({ getState: async () => state(), sendText: async (...x) => calls.push(['text', ...x]), sendEnter: async (...x) => calls.push(['enter', ...x]), record: async (e) => events.push(e), now: () => 1000 });
  await r.tick(['pane']);
  await r.tick(['pane']);
  assert.deepEqual(calls.map((x) => x[0]), ['text', 'enter']);
  assert.equal(events[0].key, 'health:session-crash-resumed:pane');
  assert.equal((await r.tick(['pane']))[0].reason, 'throttled');
});
