// Ghosty Sessions — server
// Streams tmux panes for every Claude/Codex session on codebox over WebSocket.
// Bound to :7777 on Tailscale only. No public DNS, no auth prompt.
//
// Routes
//   GET  /api/sessions          → list tmux sessions + status pill
//   GET  /ws/:session           → WebSocket: streams pane content (1 Hz tick)
//   POST /api/send/:session     → body {keys: "..."} → tmux send-keys + Enter
//   GET  /api/snapshot/:session → last full pane snapshot (for first paint)
//                                 each stopped agent also has `lastTurn` {at, elapsedMs, tokens{in,out,cacheRead,cacheWrite,total}, status, info, line, source} (turn-meter.js; null parts = unknown)
//   GET  /api/sessions?full=1   → same, plus `reply` text per session
//   GET  /api/reply/:session    → {reply, replyHash}: agent's last reply block, plain text
//   POST /api/resize/:session   → {cols, rows} resize a detached session's window
//   POST /api/sessions          → {name, agent, cwd, priority?} create a tmux session + start the agent
//   DELETE /api/sessions/:name?confirm=<name> → kill session
//   POST /api/sessions/:name/park   → record the Claude conversation, /exit, kill the tmux session (refuses when not idle / lease held / job running)
//   POST /api/sessions/:name/resume → recreate the tmux session in the same folder and run `claude --resume <id>`
//   GET  /api/parking               → { cap, live, over, candidates[], parked[], manual[], ramSavedMb } (manual notes read from <STATE_DIR>/parked.json, never counted in ramSavedMb or in parked)
//   GET  /api/manager           → AI manager config (auto-answer settings, disabled sessions, Jev budget, today counts)
//   POST /api/manager           → {enabled?, autoSend?, autoCases?, minConfidence?, delayMs?, maxPerSessionPerHour?}
//                                 global settings, {session, sessionEnabled} per session
//   POST /api/manager/cancel/:s → cancel the pending auto answer of a session
//   POST /api/manager/label     → {id, label: no_reason|legit|wrong_case, note?, correctCase?} owner label on a stall
//   POST /api/manager/triage    → {id, action: sent|edited|dismissed} what the owner did with the AI reviewer's proposal (dismissed hides it)
//   POST /api/manager/choice    → {id, session, kind:<yesno|menu|either|open>, owner:<button|reply>, ownerText?, ai:<button|null>, aiConfidence?, jev?:<choice>, jevProbabilities?}
//                                 the owner answered a stop from the popup (one-tap; records owner vs AI vs Jev agreement in stalls.jsonl for the scorecard)
//   POST /api/manager/unlabel   → {id} withdraw the newest label of a stall (swipe page undo)
//   GET  /api/credits           → OpenRouter credit from the VPT server's /server/ai/credits (cached 10 min; ok:false when the server is older)
//   GET  /api/jev-ai            → the "Jev & AI" usage tab: manager Jev + AI reviewer per day (local logs), the product's Jev uses (server summary, when it has it)
//   GET  /api/decisions?usage=&ok=&has_outcome=&min_conf=&limit=&offset= → Jev decisions, newest first (the server's log, else the manager's own; /?decisions=1)
//   GET  /api/manager/review?limit → unlabelled stops, newest first, + counts (the swipe page, /?review=1)
//   GET  /api/manager/log?limit → last stall / outcome records (stalls.jsonl)
//   GET  /api/manager/wakes?day=YYYY-MM-DD → {summary, wakes} per wake of the manager agent, from its Claude transcript (manager-wakes.js, cached 60 s)
//   GET  /api/leases/watch      → lease-watch snapshot: mode, holders {status live|ended|remote|unknown|system, plan}, unknown count
//   GET  /api/handoffs?state=&session= → {handoffs:[...]} the open/overdue rows for a session or all rows filtered by state
//   POST /api/handoffs          → {resource, from, to, due?} create a new hand-off row
//   POST /api/handoffs/<id>/done → mark a hand-off done (body {by?})
//   GET  /api/manager/actions?since=<ISO>&limit=100 → { actions, regrets } tail of manager-actions.jsonl (newest last) + the `at|session` keys the owner marked wrong
//   POST /api/manager/regret → {at, session, decision?, undo?} one-tap "wrong" on a manager action; appends to manager-regret.jsonl (regret.js)
//   GET  /api/manager/scorecard?days=7 → { today, days:[...] } performance + cost + Jev integration for the window
//                                       (cached 60 s; manager sessions, subagents, workers, Jev, reviewer, judge; see scorecard.js)
//   POST /api/session-meta/:s   → {priority:'P0'|'P1'|'P2'} and/or {paused:bool} (pause = Esc once + hold; resume = "continue")
//   GET  /api/manager/events?since=<ISO>&limit=50 → tail of manager-events.jsonl (newest last): the events the AI manager should react to (skips the manager's own stops, /api/alert, 'done'). The manager agent follows the file directly with `tail -n0 -F` so it wakes only when something happens
//   GET  /api/vpt-locks         → VPT take-control locks per device (read-only, vpt-locks.js), cached 15 s; {ok:false, error} = "VPT lock: unknown"
//   GET  /api/deploys           → deploy queue + recent (registry on proxmox), {enabled, running, lastRef, deployed (ledger: per env/target version, ref, commit, at, agent, lastAttempt)}; pushed on /ws/status as {type:'deploys'}
//   POST /api/deploys/:id/approve | /cancel → owner action on a queued request
//   GET  /api/deploys/:id/log?tail=200      → the runner's log of that deploy (text)
//   (the runner itself only starts deploys when manager.json has deployRunner:true, see deploy-runner.js)
//   POST /api/alert             → {title, body, url?, priority?, tag?} the manager agent's alert; loopback + reporter token, max 10/h
//   POST /api/reporter/event    → ghosty-reporter plugin events; loopback peers + x-ghosty-reporter-token (state dir reporter.token) only
//   GET  /api/reporter/:session → latest reported turn / prompt / waiting / agents of a session
//   GET  /api/quota             → plan windows (codex / claude / minimax); also pushed on /ws/status
//   GET  /api/usage             → usage-summary.json (API-equivalent cost / tokens) + `sessions` {name:{todayCost, days[14]}} for live sessions; 404 when absent
//   GET  /api/vm                → codebox health: cpu %, load vs cores, RAM, disks (also pushed on /ws/status)
//   GET  /api/dirs              → candidate working dirs (repos / worktrees / pane cwds)
//   GET|PUT /api/layout         → the session list's order / pins / groups ({order,pins,groups,groupNames,collapsed}); PUT merges the keys it carries
//   POST /api/send-many         → {sessions:[...], keys|key} fan-out send
//   GET  /*                     → static files in ./public

import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, stat, readdir, realpath } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { createLeaseStore, sshRun as leaseRun } from './leases.js';
import { createLeaseWatch } from './lease-watch.js';
import { machinesOf, holdingsOf, deployWaitOf } from './public/platforms.js';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sampleHealth } from './health.js';
import { createPush, createAlerts, tierConfig } from './push.js';
import { trustFolder } from './trust.js';
import { createLayoutStore } from './layout.js';
import { createSessionMeta } from './session-meta.js';
import { createQuota } from './quota.js';
import { createCredits } from './credits.js';
import { createUsage, usageFile } from './usage-view.js';
import { createTurnMeter, statusMeterLine } from './turn-meter.js';
import { evaluatePolicy } from './public/policy.js';
import { isPriority } from './public/prio.js';
import { initManager, logEvent, observe, forget as managerForget, prune as pruneManager, stallOf, autoOf, cancelAuto, todayCounts, managerConfig, setManagerConfig, labelStall, unlabelStall, logOwnerChoice, reviewDeck, triageOf, triageAction, aiSummary, jevAiTab, decisionsView, policyConfig, releaseHold, heldOf, reevaluateHolds, deployRunnerOn, wakeAnnotate, wakeOutcomeTick, LOG_FILE, jevBreaker } from './manager.js';
import { cachedScorecard } from './scorecard.js';
import { createDeployRunner } from './deploy-runner.js';
import { quotaLine, leasesLine, deploysLine } from './triage.js';
import { createReporter, isLoopback, TOKEN_HEADER } from './reporter.js';
import { createClaudeIndex, claudeOfPane, busyChildren, lastActivityOf, leasesOfSession, capView, createParking, readManualNotes, SESSION_CAP } from './parking.js';
import { actorOf, agentFromArgs, createAlertApi, DEFAULT_ACTOR, shouldRefuse } from './api-extras.js';
import { createManagerEvents, classifyKey, readActions } from './manager-events.js';
import { createHandoffs } from './handoffs.js';
import { createVptLockStore } from './vpt-locks.js';
import { appendRegret, readRegrets, effectiveRegrets, regretKey } from './regret.js';
import { createWakesView, startWakesLogger } from './manager-wakes.js';
import { wakeFacts, quotaPercents } from './wake-shadow.js';

const exec = promisify(execFile);
const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '0.0.0.0';
const TICK_MS = Number(process.env.TICK_MS || 1000);
const PANE_LINES = Number(process.env.PANE_LINES || 1000);            // depth for a session someone has open
const PANE_LINES_BG = Number(process.env.PANE_LINES_BG || 300);         // depth for the rest (state only needs the tail)
const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));

// HTTPS support. If both TLS_KEY and TLS_CERT exist, we listen on TLS too.
// Self-signed is fine on a Tailscale tailnet — the phone accepts the cert once.
const TLS_KEY  = process.env.TLS_KEY  || join(PUBLIC_DIR, '..', 'certs', 'key.pem');
const TLS_CERT = process.env.TLS_CERT || join(PUBLIC_DIR, '..', 'certs', 'cert.pem');
const TLS_PORT = Number(process.env.TLS_PORT || (Number(PORT) === 443 ? 443 : 7443));

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------

const TMUX = process.env.TMUX_BIN || 'tmux';
const CONCURRENCY = 6;
const WORKING_HOLD_MS = 4000;

async function listSessions() {
  const fmt = '#{session_name}|#{session_attached}|#{session_activity}|#{session_windows}';
  let raw = '';
  try {
    ({ stdout: raw } = await exec(TMUX, ['list-sessions', '-F', fmt]));
  } catch (err) {
    if (!/no server running/.test(err.stderr || '')) {
      console.error('[listSessions] failed:', err.code || err.message, 'stderr=', err.stderr || '');
    }
    return [];
  }
  const now = Math.floor(Date.now() / 1000);
  const sessions = raw.trim().split('\n').filter(Boolean).map((line) => {
    const [name, attached, activity, windows] = line.split('|');
    return {
      name,
      attached: Number(attached) > 0,
      windows: Number(windows) || 1,
      lastActivitySec: Math.max(0, now - Number(activity)),
    };
  });
  sessions.sort((a, b) => a.lastActivitySec - b.lastActivitySec);
  return sessions;
}

// session -> { pid, cmd, cols, rows, dead }  (active pane of the active window)
async function listPanes() {
  const fmt = '#{session_name}|#{pane_pid}|#{pane_current_command}|#{pane_width}|#{pane_height}|#{pane_dead}|#{window_active}|#{pane_active}|#{pane_current_path}';
  const out = new Map();
  try {
    const { stdout } = await exec(TMUX, ['list-panes', '-a', '-F', fmt]);
    for (const line of stdout.split('\n').filter(Boolean)) {
      const [name, pid, cmd, cols, rows, dead, wa, pa, ...cwdParts] = line.split('|');
      const active = wa === '1' && pa === '1';
      if (out.has(name) && !active) continue;
      out.set(name, { pid: Number(pid), cmd, cols: Number(cols), rows: Number(rows), dead: dead === '1', cwd: cwdParts.join('|') });
    }
  } catch {}
  return out;
}

