// Crash detection + in-place auto-resume (2026-10-18).
//
// Problem: interactive Claude / codex / mcode sessions sometimes die at idle with SIGABRT
// ("Aborted", "Segmentation fault", "Killed", "core dumped", "FATAL ERROR") while the tmux
// session stays up at a bash prompt. Nobody notices for hours. The fix is to detect the
// crash from the pane text and restart the agent in place with `--resume <id>` (or `mcode -c`
// for MiniMax, `codex resume` for codex) — same flags the parking resume / dashboard Resume
// already build, so the new agent picks up the conversation exactly where it left off.
//
// Detection is a pure function over the pane text:
//   - crash marker:    Aborted | Segmentation fault | Killed | core dumped | FATAL ERROR
//   - normal exit:     /exit | "Exit and stop tasks" | "Goodbye!" | a clean prompt re-render
//   - "ran claude a moment ago": we have a recent lastAgent entry for this session name
//     (pollOnce keeps one, updated every tick the agent is alive; it survives the crash).
//
// Throttle: at most once per 30 min per session, so a crash loop never spins.
//
// Owner-closed / manager-closed sessions are never resumed:
//   - session-meta.isPaused(name) — the owner hit pause
//   - session-meta.held(name)      — the manager holds it
//   - lastAgent was null (we never saw this session as an agent) — covers random bash panes
//   - scriptBusy (a script is driving the pane) — never restart on top of a script loop
//
// Pure helpers are exported for tests; createCrashResumer() takes its IO (tmux, table, panes,
// session-meta, manager-events) as injected functions so the tick is testable end to end.

import { resumeCommand } from './parking.js';

// Crash markers: these are the strings the kernel / runtime prints when a process dies badly.
// "Killed" alone is too broad (a sentence like "Killed it gently" would match), so we require
// it to be the trailing word of a shell line, or followed by '(' / ' by '.
const CRASH_RE = /\b(Aborted|Segmentation fault|core dumped|FATAL ERROR|SIGABRT)\b|Killed\s*(?:\(|$|by\b)/;
// Normal exits: the user (or the agent) closed the agent cleanly. We do NOT resume these.
// `/exit` is the Claude/Codex REPL command; bare "exit" is a shell builtin and can appear in
// logs ("exit code 0") — only the slash form counts. The literal phrases are case-sensitive
// (the REPL prints them exactly that way; "session ended gracefully" in a log is not an exit).
const NORMAL_EXIT_RE = /(?:^|[\s>])\/exit\b|Exit and stop tasks|^Goodbye!|Session ended\b|Clean exit/;
// how many trailing non-blank lines to consider for the marker scan
const DEFAULT_TAIL = 30;
// how old the last agent entry can be for us to still call this "a moment ago"
const DEFAULT_MAX_AGENT_AGE_MS = 5 * 60 * 1000;
// throttle window per session
const DEFAULT_MIN_RESUME_INTERVAL_MS = 30 * 60 * 1000;

// Pure: a single line is a crash marker?
export function isCrashLine(line) {
  return typeof line === 'string' && CRASH_RE.test(line);
}

// Pure: a single line is a normal-exit marker?
export function isNormalExitLine(line) {
  return typeof line === 'string' && NORMAL_EXIT_RE.test(line);
}

// Pure: scan the last `tail` non-blank lines of the pane and report what we found.
// Returns:
//   { verdict: 'crash' }                         — a crash marker, no normal exit after it
//   { verdict: 'normal-exit' }                   — a normal exit marker, no crash marker after it
//   { verdict: 'none' }                          — neither
// The tail window is applied to the RAW lines first, so blank lines don't inflate it (a long
// stretch of empty output between the agent and the prompt does not push old crash markers
// back into view). The "last interesting line wins" rule mirrors what a human would do: scroll
// to the bottom. A user who typed /exit and then the agent crashed on the way out is still a
// crash, but in practice the shell prints the crash marker AFTER the /exit text, so the crash
// wins. The `at` / `total` are positions in the filtered (non-blank) tail.
export function classifyTail(plainLines, tail = DEFAULT_TAIL) {
  const all = Array.isArray(plainLines) ? plainLines : [];
  const lines = all.slice(-tail).filter((l) => String(l || '').trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isCrashLine(lines[i])) return { verdict: 'crash', line: lines[i], at: i, total: lines.length };
    if (isNormalExitLine(lines[i])) return { verdict: 'normal-exit', line: lines[i], at: i, total: lines.length };
  }
  return { verdict: 'none' };
}

