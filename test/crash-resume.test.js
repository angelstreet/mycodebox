// Crash auto-resume (2026-10-18): detect SIGABRT / segfault / Killed / core dumped / FATAL ERROR
// in the pane and restart the agent with the same flags parking resume / dashboard Resume use.
// Pure helpers (isCrashLine, isNormalExitLine, classifyTail, recentAgentOf, shouldThrottle,
// decideCrashResume, buildResumeCommand) are exported for tests; the IO lives in
// createCrashResumer() and is covered by an end-to-end fake-tmux test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isCrashLine, isNormalExitLine, classifyTail, shouldThrottle, recentAgentOf, buildResumeCommand, decideCrashResume, createCrashResumer, CRASH_RESUME_DEFAULTS } from '../crash-resume.js';
import { resumeCommand } from '../parking.js';

// ---------- isCrashLine / isNormalExitLine ----------

test('isCrashLine: Aborted / Segmentation fault / Killed / core dumped / FATAL ERROR / SIGABRT', () => {
  assert.equal(isCrashLine('12345 Aborted                 (core dumped)'), true);
  assert.equal(isCrashLine('Segmentation fault (core dumped)'), true);
  assert.equal(isCrashLine('Killed'), true);
  assert.equal(isCrashLine('Killed (signal 9)'), true);
  assert.equal(isCrashLine('Killed by signal 11'), true);
  assert.equal(isCrashLine('core dumped'), true);
  assert.equal(isCrashLine('FATAL ERROR: out of memory'), true);
  assert.equal(isCrashLine('SIGABRT received'), true);
  // a real-world shell wrapper line: "<pid> Aborted   ... claude ... --remote-control <name>"
  assert.equal(isCrashLine('  12345 Aborted                          claude --remote-control my-session'), true);
});

test('isCrashLine: false on quiet lines, prompts, and unrelated text', () => {
  assert.equal(isCrashLine('user@box:~$'), false);
  assert.equal(isCrashLine('  ⎿  Done · 2 files · 14 lines'), false);
  assert.equal(isCrashLine('Thinking…'), false);
  assert.equal(isCrashLine('Reading /etc/hosts'), false);
  assert.equal(isCrashLine('Killed it gently'), false);  // "Killed" must be a kernel-style marker
  // edge cases
  assert.equal(isCrashLine(''), false);
  assert.equal(isCrashLine(null), false);
  assert.equal(isCrashLine(undefined), false);
});

test('isNormalExitLine: /exit, Exit and stop tasks, Goodbye, Session ended', () => {
  assert.equal(isNormalExitLine('> /exit'), true);
  assert.equal(isNormalExitLine('> /exit '), true);
  assert.equal(isNormalExitLine('Exit and stop tasks'), true);
  assert.equal(isNormalExitLine('Goodbye!'), true);
  assert.equal(isNormalExitLine('Session ended'), true);
  assert.equal(isNormalExitLine('Clean exit'), true);
  // must NOT match a mid-sentence "exit" or "ended"
  assert.equal(isNormalExitLine('exit code 0'), false);
  assert.equal(isNormalExitLine('session ended gracefully'), false);   // lowercase prefix wins; NORMAL_EXIT_RE requires /exit or the literal phrases
  // but "Session ended" is the literal phrase — keep it matched
  assert.equal(isNormalExitLine('Session ended.'), true);
});

test('isNormalExitLine: false on crash markers and ordinary prompts', () => {
  assert.equal(isNormalExitLine('Aborted (core dumped)'), false);
  assert.equal(isNormalExitLine('user@box:~$'), false);
});

// ---------- classifyTail ----------

test('classifyTail: returns none when the pane is empty / no markers', () => {
  assert.deepEqual(classifyTail([]), { verdict: 'none' });
  assert.deepEqual(classifyTail(['  ', '']), { verdict: 'none' });
  assert.deepEqual(classifyTail(['user@box:~$', 'ls -la', 'README.md']), { verdict: 'none' });
});

