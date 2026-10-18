// Small API pieces the manager agent needs (TASK-44): who did an action, and the alert endpoint.
// Kept apart from server.js (which starts listening on import) so they can be unit-tested.

import { isLoopback, TOKEN_HEADER } from './reporter.js';
import { basename } from 'node:path';

export const ACTOR_MAX = 40;
export const DEFAULT_ACTOR = 'owner';

// The optional `by` of a request body: who acted. Default 'owner' (the UI never sends it); the manager
// agent passes 'manager-agent'. Anything but a short non-empty string is a 400.
export function actorOf(body) {
  const v = body && typeof body === 'object' ? body.by : undefined;
  if (v === undefined || v === null) return DEFAULT_ACTOR;
  if (typeof v !== 'string' || !v.trim() || v.trim().length > ACTOR_MAX) throw Object.assign(new Error(`by must be a string of 1..${ACTOR_MAX} characters`), { status: 400 });
  return v.trim();
}

// ---- Pane process-tree: which agent (if any) is the pane running? ----
// Pure (no I/O). Server.js feeds processTable() into agentFromTree() via liveAgentOf();
// the policy layer below treats its `{agent, cmd}` return as "live" and its `null` as "no agent".
const AGENT_BINS = [
  [/^claude(?:-code)?$/, 'claude', 'claude'],
  [/^codex(?:-cli)?$/, 'codex', 'codex'],
  [/^minimax-code$/, 'minimax', 'minimax-code'],
  [/^mcode$/, 'minimax', 'mcode'],
];
const WRAPPERS = new Set(['node', 'nodejs', 'bun', 'python', 'python3', 'bash', 'sh', 'env']);

export function agentFromArgs(argline) {
  const toks = argline.split(/\s+/).filter(Boolean);
  const cand = [toks[0]];
  if (toks[0] && WRAPPERS.has(basename(toks[0]))) {
    for (const t of toks.slice(1, 4)) if (!t.startsWith('-')) cand.push(t);
  }
  for (const c of cand) {
    const b = basename(c || '');
    for (const [re, agent, cmd] of AGENT_BINS) if (re.test(b)) return { agent, cmd };
  }
  return null;
}

// Pure policy: should the server refuse a typed send to this pane from this actor?
// The owner (default actor) is ALWAYS allowed — Ghosty is also a terminal, shells and
// scripts included. The owner check is first and unconditional, so a dashboard send
// (no `by`) or an explicit `by: 'owner'` always returns null, even on a script-busy
// pane where the owner might want to Ctrl-C the loop. Any non-owner actor is refused
// when `live` is null (no agent TUI in the pane) or when the pane is being driven by
// a script (a script-wrapped `claude -p` / `mcode exec` turn, or a `sleep` under a
// bash script) — typing into a script-driven pane lands in the terminal input and
// gets read by bash as commands. Return value: null when allowed, otherwise a short
// reason (logged as the `reason` of the send-refused event in manager.js).
export function shouldRefuse({ by, live, scriptBusy = false }) {
  // Owner bypass — must come before every other check, including scriptBusy.
  if (by === DEFAULT_ACTOR) return null;
  // Non-owner actors need a live agent TUI in the pane.
  if (!live) return 'no claude/codex/minimax process running in the pane';
  // Non-owner actors are refused on script-driven panes.
  if (scriptBusy) return 'pane is being driven by a script (claude -p / mcode exec / sleep under bash)';
  return null;
}

// ---- Loop-wait detection (display only) ----
// The Claude Code Stop hook reports background tasks / scheduled crons (status.reporter).
// MiniMax (mcode) and Codex do not run a hook, but their pane footer rotates a
// background-work marker while the turn is over. Treat the last ~6 non-blank lines of
// the pane as a footer: a `N background active` count, a `… Running Nm` / spinner, or a
// `Tasks · 1 background active` line counts. Pure, no I/O.

// "\bN background active\b" tolerates "Tasks · 1 background active" (the MiniMax footer)
// and Codex's "1 background task" variants, and the inline `… · 2 background active · …` form.
const PANE_BG_COUNT_RE = /\b\d+\s+background\s+(?:active|tasks?)\b/i;
// "Running 14min50s", "Running 3s", Codex's "… Running 5m" inline.
const PANE_RUNNING_RE = /\bRunning\s+\d+(?:[hms])/i;
// Inline spinner glyphs (Codex uses ⠇ ⠋ ⠙ …).
const PANE_SPINNER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S/;

export function paneBackgroundOf(plain) {
  if (!Array.isArray(plain) || plain.length === 0) return false;
  // Strip ANSI, look at the last ~6 non-blank lines. NOISE has already been removed by
  // plainLines() upstream, so spinners and the footer are still here.
  const tail = plain.filter((l) => String(l || '').trim()).slice(-6);
  for (const l of tail) {
    if (PANE_BG_COUNT_RE.test(l)) return true;
    if (PANE_RUNNING_RE.test(l)) return true;
    if (PANE_SPINNER_RE.test(l)) return true;
  }
  return false;
}

// --- Script-loop detection (process tree) ---
// A tmux pane whose foreground process tree runs a non-interactive agent turn
// (`claude -p ...`, `claude --print ...`, or `mcode` with a one-shot flag) or a `sleep`
// under a bash script is still doing work, even when the screen shows no agent prompt.
// The agent pane itself is fine; this catches the wrappers that scripts hang in.
// table = { children: Map<ppid, pid[]>, args: Map<pid, string> } (server.js processTable()).
// depth <= 8 mirrors agentFromTree/claudePidsUnder.
const BASH_BIN = /^(?:\/usr)?(?:\/bin)?\/(?:bash|sh)\b|^(?:bash|sh)\b/;
const CLAUDE_PRINT = /(?:^|\/)claude(?:-code)?\s+(?:-p\b|--print\b)/;
const MCODE_PRINT = /(?:^|\/)mcode\s+(?:-p\b|--print\b|exec\b)/;
const SLEEP_RE = /^(?:\/usr)?(?:\/bin)?\/sleep\s+\d|^sleep\s+\d/;