// Pure: should we skip because we resumed this session too recently?
export function shouldThrottle({ lastResumeAt, now, minIntervalMs = DEFAULT_MIN_RESUME_INTERVAL_MS } = {}) {
  return lastResumeAt != null && Number.isFinite(lastResumeAt) && now - lastResumeAt < minIntervalMs;
}

// Pure: did this session have a live agent a moment ago?
// lastAgent = Map<name, { agent, claudeSessionId, claudeName, model, args, cwd, at }>
// Returns the entry, or null when missing / stale. `at <= 0` is treated as "never seen" so a
// never-initialised entry (or one from a previous process) does not survive a restart.
export function recentAgentOf(lastAgent, name, now, maxAgeMs = DEFAULT_MAX_AGENT_AGE_MS) {
  if (!lastAgent || typeof lastAgent.get !== 'function') return null;
  const e = lastAgent.get(name);
  if (!e) return null;
  if (!Number.isFinite(e.at) || e.at <= 0 || now - e.at > maxAgeMs) return null;
  return e;
}

// Pure: build the resume command for an agent. Claude: reuse resumeCommand() (model +
// remote-control + --resume <id>). MiniMax: `mcode -c` in the same cwd. codex: `codex -c`
// (continue the most recent session in cwd). The same flags the parking resume already
// produces, so the agent comes up with the right context.
export function buildResumeCommand({ agent, lastAgent, base }) {
  if (agent === 'claude') {
    const sid = lastAgent?.claudeSessionId;
    if (!sid) return null;
    return resumeCommand({ base, args: lastAgent.args || 'claude', name: lastAgent.claudeName || lastAgent.tmuxName, sessionId: sid });
  }
  if (agent === 'minimax') return `${base} -c`;
  if (agent === 'codex') return `${base} -c`;
  return null;
}

// Pick the right base command from either a string (per-agent) or the full {claude,minimax,codex} object.
function pickBase(base, agent) {
  if (!base) return '';
  if (typeof base === 'string') return base;
  return base[agent] || base.claude || '';
}

// Pure: the full decision for one session, given its pane text + bookkeeping. Returns one of:
//   { ok: true,  reason: 'crash', command, lastAgent }
//   { ok: false, reason: 'normal-exit' | 'no-marker' | 'no-recent-agent' | 'throttled' | 'paused' | 'held' | 'no-command' | 'script-busy' | 'wrong-agent' }
export function decideCrashResume({
  plainLines,
  lastAgent,
  name,
  now,
  lastResumeAt,
  sessionMeta,
  scriptBusy,
  agent,
  base,
  minIntervalMs = DEFAULT_MIN_RESUME_INTERVAL_MS,
  maxAgentAgeMs = DEFAULT_MAX_AGENT_AGE_MS,
} = {}) {
  if (sessionMeta?.isPaused?.(name)) return { ok: false, reason: 'paused' };
  if (sessionMeta?.held?.(name)) return { ok: false, reason: 'held' };
  if (scriptBusy) return { ok: false, reason: 'script-busy' };
  // Only consider sessions that recently ran an interactive agent. A bash pane that happens
  // to show "Aborted" in its scrollback (e.g. from a previous run) is not a crash to fix.
  const la = recentAgentOf(lastAgent, name, now, maxAgentAgeMs);
  if (!la) return { ok: false, reason: 'no-recent-agent' };
  // The pane must still look like a crashed agent, not a normal exit.
  const cls = classifyTail(plainLines);
  if (cls.verdict === 'normal-exit') return { ok: false, reason: 'normal-exit' };
  if (cls.verdict !== 'crash') return { ok: false, reason: 'no-marker' };
  if (shouldThrottle({ lastResumeAt, now, minIntervalMs })) return { ok: false, reason: 'throttled' };
  // The agent that died is the one we resume. Mismatches only count when the current agent
  // in the tree is a DIFFERENT live agent (claude/codex/minimax). A crashed pane's tree shows
  // 'bash' (the shell that survived the agent) and that is the normal crash case, not a
  // mismatch. A live 'minimax' process in a session that was running 'claude' is a mismatch.
  if (agent && la.agent && ['claude', 'codex', 'minimax'].includes(agent) && agent !== la.agent) return { ok: false, reason: 'wrong-agent' };
  const command = buildResumeCommand({ agent: la.agent, lastAgent: la, base: pickBase(base, la.agent) });
  if (!command) return { ok: false, reason: 'no-command' };
  return { ok: true, reason: 'crash', command, lastAgent: la, markerLine: cls.line };
}