test('classifyTail: crash wins when the last interesting line is a crash marker', () => {
  const pane = [
    '  ⎿  Done · 2 files',
    '  Aborted (core dumped)',
    'user@box:~$',
  ];
  const cls = classifyTail(pane);
  assert.equal(cls.verdict, 'crash');
  assert.match(cls.line, /Aborted/);
  // The crash line is the last *interesting* line (the bash prompt after it is not interesting).
  assert.equal(cls.at, 1);
  assert.equal(cls.total, 3);
});

test('classifyTail: normal exit when only a normal-exit marker is present', () => {
  const pane = [
    '> /exit',
    'Goodbye!',
    'user@box:~$',
  ];
  const cls = classifyTail(pane);
  assert.equal(cls.verdict, 'normal-exit');
  assert.match(cls.line, /Goodbye/);
});

test('classifyTail: a crash marker after a /exit still counts as a crash (the last interesting line wins)', () => {
  // The user typed /exit, the agent then died on the way out: the crash marker is the bottom of the pane.
  const pane = [
    '> /exit',
    'Aborted (core dumped)',
  ];
  const cls = classifyTail(pane);
  assert.equal(cls.verdict, 'crash');
});

test('classifyTail: a /exit typed AFTER the crash means the user accepted the crash — not resumed', () => {
  // The agent crashed, then the user typed /exit at the bash prompt. The /exit is the last
  // interesting line; we do NOT resume (the user has already moved on).
  const pane = [
    'Aborted (core dumped)',
    '> /exit',
  ];
  const cls = classifyTail(pane);
  assert.equal(cls.verdict, 'normal-exit');
});

test('classifyTail: tail window limits the scan (an old crash line is ignored)', () => {
  // 100 lines: an old "Aborted" at the top, a live bash prompt at the bottom, 98 blank between.
  // Default tail=30 only sees the bottom (the prompt, no crash) -> 'none'.
  // tail=100 sees the whole pane -> the old 'Aborted' line wins -> 'crash'.
  const long = Array.from({ length: 100 }, (_, i) => {
    if (i === 0) return 'old crash line Aborted';
    if (i === 99) return 'user@box:~$';
    return '';
  });
  assert.equal(classifyTail(long).verdict, 'none');
  assert.equal(classifyTail(long, 100).verdict, 'crash');
});

// ---------- shouldThrottle ----------

test('shouldThrottle: blocks when the last resume is inside the window', () => {
  assert.equal(shouldThrottle({ lastResumeAt: 1000, now: 1000 + 29 * 60 * 1000, minIntervalMs: 30 * 60 * 1000 }), true);
  assert.equal(shouldThrottle({ lastResumeAt: 1000, now: 1000 + 30 * 60 * 1000, minIntervalMs: 30 * 60 * 1000 }), false);
  assert.equal(shouldThrottle({ lastResumeAt: 1000, now: 1000 + 31 * 60 * 1000, minIntervalMs: 30 * 60 * 1000 }), false);
  assert.equal(shouldThrottle({ lastResumeAt: null, now: 5000 }), false);
  assert.equal(shouldThrottle({}), false);
});

// ---------- recentAgentOf ----------

test('recentAgentOf: returns the entry when fresh, null when stale or missing', () => {
  const m = new Map([['a', { agent: 'claude', at: 1000 }], ['b', { agent: 'minimax', at: 0 }]]);
  assert.deepEqual(recentAgentOf(m, 'a', 1000 + 4 * 60 * 1000, 5 * 60 * 1000), { agent: 'claude', at: 1000 });
  assert.equal(recentAgentOf(m, 'a', 1000 + 6 * 60 * 1000, 5 * 60 * 1000), null);
  assert.equal(recentAgentOf(m, 'b', 1000, 5 * 60 * 1000), null);   // at=0 is not "now"
  assert.equal(recentAgentOf(m, 'c', 1000, 5 * 60 * 1000), null);
  assert.equal(recentAgentOf(null, 'a', 1000), null);
});

// ---------- buildResumeCommand ----------

