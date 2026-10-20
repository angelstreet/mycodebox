import test from 'node:test';
import assert from 'node:assert/strict';
import { scanCrash, scanBareAbort, crashLineOf, decideCrashResume, createCrashResumer, findClaudeSessionId } from '../crash-resume.js';

const base = 'claude --dangerously-skip-permissions';
// Captured session output from a real abort trace: keep the structure (wrap + jndoye@codebox prompt) but use a
// placeholder home path so this fixture cannot leak a real /home/<user> location. The original wrapped the launcher
// across two physical lines (column-wrap); we keep that structure for the scanner test.
const T129 = [
  '❯ /home/user/handovers/TASK129-deferred-restart.launch.sh: line 3: 99999 Aborted                 env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN /home/user/.local/bin/clau',
  'de --dangerously-skip-permissions --remote-control TASK129-deferred-restart -n TASK129-deferred-restart --model sonnet "$(cat /home/user/han',
  'dovers/TASK129-deferred-restart.prompt.md)"                                                                             ✔ Update installed · Restart to update',
  'shell-init: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory     new task? /clear to save 166.5k tokens',
  'user@host:~/vpt-deferred-restart$                                                                                                                     /rc',
];
const GAME = [
  '❯ /home/user/handovers/game-report-ai-usage.launch.sh: line 3: 88888 Aborted                 env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN /home/user/.local/bin/claude --dangerous',
  'ly-skip-permissions --remote-control game-report-ai-usage -n game-report-ai-usage --model sonnet "$(cat /home/user/handovers/game-report-ai-usage.prompt.md)"─────────────────────────────',
  'user@host:~/virtualpytest$                                                                                                                     ✔ Update installed · Restart to update',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)                                                                                                     new task? /clear to save 138.7k tokens',
  '                                                                                                                                                                                       /rc',
];
const TYPED = [
  'launch.sh: line 3: 99 Aborted                 env claude --remote-control coc-llm-haiku -n coc-llm-haiku --model haiku "$(cat p.md)"',
  'user@host:~/virtualpytest$ what is the status are we still waiting ?',
  '-bash: what: command not found',
  'user@host:~/virtualpytest$',
];
// A RESUMED claude that aborts again leaves no "line N: pid" wrapper line: interactive bash only prints the bare
// message, sometimes behind a leftover TUI marker and next to the dead agent's status bar.
const BARE = ['Aborted', 'user@host:~/virtualpytest$'];
const BARE_TUI = [
  '❯ Aborted                                             ⏵⏵ bypass permissions on (shift+tab to cycle)',
  '  ⏵⏵ auto-accept edits on (shift+tab to cycle)                                                                new task? /clear to save 166.5k tokens',
  'user@host:~/virtualpytest$',
];
const BARE_CORE = ['Aborted (core dumped)', 'user@host:~/virtualpytest$'];
const BARE_THEN_OUTPUT = ['Aborted', 'the report was written to disk', 'user@host:~/virtualpytest$'];
const st = (lines, extra = {}) => ({ name: 'pane', tmuxName: 'pane', cwd: '/home/user/virtualpytest', base, model: null, claudeSessionId: 'sid', shellForeground: true, agent: null, scriptBusy: false, input: '', lines, ...extra });
const dec = (s) => decideCrashResume({ state: s, consecutiveNoAgent: 2 });
const NOW = 1780000000000;
// A fake ~/.claude/projects tree: { '<projectsDir>/<encoded cwd>': { '<id>.jsonl': { mtime, tail } } }. No real paths.
const fakeProjects = (tree, onRead = () => {}) => ({
  readdir: async (dir) => {
    if (dir === '/p') return Object.keys(tree).filter((d) => d.slice(0, d.lastIndexOf('/')) === dir).map((d) => d.slice(d.lastIndexOf('/') + 1));
    const entries = tree[dir];
    if (!entries) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' });
    return Object.keys(entries);
  },
  stat: async (file) => ({ mtimeMs: fakeEntry(tree, file).mtime }),
  readTail: async (file) => { onRead(file); return fakeEntry(tree, file).tail; },
});
function fakeEntry(tree, file) {
  const i = file.lastIndexOf('/'), e = tree[file.slice(0, i)]?.[file.slice(i + 1)];
  if (!e) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  return e;
}