// One `ps` per tick -> { children: Map<ppid, pid[]>, args: Map<pid, string> }
async function processTable() {
  const children = new Map();
  const args = new Map();
  const rss = new Map();   // pid -> resident KB
  try {
    const { stdout } = await exec('ps', ['-eo', 'pid=,ppid=,rss=,args='], { maxBuffer: 16 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]), ppid = Number(m[2]);
      args.set(pid, m[4]);
      rss.set(pid, Number(m[3]));
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
  } catch {}
  return { children, args, rss };
}

// Breadth-first walk under pane pid; shallowest agent process wins. agentFromArgs lives in api-extras.js.
function agentFromTree(pid, table) {
  const seen = new Set();
  let level = [pid];
  for (let depth = 0; level.length && depth < 8; depth++) {
    const next = [];
    for (const p of level) {
      if (seen.has(p)) continue;
      seen.add(p);
      const a = table.args.get(p);
      if (a) {
        const hit = agentFromArgs(a);
        if (hit) return hit;
      }
      next.push(...(table.children.get(p) || []));
    }
    level = next;
  }
  return null;
}

function agentFromText(text) {
  if (/Ask Mcode|✦ M3|MiniMax/.test(text)) return { agent: 'minimax', cmd: 'minimax-code' };
  if (/✻|⏺|Claude Code|bypass permissions on/.test(text)) return { agent: 'claude', cmd: 'claude' };
  if (/\bcodex\b/i.test(text) && /(?:gpt-|\? for shortcuts|To get started)/i.test(text)) return { agent: 'codex', cmd: 'codex' };
  return null;
}

// Process-tree only: what agent (if any) the pane is actually running right now. Never
// matches on screen text, so a `sleep` shell with old MiniMax JSON in its scrollback does
// not get labelled "minimax" — only a live claude / codex / minimax-code (under any of the
// usual wrappers) counts.
async function liveAgentOf(session) {
  const panes = await listPanes();
  const pane = panes.get(session);
  if (!pane || !pane.pid) return null;
  const table = await processTable();
  return agentFromTree(pane.pid, table);
}

// Gate a typed send. The owner (default actor) is always allowed — Ghosty is also a
// terminal, shells included. Any other actor needs a live agent process in the pane;
// otherwise we 409 and log a `send-refused` event so the refusal is auditable.
async function assertAgentPane(session, by) {
  if (by === DEFAULT_ACTOR) return;
  const live = await liveAgentOf(session);
  const reason = shouldRefuse({ by, live });
  if (reason) {
    logEvent({ type: 'send-refused', session, by, reason });
    throw httpError(409, `not an agent pane: ${session} runs no claude/codex/minimax process`);
  }
}

const tgt = (s) => `=${s}:`;
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash']);