// createCrashResumer: orchestrator. One tick = one pass over the sessions the caller lists.
//   inputs:
//     getState(name) -> { plain, agent, scriptBusy } | null   (null = session gone)
//     lastAgent:     Map<name, { agent, claudeSessionId, claudeName, model, args, cwd, at }>
//     lastResumeAt:  Map<name, number>  (ms epoch; updated here on a successful resume)
//     sessionMeta:   { isPaused(name), held(name) }   (the existing session-meta object)
//     base:          { claude, minimax, codex }       (the AGENT_CMDS table from launch-config)
//     tmux:          { sendText, sendEnter, sendCtrlC }
//     managerEvents: { record(event) }                (server.js's managerEvents)
//     now = Date.now
//     minIntervalMs, maxAgentAgeMs
//   effects (per resumed session):
//     - lastResumeAt.set(name, now)
//     - tmux.sendCtrlC(name) (best effort) ; tmux.sendText(name, command) ; tmux.sendEnter(name)
//     - managerEvents.record({ key: 'health:session-crash-resumed:<name>', kind: 'health', ... })
//
// Returns the list of decisions for this tick (so the caller / tests can inspect).
export function createCrashResumer({
  getState,
  lastAgent,
  lastResumeAt,
  sessionMeta,
  base,
  tmux,
  managerEvents,
  log = () => {},
  now = Date.now,
  minIntervalMs = DEFAULT_MIN_RESUME_INTERVAL_MS,
  maxAgentAgeMs = DEFAULT_MAX_AGENT_AGE_MS,
} = {}) {
  if (!getState) throw new Error('crash-resume: getState required');
  if (!lastAgent) throw new Error('crash-resume: lastAgent required');
  if (!lastResumeAt) throw new Error('crash-resume: lastResumeAt required');
  if (!sessionMeta) throw new Error('crash-resume: sessionMeta required');
  if (!base) throw new Error('crash-resume: base required');
  if (!tmux || typeof tmux.sendText !== 'function') throw new Error('crash-resume: tmux.sendText required');
  if (!managerEvents || typeof managerEvents.record !== 'function') throw new Error('crash-resume: managerEvents.record required');

  async function sendCommand(name, command) {
    // A crashed agent may leave the cursor on a half-typed prompt; Ctrl-C clears it so the
    // new command lands on a clean line. Best effort: tmux may not be responsive (race with
    // the shell), and the error is logged and swallowed.
    try { if (typeof tmux.sendCtrlC === 'function') await tmux.sendCtrlC(name); } catch (e) { log('sendCtrlC', name, e.message); }
    await tmux.sendText(name, command);
    if (typeof tmux.sendEnter === 'function') await tmux.sendEnter(name);
  }

  async function tick(names) {
    const t = now();
    const decisions = [];
    for (const name of names || []) {
      const st = await getState(name);
      if (!st) { decisions.push({ name, ok: false, reason: 'gone' }); continue; }
      const decision = decideCrashResume({
        plainLines: st.plain,
        lastAgent,
        name,
        now: t,
        lastResumeAt: lastResumeAt.get(name),
        sessionMeta,
        scriptBusy: st.scriptBusy,
        agent: st.agent,
        base,   // pass the full {claude,minimax,codex} object; decideCrashResume picks the right one
        minIntervalMs,
        maxAgentAgeMs,
      });
      decisions.push({ name, ...decision });
      if (!decision.ok) continue;
      try {
        await sendCommand(name, decision.command);
        lastResumeAt.set(name, t);
        // Push to the manager feed. classifyKey() in manager-events.js maps `head === 'health'`
        // to kind 'health' (added in this change), so the manager agent sees it as a health
        // event with the session-crash-resumed sub-key.
        await managerEvents.record({
          at: new Date(t).toISOString(),
          key: `health:session-crash-resumed:${name}`,
          kind: 'health',
          title: `auto-resumed crashed session: ${name}`,
          body: `Pane showed "${(decision.markerLine || '').slice(0, 160)}". Restarted with \`${decision.command.slice(0, 120)}\`.`,
          url: `/?s=${encodeURIComponent(name)}`,
          priority: 'default',
        });
        log('resumed', name, decision.command);
      } catch (err) {
        log('resume-failed', name, err.message);
        decisions[decisions.length - 1] = { name, ok: false, reason: 'io-error', error: err.message };
      }
    }
    return decisions;
  }

  return { tick, decide: decideCrashResume, buildResumeCommand, classifyTail, isCrashLine, isNormalExitLine, recentAgentOf, shouldThrottle };
}

export const CRASH_RESUME_DEFAULTS = {
  TAIL: DEFAULT_TAIL,
  MAX_AGENT_AGE_MS: DEFAULT_MAX_AGENT_AGE_MS,
  MIN_RESUME_INTERVAL_MS: DEFAULT_MIN_RESUME_INTERVAL_MS,
};