test('buildResumeCommand: claude reuses resumeCommand (model + remote-control + --resume id)', () => {
  const cmd = buildResumeCommand({
    agent: 'claude',
    lastAgent: { claudeSessionId: 'sid-abc', claudeName: 'my-session', args: 'claude --dangerously-skip-permissions --model opus --remote-control my-session -n my-session' },
    base: 'claude --dangerously-skip-permissions',
  });
  assert.equal(cmd, "claude --dangerously-skip-permissions --model opus --remote-control 'my-session' -n 'my-session' --resume sid-abc");
  // and it must match the parking helper so the flags the dashboard Resume / parking resume
  // already produce are byte-identical
  const expected = resumeCommand({ base: 'claude --dangerously-skip-permissions', args: 'claude --dangerously-skip-permissions --model opus --remote-control my-session -n my-session', name: 'my-session', sessionId: 'sid-abc' });
  assert.equal(cmd, expected);
});

test('buildResumeCommand: claude with no sessionId returns null (nothing to resume)', () => {
  assert.equal(buildResumeCommand({ agent: 'claude', lastAgent: { args: 'claude', claudeName: 'n' }, base: 'claude' }), null);
  assert.equal(buildResumeCommand({ agent: 'claude', lastAgent: null, base: 'claude' }), null);
});

test('buildResumeCommand: minimax uses mcode -c (no per-session id)', () => {
  assert.equal(buildResumeCommand({ agent: 'minimax', lastAgent: { cwd: '/w' }, base: 'mcode' }), 'mcode -c');
});

test('buildResumeCommand: codex uses codex -c to continue the last session in cwd', () => {
  assert.equal(buildResumeCommand({ agent: 'codex', lastAgent: { cwd: '/w' }, base: 'codex' }), 'codex -c');
});

test('buildResumeCommand: unknown agent returns null', () => {
  assert.equal(buildResumeCommand({ agent: 'bash', lastAgent: {}, base: 'bash' }), null);
});

// ---------- decideCrashResume ----------

const lastAgent = (entries) => new Map(Object.entries(entries));
const meta = ({ paused = false, held = null } = {}) => ({ isPaused: () => paused, held: () => held });

test('decideCrashResume: ok when pane shows Aborted and lastAgent is fresh (claude)', () => {
  const t = 1_000_000;
  const la = lastAgent({
    s1: { agent: 'claude', claudeSessionId: 'sid', claudeName: 's1', args: 'claude --dangerously-skip-permissions --model opus --remote-control s1 -n s1', at: t - 60_000 },
  });
  const d = decideCrashResume({
    plainLines: ['  ⎿  Done', '  12345 Aborted                          claude --remote-control s1', 'user@box:~$'],
    lastAgent: la,
    name: 's1',
    now: t,
    sessionMeta: meta(),
    scriptBusy: false,
    base: { claude: 'claude --dangerously-skip-permissions', minimax: 'mcode', codex: 'codex' },
  });
  assert.equal(d.ok, true);
  assert.equal(d.reason, 'crash');
  assert.match(d.command, /--resume sid/);
  assert.match(d.command, /--model opus/);
});