async function capturePane(session, lines = PANE_LINES) {
  // Visible pane + scrollback. No -J: keep tmux's own line breaks so
  // the client can size xterm to the pane's cols. -e keeps colour escapes.
  const { stdout } = await exec(TMUX, [
    'capture-pane', '-t', tgt(session), '-p', '-e', '-S', `-${lines}`,
  ], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const lastSendAt = new Map();    // session -> ms epoch
const lastSendText = new Map();  // session -> what was sent (for the manager's outcome log)

const NAMED_KEYS = new Set(['Escape', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab', 'C-c', 'C-d', 'Space', 'BSpace']);
const LITERAL_KEYS = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'y', 'n']);

async function sendKey(session, key) {
  if (NAMED_KEYS.has(key)) {
    await exec(TMUX, ['send-keys', '-t', tgt(session), key]);
  } else if (LITERAL_KEYS.has(key)) {
    await exec(TMUX, ['send-keys', '-t', tgt(session), '-l', '--', key]);
  } else {
    const e = new Error('key not allowed'); e.status = 400; throw e;
  }
  lastSendAt.set(session, Date.now());
  lastSendText.set(session, key);
  return { ok: true, key };
}

async function sendKeys(session, keys, enter = true) {
  // Multi-line text goes in as ONE bracketed paste, then a separate Enter after a pause: per-line Enter would submit
  // line 1 alone, and an Enter sent right after a fast burst is swallowed by Claude Code's paste detection.
  const text = String(keys || '');
  const lines = text.split('\n');
  if (lines.length > 200) throw httpError(400, 'too many lines (max 200)');
  if (lines.length > 1) {
    const buf = `ghosty-send-${process.pid}-${Date.now()}`;
    await exec(TMUX, ['set-buffer', '-b', buf, '--', text]);
    await exec(TMUX, ['paste-buffer', '-p', '-d', '-b', buf, '-t', tgt(session)]);
  } else if (text.length) {
    await exec(TMUX, ['send-keys', '-t', tgt(session), '-l', '--', text]);
  }
  if (enter) {
    await new Promise((r) => setTimeout(r, text.length > 200 || lines.length > 1 ? 400 : 80));
    await exec(TMUX, ['send-keys', '-t', tgt(session), 'Enter']);
  }
  lastSendAt.set(session, Date.now());
  lastSendText.set(session, String(keys || ''));
  return { ok: true, sent: lines.length };
}

// ---------------------------------------------------------------------------
// State classification
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

// Explicit permission / question prompts only; tested against the LAST lines.
const WAIT_RE = /Do you want to |Would you like to (?:proceed|allow|run)|^\W*(?:1\.\s*)?Yes,? (?:allow|and|proceed)|^\s*[❯>›]\s*1\.\s*Yes\b|\(y\/n\)|\[y\/n\]|\(y\/N\)|\[Y\/n\]|Allow (?:command|this|once|always)|Allow\?|Approve\?|Esc to cancel|Enter to confirm|Press Enter to (?:continue|confirm|approve)|Run this command\?|Apply (?:this )?(?:patch|changes)\?|Proceed\?/i;
// Spinner / progress markers (NOT "Thinking On", which is MiniMax's status bar).
const WORK_RE = /esc to interrupt|ctrl\+c to interrupt|Working \(|Thinking[….]|…\s*\(\d+(?:m \d+)?s\b|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S/;

function tailLines(text, n) {
  const lines = stripAnsi(text).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  return lines.slice(-n);
}

const TRIM_RE = /^[\s│┃|╭╰─╮╯>❯›]+|[\s│┃|╮╯]+$/g;
function findWaitReason(lines) {
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (WAIT_RE.test(lines[i])) { idx = i; break; }
  }
  if (idx < 0) return null;
  for (let i = idx; i >= Math.max(0, idx - 6); i--) {
    const l = lines[i].replace(TRIM_RE, '');
    if (/\?$/.test(l) && !/^\d+\./.test(l)) return l.slice(0, 120);
  }
  return lines[idx].replace(TRIM_RE, '').slice(0, 120);
}

// ---------------------------------------------------------------------------
// Pane parsing: turn markers, activity, last message, reply block, footer info
// ---------------------------------------------------------------------------

const DONE_IDLE_MS = Number(process.env.DONE_IDLE_HOURS || 6) * 3600 * 1000;
const RULE_LINE = /^\s*[─━]{4,}/;
const CHROME_LINE = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║>❯›$#%·•\-_=]*$/;
// Chrome that is never "the agent's message": footers, timings, tips, spinners.
const NOISE_LINE = /^\s*(?:[✻✶✳✢✽]\s+\S+ for \d|[✻✶✳✢✽]\s+\S+…|[*·]\s+\S+…\s*\(\d|└ Completed in|─ Worked for|⎿\s*$)|Message · Enter send|^\s*(?:⎿\s*)?Tip:|for shortcuts|bypass permissions|Context \d+% left|\d+% context left|esc to interrupt|Update installed|\/clear to save|^\s*\/rc\s*$|ctrl\+x ctrl\+s|Press up to edit queued|^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s|Ask Mcode|interrupting Claude|\(ctrl\+o to expand\)|^\s*… \+\d+ lines|\(ctrl\+b ctrl\+b|install gh for PR status|← for agents/i;
// A finished turn: Claude "✻ Baked for 8m 10s [· done 8:12 AM]", MiniMax "└ Completed in 8min21s",
// Codex "─ Worked for 1m 23s ───".
const TURN_DONE_RE = /^\s*[✻✶✳✢✽]\s+\S+ for \d+\s*[smh]|^\s*└ Completed in \d|^\s*─+ Worked for \d/;
const SPINNER_RE = /^\s*(?:[✻✶✳✢✽]\s+\S[^\n]*…[^\n]*|[*·]\s+\S+…\s*\(\d[^\n]*|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S[^\n]*|[•◦]\s*Working\b[^\n]*|[•◦]\s*Thinking\b[^\n]*)$/;
const TOOL_LINE_RE = /^\s*[⏺●•]\s+[A-Za-z_][\w.:-]*\(/;
const BULLET_RE = /^(\s*)[⏺●•]\s+/;

// ANSI-stripped, right-trimmed lines with the blank rows below the cursor dropped.
function plainLines(pane) {
  const lines = stripAnsi(pane).split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

const oneLine = (s, n) => s.replace(/[│┃]/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, n);

// lines = ANSI-stripped pane lines. Returns the index where the input box starts
// (the second rule from the bottom, within the last 14 lines), else lines.length.
function bodyEnd(lines) {
  for (let i = lines.length - 1, seen = 0; i >= 0 && i >= lines.length - 14; i--) {
    if (RULE_LINE.test(lines[i]) && ++seen === 2) return i;
  }
  return lines.length;
}

function lastMessageOf(lines, end) {
  for (let i = end - 1; i >= Math.max(0, end - 200); i--) {
    const l = lines[i].replace(/[│┃]/g, ' ').trim();
    if (l && !CHROME_LINE.test(l) && !NOISE_LINE.test(l)) {
      return l.replace(/^[⏺●•]\s*/, '').replace(/\s{2,}/g, ' ').slice(0, 200);
    }
  }
  return null;
}

// Current step while working: the live spinner line, else the latest tool call.
function activityOf(lines, end) {
  const lo = Math.max(0, lines.length - 40);
  for (let i = lines.length - 1; i >= lo; i--) {
    const l = lines[i];
    if (!l.trim() || RULE_LINE.test(l)) continue;
    if (SPINNER_RE.test(l) && !/bypass permissions|accept edits/.test(l)) return oneLine(l, 120);
  }
  for (let i = end - 1; i >= Math.max(0, end - 60); i--) {
    if (TOOL_LINE_RE.test(lines[i])) {
      // Tool calls can wrap over several lines; join continuation lines (indented, no bullet/result mark).
      let t = lines[i];
      for (let j = i + 1; j < end && j < i + 3 && /^\s{2,}\S/.test(lines[j]) && !/^\s*[⎿├└⏺●•]/.test(lines[j]); j++) t += ' ' + lines[j];
      return oneLine(t.replace(/^\s*[⏺●•]\s*/, ''), 120);
    }
    if (/^\s*[├└]\s*•\s/.test(lines[i])) return oneLine(lines[i].replace(/^\s*[├└]\s*•\s*/, ''), 120);
  }
  return null;
}

// Does the visible body end in a completed-turn marker (ignoring trailing noise)?
function hasTurnMarker(lines, end) {
  let seen = 0;
  for (let i = end - 1; i >= 0 && seen < 8; i--) {
    const l = lines[i];
    if (!l.trim() || CHROME_LINE.test(l.replace(/[│┃]/g, ' '))) continue;
    seen++;
    if (TURN_DONE_RE.test(l)) return true;
  }
  return false;
}

// Claude prints "✻ Baked for 8m 10s · done 8:12 AM" (server-local clock). Returns the most recent
// past occurrence of that time as ms epoch, or null. Ambiguous modulo 24h, which only matters for
// markers older than a day (already "idle" by then in practice).
function doneClockMs(lines, end, now) {
  for (let i = end - 1, seen = 0; i >= 0 && seen < 8; i--) {
    if (!lines[i].trim()) continue;
    seen++;
    const m = lines[i].match(/^\s*[✻✶✳✢✽]\s+\S+ for [^\n]*?done (\d{1,2}):(\d{2})\s*([AP]M)?/i);
    if (!m) continue;
    let h = Number(m[1]);
    if (m[3]) h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0);
    const d = new Date(now);
    d.setHours(h, Number(m[2]), 0, 0);
    let ms = d.getTime();
    if (ms > now + 60000) ms -= 86400000;
    return ms;
  }
  return null;
}

// The agent's last reply block as plain text for a mobile reader.
function replyOf(lines, end) {
  // a long "Tip: …" wraps onto indented continuation lines that are not noise by themselves: blank them (keeps indexes)
  lines = lines.slice();
  for (let i = 0; i < end; i++) {
    if (!/^\s*(?:⎿\s*)?Tip:/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(end, i + 3) && /^\s{3,}\S/.test(lines[j]) && !BULLET_RE.test(lines[j]); j++) lines[j] = '';
  }
  let hi = end - 1;
  while (hi >= 0) {
    const l = lines[hi];
    const bare = l.replace(/[│┃]/g, ' ');
    if (!bare.trim() || CHROME_LINE.test(bare) || NOISE_LINE.test(l)) hi--; else break;
  }
  if (hi < 0) return null;
  let lo = hi, first = true;
  for (let i = hi; i >= Math.max(0, hi - 400); i--) {
    const l = lines[i];
    if (/^\s*(?:[❯›>]\s|⎿|[├└]\s)/.test(l) || RULE_LINE.test(l)) { if (first) { return null; } break; }
    if (TOOL_LINE_RE.test(l) && !first) break;
    if (TOOL_LINE_RE.test(l) && first) return null;
    first = false;
    lo = i;
    if (BULLET_RE.test(l)) break;
  }
  const block = lines.slice(lo, hi + 1)
    .filter((l) => !NOISE_LINE.test(l))
    .map((l) => l.replace(/\s+$/, '').replace(/^(\s*)[⏺●•]\s+/, '$1  '));
  // Drop table-drawing side borders but keep the content; keep code indentation via common-indent removal.
  const indents = block.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  let text = block.map((l) => l.slice(cut)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return null;
  if (text.length > 6000) {
    text = text.slice(-6000);
    text = '…' + text.slice(text.indexOf('\n') + 1 || 0);
  }
  return text;
}

// Markdown for a task session: taskNN[-x] -> docs/tasks/TASK-NN*.md in the repo of its cwd (or ~/virtualpytest), or a task.md in cwd.
async function taskDocFiles(session) {
  const out = [], seen = new Set();
  const add = (dir, name) => { const path = join(dir, name); if (!seen.has(name)) { seen.add(name); out.push({ name, path }); } };
  let cwd = '';
  try { cwd = (await exec(TMUX, ['display-message', '-p', '-t', tgt(session), '#{pane_current_path}'])).stdout.trim(); } catch { return out; }
  const m = /^task0*(\d+)/i.exec(session);
  const dirs = [cwd, join(cwd, 'docs', 'tasks'), join(HOME, 'virtualpytest', 'docs', 'tasks')];
  try { const top = (await exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])).stdout.trim(); if (top) dirs.splice(1, 0, join(top, 'docs', 'tasks')); } catch { /* not a repo */ }
  for (const d of dirs) {
    let names = [];
    try { names = await readdir(d); } catch { continue; }
    for (const n of names.sort()) {
      if (!/\.md$/i.test(n)) continue;
      if (/^task\.md$/i.test(n) && d === cwd) add(d, n);
      else if (m && new RegExp(`^TASK-0*${m[1]}(?!\\d)`, 'i').test(n)) add(d, n);
    }
  }
  return out;
}

// The whole captured conversation as readable text: prompts, replies, and tool names only.
function transcriptOf(lines, end) {
  const out = [];
  let inTool = false;
  for (let i = 0; i < end; i++) {
    const l = lines[i];
    if (!l.trim()) { if (!inTool) out.push(''); continue; }
    if (RULE_LINE.test(l) || CHROME_LINE.test(l.replace(/[│┃]/g, ' ')) || NOISE_LINE.test(l)) continue;
    if (/^\s*[❯›>]\s/.test(l)) { inTool = false; out.push('', '**You:** ' + l.replace(/^\s*[❯›>]\s+/, '').trim()); continue; }
    if (TOOL_LINE_RE.test(l)) { inTool = true; out.push('', '`' + l.replace(BULLET_RE, '').trim().slice(0, 100).replace(/`/g, "'") + '`'); continue; }
    if (BULLET_RE.test(l)) { inTool = false; out.push('', l.replace(BULLET_RE, '$1')); continue; }
    if (inTool) continue;
    out.push(l.replace(/\s+$/, ''));
  }
  let text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > 60000) { text = text.slice(-60000); text = '…' + text.slice(text.indexOf('\n') + 1 || 0); }
  return text;
}

// Footer facts: context left %, model name.
function footerInfo(lines) {
  const foot = lines.slice(-12).join('\n');
  let contextLeft = null, model = null;
  let m = foot.match(/Context (\d+)% left/i) || foot.match(/(\d+)%\s+context left/i) || foot.match(/Context left until auto-compact:\s*(\d+)%/i) || foot.match(/auto-compact[^\n]*?(\d+)%/i);
  if (m) contextLeft = Number(m[1]);
  m = foot.match(/✦\s*([A-Za-z][\w.-]*)/) || foot.match(/\b(gpt-[\w.-]+)/i) || foot.match(/\b((?:opus|sonnet|haiku|fable)(?:[ -]\d+(?:[.-]\d+)?)?)/i);
  if (m) model = m[1].replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-/g, ' ');
  return { contextLeft, model };
}

const shortHash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 8);

// ---------------------------------------------------------------------------
// Context metadata (cwd / repo / branch / dirty), cached per session
// ---------------------------------------------------------------------------

const META_TTL_MS = 10000;
const metaCache = new Map(); // session -> { at, cwd, repo, branch, dirty, busy }

async function gitInfo(cwd) {
  try {
    const run = (args) => exec('git', ['-C', cwd, ...args], { timeout: 4000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).then((r) => r.stdout.trim());
    const [top, gitDir, commonDir, branch] = (await run(['rev-parse', '--path-format=absolute',
      '--show-toplevel', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD'])).split('\n');
    let dirty = false;
    try { dirty = (await run(['status', '--porcelain', '-uno'])).length > 0; } catch {}
    // project = GitHub repo name from origin (owner/name), else the main checkout's folder
    let project = null, github = false;
    try {
      const url = await run(['remote', 'get-url', 'origin']);
      const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
      if (m) { project = m[2]; github = true; }
      else project = basename(url.replace(/\.git\/?$/, ''));
    } catch {}
    // linked worktree: its git dir lives under the main repo's .git/worktrees/
    const worktree = gitDir && commonDir && gitDir !== commonDir ? basename(top) : null;
    if (!project) project = basename(worktree ? dirname(commonDir) : top);
    return { repo: basename(top), project, github, worktree, branch: branch === 'HEAD' ? null : branch, dirty };
  } catch {
    return { repo: null, project: null, github: false, worktree: null, branch: null, dirty: null };
  }
}

async function getMeta(session, cwd) {
  let m = metaCache.get(session);
  const stale = !m || m.cwd !== cwd || Date.now() - m.at > META_TTL_MS;
  if (stale && !(m && m.busy)) {
    const fresh = m && m.cwd === cwd ? m : { cwd, repo: null, branch: null, dirty: null, at: 0 };
    fresh.busy = true;
    metaCache.set(session, fresh);
    const job = (cwd ? gitInfo(cwd) : Promise.resolve({ repo: null, branch: null, dirty: null }))
      .then((g) => { Object.assign(fresh, g, { cwd, at: Date.now(), busy: false }); });
    if (!m || m.cwd !== cwd || !m.at) await job;   // first sight: wait once so the first payload is complete
    m = fresh;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Lease link
// ---------------------------------------------------------------------------

const MACHINES = machinesOf(hostname());
const leaseStore = createLeaseStore();
// VPT take-control locks (read-only) for the Platforms page; they belong to the env whose server JEV_URL points at.
const vptLockStore = createVptLockStore({ jevUrl: process.env.JEV_URL || '', apiKey: process.env.JEV_API_KEY || '' });
const VPT_LOCKS_ENV = process.env.VPT_LOCKS_ENV || 'node1-vpt';
// Resources this session holds ([{env, resource, ttlLeftMin, purpose, blocksDeploy}]), exact match on `<machine>:<session>`.
function leaseFor(session, sessionNames) {
  const v = leaseStore.peek();
  if (!v?.ok) return [];
  return holdingsOf(session, v.leases, deployRunner.snapshot().deploys, sessionNames, MACHINES).map(({ id, agent, ...r }) => r);
}
function deployWaitFor(session, sessionNames, stall) {
  const v = leaseStore.peek();
  return deployWaitOf(session, { deploys: deployRunner.snapshot().deploys, waiters: v?.ok ? v.waiters : [], stall, sessionNames, machines: MACHINES });
}

// ---------------------------------------------------------------------------
// Alerts: Web Push (always) + ntfy (optional, only when NTFY_TOPIC is set)
// ---------------------------------------------------------------------------

const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_URL = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const NTFY_DONE = process.env.NTFY_DONE === '1';   // also alert when a turn finishes (off: only 'needs you' + disk)
const NTFY_DEBOUNCE_MS = 60000;
const STATE_DIR = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
const push = createPush({ stateDir: STATE_DIR });
// manager.json key `managerSessions` (default ['manager']) — same source the scorecard reads.
const MANAGER_SESSIONS_DEFAULT = ['manager'];
const managerConfigFile = join(STATE_DIR, 'manager.json');
const loadManagerSessions = () => {
  try {
    const j = JSON.parse(readFileSync(managerConfigFile, 'utf8'));
    if (Array.isArray(j?.managerSessions) && j.managerSessions.length) return j.managerSessions;
  } catch {}
  return MANAGER_SESSIONS_DEFAULT;
};
// Jev's wake opinion on each event line (TASK-47 G10, shadow): the facts ghosty knows at that moment.
const wakeAnnotateEvent = (event, cls) => {
  const snap = deployRunner.snapshot();
  const cr = credits.peek();
  return wakeAnnotate(wakeFacts({
    cls, event,
    priority: cls.session ? sessionMeta.priority(cls.session) : null,
    stall: cls.session ? stallOf(cls.session) : null,
    agent: cls.session ? (latest?.status?.[cls.session]?.agent ?? null) : null,
    deploy: cls.kind === 'deploy' ? (snap.deploys || []).find((d) => d.id === cls.deployId) || null : null,
    quota: cls.kind === 'quota' ? quotaPercents(quota.get()) : null,
    diskPct: cls.kind === 'disk' ? health?.disks?.find((d) => d.path === cls.diskPath)?.pct ?? null : null,
    credits: cls.kind === 'credits' && cr?.ok ? { balance: cr.balance ?? null } : null,
  }));
};
const wakesView = createWakesView({ stateDir: STATE_DIR });
const managerEvents = createManagerEvents({ stateDir: STATE_DIR, managerSessions: loadManagerSessions, annotate: wakeAnnotateEvent });
// Two-tier push (MANAGER.md section 6): interrupts at once, the rest as one digest per pushDigestMinutes while awake.
// Knobs in manager.json: pushDigestMinutes (30), pushAwakeFrom ("07:00"), pushAwakeTo ("23:00"), pushTimezone ("Europe/Zurich"), pushInterruptPct (95).
const pushTierConfig = () => { try { return tierConfig(JSON.parse(readFileSync(managerConfigFile, 'utf8'))); } catch { return tierConfig({}); } };
const { alert, resetDebounce, digestTick } = createAlerts({ push, ntfyTopic: NTFY_TOPIC, ntfyUrl: NTFY_URL, publicUrl: PUBLIC_URL, defaultDebounceMs: NTFY_DEBOUNCE_MS,
  tiering: { config: pushTierConfig, managerSessions: loadManagerSessions, file: join(STATE_DIR, 'push-digest.json') }, onFired: (e) => {
    // The manager agent's own alerts are not fed back to it, but they are what the wake outcome looks for.
    if (classifyKey(e.key).kind === 'agent-skip') logEvent({ type: 'agent-alert', key: e.key, title: String(e.title || '').slice(0, 120), body: String(e.body || '').slice(0, 300) });
    managerEvents.record(e).catch((err) => console.error('[manager-events]', err.message));
  } });

const reporter = createReporter({ stateDir: STATE_DIR });   // events from the ghosty-reporter Claude Code plugin (claude-plugin/)
const alertApi = createAlertApi({ alert, tokenOk: (t) => reporter.tokenOk(t) });
const sessionMeta = createSessionMeta({ file: join(STATE_DIR, 'sessions.json') });
const layoutStore = createLayoutStore({ file: join(STATE_DIR, 'layout.json') });   // order / pins / groups of the session list
const turnMeter = createTurnMeter({ ledgerFile: join(STATE_DIR, 'usage-ledger.jsonl') });   // elapsed + tokens of a finished turn, shown with its STATUS line (turn-meter.js)
const usage = createUsage({ file: usageFile(process.env, STATE_DIR) });   // USAGE_SUMMARY overrides the path
const deployRunner = createDeployRunner({
  stateDir: STATE_DIR, alert, isEnabled: deployRunnerOn,
  pollMs: Number(process.env.DEPLOY_POLL_MS || 30000), timeoutMs: Number(process.env.DEPLOY_TIMEOUT_MS || 45 * 60 * 1000),
  onChange: (d) => broadcastStatus({ type: 'deploys', deploys: d }),
});
// Lease <-> session binding (lease-watch.js): lease:* manager events, release of ended holders, narrow of idle server leases.
// manager.json key `leaseBind`: "live" (default) | "dry" (log what it would do) | "off".
const handoffs = createHandoffs({ file: join(STATE_DIR, 'handoffs.json'), machines: MACHINES, record: (e) => managerEvents.record(e), log: console });
const leaseWatch = createLeaseWatch({
  stateDir: STATE_DIR, run: leaseRun, machines: MACHINES,
  listSessionNames: async () => (await listSessions()).map((x) => x.name),
  activityOf: (name) => reporter.activityOf(name),
  record: async (e) => { await handoffs.onLeaseEvent(e).catch((err) => console.error('[handoffs] lease event', err.message)); return managerEvents.record(e); },
  onChange: (snap) => { handoffs.onHolders(snap.holders).catch((err) => console.error('[handoffs] holders', err.message)); },
  mode: () => { try { const m = JSON.parse(readFileSync(managerConfigFile, 'utf8')).leaseBind; return m === 'dry' || m === 'off' ? m : 'live'; } catch { return 'live'; } },
});
const credits = createCredits({ jevUrl: process.env.JEV_URL || '', apiKey: process.env.JEV_API_KEY || '', alert, onChange: (c) => broadcastStatus({ type: 'credits', credits: c }) });
const quota = createQuota({ alert, onChange: (q) => broadcastStatus({ type: 'quota', quota: q }) });

// Debounced per session and kind, so a "done" never swallows a "needs you" that follows it.
function notifySession(session, kind, body, meta) {
  if ((kind === 'waiting' || kind === 'asks') && loadManagerSessions().includes(session)) return;   // the manager's own session never pushes the owner
  const waiting = kind === 'waiting' || kind === 'asks';
  // The agent's STATUS verdict + what the turn took (elapsed, tokens) + its own info, first in the body so every cut keeps it.
  const lt = turnMeter.get(session);
  const turn = lt && meta?.status ? { ...lt, status: meta.status, info: meta.info ?? lt.info } : lt;
  const line = turn ? statusMeterLine(turn) : null;
  if (line) body = [line, body && !/^\s*[*_`]*STATUS:/i.test(String(body)) ? body : null].filter(Boolean).join('\n');   // a body that is the STATUS line itself is replaced by the metered one
  alert(`${session}:${kind}`, {
    title: kind === 'asks' ? `${session} asks you` : waiting ? `${session} needs you` : `${session} is done`,
    priority: waiting ? 'high' : 'default',
    ntfyTags: waiting ? 'warning' : 'white_check_mark',
    body: body || kind,
    url: `/?s=${encodeURIComponent(session)}`,
    tag: `ghosty-${session}`,
    meta: { session, case: meta?.case || kind, question: meta?.question, answer: meta?.answer },
    ...(line ? { turn: { ...turn, line } } : {}),
  });
}

// ---------------------------------------------------------------------------
// Codebox health (CPU / load / RAM / disk) + disk-critical push
// ---------------------------------------------------------------------------

const HEALTH_MS = Number(process.env.HEALTH_MS || 5000);
const HEALTH_DISKS = (process.env.HEALTH_DISKS || '/').split(',').map((d) => d.trim()).filter(Boolean);
const DISK_ALERT_REPEAT_MS = 6 * 3600 * 1000;   // remind every 6 h while a disk stays critical
let health = null;
const diskCrit = new Set();   // paths currently critical

async function healthTick() {
  try { health = await sampleHealth(HEALTH_DISKS); }
  catch (err) { console.error('[health]', err.message); return; }
  const gb = (b) => `${(b / 2 ** 30).toFixed(1)}G`;
  for (const d of health.disks) {
    if (d.level === 'crit') {
      // First crossing pushes at once; while it stays critical, alert()'s debounce paces reminders.
      if (!diskCrit.has(d.path)) resetDebounce(`disk:${d.path}`);
      diskCrit.add(d.path);
      alert(`disk:${d.path}`, {
        title: `codebox disk ${d.path} ${Math.round(d.pct)}% full`,
        priority: 'urgent', ntfyTags: 'rotating_light', tag: `ghosty-disk-${d.path}`, url: '/',
        body: `${gb(d.free)} free of ${gb(d.total)} on ${d.path}`,
      }, DISK_ALERT_REPEAT_MS);
    } else diskCrit.delete(d.path);
  }
  broadcastStatus({ type: 'health', health });
}

// ---------------------------------------------------------------------------
// In-memory cache + poll
// ---------------------------------------------------------------------------

const lastSnapshots = new Map(); // session -> { pane, cols, rows }
// session -> { changeAt, workingSince, lastWorkAt, realWork, prevState, doneAt, ackFor, ackAt,
//              reply, replyHash, contextLeft, model }
const track = new Map();

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function pollOnce() {
  const [sessions, panes, table] = await Promise.all([listSessions(), listPanes(), processTable()]);
  const now = Date.now();
  const sessionNames = sessions.map((x) => x.name);
  const status = {};
  const changedSessions = [];
  await turnMeter.refresh();
  await pool(sessions, CONCURRENCY, async (s) => {
    const p = panes.get(s.name) || { pid: 0, cmd: '', cols: 0, rows: 0, dead: false };
    let pane = null;
    let failed = false;
    // Full scrollback only for sessions with an open card/cell (a WebSocket viewer); the rest
    // get the tail, which is all the state, reply and manager parsing need. Saves tmux CPU.
    const depth = wsBySession.has(s.name) ? PANE_LINES : PANE_LINES_BG;
    if (!p.dead) {
      try { pane = await capturePane(s.name, depth); } catch { failed = true; }
    }
    const offline = p.dead || failed;
    const prev = lastSnapshots.get(s.name);
    let changed = false;
    if (!offline) {
      changed = !prev || prev.pane !== pane || prev.cols !== p.cols || prev.rows !== p.rows;
      if (changed) {
        lastSnapshots.set(s.name, { pane, cols: p.cols, rows: p.rows, depth });
        changedSessions.push(s.name);
      }
    }
    const t = track.get(s.name) || { changeAt: 0, workingSince: null, lastWorkAt: 0, realWork: false, prevState: undefined, doneAt: null, ackFor: null, ackAt: null, reply: null, replyHash: null, contextLeft: null, model: null };
    // A change of capture depth (card opened/closed) is not activity.
    const paneChanged = !!(changed && prev && prev.pane !== pane && prev.depth === depth);
    if (paneChanged) t.changeAt = now;   // first sight is not activity
    track.set(s.name, t);
    // Delivery ack: first pane change after the most recent send.
    const sentAt = lastSendAt.get(s.name) ?? null;
    if (sentAt && t.ackFor !== sentAt) { t.ackFor = sentAt; t.ackAt = null; }
    if (sentAt && t.ackAt == null && paneChanged && now > sentAt) t.ackAt = now;

    const plain = offline ? [] : plainLines(pane);
    const tail = plain.filter((l) => l.trim()).slice(-15);
    const tailText = tail.join('\n');
    const ag = (!offline && agentFromTree(p.pid, table)) || (!offline && agentFromText(tailText)) || null;
    const agent = ag ? ag.agent : (SHELLS.has(p.cmd) || p.cmd === 'sleep' || !p.cmd ? 'bash' : 'other');
    const agentCmd = ag ? ag.cmd : (p.cmd || 'bash');

    let state = 'idle';
    let waitReason = null;
    let reportedWait = null;
    let spinning = false;   // the live spinner / WORK_RE signal this tick: real work, not just a repaint
    if (offline) state = 'offline';
    else if (agent !== 'bash' && (waitReason = findWaitReason(tail)) !== null) state = 'waiting';
    // Claude with a live reporter: a permission request / notification it reported still stands (the pane
    // has been still since) even when the pane regex above missed it.
    else if (agent === 'claude' && (reportedWait = reporter.waitingNow(s.name, t.changeAt))) { state = 'waiting'; waitReason = reportedWait.message || 'needs input'; }
    else {
      spinning = agent !== 'bash' && WORK_RE.test(tail.filter((l) => !/⏵⏵|bypass permissions|accept edits/.test(l)).join('\n'));
      if (spinning) t.realWork = true;
      if (now - t.changeAt < WORKING_HOLD_MS || spinning) state = 'working';
    }
    if (state !== 'waiting') waitReason = null;
    if (state === 'waiting') t.realWork = true;
    if (state === 'working') { t.lastWorkAt = now; if (!t.workingSince) t.workingSince = now; }
    else t.workingSince = null;

    // Parse once per tick; cheap (<=300 lines).
    const end = bodyEnd(plain);
    const isAgent = agent === 'claude' || agent === 'codex' || agent === 'minimax';
    if (state === 'idle' && isAgent) {
      // tmux's session_activity only moves with client input, so prefer (1) our own pane-change
      // clock, then (2) the "done 8:12 AM" stamp in the pane, then (3) session_activity.
      const clockMs = doneClockMs(plain, end, now);
      const lastAct = t.changeAt > 0 ? t.changeAt : (clockMs ?? now - s.lastActivitySec * 1000);
      const recent = now - lastAct < DONE_IDLE_MS;
      const after = !sentAt || t.lastWorkAt >= sentAt;
      if (recent && after && hasTurnMarker(plain, end)) { state = 'done'; t.doneGuess = clockMs ?? lastAct; }
    }
    if (state === 'done') {
      if (t.prevState !== 'done' && (t.realWork || !t.doneAt)) {
        t.doneAt = t.prevState === undefined ? t.doneGuess : now;
      }
    } else if (t.realWork) t.doneAt = null;   // a genuinely new turn started
    const lastMessage = offline ? null : lastMessageOf(plain, end);

    // The finished turn's meter (before the notification, which carries it). stopAt = when ghosty first saw this stop: unknown for one that predates it.
    const stopped = state === 'done' || state === 'waiting';
    if (!stopped || offline) t.stopAt = null;
    else if (t.prevState !== undefined && t.prevState !== state) t.stopAt = now;
    const lastTurn = stopped && !offline && isAgent
      ? turnMeter.compute({ name: s.name, agent, sentAt, stopAt: t.stopAt ?? null, claude: agent === 'claude' && reporter.liveOf(s.name) ? reporter.meterOf(s.name) : null, plain })
      : (turnMeter.forget(s.name), null);

    // Notifications: transitions only, never on first sight.
    if (t.prevState !== undefined && t.prevState !== state) {
      if (state === 'waiting') notifySession(s.name, 'waiting', waitReason || 'needs input');
      else if (state === 'done' && t.realWork && NTFY_DONE) notifySession(s.name, 'done', lastMessage || 'turn finished');
    }
    if (state === 'done') t.realWork = false;
    t.prevState = state;

    if (!offline && isAgent && (paneChanged || changed || t.replyHash == null)) {
      t.reply = replyOf(plain, end);
      t.replyHash = t.reply ? shortHash(t.reply) : null;
    } else if (!isAgent || offline) { t.reply = null; t.replyHash = null; }

    const foot = offline ? { contextLeft: null, model: null } : footerInfo(plain.filter((l) => l.trim()));
    if (isAgent) {
      if (foot.contextLeft != null) t.contextLeft = foot.contextLeft;
      if (foot.model) t.model = foot.model;
    } else { t.contextLeft = null; t.model = null; }
    const meta = offline ? { cwd: p.cwd || null, repo: null, branch: null, dirty: null } : await getMeta(s.name, p.cwd || null);

    if (!offline) {
      observe({ name: s.name, state, agent, plain, raw: pane.split('\n').slice(0, plain.length), changed: paneChanged || t.prevObserved !== state, realWork: spinning,
        project: meta.project ?? null, lastSendAt: sentAt, lastSendText: lastSendText.get(s.name) ?? null, now,
        rep: agent === 'claude' && reporter.liveOf(s.name) ? { turnForStop: (since) => reporter.turnForStop(s.name, since), promptSince: (since) => reporter.promptSince(s.name, since) } : null });
      t.prevObserved = state;
    }

    status[s.name] = {
      state, agent, agentCmd, waitReason,
      stall: stallOf(s.name),
      triage: triageOf(s.name),
      auto: autoOf(s.name),
      handoffs: handoffs.forSession(s.name),
      lastActivitySec: s.lastActivitySec,
      lastSendAt: sentAt,
      lastSendAck: sentAt && t.ackFor === sentAt ? t.ackAt : null,
      workingSinceMs: t.workingSince,
      doneAt: state === 'done' ? t.doneAt : null,
      activity: state === 'working' && !offline ? activityOf(plain, end) : null,
      lastMessage,
      lastTurn,
      replyHash: t.replyHash,
      cwd: meta.cwd, repo: meta.repo, branch: meta.branch, dirty: meta.dirty,
      project: meta.project ?? null, github: !!meta.github, worktree: meta.worktree ?? null,
      contextLeft: t.contextLeft, model: t.model,
      lease: leaseFor(s.name, sessionNames),
      deployWait: deployWaitFor(s.name, sessionNames, stallOf(s.name)),
      cols: p.cols, rows: p.rows,
      attached: s.attached, windows: s.windows, cmd: p.cmd,
    };
  });
  for (const k of [...lastSnapshots.keys()]) if (!status[k]) lastSnapshots.delete(k);
  for (const k of [...track.keys()]) if (!status[k]) track.delete(k);
  for (const k of [...metaCache.keys()]) if (!status[k]) metaCache.delete(k);
  for (const k of [...lastSendText.keys()]) if (!status[k]) lastSendText.delete(k);
  pruneManager(new Set(Object.keys(status)));
  reporter.prune(new Set(Object.keys(status)));
  turnMeter.prune(new Set(Object.keys(status)));
  sessionMeta.sync(Object.keys(status));
  const claudeIdx = await claudeIndex.get();
  for (const [k, v] of Object.entries(status)) {
    if (v.agent !== 'claude') continue;
    const c = claudeOfPane(panes.get(k)?.pid || 0, table, claudeIdx);
    const la = lastActivityOf({ info: c?.info, reporterAt: reporter.lastActivity(k) });
    v.lastActivity = la ? la.at : null;
    v.lastActivitySource = la ? la.source : null;
    v.claudeSessionId = c ? c.info.sessionId : null;
    v.rssMb = c && table.rss.get(c.pid) ? Math.round(table.rss.get(c.pid) / 1024) : null;
  }
  for (const [k, v] of Object.entries(status)) { v.priority = sessionMeta.priority(k); v.paused = sessionMeta.isPaused(k); v.held = heldOf(k); v.usage = usage.forSession(k); v.reporter = v.agent === 'claude' ? reporter.summary(k) : null; }
  return { sessions, status, changedSessions };
}

// Shared in-flight poll so HTTP callers don't trigger extra work.
let latest = null; // { at, sessions, status }
let inflight = null;
function poll() {
  if (inflight) return inflight;
  inflight = pollOnce().then((r) => { latest = { at: Date.now(), ...r }; return latest; })
    .finally(() => { inflight = null; });
  return inflight;
}

// ---------------------------------------------------------------------------
// Leases (shared registry on proxmox)
// ---------------------------------------------------------------------------

const getLeases = (force) => leaseStore.get(force);
const leasesPayload = (v) => (v.ok ? { type: 'leases', leases: v.leases, waiters: v.waiters, hostname: hostname() } : { type: 'leases', error: v.error });

// Per-session WebSocket fan-out
const wsBySession = new Map(); // session -> Set<ws>
const statusSubs = new Set();   // ws clients that want status updates

function broadcast(session, payload) {
  const set = wsBySession.get(session);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function broadcastStatus(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of statusSubs) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.apk':  'application/vnd.android.package-archive',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

async function serveStatic(req, res, urlPath) {
  // Sanitize: strip leading '/', resolve under PUBLIC_DIR, block escapes.
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!existsSync(full)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const st = await stat(full);
  if (st.isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const body = await readFile(full);
  const type = MIME[extname(full)] || 'application/octet-stream';
  // No-cache for everything the browser might serve stale. The PWA shell is
  // small enough that the extra round-trip costs nothing; xterm.js is the only
  // big file and we still cache it (long max-age) because it changes rarely.
  const noCacheExts = new Set(['.html', '.js', '.css', '.webmanifest', '.json']);
  const cache = noCacheExts.has(extname(full)) || rel === '/sw.js' || rel === '/manifest.webmanifest'
    ? 'no-cache'
    : 'public, max-age=3600';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  res.end(body);
}

const MAX_BODY = 64 * 1024;
async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { if (size - c.length <= MAX_BODY) reject(Object.assign(new Error('body too large'), { status: 413 })); chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle + directory picker
// ---------------------------------------------------------------------------

const HOME = homedir();
const NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const AGENT_CMDS = {
  claude:  process.env.AGENT_CMD_CLAUDE  ?? 'claude --dangerously-skip-permissions',
  codex:   process.env.AGENT_CMD_CODEX   ?? 'codex --dangerously-bypass-approvals-and-sandbox',
  minimax: process.env.AGENT_CMD_MINIMAX ?? 'PATH=$HOME/.local/node-v24.21.0-linux-x64/bin:$PATH mcode',
  bash:    process.env.AGENT_CMD_BASH    ?? '',
};
const RESIZE_ALLOW = process.env.GHOSTY_RESIZE_ALLOW ? new RegExp(process.env.GHOSTY_RESIZE_ALLOW) : null;

// Resize a DETACHED session's window to cols x rows so the agent re-renders
// (SIGWINCH) at the card's size. `resize-window` flips the window to
// window-size=manual; we immediately unset that per-window option so a later
// real `tmux attach` resizes the window to the attaching terminal again (the
// current size just stays until then).
async function resizeSession(name, cols, rows) {
  if (RESIZE_ALLOW && !RESIZE_ALLOW.test(name)) throw Object.assign(httpError(403, 'resize not allowed for this session'), { reason: 'forbidden' });
  if (!(await sessionExists(name))) throw httpError(404, 'no such session');
  const target = `=${name}:`;
  const { stdout } = await exec(TMUX, ['display-message', '-p', '-t', target, '#{session_attached}']);
  if (Number(stdout.trim()) > 0) throw Object.assign(httpError(409, 'session is attached'), { reason: 'attached' });
  await exec(TMUX, ['resize-window', '-t', target, '-x', String(cols), '-y', String(rows)]);
  try { await exec(TMUX, ['set-option', '-w', '-u', '-t', target, 'window-size']); } catch {}
  return { ok: true, cols, rows };
}
const httpError = (status, message) => Object.assign(new Error(message), { status });

async function sessionExists(name) {
  try { await exec(TMUX, ['has-session', '-t', `=${name}`]); return true; } catch { return false; }
}

async function createSession({ name, agent, cwd, priority }) {
  if (priority !== undefined && !isPriority(priority)) throw httpError(400, 'priority must be P0, P1 or P2');
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw httpError(400, 'invalid name (A-Z a-z 0-9 _ . -, max 40)');
  if (!Object.hasOwn(AGENT_CMDS, agent)) throw httpError(400, 'agent must be claude|codex|minimax|bash');
  let dir;
  try {
    dir = await realpath(cwd || HOME);
    if (!(await stat(dir)).isDirectory()) throw new Error();
  } catch { throw httpError(400, 'cwd must be an existing directory'); }
  const home = await realpath(HOME);
  if (dir !== home && !dir.startsWith(home + sep)) throw httpError(400, 'cwd must be under $HOME');
  // tmux silently rewrites '.' and ':' in session names to '_'.
  const real = name.replace(/[.:]/g, '_');
  if (await sessionExists(real)) throw httpError(409, 'session already exists');
  try {
    await exec(TMUX, ['new-session', '-d', '-s', real, '-c', dir, '-x', '120', '-y', '40']);
  } catch (err) {
    throw httpError(/duplicate session/.test(err.stderr || '') ? 409 : 500, String(err.stderr || err.message).trim().slice(0, 200));
  }
  try { await trustFolder(agent, dir); } catch { /* best effort: the agent just asks */ }
  const cmd = AGENT_CMDS[agent];
  if (cmd) {
    await exec(TMUX, ['send-keys', '-t', `=${real}:`, '-l', '--', cmd]);
    await exec(TMUX, ['send-keys', '-t', `=${real}:`, 'Enter']);
  }
  sessionMeta.reset(real);
  sessionMeta.sync([real]);   // a new session starts at P2 (or the chosen priority), not paused
  if (priority) sessionMeta.set(real, { priority });
  latest = null;
  return { ok: true, name: real, agent, cwd: dir, priority: sessionMeta.priority(real) };
}

async function killSession(name, confirm) {
  if (confirm !== name) throw httpError(400, 'confirm must equal the session name');
  if (!(await sessionExists(name))) throw httpError(404, 'no such session');
  await exec(TMUX, ['kill-session', '-t', `=${name}`]);
  lastSendAt.delete(name);
  managerForget(name);
  sessionMeta.reset(name);
  latest = null;
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// Session cap + parking (parking.js): park = record the Claude conversation, /exit, kill tmux; resume = new tmux + claude --resume.
// ---------------------------------------------------------------------------
const claudeIndex = createClaudeIndex({ dir: process.env.CLAUDE_SESSIONS_DIR || join(homedir(), '.claude', 'sessions') });
const parking = createParking({
  file: join(STATE_DIR, 'parked-sessions.json'),
  tmux: {
    exists: sessionExists,
    kill: async (name) => { await killSession(name, name); },
    sendText: (name, text) => exec(TMUX, ['send-keys', '-t', `=${name}:`, '-l', '--', text]),
    sendEnter: (name) => exec(TMUX, ['send-keys', '-t', `=${name}:`, 'Enter']),
    create: (name, cwd) => exec(TMUX, ['new-session', '-d', '-s', name, '-c', cwd, '-x', '120', '-y', '40']),
  },
});
const pidAlive = async (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function parkFacts(name) {
  if (!(await sessionExists(name))) throw httpError(404, 'no such session');
  const panes = await listPanes();
  const table = await processTable();
  const idx = await claudeIndex.get(true);
  const claude = claudeOfPane(panes.get(name)?.pid || 0, table, idx);
  const sess = (await listSessions()).find((x) => x.name === name);
  const st = (latest && latest.status[name]) || null;
  const lz = await getLeases(true);
  let leases = null;
  if (lz?.ok) leases = leasesOfSession(lz.leases, [name, claude?.info?.name || '']);
  let rssMb = null;
  if (claude) { try { rssMb = Math.round(Number((await exec('ps', ['-o', 'rss=', '-p', String(claude.pid)])).stdout.trim()) / 1024); } catch {} }
  const rw = reporter.detail(name);
  return {
    claude, state: st?.state || null, attached: !!sess?.attached, reporterWaiting: !!(rw && reporter.waitingNow(name, 0)),
    backgroundWork: rw?.lastTurn?.backgroundWork || 0, busy: claude ? busyChildren(claude.pid, table) : [], leases, rssMb, priority: sessionMeta.priority(name),
  };
}

async function parkSession(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw httpError(400, 'invalid session name');
  const rec = await parking.park(name, await parkFacts(name), { claudeAlive: pidAlive });
  latest = null;
  return { ok: true, parked: rec };
}

async function resumeSession(name) {
  const rec = await parking.get(name);
  if (!rec) throw httpError(404, 'not parked');
  const out = await parking.resume(name, {
    base: AGENT_CMDS.claude,
    start: async (n, r, cmd) => {
      try { await trustFolder('claude', r.cwd); } catch { /* best effort */ }
      await exec(TMUX, ['send-keys', '-t', `=${n}:`, '-l', '--', cmd]);
      await exec(TMUX, ['send-keys', '-t', `=${n}:`, 'Enter']);
      sessionMeta.reset(n);
      sessionMeta.sync([n]);
      if (r.priority) sessionMeta.set(n, { priority: r.priority });
    },
  });
  latest = null;
  return { ok: true, resumed: out };
}

async function parkingView() {
  const r = (latest && Date.now() - latest.at < 5000) ? latest : await poll();
  const rows = Object.entries(r.status).map(([name, v]) => ({ name, agent: v.agent, state: v.state, lastActivity: v.lastActivity ?? null, rssMb: v.rssMb ?? null }));
  const parked = await parking.list();
  return { ...capView({ sessions: rows, cap: SESSION_CAP }), parked, manual: await readManualNotes(join(STATE_DIR, 'parked.json')), ramSavedMb: parked.reduce((a, p) => a + (p.rssMb || 0), 0) };
}

// Owner settings of one session: { priority } and / or { paused }.
// paused:true  -> hold first (so the manager stops at once), then Escape once.
// paused:false -> release, then "continue" + Enter.
async function setSessionMeta(session, body) {
  const by = actorOf(body);
  if (!(await sessionExists(session))) throw httpError(404, 'no such session');
  // Pause / resume type into the pane: refuse BEFORE touching any state (paused flag, hold) so a
  // refused non-owner call leaves nothing half-applied. Owner is exempt inside assertAgentPane.
  if (typeof body?.paused === 'boolean') await assertAgentPane(session, by);
  sessionMeta.sync([session]);
  const changed = sessionMeta.set(session, body || {});
  if (changed.priority) logEvent({ type: 'priority', session, by, priority: changed.priority });
  const released = body?.paused === false && releaseHold(session);   // Resume also clears the manager's quota hold
  if (changed.paused === true) {
    cancelAuto(session, 'paused by owner');
    logEvent({ type: 'pause', session, by });
    try { await sendKey(session, 'Escape'); }
    catch (e) { sessionMeta.set(session, { paused: false }); throw e; }
  } else if (changed.paused === false) {
    logEvent({ type: 'resume', session, by });
    await sendKeys(session, 'continue', true);
  } else if (released) {
    await sendKeys(session, 'continue', true);
  }
  latest = null;
  return { ok: true, session, priority: sessionMeta.priority(session), paused: sessionMeta.isPaused(session), held: heldOf(session), changed };
}

// Who typed: every send is logged with its actor (the owner's UI sends no `by`, the manager agent sends 'manager-agent').
function logSend(session, by, payload) {
  logEvent({ type: 'send', session, by, ...(payload.key !== undefined ? { key: String(payload.key).slice(0, 40) } : { text: String(payload.keys || '').slice(0, 200) }) });
}

async function sendMany(sessions, payload) {
  const by = actorOf(payload);
  if (!Array.isArray(sessions) || !sessions.length || sessions.length > 50) throw httpError(400, 'sessions must be a non-empty array (max 50)');
  if (payload.key === undefined && typeof payload.keys !== 'string') throw httpError(400, 'keys (string) or key required');
  const list = [...new Set(sessions.map(String))];
  const results = new Array(list.length);
  await pool(list.map((session, idx) => ({ session, idx })), 4, async ({ session, idx }) => {
    try {
      if (!(await sessionExists(session))) { results[idx] = { session, ok: false, error: 'no such session' }; return; }
      await assertAgentPane(session, by);
      const out = payload.key !== undefined
        ? await sendKey(session, String(payload.key))
        : await sendKeys(session, payload.keys, payload.enter !== false);
      logSend(session, by, payload);
      results[idx] = { session, ...out };
    } catch (err) {
      results[idx] = { session, ok: false, error: err.stderr ? String(err.stderr).trim().slice(0, 120) : err.message };
    }
  });
  return { ok: results.every((r) => r.ok), results };
}

// Candidate working dirs: repos + their worktrees under $HOME (depth <= 3), plus live pane cwds.
// Project list: cached in memory, persisted to <state dir>/dirs.json (instant after a restart), refreshed in the background.
// A request never waits for the scan once there is any copy: it gets the cached list and, when it is older than a minute, a
// single background refresh starts.
let dirsCache = { at: 0, value: null };
let dirsInflight = null;
const DIRS_FILE = join(STATE_DIR, 'dirs.json');
const SKIP_DIRS = new Set(['node_modules', 'snap', 'venv', '.venv', '__pycache__', 'dist', 'build', 'target']);
async function walkRepos(dir, depth, out) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
  if (ents.some((e) => e.name === '.git')) { out.push(dir); return; }
  if (depth >= 3) return;
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    await walkRepos(join(dir, e.name), depth + 1, out);
  }
}

async function scanDirs() {
  const repos = [];
  // depth counted from $HOME: ~/a (1), ~/a/b (2), ~/a/b/c (3)
  let top = [];
  try { top = await readdir(HOME, { withFileTypes: true }); } catch {}
  if (existsSync(join(HOME, '.git'))) repos.push(HOME);
  await pool(top.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)), 6, (e) => walkRepos(join(HOME, e.name), 1, repos));
  const paths = new Set(repos);
  await pool(repos, 6, async (repo) => {
    try {
      const { stdout } = await exec('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { timeout: 4000 });
      for (const l of stdout.split('\n')) {
        // Skip Claude's ephemeral agent worktrees; they only show up if a pane is actually in one.
        if (l.startsWith('worktree ') && !l.includes('/.claude/worktrees/')) paths.add(l.slice(9));
      }
    } catch {}
  });
  for (const p of (await listPanes()).values()) if (p.cwd && (p.cwd === HOME || p.cwd.startsWith(HOME + sep))) paths.add(p.cwd);
  const list = [];
  await pool([...paths], 8, async (path) => {
    let mtime = 0;
    for (const f of ['.git/index', '.git/HEAD', '.git', '']) {
      try { mtime = Math.max(mtime, (await stat(join(path, f))).mtimeMs); } catch {}
      if (mtime) break;
    }
    if (!mtime) return;   // vanished
    const g = await gitInfo(path);
    list.push({ path, name: basename(path), branch: g.branch, mtime, git: existsSync(join(path, '.git')) });
  });
  list.sort((a, b) => b.mtime - a.mtime);
  const value = list.map(({ path, name, branch, git }) => ({ path, name, branch, git }));
  return value;
}
function refreshDirs() {
  if (!dirsInflight) {
    dirsInflight = scanDirs().then(async (value) => {
      dirsCache = { at: Date.now(), value };
      try { await writeFile(DIRS_FILE, JSON.stringify(value)); } catch { /* cache only */ }
      return value;
    }).finally(() => { dirsInflight = null; });
  }
  return dirsInflight;
}
async function collectDirs() {
  if (!dirsCache.value) {
    try { dirsCache = { at: (await stat(DIRS_FILE)).mtimeMs, value: JSON.parse(await readFile(DIRS_FILE, 'utf8')) }; } catch { /* no copy yet */ }
  }
  if (dirsCache.value) {
    if (Date.now() - dirsCache.at > 60000) refreshDirs().catch(() => {});
    return dirsCache.value;
  }
  return refreshDirs();
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Reject browser requests whose Origin host differs from the Host header (CSRF / cross-site WS).
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  // Tight CORS — bound to Tailscale only anyway, but be explicit.
  res.setHeader('referrer-policy', 'no-referrer');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method !== 'GET' && !originOk(req)) return json(res, 403, { ok: false, error: 'cross-origin request refused' });
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE'
      && req.method !== 'OPTIONS' && !/application\/json/i.test(req.headers['content-type'] || '')) {
    return json(res, 415, { ok: false, error: 'content-type must be application/json' });
  }

  // --- reporter intake: loopback peers only, shared token (reporter.token, 0600) ---
  // Cross-session peer messages (peer.send, peer.recv) are recorded as {type:'peer'} in stalls.jsonl via
  // logEvent; the per-session facts are untouched. The response keeps the previous {ok,...} shape for
  // every event (the peer record itself is not echoed back to the plugin).
  if (req.method === 'POST' && p === '/api/reporter/event') {
    if (!isLoopback(req.socket.remoteAddress)) return json(res, 403, { ok: false, error: 'loopback only' });
    if (!reporter.tokenOk(req.headers[TOKEN_HEADER])) return json(res, 401, { ok: false, error: 'bad token' });
    try {
      const r = reporter.ingest(await readJsonBody(req));
      if (r && r.peer) logEvent(r.peer);
      const { peer: _peer, ...rest } = r || {};
      return json(res, 200, rest);
    }
    catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'POST' && p === '/api/alert') {   // the manager agent's channel to the owner: loopback + reporter token
    try {
      const r = await alertApi.handle({ remoteAddress: req.socket.remoteAddress, headers: req.headers, readBody: () => readJsonBody(req) });
      return json(res, r.status, r.body);
    } catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'GET' && p.startsWith('/api/reporter/')) {
    const d = reporter.detail(decodeURIComponent(p.slice('/api/reporter/'.length)));
    return d ? json(res, 200, d) : json(res, 404, { ok: false, error: 'no reports for that session' });
  }

  // --- API ---
  if (req.method === 'GET' && p === '/api/sessions') {
    const r = (latest && Date.now() - latest.at < 1500) ? latest : await poll();
    let status = r.status;
    if (url.searchParams.get('full') === '1') {
      status = {};
      for (const [k, v] of Object.entries(r.status)) status[k] = { ...v, reply: track.get(k)?.reply ?? null };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: r.sessions, status }));
    return;
  }
  if (req.method === 'GET' && (p.startsWith('/api/taskdocs/') || p.startsWith('/api/taskdoc/'))) {
    const one = p.startsWith('/api/taskdoc/');
    const session = decodeURIComponent(p.slice(one ? '/api/taskdoc/'.length : '/api/taskdocs/'.length));
    const files = await taskDocFiles(session);
    if (!one) return json(res, 200, { session, files: files.map((f) => f.name) });
    const want = new URL(req.url, 'http://x').searchParams.get('f');
    const f = files.find((x) => x.name === want) || files[0];
    if (!f) return json(res, 404, { ok: false, error: 'no task doc' });
    return json(res, 200, { session, name: f.name, text: (await readFile(f.path, 'utf8')).slice(0, 400000) });
  }
  if (req.method === 'GET' && p.startsWith('/api/transcript/')) {
    const session = decodeURIComponent(p.slice('/api/transcript/'.length));
    try {
      const lines = plainLines(await capturePane(session));
      const text = transcriptOf(lines, bodyEnd(lines));
      return json(res, 200, { session, text, hash: shortHash(text) });
    } catch {
      return json(res, 404, { ok: false, error: 'no such session' });
    }
  }
  if (req.method === 'GET' && p.startsWith('/api/reply/')) {
    const session = decodeURIComponent(p.slice('/api/reply/'.length));
    const t = track.get(session);
    let reply = t ? t.reply : null;
    if (!t) {
      try {
        const lines = plainLines(await capturePane(session));
        reply = replyOf(lines, bodyEnd(lines));
      } catch {
        return json(res, 404, { ok: false, error: 'no such session' });
      }
    }
    return json(res, 200, { session, reply, replyHash: reply ? shortHash(reply) : null });
  }
  if (req.method === 'GET' && p === '/api/vpt-locks') {   // {ok, env, locks:[{host, device, ownerType, owner, reason, ageMin}]} or {ok:false, env, error}; never an error status
    let v;
    try { v = await vptLockStore.get(); } catch (e) { v = { ok: false, error: String(e.message || e).slice(0, 120) }; }
    return json(res, 200, { ...v, env: VPT_LOCKS_ENV });
  }
  if (req.method === 'GET' && p === '/api/leases') {
    res.writeHead(200, { 'content-type': 'application/json' });
    { const v = await getLeases(); res.end(JSON.stringify(v.ok ? { ok: true, leases: v.leases, waiters: v.waiters, hostname: hostname() } : v)); }
    return;
  }
  if (req.method === 'GET' && p.startsWith('/api/snapshot/')) {
    const session = decodeURIComponent(p.slice('/api/snapshot/'.length));
    let snap = lastSnapshots.get(session);
    if (!snap) {
      try { snap = { pane: await capturePane(session) }; } catch { snap = { pane: '' }; }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ session, pane: snap.pane, cols: snap.cols, rows: snap.rows }));
    return;
  }
  if (req.method === 'POST' && p.startsWith('/api/send/')) {
    const session = decodeURIComponent(p.slice('/api/send/'.length));
    let payload;
    try { payload = await readJsonBody(req); }
    catch (err) {
      return json(res, err.status || 400, { ok: false, error: err.status ? err.message : 'bad json' });
    }
    try {
      const by = actorOf(payload);
      if (!(await sessionExists(session))) throw httpError(404, 'no such session');
      await assertAgentPane(session, by);
      const out = payload.key !== undefined
        ? await sendKey(session, String(payload.key))
        : await sendKeys(session, payload.keys || '', payload.enter !== false);
      logSend(session, by, payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(err.status || 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  if (req.method === 'POST' && p.startsWith('/api/resize/')) {
    const session = decodeURIComponent(p.slice('/api/resize/'.length));
    try {
      const b = await readJsonBody(req);
      const cols = b.cols, rows = b.rows;
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) throw httpError(400, 'cols 20-400 and rows 5-200 required');
      return json(res, 200, await resizeSession(session, cols, rows));
    } catch (err) {
      return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message, reason: err.reason });
    }
  }
  if (req.method === 'POST' && p === '/api/sessions') {
    try { return json(res, 200, await createSession(await readJsonBody(req))); }
    catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'GET' && p === '/api/parking') {
    try { return json(res, 200, await parkingView()); } catch (err) { return json(res, err.status || 500, { ok: false, error: err.message }); }
  }
  {
    const m = req.method === 'POST' && /^\/api\/sessions\/([^/]+)\/(park|resume)$/.exec(p);
    if (m) {
      const name = decodeURIComponent(m[1]);
      try { return json(res, 200, m[2] === 'park' ? await parkSession(name) : await resumeSession(name)); }
      catch (err) { return json(res, err.status || 500, { ok: false, error: err.message, reasons: err.reasons }); }
    }
  }
  if (req.method === 'DELETE' && p.startsWith('/api/sessions/')) {
    try { return json(res, 200, await killSession(decodeURIComponent(p.slice('/api/sessions/'.length)), url.searchParams.get('confirm'))); }
    catch (err) { return json(res, err.status || 500, { ok: false, error: err.message }); }
  }
  if (p === '/api/layout' && (req.method === 'GET' || req.method === 'PUT')) {
    try {
      if (req.method === 'GET') return json(res, 200, await layoutStore.get());
      return json(res, 200, await layoutStore.set(await readJsonBody(req)));
    } catch (err) { return json(res, err instanceof SyntaxError ? 400 : 500, { ok: false, error: err.message }); }
  }
  if (req.method === 'GET' && p === '/api/dirs') {
    try { return json(res, 200, await collectDirs()); }
    catch (err) { return json(res, 500, { ok: false, error: err.message }); }
  }
  if (req.method === 'POST' && p === '/api/send-many') {
    try {
      const payload = await readJsonBody(req);
      return json(res, 200, await sendMany(payload.sessions, payload));
    } catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'GET' && p === '/api/manager') {
    return json(res, 200, { ...managerConfig(), today: await todayCounts(), aiStats: await aiSummary() });
  }
  if (p.startsWith('/api/push/')) {
    try {
      if (req.method === 'GET' && p === '/api/push/key') return json(res, 200, { key: push.publicKey });
      if (req.method === 'GET' && p === '/api/push/feed') {
        const since = url.searchParams.get('since');
        return json(res, 200, { items: push.feedSince(since === null || since === '' ? undefined : since) });
      }
      if (req.method === 'POST' && p === '/api/push/subscribe') {
        push.subscribe((await readJsonBody(req)).subscription);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/push/unsubscribe') {
        return json(res, 200, { ok: true, removed: push.unsubscribe((await readJsonBody(req)).endpoint) });
      }
      if (req.method === 'POST' && p === '/api/push/diag') {
        const d = await readJsonBody(req);
        console.log('[push] diag', JSON.stringify(d).slice(0, 800));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/push/test') {
        const { results } = await push.notify({ title: 'codebox: test notification', body: 'Web Push is working.', url: '/', tag: 'ghosty-test', priority: 'high' });
        return json(res, 200, { ok: true, subscriptions: results.length, results });
      }
    } catch (err) { return json(res, err.status || 400, { ok: false, error: err.message }); }
  }
  if (req.method === 'POST' && p.startsWith('/api/session-meta/')) {
    try { return json(res, 200, await setSessionMeta(decodeURIComponent(p.slice('/api/session-meta/'.length)), await readJsonBody(req))); }
    catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'GET' && p === '/api/usage') {
    const b = await usage.body(Object.keys(latest?.status || {}));
    return b ? json(res, 200, b) : json(res, 404, { error: 'no usage summary yet' });
  }
  if (req.method === 'GET' && p === '/api/deploys') return json(res, 200, deployRunner.snapshot());
  const dm = p.match(/^\/api\/deploys\/([0-9a-f]+)\/(approve|cancel|log)$/);
  if (dm) {
    if (dm[2] === 'log' && req.method === 'GET') {
      const tail = Math.min(2000, Math.max(1, Number(url.searchParams.get('tail')) || 200));
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(await deployRunner.logTail(dm[1], tail));
      return;
    }
    if (dm[2] !== 'log' && req.method === 'POST') {
      let by;
      try { by = actorOf(await readJsonBody(req)); } catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
      const r = await deployRunner.act(dm[1], dm[2]);
      if (r.ok) logEvent({ type: 'deploy_action', id: dm[1], action: dm[2], by });
      return json(res, r.ok ? 200 : r.status, r.ok ? { ok: true } : { ok: false, error: r.error });
    }
  }
  if (req.method === 'GET' && p === '/api/quota') return json(res, 200, quota.get());
  if (req.method === 'POST' && p.startsWith('/api/manager/cancel/')) {
    const name = decodeURIComponent(p.slice('/api/manager/cancel/'.length));
    if (!cancelAuto(name)) return json(res, 404, { ok: false, error: 'no pending auto answer' });
    latest = null;
    return json(res, 200, { ok: true, session: name });
  }
  if (req.method === 'POST' && p === '/api/manager') {
    try { const cfg = await setManagerConfig(await readJsonBody(req)); broadcastStatus({ type: 'deploys', deploys: deployRunner.snapshot() }); return json(res, 200, cfg); }
    catch (err) { return json(res, err.status || 400, { ok: false, error: err.message }); }
  }
  if (req.method === 'POST' && p === '/api/manager/label') {
    try { return json(res, 200, { ok: true, label: await labelStall(await readJsonBody(req)) }); }
    catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'POST' && p === '/api/manager/triage') {   // {id, action: sent|edited|dismissed, session?}: what the owner did with the AI's proposal
    try { return json(res, 200, { ok: true, action: await triageAction(await readJsonBody(req)) }); }
    catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'POST' && p === '/api/manager/choice') {   // {id, session, kind:'choice', owner, ai?, jev?, agreeJev?}: owner answered from the popup (one tap)
    try { return json(res, 200, { ok: true, choice: await logOwnerChoice(await readJsonBody(req)) }); }
    catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'POST' && p === '/api/manager/unlabel') {
    try { return json(res, 200, { ok: true, unlabel: await unlabelStall(await readJsonBody(req)) }); }
    catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'GET' && p === '/api/jev-ai') return json(res, 200, { ...await jevAiTab(), credits: await credits.get() });
  if (req.method === 'GET' && p === '/api/credits') return json(res, 200, await credits.get());
  if (req.method === 'GET' && p === '/api/decisions') {
    const q = url.searchParams;
    return json(res, 200, await decisionsView({ usage: q.get('usage') || '', ok: q.get('ok') || '', hasOutcome: q.get('has_outcome') || '', minConf: q.get('min_conf') || '',
      limit: q.get('limit') || 100, offset: q.get('offset') || 0 }));
  }
  if (req.method === 'GET' && p === '/api/manager/review') {
    return json(res, 200, await reviewDeck(url.searchParams.get('limit') || 50));
  }
  if (req.method === 'GET' && p === '/api/manager/log') {
    const limit = Math.min(2000, Number(url.searchParams.get('limit')) || 200);
    let lines = [];
    try { lines = (await readFile(LOG_FILE, 'utf8')).trim().split('\n').filter(Boolean); } catch {}
    return json(res, 200, { entries: lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) });
  }
  if (req.method === 'GET' && p === '/api/manager/events') {   // tail of manager-events.jsonl (newest last); a freshly-started manager agent catches up
    const q = url.searchParams;
    const since = q.get('since') || '';
    const limit = Math.min(2000, Math.max(1, Number(q.get('limit')) || 50));
    return json(res, 200, { events: await managerEvents.tail({ since, limit }) });
  }
  if (req.method === 'GET' && p === '/api/leases/watch') return json(res, 200, leaseWatch.snapshot());   // holders classified (live / ended / remote / unknown) + planned actions
  if (req.method === 'GET' && p === '/api/handoffs') {
    const q = url.searchParams;
    return json(res, 200, { handoffs: handoffs.list({ state: q.get('state') || undefined, session: q.get('session') || undefined }) });
  }
  if (req.method === 'POST' && p === '/api/handoffs') {
    try {
      const b = await readJsonBody(req);
      if (!b || !b.resource || !b.from || !b.to) return json(res, 400, { ok: false, error: 'resource, from and to are required' });
      const due = typeof b.due === 'number' ? b.due : (typeof b.due === 'string' && /^\d{1,2}:\d{2}$/.test(b.due) ? (() => { const d = new Date(); const [hh, mm] = b.due.split(':'); d.setHours(Number(hh), Number(mm), 0, 0); return d.getTime(); })() : null);
      const row = await handoffs.create({ resource: String(b.resource), from: String(b.from), to: String(b.to), due });
      return json(res, 200, { ok: true, handoff: row });
    } catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'POST' && p.startsWith('/api/handoffs/') && p.endsWith('/done')) {
    const id = p.slice('/api/handoffs/'.length, -'/done'.length);
    try {
      const b = await readJsonBody(req).catch(() => ({}));
      const row = await handoffs.done(id, b?.by);
      return row ? json(res, 200, { ok: true, handoff: row }) : json(res, 404, { ok: false, error: 'no such handoff' });
    } catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'GET' && p === '/api/manager/actions') {   // the manager agent's own action log (manager-actions.jsonl), newest last, read-only
    const q = url.searchParams;
    return json(res, 200, { actions: await readActions({ stateDir: STATE_DIR, since: q.get('since') || null, limit: q.get('limit') }), regrets: effectiveRegrets(await readRegrets({ stateDir: STATE_DIR })).map((r) => regretKey(r.at, r.session)) });
  }
  if (req.method === 'POST' && p === '/api/manager/regret') {   // {at, session, decision?, undo?}: the owner's one-tap "wrong" on a manager action (G8 ground truth)
    try {
      const b = await readJsonBody(req);
      return json(res, 200, { ok: true, label: await appendRegret({ stateDir: STATE_DIR, at: b?.at, session: b?.session, decision: b?.decision, undo: b?.undo === true }) });
    } catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'GET' && p === '/api/manager/wakes') {   // per-wake log built from the manager's Claude transcript (60 s cache)
    try { return json(res, 200, await wakesView(url.searchParams.get('day') || '')); } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
  }
  if (req.method === 'GET' && p === '/api/manager/scorecard') {
    // 60 s in-process cache: the file is ~35k lines and the UI re-renders on every status tick.
    // Scorecard reports tokens + calls per bucket (session / subagents / workers / Jev / reviewer / judge / total — no USD),
    // claude_weekly_pct / claude_today_pct (manager's share of the Claude Max weekly plan) and efficiency vs the
    // planBudget.claudeWeeklyPct pro-rated to the elapsed fraction of the plan-week. The plan-week ends at the
    // Claude seven_day resets_at (read from claude-rate-limits.json by the loader), else the rolling last 7 days.
    const days = Math.max(1, Math.min(30, Number(url.searchParams.get('days')) || 7));
    return json(res, 200, await cachedScorecard({ days, ttlMs: 60000, deployList: () => deployRunner.snapshot().deploys }));
  }
  if (req.method === 'GET' && p === '/api/vm') {
    return json(res, 200, health || await sampleHealth(HEALTH_DISKS));
  }
  if (req.method === 'GET' && p === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: lastSnapshots.size, port: PORT }));
    return;
  }

  // --- static ---
  if (req.method === 'GET') {
    await serveStatic(req, res, p);
    return;
  }

  res.writeHead(405); res.end('method not allowed');
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!originOk(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/ws/status') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      statusSubs.add(ws);
      if (leaseStore.peek()?.ok) ws.send(JSON.stringify(leasesPayload(leaseStore.peek())));
      if (latest) ws.send(JSON.stringify({ type: 'status', status: latest.status }));
      if (health) ws.send(JSON.stringify({ type: 'health', health }));
      ws.send(JSON.stringify({ type: 'deploys', deploys: deployRunner.snapshot() }));
      if (credits.peek()) ws.send(JSON.stringify({ type: 'credits', credits: credits.peek() }));
      if (quota.get().at) ws.send(JSON.stringify({ type: 'quota', quota: quota.get() }));
      ws.on('close', () => statusSubs.delete(ws));
      ws.on('message', () => {}); // no-op
    });
    return;
  }
  if (p.startsWith('/ws/')) {
    const session = decodeURIComponent(p.slice(4));
    wss.handleUpgrade(req, socket, head, (ws) => {
      let set = wsBySession.get(session);
      if (!set) { set = new Set(); wsBySession.set(session, set); }
      set.add(ws);
      // Send the cached snapshot on open so the pane is never blank.
      const send = (c) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'snapshot', session, pane: c.pane, cols: c.cols, rows: c.rows }));
      const cache = lastSnapshots.get(session);
      if (cache && cache.depth >= PANE_LINES) send(cache);
      else if (cache) {
        // The cached capture is the short background one: paint it at once, then the full history.
        send(cache);
        capturePane(session).then((pane) => send({ pane, cols: cache.cols, rows: cache.rows }), () => {});
      }
      else {
        capturePane(session).then((pane) => send({ pane }), () => {});
      }
      ws.on('close', () => {
        set.delete(ws);
        if (set.size === 0) wsBySession.delete(session);
      });
      ws.on('message', () => {});
    });
    return;
  }

  socket.destroy();
});

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function tick() {
  try {
    const { status, changedSessions } = await poll();
    for (const name of changedSessions) {
      const c = lastSnapshots.get(name);
      if (c) broadcast(name, { type: 'snapshot', session: name, pane: c.pane, cols: c.cols, rows: c.rows });
    }
    // Status: always (it is small); working timers etc. need fresh values.
    broadcastStatus({ type: 'status', status });
  } catch (err) {
    console.error('[poll]', err.message);
  }
}

async function leaseTick() {
  const v = await getLeases(true);
  if (v.ok) broadcastStatus(leasesPayload(v));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

server.listen(PORT, HOST, async () => {
  console.log(`[ghosty] listening on http://${HOST}:${PORT}`);
  try { console.log(`[ghosty] reporter token: ${await reporter.init()}`); } catch (e) { console.error('[ghosty] reporter token', e.message); }
  // The manager agent's own auto-answers and resumes are never the owner, so gate every
  // typed send with assertAgentPane first. A bash / sleep shell with old MiniMax JSON in
  // its scrollback would otherwise be mistaken for an agent (see agentFromText) — this
  // wrapper only consults the live process tree.
  const guardSendKey = async (session, key) => { await assertAgentPane(session, 'manager'); return sendKey(session, key); };
  const guardSendKeys = async (session, keys, enter) => { await assertAgentPane(session, 'manager'); return sendKeys(session, keys, enter); };
  await initManager({
    managerSessions: loadManagerSessions,
    credits: () => credits.peek(),
    onOwnerNeeded: (session, stall, reason) => notifySession(session, 'asks', [reason, stall.question || stall.case, stall.aiLine ? `AI ${stall.aiLine}` : null].filter(Boolean).join('\n'), { case: stall.case, question: stall.question || reason, answer: stall.aiLine, status: stall.status, info: stall.status ? stall.question : undefined }),
    context: (session) => ({ priority: sessionMeta.priority(session), quota: quotaLine(quota.get()), leases: leasesLine(leaseStore.peek()), deploys: deploysLine(deployRunner.snapshot()) }),
    sendKey: guardSendKey, sendKeys: guardSendKeys, paused: (n) => sessionMeta.isPaused(n),
    policy: (n, agent) => evaluatePolicy({ priority: sessionMeta.priority(n), agent, quota: quota.get(), now: Date.now(), config: policyConfig() }),
    heldStore: { get: (n) => sessionMeta.held(n), set: (n, h) => sessionMeta.setHeld(n, h) },
    onHold: (n, kind, reason) => alert(`${n}:${kind}`, {
      title: kind === 'hold' ? `${n} held: ${reason} (${sessionMeta.priority(n)})` : `${n} resumed`,
      body: kind === 'hold' ? 'continues when the quota recovers; Resume to override' : reason,
      priority: 'default', ntfyTags: kind === 'hold' ? 'pause_button' : 'arrow_forward', url: `/?s=${encodeURIComponent(n)}`, tag: `ghosty-hold-${n}`,
    }, 0),
    onHandoff: async (session, text, at) => { await handoffs.fromStop(session, text, at); },
  });
  console.log(`[ghosty] public dir: ${PUBLIC_DIR}`);
  // First poll, then on tick.
  await tick();
  setInterval(tick, TICK_MS);
  leaseTick();
  setInterval(leaseTick, 15000);
  setInterval(digestTick, 60000);   // digest tier: one push per 30 min while the owner is awake
  healthTick();
  setInterval(healthTick, HEALTH_MS);
  const usageTick = () => usage.get().catch(() => {});   // one small file read per 30 s keeps the status field cheap
  usageTick();
  setInterval(usageTick, 30000);
  const quotaTick = () => quota.poll().then(() => { reevaluateHolds(); latest = null; }).catch((e) => console.error('[quota]', e.message));
  quotaTick();
  deployRunner.start();
  await handoffs.load();
  leaseWatch.start();
  setInterval(() => handoffs.tick().catch((e) => console.error('[handoffs] tick', e.message)), 60000).unref?.();
  credits.start();
  // Jev circuit breaker (jev-breaker.js): the 3rd error in a row opens it (also when scripts/jev-ask.js was the caller). Announce once:
  // ONE alert (digest tier) + the jev:down event (the alert feeds the manager feed), and a jev:up event when it closes.
  const jevBreakerTick = () => jevBreaker.announce(({ kind, state }) => {
    if (kind === 'down') alert('jev:down', { title: 'Jev is down: the rules decide', body: `3 errors in a row (last: ${state.lastError || '?'}). Jev is not called except one probe every 10 min.`, priority: 'default', tier: 'digest', ntfyTags: 'warning', tag: 'ghosty-jev-down', url: '/' }, 0);
    else managerEvents.record({ key: 'jev:up', title: 'Jev is back', body: 'a Jev call succeeded again', priority: 'default' }).catch(() => {});
  });
  setInterval(jevBreakerTick, 15000).unref?.();
  startWakesLogger({ stateDir: STATE_DIR });   // keeps manager-wakes.jsonl current (it silently stopped 2026-10-04)
  setInterval(() => wakeOutcomeTick().catch((e) => console.error('[wake-outcome]', e.message)), 60000).unref?.();
  setInterval(quotaTick, 60000);
});

// Optional TLS listener — required for PWA install on most browsers.
// Set TLS_KEY / TLS_CERT (or drop PEM files in ./certs/) and we listen too.
let tlsServer = null;
if (existsSync(TLS_KEY) && existsSync(TLS_CERT)) {
  tlsServer = https.createServer(
    { key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) },
    server.emit.bind(server, 'request')  // share the HTTP handler
  );
  tlsServer.on('upgrade', server.emit.bind(server, 'upgrade'));
  tlsServer.listen(TLS_PORT, HOST, () => {
    console.log(`[ghosty] listening on https://${HOST}:${TLS_PORT}`);
  });
}

// Clean shutdown
for (const s of ['SIGINT', 'SIGTERM']) {
  process.on(s, () => {
    console.log(`[ghosty] ${s}, shutting down`);
    wss.clients.forEach((c) => c.close());
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}