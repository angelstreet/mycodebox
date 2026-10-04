// Ghosty Sessions — server
// Streams tmux panes for every Claude/Codex session on codebox over WebSocket.
// Bound to :7777 on Tailscale only. No public DNS, no auth prompt.
//
// Routes
//   GET  /api/sessions          → list tmux sessions + status pill
//   GET  /ws/:session           → WebSocket: streams pane content (1 Hz tick)
//   POST /api/send/:session     → body {keys: "..."} → tmux send-keys + Enter
//   GET  /api/snapshot/:session → last full pane snapshot (for first paint)
//   GET  /api/sessions?full=1   → same, plus `reply` text per session
//   GET  /api/reply/:session    → {reply, replyHash}: agent's last reply block, plain text
//   POST /api/resize/:session   → {cols, rows} resize a detached session's window
//   POST /api/sessions          → {name, agent, cwd, priority?} create a tmux session + start the agent
//   DELETE /api/sessions/:name?confirm=<name> → kill session
//   GET  /api/manager           → AI manager config (auto-answer settings, disabled sessions, Jev budget, today counts)
//   POST /api/manager           → {enabled?, autoSend?, autoCases?, minConfidence?, delayMs?, maxPerSessionPerHour?}
//                                 global settings, {session, sessionEnabled} per session
//   POST /api/manager/cancel/:s → cancel the pending auto answer of a session
//   POST /api/manager/label     → {id, label: no_reason|legit|wrong_case, note?, correctCase?} owner label on a stall
//   POST /api/manager/triage    → {id, action: sent|edited|dismissed} what the owner did with the AI reviewer's proposal (dismissed hides it)
//   POST /api/manager/unlabel   → {id} withdraw the newest label of a stall (swipe page undo)
//   GET  /api/manager/review?limit → unlabelled stops, newest first, + counts (the swipe page, /?review=1)
//   GET  /api/manager/log?limit → last stall / outcome records (stalls.jsonl)
//   POST /api/session-meta/:s   → {priority:'P0'|'P1'|'P2'} and/or {paused:bool} (pause = Esc once + hold; resume = "continue")
//   GET  /api/deploys           → deploy queue + recent (registry on proxmox), {enabled, running, lastRef}; pushed on /ws/status as {type:'deploys'}
//   POST /api/deploys/:id/approve | /cancel → owner action on a queued request
//   GET  /api/deploys/:id/log?tail=200      → the runner's log of that deploy (text)
//   (the runner itself only starts deploys when manager.json has deployRunner:true, see deploy-runner.js)
//   POST /api/reporter/event    → ghosty-reporter plugin events; loopback peers + x-ghosty-reporter-token (state dir reporter.token) only
//   GET  /api/reporter/:session → latest reported turn / prompt / waiting / agents of a session
//   GET  /api/quota             → plan windows (codex / claude / minimax); also pushed on /ws/status
//   GET  /api/usage             → usage-summary.json (API-equivalent cost / tokens) + `sessions` {name:{todayCost, days[14]}} for live sessions; 404 when absent
//   GET  /api/vm                → codebox health: cpu %, load vs cores, RAM, disks (also pushed on /ws/status)
//   GET  /api/dirs              → candidate working dirs (repos / worktrees / pane cwds)
//   POST /api/send-many         → {sessions:[...], keys|key} fan-out send
//   GET  /*                     → static files in ./public

import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import { spawn, execFile } from 'node:child_process';
import { readFile, stat, readdir, realpath } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sampleHealth } from './health.js';
import { createPush, createAlerts } from './push.js';
import { createSessionMeta } from './session-meta.js';
import { createQuota } from './quota.js';
import { createUsage, usageFile } from './usage-view.js';
import { evaluatePolicy } from './public/policy.js';
import { isPriority } from './public/prio.js';
import { initManager, logEvent, observe, forget as managerForget, prune as pruneManager, stallOf, autoOf, cancelAuto, todayCounts, managerConfig, setManagerConfig, labelStall, unlabelStall, reviewDeck, triageOf, triageAction, aiSummary, policyConfig, releaseHold, heldOf, reevaluateHolds, deployRunnerOn, LOG_FILE } from './manager.js';
import { createDeployRunner } from './deploy-runner.js';
import { quotaLine, leasesLine, deploysLine } from './triage.js';
import { createReporter, isLoopback, TOKEN_HEADER } from './reporter.js';

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
  try {
    const { stdout } = await exec('ps', ['-eo', 'pid=,ppid=,args='], { maxBuffer: 16 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]), ppid = Number(m[2]);
      args.set(pid, m[3]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
  } catch {}
  return { children, args };
}