export function scriptBusyOf(panePid, table) {
  if (!panePid || !table || !table.children || !table.args) return false;
  const seen = new Set();
  // Breadth-first walk: track whether the current process has a bash/sh script ancestor,
  // so a `sleep N` deep in the tree only counts when a script is driving it.
  let level = [{ pid: panePid, underBash: false }];
  for (let d = 0; d < 8 && level.length; d++) {
    const next = [];
    for (const { pid, underBash } of level) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const a = String(table.args.get(pid) || '');
      if (a) {
        // a non-interactive `claude -p` / `claude --print` turn (printed output, not REPL)
        if (CLAUDE_PRINT.test(a)) return true;
        // a MiniMax one-shot: `mcode -p`, `mcode exec ...`, or `mcode --print`
        if (MCODE_PRINT.test(a)) return true;
        // a `sleep N` under a bash script ancestor (a script's `do_wait` step)
        if (SLEEP_RE.test(a) && underBash) return true;
      }
      const kids = table.children.get(pid) || [];
      const childUnderBash = underBash || BASH_BIN.test(a);
      for (const c of kids) next.push({ pid: c, underBash: childUnderBash });
    }
    level = next;
  }
  return false;
}

// Returns true if the process tree rooted at panePid contains an interactive agent TUI
// (a claude / codex / mcode process whose args are NOT -p/--print/exec). Used to keep
// scriptBusy from flagging an interactive REPL that happens to have a background
// mcode exec worker or sleep in the same tree. The combined "script-driven" check
// in server.js is `scriptBusyOf(...) && !interactiveAgentOf(...)`, so an interactive
// session that launched its own helpers stays messageable; a script-driven pane
// with no interactive TUI stays guarded.
export function interactiveAgentOf(panePid, table) {
  if (!panePid || !table || !table.children || !table.args) return false;
  const seen = new Set();
  let level = [panePid];
  for (let d = 0; d < 8 && level.length; d++) {
    const next = [];
    for (const pid of level) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const a = String(table.args.get(pid) || '');
      if (a) {
        // agentFromArgs returns { agent, cmd } for a claude/codex/mcode (possibly wrapped).
        // An agent process is interactive unless its args include -p/--print/exec — the same
        // print/exec patterns scriptBusyOf uses, so the two helpers agree on what counts as
        // "non-interactive" (scriptBusyOf would flag the same line as busy).
        const agent = agentFromArgs(a);
        if (agent && !CLAUDE_PRINT.test(a) && !MCODE_PRINT.test(a)) return true;
      }
      const kids = table.children.get(pid) || [];
      for (const c of kids) next.push(c);
    }
    level = next;
  }
  return false;
}

export const ALERT_PRIORITIES = ['min', 'low', 'default', 'high', 'urgent'];
export const ALERT_MAX_PER_HOUR = 10;

// POST /api/alert {title, body, url?, priority?, tag?}: the manager agent's own channel to the owner.
// Loopback peers + the reporter token only; goes through the normal alert() (debounce, feed, Web Push, ntfy);
// at most ALERT_MAX_PER_HOUR calls per hour. handle() is async and returns { status, body }; readBody() is only called after the peer and token check.
export function createAlertApi({ alert, tokenOk, now = Date.now, maxPerHour = ALERT_MAX_PER_HOUR } = {}) {
  const calls = [];
  const bad = (status, error) => ({ status, body: { ok: false, error } });
  return {
    async handle({ remoteAddress, headers = {}, readBody }) {
      if (!isLoopback(remoteAddress)) return bad(403, 'loopback only');
      if (!tokenOk(headers[TOKEN_HEADER])) return bad(401, 'bad token');
      const body = await readBody();
      const b = body && typeof body === 'object' ? body : {};
      if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 120) return bad(400, 'title must be a string of 1..120 characters');
      if (typeof b.body !== 'string' || !b.body.trim() || b.body.length > 1000) return bad(400, 'body must be a string of 1..1000 characters');
      if (b.url != null && (typeof b.url !== 'string' || b.url.length > 300 || !/^(\/|https?:\/\/)/.test(b.url))) return bad(400, 'url must start with / or http(s)://');
      if (b.priority != null && !ALERT_PRIORITIES.includes(b.priority)) return bad(400, `priority must be one of: ${ALERT_PRIORITIES.join(', ')}`);
      if (b.tag != null && (typeof b.tag !== 'string' || b.tag.length > 60)) return bad(400, 'tag must be a string of at most 60 characters');
      const t = now();
      while (calls.length && t - calls[0] >= 3600e3) calls.shift();
      if (calls.length >= maxPerHour) return bad(429, `at most ${maxPerHour} alerts per hour`);
      calls.push(t);
      const tag = b.tag || 'manager-agent';
      const sent = alert(`manager-agent:${b.tag || b.title}`, {
        title: b.title.trim(), body: b.body, url: b.url || '/', tag, priority: b.priority || 'default', ntfyTags: 'robot',
      });
      return { status: 200, body: { ok: true, sent, ...(sent ? {} : { debounced: true }) } };
    },
  };
}