test('decideCrashResume: refuses paused sessions (owner hit pause)', () => {
  const t = 1_000_000;
  const la = lastAgent({ s1: { agent: 'claude', claudeSessionId: 'sid', at: t - 60_000 } });
  const d = decideCrashResume({
    plainLines: ['Aborted (core dumped)'],
    lastAgent: la, name: 's1', now: t,
    sessionMeta: meta({ paused: true }), scriptBusy: false, base: { claude: 'claude' },
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'paused');
});

test('decideCrashResume: refuses manager-held sessions', () => {
  const t = 1_000_000;
  const la = lastAgent({ s1: { agent: 'claude', claudeSessionId: 'sid', at: t - 60_000 } });
  const d = decideCrashResume({
    plainLines: ['Aborted (core dumped)'],
    lastAgent: la, name: 's1', now: t,
    sessionMeta: meta({ held: { by: 'manager', reason: 'quota', at: t - 10_000 } }), scriptBusy: false, base: { claude: 'claude' },
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'held');
});

test('decideCrashResume: refuses script-busy panes (a script loop is running the agent)', () => {
  const t = 1_000_000;
  const la = lastAgent({ s1: { agent: 'claude', claudeSessionId: 'sid', at: t - 60_000 } });
  const d = decideCrashResume({
    plainLines: ['Aborted (core dumped)'],
    lastAgent: la, name: 's1', now: t,
    sessionMeta: meta(), scriptBusy: true, base: { claude: 'claude' },
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'script-busy');
});

test('decideCrashResume: refuses when the lastAgent entry is missing or stale (we never saw this session)', () => {
  const t = 1_000_000;
  assert.equal(decideCrashResume({ plainLines: ['Aborted'], lastAgent: new Map(), name: 's1', now: t, sessionMeta: meta(), base: { claude: 'claude' } }).reason, 'no-recent-agent');
  // stale entry (10 min old, default cap is 5)
  const la = lastAgent({ s1: { agent: 'claude', claudeSessionId: 'sid', at: t - 10 * 60_000 } });
  assert.equal(decideCrashResume({ plainLines: ['Aborted'], lastAgent: la, name: 's1', now: t, sessionMeta: meta(), base: { claude: 'claude' } }).reason, 'no-recent-agent');
});

test('decideCrashResume: refuses normal exits (the user typed /exit)', () => {
  const t = 1_000_000;
  const la = lastAgent({ s1: { agent: 'claude', claudeSessionId: 'sid', at: t - 60_000 } });
  const d = decideCrashResume({
    plainLines: ['> /exit', 'user@box:~$'],
    lastAgent: la, name: 's1', now: t,
    sessionMeta: meta(), scriptBusy: false, base: { claude: 'claude' },
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'normal-exit');
});

test('decideCrashResume: refuses when there is no crash marker at all', () => {
  const t = 1_000_000;
  const la = lastAgent({ s1: { agent: 'claude', claudeSessionId: 'sid', at: t - 60_000 } });
  const d = decideCrashResume({
    plainLines: ['all quiet', 'user@box:~$'],
    lastAgent: la, name: 's1', now: t,
    sessionMeta: meta(), scriptBusy: false, base: { claude: 'claude' },
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'no-marker');
});

test('decideCrashResume: throttled inside the 30 min window (the same session keeps crashing)', () => {
  const t = 1_000_000;
  const la = lastAgent({ s1: { agent: 'claude', claudeSessionId: 'sid', at: t - 60_000 } });
  const d = decideCrashResume({
    plainLines: ['Aborted'],
    lastAgent: la, name: 's1', now: t,
    lastResumeAt: t - 5 * 60_000,   // 5 min ago
    sessionMeta: meta(), scriptBusy: false, base: { claude: 'claude' },
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'throttled');
});

test('decideCrashResume: not throttled after 30 min', () => {
  const t = 1_000_000;
  const la = lastAgent({ s1: { agent: 'claude', claudeSessionId: 'sid', at: t - 60_000 } });
  const d = decideCrashResume({
    plainLines: ['Aborted'],
    lastAgent: la, name: 's1', now: t,
    lastResumeAt: t - 31 * 60_000,
    sessionMeta: meta(), scriptBusy: false, base: { claude: 'claude' },
  });
  assert.equal(d.ok, true);
});

test('decideCrashResume: MiniMax pane -> mcode -c', () => {
  const t = 1_000_000;
  const la = lastAgent({ s1: { agent: 'minimax', at: t - 60_000 } });
  const d = decideCrashResume({
    plainLines: ['mcode panicked: FATAL ERROR', 'user@box:~$'],
    lastAgent: la, name: 's1', now: t,
    sessionMeta: meta(), scriptBusy: false, base: { claude: 'claude', minimax: 'mcode', codex: 'codex' },
  });
  assert.equal(d.ok, true);
  assert.equal(d.command, 'mcode -c');
});

test('decideCrashResume: refuses when the agent in the tree disagrees with the recorded one', () => {
  // e.g. the user started a different agent in the same tmux session after the crash
  const t = 1_000_000;
  const la = lastAgent({ s1: { agent: 'claude', claudeSessionId: 'sid', at: t - 60_000 } });
  const d = decideCrashResume({
    plainLines: ['Aborted'],
    lastAgent: la, name: 's1', now: t,
    sessionMeta: meta(), scriptBusy: false, agent: 'minimax',
    base: { claude: 'claude', minimax: 'mcode' },
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'wrong-agent');
});

// ---------- createCrashResumer: end-to-end with fake tmux + manager-events ----------

function fakeHarness() {
  const tmuxLog = [];
  const tmux = {
    sendText: async (n, t) => { tmuxLog.push(['text', n, t]); },
    sendEnter: async (n) => { tmuxLog.push(['enter', n]); },
    sendCtrlC: async (n) => { tmuxLog.push(['ctrlc', n]); },
  };
  const events = [];
  const managerEvents = { record: async (e) => { events.push(e); return true; } };
  const lastAgent = new Map();
  const lastResumeAt = new Map();
  const sessionMeta = { isPaused: () => false, held: () => null };
  const log = [];
  const r = createCrashResumer({
    getState: async (name) => fakeStates[name] || null,
    lastAgent, lastResumeAt: lastResumeAt, sessionMeta,
    base: { claude: 'claude --dangerously-skip-permissions', minimax: 'mcode', codex: 'codex' },
    tmux, managerEvents, log: (k, n, x) => log.push([k, n, x]),
    now: () => NOW,
  });
  return { r, tmuxLog, events, lastAgent, lastResumeAt, sessionMeta, log };
}
let NOW = 0;
const fakeStates = {};

test('createCrashResumer: resumes a crashed claude pane, records a health event, updates lastResumeAt', async () => {
  NOW = 1_000_000;
  const h = fakeHarness();
  h.lastAgent.set('s1', { agent: 'claude', claudeSessionId: 'sid', claudeName: 's1', args: 'claude --dangerously-skip-permissions --remote-control s1 -n s1', at: NOW - 60_000 });
  fakeStates.s1 = { plain: ['Aborted (core dumped)', 'user@box:~$'], agent: 'bash', scriptBusy: false, lastAgentAgent: 'claude' };
  const decisions = await h.r.tick(['s1']);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].ok, true);
  assert.equal(decisions[0].reason, 'crash');
  // tmux sees Ctrl-C (best effort), the text, then Enter — same pattern parking uses
  assert.deepEqual(h.tmuxLog.map(([k]) => k), ['ctrlc', 'text', 'enter']);
  assert.match(h.tmuxLog[1][2], /--resume sid/);
  // lastResumeAt is set, so a second tick inside 30 min is throttled
  assert.equal(h.lastResumeAt.get('s1'), NOW);
  // one event in the feed, key shape: `health:session-crash-resumed:<name>`
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].key, 'health:session-crash-resumed:s1');
  assert.equal(h.events[0].kind, 'health');
  assert.match(h.events[0].title, /auto-resumed crashed session: s1/);
});

test('createCrashResumer: second tick inside 30 min is throttled (no second resume, no second event)', async () => {
  NOW = 1_000_000;
  const h = fakeHarness();
  h.lastAgent.set('s1', { agent: 'claude', claudeSessionId: 'sid', claudeName: 's1', args: 'claude --dangerously-skip-permissions --remote-control s1 -n s1', at: NOW - 60_000 });
  fakeStates.s1 = { plain: ['Aborted (core dumped)'], agent: 'bash', scriptBusy: false, lastAgentAgent: 'claude' };
  await h.r.tick(['s1']);
  assert.equal(h.events.length, 1);
  // 5 min later: same crash, no resume. Keep the lastAgent entry fresh (pollOnce would have
  // refreshed it on the next tick; in the test we advance the clock so we update `at` by hand).
  NOW += 5 * 60_000;
  const e = h.lastAgent.get('s1'); e.at = NOW - 60_000;
  fakeStates.s1 = { plain: ['Aborted (core dumped)'], agent: 'bash', scriptBusy: false, lastAgentAgent: 'claude' };
  const decisions = await h.r.tick(['s1']);
  assert.equal(decisions[0].ok, false);
  assert.equal(decisions[0].reason, 'throttled');
  assert.equal(h.events.length, 1);
});

test('createCrashResumer: paused / held / scriptBusy are never resumed, no event written', async () => {
  NOW = 1_000_000;
  // paused
  const h1 = fakeHarness();
  h1.sessionMeta.isPaused = (n) => n === 's1';
  h1.lastAgent.set('s1', { agent: 'claude', claudeSessionId: 'sid', at: NOW - 60_000 });
  fakeStates.s1 = { plain: ['Aborted'], agent: 'bash', scriptBusy: false, lastAgentAgent: 'claude' };
  const d1 = await h1.r.tick(['s1']);
  assert.equal(d1[0].reason, 'paused');
  assert.equal(h1.events.length, 0);
  // held
  const h2 = fakeHarness();
  h2.sessionMeta.held = (n) => n === 's1' ? { by: 'manager' } : null;
  h2.lastAgent.set('s1', { agent: 'claude', claudeSessionId: 'sid', at: NOW - 60_000 });
  fakeStates.s1 = { plain: ['Aborted'], agent: 'bash', scriptBusy: false, lastAgentAgent: 'claude' };
  const d2 = await h2.r.tick(['s1']);
  assert.equal(d2[0].reason, 'held');
  assert.equal(h2.events.length, 0);
  // scriptBusy
  const h3 = fakeHarness();
  h3.lastAgent.set('s1', { agent: 'claude', claudeSessionId: 'sid', at: NOW - 60_000 });
  fakeStates.s1 = { plain: ['Aborted'], agent: 'bash', scriptBusy: true, lastAgentAgent: 'claude' };
  const d3 = await h3.r.tick(['s1']);
  assert.equal(d3[0].reason, 'script-busy');
  assert.equal(h3.events.length, 0);
});

test('createCrashResumer: normal-exit pane is NOT resumed (user typed /exit)', async () => {
  NOW = 1_000_000;
  const h = fakeHarness();
  h.lastAgent.set('s1', { agent: 'claude', claudeSessionId: 'sid', at: NOW - 60_000 });
  fakeStates.s1 = { plain: ['> /exit', 'Goodbye!', 'user@box:~$'], agent: 'bash', scriptBusy: false, lastAgentAgent: 'claude' };
  const d = await h.r.tick(['s1']);
  assert.equal(d[0].reason, 'normal-exit');
  assert.equal(h.events.length, 0);
  assert.equal(h.tmuxLog.length, 0);
});

test('createCrashResumer: missing lastAgent (never saw this session as an agent) is not resumed', async () => {
  NOW = 1_000_000;
  const h = fakeHarness();
  // no lastAgent entry
  fakeStates.s1 = { plain: ['Aborted (core dumped)'], agent: 'bash', scriptBusy: false, lastAgentAgent: null };
  const d = await h.r.tick(['s1']);
  assert.equal(d[0].reason, 'no-recent-agent');
  assert.equal(h.events.length, 0);
});

test('createCrashResumer: tmux failures are caught (the poll loop must not die)', async () => {
  NOW = 1_000_000;
  const h = fakeHarness();
  h.lastAgent.set('s1', { agent: 'claude', claudeSessionId: 'sid', at: NOW - 60_000 });
  fakeStates.s1 = { plain: ['Aborted (core dumped)'], agent: 'bash', scriptBusy: false, lastAgentAgent: 'claude' };
  h.tmuxLog; // (placeholder)
  const tmux2 = { sendText: async () => { throw new Error('tmux: server gone'); }, sendEnter: async () => {}, sendCtrlC: async () => {} };
  const r2 = createCrashResumer({
    getState: fakeStates.s1 ? async () => fakeStates.s1 : async () => null,
    lastAgent: h.lastAgent, lastResumeAt: h.lastResumeAt, sessionMeta: h.sessionMeta,
    base: { claude: 'claude' }, tmux: tmux2, managerEvents: h.managerEvents || { record: async () => true },
    log: () => {},
    now: () => NOW,   // match the harness: the at timestamp is relative to NOW, not Date.now
  });
  const decisions = await r2.tick(['s1']);
  assert.equal(decisions[0].ok, false);
  assert.equal(decisions[0].reason, 'io-error');
  assert.match(decisions[0].error, /tmux: server gone/);
});

test('CRASH_RESUME_DEFAULTS exposes the documented thresholds', () => {
  assert.equal(CRASH_RESUME_DEFAULTS.TAIL, 30);
  assert.equal(CRASH_RESUME_DEFAULTS.MAX_AGENT_AGE_MS, 5 * 60 * 1000);
  assert.equal(CRASH_RESUME_DEFAULTS.MIN_RESUME_INTERVAL_MS, 30 * 60 * 1000);
});