const AGENT_BINS = [
  [/^claude(?:-code)?$/, 'claude', 'claude'],
  [/^codex(?:-cli)?$/, 'codex', 'codex'],
  [/^minimax-code$/, 'minimax', 'minimax-code'],
  [/^mcode$/, 'minimax', 'mcode'],
];
const WRAPPERS = new Set(['node', 'nodejs', 'bun', 'python', 'python3', 'bash', 'sh', 'env']);

function agentFromArgs(argline) {
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

// Breadth-first walk under pane pid; shallowest agent process wins.
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
  // Split on \n so a multi-line paste works.
  const lines = String(keys || '').split('\n');
  if (lines.length > 200) throw httpError(400, 'too many lines (max 200)');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length) {
      await exec(TMUX, ['send-keys', '-t', tgt(session), '-l', '--', line]);
    }
    if (enter || i < lines.length - 1) await exec(TMUX, ['send-keys', '-t', tgt(session), 'Enter']);
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

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const GENERIC_BRANCH = new Set(['main', 'master', 'dev', 'develop', 'head', 'trunk']);
function leaseFor(session, branch) {
  const leases = leaseCache.value?.ok ? leaseCache.value.leases : null;
  if (!leases || !leases.length) return null;
  const keys = [norm(session)];
  if (branch && !GENERIC_BRANCH.has(branch.toLowerCase())) keys.push(norm(branch));
  const hits = leases.filter((l) => {
    const a = norm(l.agent);
    return a && keys.some((k) => k.length >= 3 && a.includes(k));
  });
  if (!hits.length) return null;
  const l = hits[0];
  return { resource: l.resource, env: l.env, ttlLeftMin: l.ttlLeftMin, count: hits.length };
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
const { alert, resetDebounce } = createAlerts({ push, ntfyTopic: NTFY_TOPIC, ntfyUrl: NTFY_URL, publicUrl: PUBLIC_URL, defaultDebounceMs: NTFY_DEBOUNCE_MS });

const reporter = createReporter({ stateDir: STATE_DIR });   // events from the ghosty-reporter Claude Code plugin (claude-plugin/)
const sessionMeta = createSessionMeta({ file: join(STATE_DIR, 'sessions.json') });
const usage = createUsage({ file: usageFile(process.env, STATE_DIR) });   // USAGE_SUMMARY overrides the path
const deployRunner = createDeployRunner({
  stateDir: STATE_DIR, alert, isEnabled: deployRunnerOn,
  pollMs: Number(process.env.DEPLOY_POLL_MS || 30000), timeoutMs: Number(process.env.DEPLOY_TIMEOUT_MS || 45 * 60 * 1000),
  onChange: (d) => broadcastStatus({ type: 'deploys', deploys: d }),
});
const quota = createQuota({ alert, onChange: (q) => broadcastStatus({ type: 'quota', quota: q }) });

// Debounced per session and kind, so a "done" never swallows a "needs you" that follows it.
function notifySession(session, kind, body) {
  const waiting = kind === 'waiting' || kind === 'asks';
  alert(`${session}:${kind}`, {
    title: kind === 'asks' ? `${session} asks you` : waiting ? `${session} needs you` : `${session} is done`,
    priority: waiting ? 'high' : 'default',
    ntfyTags: waiting ? 'warning' : 'white_check_mark',
    body: body || kind,
    url: `/?s=${encodeURIComponent(session)}`,
    tag: `ghosty-${session}`,
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
  const status = {};
  const changedSessions = [];
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
      lastActivitySec: s.lastActivitySec,
      lastSendAt: sentAt,
      lastSendAck: sentAt && t.ackFor === sentAt ? t.ackAt : null,
      workingSinceMs: t.workingSince,
      doneAt: state === 'done' ? t.doneAt : null,
      activity: state === 'working' && !offline ? activityOf(plain, end) : null,
      lastMessage,
      replyHash: t.replyHash,
      cwd: meta.cwd, repo: meta.repo, branch: meta.branch, dirty: meta.dirty,
      project: meta.project ?? null, github: !!meta.github, worktree: meta.worktree ?? null,
      contextLeft: t.contextLeft, model: t.model,
      lease: leaseFor(s.name, meta.branch),
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
  sessionMeta.sync(Object.keys(status));
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

let leaseCache = { at: 0, value: null };
function parseTtl(s) {
  let min = 0;
  const h = s.match(/(\d+)h/), m = s.match(/(\d+)m/);
  if (h) min += Number(h[1]) * 60;
  if (m) min += Number(m[1]);
  if (!h && !m && /^\d+$/.test(s)) min = Number(s);
  return min;
}
function parseLeases(out) {
  const leases = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{6,})\s+(\S+)\s+(.*)$/i);
    if (!m) continue;
    const [env, ...rest] = m[2].split('/');
    const kv = (k) => (m[3].match(new RegExp(`${k}=(\\S+)`)) || [])[1] || '';
    const purpose = (m[3].match(/purpose=(.*)$/) || [])[1] || '';
    leases.push({
      id: m[1], env, resource: rest.join('/') || '*',
      agent: kv('agent'), purpose: purpose.trim(),
      ttlLeftMin: parseTtl(kv('expires_in')),
    });
  }
  return leases;
}
async function getLeases() {
  if (leaseCache.value && Date.now() - leaseCache.at < 15000) return leaseCache.value;
  let value;
  try {
    const { stdout } = await exec('ssh', ['-o', 'ConnectTimeout=3', '-o', 'BatchMode=yes', 'proxmox', '~/bin/vpt-lease list'], { timeout: 8000 });
    value = { ok: true, leases: parseLeases(stdout) };
  } catch (err) {
    value = { ok: false, error: String(err.stderr || err.message).trim().slice(0, 200) };
  }
  leaseCache = { at: Date.now(), value };
  return value;
}

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
  claude:  process.env.AGENT_CMD_CLAUDE  ?? 'claude',
  codex:   process.env.AGENT_CMD_CODEX   ?? 'codex',
  minimax: process.env.AGENT_CMD_MINIMAX ?? 'minimax-code',
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

// Owner settings of one session: { priority } and / or { paused }.
// paused:true  -> hold first (so the manager stops at once), then Escape once.
// paused:false -> release, then "continue" + Enter.
async function setSessionMeta(session, body) {
  if (!(await sessionExists(session))) throw httpError(404, 'no such session');
  sessionMeta.sync([session]);
  const changed = sessionMeta.set(session, body || {});
  const released = body?.paused === false && releaseHold(session);   // Resume also clears the manager's quota hold
  if (changed.paused === true) {
    cancelAuto(session, 'paused by owner');
    logEvent({ type: 'pause', session, by: 'owner' });
    try { await sendKey(session, 'Escape'); }
    catch (e) { sessionMeta.set(session, { paused: false }); throw e; }
  } else if (changed.paused === false) {
    logEvent({ type: 'resume', session, by: 'owner' });
    await sendKeys(session, 'continue', true);
  } else if (released) {
    await sendKeys(session, 'continue', true);
  }
  latest = null;
  return { ok: true, session, priority: sessionMeta.priority(session), paused: sessionMeta.isPaused(session), held: heldOf(session), changed };
}

async function sendMany(sessions, payload) {
  if (!Array.isArray(sessions) || !sessions.length || sessions.length > 50) throw httpError(400, 'sessions must be a non-empty array (max 50)');
  if (payload.key === undefined && typeof payload.keys !== 'string') throw httpError(400, 'keys (string) or key required');
  const list = [...new Set(sessions.map(String))];
  const results = new Array(list.length);
  await pool(list.map((session, idx) => ({ session, idx })), 4, async ({ session, idx }) => {
    try {
      if (!(await sessionExists(session))) { results[idx] = { session, ok: false, error: 'no such session' }; return; }
      const out = payload.key !== undefined
        ? await sendKey(session, String(payload.key))
        : await sendKeys(session, payload.keys, payload.enter !== false);
      results[idx] = { session, ...out };
    } catch (err) {
      results[idx] = { session, ok: false, error: err.stderr ? String(err.stderr).trim().slice(0, 120) : err.message };
    }
  });
  return { ok: results.every((r) => r.ok), results };
}

// Candidate working dirs: repos + their worktrees under $HOME (depth <= 3), plus live pane cwds.
let dirsCache = { at: 0, value: null };
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

async function collectDirs() {
  if (dirsCache.value && Date.now() - dirsCache.at < 60000) return dirsCache.value;
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
    list.push({ path, name: basename(path), branch: g.branch, mtime });
  });
  list.sort((a, b) => b.mtime - a.mtime);
  const value = list.map(({ path, name, branch }) => ({ path, name, branch }));
  dirsCache = { at: Date.now(), value };
  return value;
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
  if (req.method === 'POST' && p === '/api/reporter/event') {
    if (!isLoopback(req.socket.remoteAddress)) return json(res, 403, { ok: false, error: 'loopback only' });
    if (!reporter.tokenOk(req.headers[TOKEN_HEADER])) return json(res, 401, { ok: false, error: 'bad token' });
    try { return json(res, 200, reporter.ingest(await readJsonBody(req))); }
    catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
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
  if (req.method === 'GET' && p === '/api/leases') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(await getLeases()));
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
      if (!(await sessionExists(session))) throw httpError(404, 'no such session');
      const out = payload.key !== undefined
        ? await sendKey(session, String(payload.key))
        : await sendKeys(session, payload.keys || '', payload.enter !== false);
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
  if (req.method === 'DELETE' && p.startsWith('/api/sessions/')) {
    try { return json(res, 200, await killSession(decodeURIComponent(p.slice('/api/sessions/'.length)), url.searchParams.get('confirm'))); }
    catch (err) { return json(res, err.status || 500, { ok: false, error: err.message }); }
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
      const r = await deployRunner.act(dm[1], dm[2]);
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
  if (req.method === 'POST' && p === '/api/manager/unlabel') {
    try { return json(res, 200, { ok: true, unlabel: await unlabelStall(await readJsonBody(req)) }); }
    catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
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
      if (leaseCache.value?.ok) ws.send(JSON.stringify({ type: 'leases', leases: leaseCache.value.leases }));
      if (latest) ws.send(JSON.stringify({ type: 'status', status: latest.status }));
      if (health) ws.send(JSON.stringify({ type: 'health', health }));
      ws.send(JSON.stringify({ type: 'deploys', deploys: deployRunner.snapshot() }));
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
  leaseCache.at = 0; // force refresh
  const v = await getLeases();
  if (v.ok) broadcastStatus({ type: 'leases', leases: v.leases });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

server.listen(PORT, HOST, async () => {
  console.log(`[ghosty] listening on http://${HOST}:${PORT}`);
  try { console.log(`[ghosty] reporter token: ${await reporter.init()}`); } catch (e) { console.error('[ghosty] reporter token', e.message); }
  await initManager({
    onOwnerNeeded: (session, stall, reason) => notifySession(session, 'asks', [reason, stall.question || stall.case, stall.aiLine ? `AI ${stall.aiLine}` : null].filter(Boolean).join('\n')),
    context: (session) => ({ priority: sessionMeta.priority(session), quota: quotaLine(quota.get()), leases: leasesLine(leaseCache.value), deploys: deploysLine(deployRunner.snapshot()) }),
    sendKey, sendKeys, paused: (n) => sessionMeta.isPaused(n),
    policy: (n, agent) => evaluatePolicy({ priority: sessionMeta.priority(n), agent, quota: quota.get(), now: Date.now(), config: policyConfig() }),
    heldStore: { get: (n) => sessionMeta.held(n), set: (n, h) => sessionMeta.setHeld(n, h) },
    onHold: (n, kind, reason) => alert(`${n}:${kind}`, {
      title: kind === 'hold' ? `${n} held: ${reason} (${sessionMeta.priority(n)})` : `${n} resumed`,
      body: kind === 'hold' ? 'continues when the quota recovers; Resume to override' : reason,
      priority: 'default', ntfyTags: kind === 'hold' ? 'pause_button' : 'arrow_forward', url: `/?s=${encodeURIComponent(n)}`, tag: `ghosty-hold-${n}`,
    }, 0),
  });
  console.log(`[ghosty] public dir: ${PUBLIC_DIR}`);
  // First poll, then on tick.
  await tick();
  setInterval(tick, TICK_MS);
  leaseTick();
  setInterval(leaseTick, 15000);
  healthTick();
  setInterval(healthTick, HEALTH_MS);
  const usageTick = () => usage.get().catch(() => {});   // one small file read per 30 s keeps the status field cheap
  usageTick();
  setInterval(usageTick, 30000);
  const quotaTick = () => quota.poll().then(() => { reevaluateHolds(); latest = null; }).catch((e) => console.error('[quota]', e.message));
  quotaTick();
  deployRunner.start();
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