test('wrapped job line + trailing banner noise + getcwd error: parsed, but cwd gone is not resumed', () => {
  const scan = scanCrash(T129);
  assert.match(scan.line, /--remote-control TASK129-deferred-restart -n TASK129-deferred-restart --model sonnet "\$\(cat \/home\/user\/handovers\/TASK129-deferred-restart\.prompt\.md\)"$/);
  assert.equal(scan.cwdGone, true);
  const d = dec(st(T129, { cwd: '/home/user/vpt-deferred-restart (deleted)' }));
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
  assert.equal(crashLineOf([...TYPED, 'some real output', 'user@host:~$']), null);
  assert.equal(crashLineOf([...TYPED.slice(0, 1), '❯ hello', 'user@host:~$']), null);
});

test('no job line (older one scrolled off or loop script ended): no resume', () => {
  assert.equal(dec(st(['40 turns done; restart the loop to continue', 'user@host:~/virtualpytest$'])).reason, 'no-exact-job-message');
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
  const r = createCrashResumer({ getState: async () => st(T129, { cwd: '/home/user/vpt-deferred-restart (deleted)' }), sendText: async (...x) => calls.push(x), sendEnter: async (...x) => calls.push(x), record: async (e) => events.push(e) });
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
  assert.deepEqual(await findClaudeSessionId({ name: 'game-report-ai-usage', cwd: '/home/user/virtualpytest', projectsDir: '/p', fs }), { sessionId: 'a', cwd: '/home/user/virtualpytest' });
  const calls = [];
  const r = createCrashResumer({ getState: async () => st(GAME, { claudeSessionId: null }), sendText: async (...x) => calls.push(x), sendEnter: async () => {}, record: async () => {}, resolveSessionId: async () => 'found-id' });
  await r.tick(['pane']); await r.tick(['pane']);
  assert.match(calls[0][1], /--resume found-id$/);
});

test('the resumer takes the session id out of the resolver object', async () => {
  const calls = [];
  const r = createCrashResumer({ getState: async () => st(GAME, { claudeSessionId: null }), sendText: async (...x) => calls.push(x), sendEnter: async () => {}, record: async () => {},
    resolveSessionId: async () => ({ sessionId: 'sid-from-elsewhere', cwd: '/srv/evolai' }) });
  await r.tick(['pane']); await r.tick(['pane']);
  assert.match(calls[0][1], /--resume sid-from-elsewhere$/);
});

test('a dead pane outside the conversation dir finds its session id and its own cwd', async () => {
  const tree = {
    '/p/-home-user': {},                                   // the shell went back to $HOME: no transcript here
    '/p/-srv-codebox-evolai': { 'sid-evolai.jsonl': { mtime: NOW - 1000, tail: '{"cwd":"/srv/codebox/evolai","agentName":"evolai"}' } },
  };
  assert.deepEqual(await findClaudeSessionId({ name: 'evolai', cwd: '/home/user', projectsDir: '/p', fs: fakeProjects(tree), now: NOW }),
    { sessionId: 'sid-evolai', cwd: '/srv/codebox/evolai' });
});

test('no match in any project dir -> null, and transcripts older than the lookback window are not read', async () => {
  const tree = {
    '/p/-home-user': {},
    '/p/-srv-other': { 'other.jsonl': { mtime: NOW - 1000, tail: '{"cwd":"/srv/other","agentName":"someone-else"}' } },
    '/p/-srv-ancient': { 'ancient.jsonl': { mtime: NOW - 15 * 86400000, tail: '{"cwd":"/srv/ancient","agentName":"evolai"}' } },
  };
  let read = 0;
  const fs = fakeProjects(tree, () => read++);
  assert.equal(await findClaudeSessionId({ name: 'evolai', cwd: '/home/user', projectsDir: '/p', fs, now: NOW }), null);
  assert.equal(read, 1);                                   // only the recent one was read, the 15-day-old transcript was not
  assert.equal(await findClaudeSessionId({ name: 'evolai', cwd: '/home/user', projectsDir: '/missing', fs, now: NOW }), null);
});

