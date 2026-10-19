import test from 'node:test';
import assert from 'node:assert/strict';
import { scanCrash, crashLineOf, decideCrashResume, createCrashResumer, findClaudeSessionId } from '../crash-resume.js';

const base = 'claude --dangerously-skip-permissions';
const T129 = [
  '❯ /home/jndoye/handovers/TASK129-deferred-restart.launch.sh: line 3: 3526208 Aborted                 env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN /home/jndo',
  'ye/.local/bin/claude --dangerously-skip-permissions --remote-control TASK129-deferred-restart -n TASK129-deferred-restart --model sonnet "$(cat /home/jndoye/han',
  'dovers/TASK129-deferred-restart.prompt.md)"                                                                             ✔ Update installed · Restart to update',
  'shell-init: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory     new task? /clear to save 166.5k tokens',
  'jndoye@codebox:~/vpt-deferred-restart$                                                                                                                     /rc',
];
const GAME = [
  '❯ /home/jndoye/handovers/game-report-ai-usage.launch.sh: line 3: 2344833 Aborted                 env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN /home/jndoye/.local/bin/claude --dangerous',
  'ly-skip-permissions --remote-control game-report-ai-usage -n game-report-ai-usage --model sonnet "$(cat /home/jndoye/handovers/game-report-ai-usage.prompt.md)"─────────────────────────────',
  'jndoye@codebox:~/virtualpytest$                                                                                                                     ✔ Update installed · Restart to update',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)                                                                                                     new task? /clear to save 138.7k tokens',
  '                                                                                                                                                                                       /rc',
];
const TYPED = [
  'launch.sh: line 3: 99 Aborted                 env claude --remote-control coc-llm-haiku -n coc-llm-haiku --model haiku "$(cat p.md)"',
  'jndoye@codebox:~/virtualpytest$ what is the status are we still waiting ?',
  '-bash: what: command not found',
  'jndoye@codebox:~/virtualpytest$',
];
const st = (lines, extra = {}) => ({ name: 'pane', tmuxName: 'pane', cwd: '/home/jndoye/virtualpytest', base, model: null, claudeSessionId: 'sid', shellForeground: true, agent: null, scriptBusy: false, input: '', lines, ...extra });
const dec = (s) => decideCrashResume({ state: s, consecutiveNoAgent: 2 });

test('wrapped job line + trailing banner noise + getcwd error: parsed, but cwd gone is not resumed', () => {
  const scan = scanCrash(T129);
  assert.match(scan.line, /--remote-control TASK129-deferred-restart -n TASK129-deferred-restart --model sonnet "\$\(cat \/home\/jndoye\/handovers\/TASK129-deferred-restart\.prompt\.md\)"$/);
  assert.equal(scan.cwdGone, true);
  const d = dec(st(T129, { cwd: '/home/jndoye/vpt-deferred-restart (deleted)' }));
  assert.equal(d.reason, 'cwd-gone');
  assert.equal(d.crash.name, 'TASK129-deferred-restart');
});

test('job line wrapped inside a flag, then fresh prompt and TUI leftovers: resumed with real name and model', () => {
  const d = dec(st(GAME));
  assert.equal(d.ok, true);
  assert.equal(d.crash.name, 'game-report-ai-usage');
  assert.equal(d.crash.model, 'sonnet');
  assert.match(d.command, /--remote-control 'game-report-ai-usage' -n 'game-report-ai-usage' --resume sid$/);
});

test('human-typed line in the bare shell and its command-not-found reply are tolerated', () => {
  const d = dec(st(TYPED));
  assert.equal(d.ok, true);
  assert.equal(d.crash.name, 'coc-llm-haiku');
});

test('real output after the job line (agent ran again / command output) is not a crash', () => {
  assert.equal(crashLineOf([...TYPED, 'some real output', 'jndoye@codebox:~$']), null);
  assert.equal(crashLineOf([...TYPED.slice(0, 1), '❯ hello', 'jndoye@codebox:~$']), null);
});

test('no job line (older one scrolled off or loop script ended): no resume', () => {
  assert.equal(dec(st(['40 turns done; restart the loop to continue', 'jndoye@codebox:~/virtualpytest$'])).reason, 'no-exact-job-message');
});

test('safety rules still hold', () => {
  assert.equal(decideCrashResume({ state: st(GAME), consecutiveNoAgent: 1 }).reason, 'agent-not-absent-twice');
  assert.equal(decideCrashResume({ state: st(GAME, { agent: 'claude' }), consecutiveNoAgent: 2 }).reason, 'agent-alive');
  assert.equal(decideCrashResume({ state: st(GAME, { input: 'draft' }), consecutiveNoAgent: 2 }).reason, 'input-not-empty');
  assert.equal(decideCrashResume({ state: st(GAME), consecutiveNoAgent: 2, closed: true }).reason, 'closed');
});

test('tick covers an already-dead pane once: resumes after two polls, never twice for the same crash', async () => {
  const calls = [];
  let t = 1000;
  const r = createCrashResumer({ getState: async () => st(GAME), sendText: async (...x) => calls.push(['text', ...x]), sendEnter: async (...x) => calls.push(['enter', ...x]), record: async () => {}, now: () => t });
  assert.equal((await r.tick(['pane']))[0].reason, 'agent-not-absent-twice');
  assert.equal((await r.tick(['pane']))[0].ok, true);
  t += 60 * 60 * 1000;
  assert.equal((await r.tick(['pane']))[0].reason, 'already-handled');
  assert.equal(calls.length, 2);
});

test('cwd gone is recorded once as a manager item, nothing is sent', async () => {
  const calls = [], events = [];
  const r = createCrashResumer({ getState: async () => st(T129, { cwd: '/home/jndoye/vpt-deferred-restart (deleted)' }), sendText: async (...x) => calls.push(x), sendEnter: async (...x) => calls.push(x), record: async (e) => events.push(e) });
  for (let i = 0; i < 4; i++) await r.tick(['pane']);
  assert.equal(calls.length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'health:session-crash-needs-owner:pane');
});

test('missing session id is looked up from transcripts', async () => {
  const fs = {
    readdir: async () => ['a.jsonl', 'b.jsonl'],
    stat: async (f) => ({ mtimeMs: f.endsWith('b.jsonl') ? 2 : 1 }),
    readTail: async (f) => (f.endsWith('a.jsonl') ? '{"agentName":"game-report-ai-usage"}' : '{"agentName":"other"}'),
  };
  assert.equal(await findClaudeSessionId({ name: 'game-report-ai-usage', cwd: '/home/jndoye/virtualpytest', projectsDir: '/p', fs }), 'a');
  const calls = [];
  const r = createCrashResumer({ getState: async () => st(GAME, { claudeSessionId: null }), sendText: async (...x) => calls.push(x), sendEnter: async () => {}, record: async () => {}, resolveSessionId: async () => 'found-id' });
  await r.tick(['pane']); await r.tick(['pane']);
  assert.match(calls[0][1], /--resume found-id$/);
});