test('the newest match across the other project dirs wins, by mtime', async () => {
  const tree = {
    '/p/-home-user': {},
    '/p/-srv-middle': { 'mid.jsonl': { mtime: NOW - 5000, tail: '{"cwd":"/srv/middle","customTitle":"evolai"}' } },
    '/p/-srv-new': { 'new.jsonl': { mtime: NOW - 1000, tail: '{"cwd":"/srv/new","agentName":"evolai","cwd":"/srv/new"}' } },
  };
  assert.deepEqual(await findClaudeSessionId({ name: 'evolai', cwd: '/home/user', projectsDir: '/p', fs: fakeProjects(tree), now: NOW }),
    { sessionId: 'new', cwd: '/srv/new' });              // and the transcript's last cwd field, not its first
});

test('bare abort lines resume; real agent output after one is not a crash', () => {
  assert.equal(scanBareAbort(BARE).line, 'Aborted');
  assert.equal(scanBareAbort(BARE_CORE).line, 'Aborted (core dumped)');
  assert.equal(scanBareAbort(BARE_TUI).line, 'Aborted');
  assert.equal(scanBareAbort(BARE_THEN_OUTPUT), null);
  assert.equal(scanCrash(BARE), null);
  for (const lines of [BARE, BARE_TUI, BARE_CORE]) {
    const d = dec(st(lines));
    assert.equal(d.ok, true, lines[0]);
    assert.equal(d.bare, true);
    assert.equal(d.crash.name, 'pane');
    assert.match(d.command, /--remote-control 'pane' -n 'pane' --resume sid$/);
  }
  assert.equal(dec(st(BARE_THEN_OUTPUT)).reason, 'no-exact-job-message');
});

test('a bare Aborted after a resume is resumed again: the line text is not the dedupe key', async () => {
  const calls = [], events = [];
  let t = 1000;
  const r = createCrashResumer({ getState: async () => st(BARE), sendText: async (...x) => calls.push(['text', ...x]), sendEnter: async (...x) => calls.push(['enter', ...x]), record: async (e) => events.push(e), now: () => t });
  assert.equal((await r.tick(['pane']))[0].reason, 'agent-not-absent-twice');
  assert.equal((await r.tick(['pane']))[0].ok, true);
  assert.equal((await r.tick(['pane']))[0].reason, 'throttled');
  t += 31 * 60 * 1000;
  assert.equal((await r.tick(['pane']))[0].ok, true, 'same pane, same Aborted text, new crash after the throttle');
  assert.equal(calls.filter((c) => c[0] === 'text').length, 2);
  assert.equal(events.length, 2);
});

test('4th crash inside 6 h is a crash loop: one manager record, nothing sent, resumes again after the window', async () => {
  const calls = [], events = [];
  let t = 1000;
  const r = createCrashResumer({ getState: async () => st(BARE), sendText: async (...x) => calls.push(['text', ...x]), sendEnter: async (...x) => calls.push(['enter', ...x]), record: async (e) => events.push(e), now: () => t });
  assert.equal((await r.tick(['pane']))[0].reason, 'agent-not-absent-twice');
  for (let i = 0; i < 3; i++) { assert.equal((await r.tick(['pane']))[0].ok, true, `resume ${i + 1}`); t += 31 * 60 * 1000; }
  assert.equal((await r.tick(['pane']))[0].reason, 'crash-loop');
  assert.equal((await r.tick(['pane']))[0].reason, 'crash-loop');
  assert.equal(calls.filter((c) => c[0] === 'text').length, 3);
  const loops = events.filter((e) => e.key === 'health:session-crash-loop:pane');
  assert.equal(loops.length, 1);
  assert.equal(loops[0].title, 'session crash loop, needs manual resume: pane');
  assert.equal(loops[0].body, '4 crashes in 6 h; last: Aborted');
  t += 6 * 60 * 60 * 1000;
  assert.equal((await r.tick(['pane']))[0].ok, true);
});

test('first-ever bare crash without a session id is resolved from transcripts and resumed', async () => {
  const calls = [];
  const r = createCrashResumer({ getState: async () => st(BARE_CORE, { claudeSessionId: null }), sendText: async (...x) => calls.push(x), sendEnter: async () => {}, record: async () => {}, resolveSessionId: async ({ name }) => (name === 'pane' ? 'found-id' : null) });
  await r.tick(['pane']); await r.tick(['pane']);
  assert.deepEqual(calls[0], ['pane', `${base} --remote-control 'pane' -n 'pane' --resume found-id`]);
});
