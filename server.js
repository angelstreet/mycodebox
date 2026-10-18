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
//   GET  /api/voice/queue       → {items}: open needs-you stops + ledger asks, P0 first then oldest, each with a spoken `script` and options (voice.js)
//   POST /api/voice/answer      → {id, transcript?|option?, confirm?, pending?, via?}: map a spoken answer to an option of the still-open item and send it as by 'owner-voice'
//   GET  /api/voice/digest?minutes=60 → {text, parts}: deterministic spoken summary (<= 900 chars) of what happened
//   GET  /api/manager/log?limit → last stall / outcome records (stalls.jsonl)
//   GET  /api/manager/merge-decisions?limit=50 → newest journal lines first, kind merge only (alias; the journal is manager-decisions.jsonl + the round-7 merge-decisions.jsonl)
//   GET|POST /api/ready  → {device|host|session, minutes} open a hardware ready window ("ready for N minutes"); {clear: id|'all'} closes (ready-window.js)
//   GET  /api/manager/roundtrips?hours=24 → { summary, records } owner waits per class (owner-roundtrips.jsonl, roundtrips.js)
//   GET  /api/manager/decided?hours=24|since=<iso>&limit=100 → { items, summary }: everything the manager answered for the owner (decided.js, OWNER_DECISIONS §15)
//   POST /api/manager/decided/:id/revert {by?} → merge/push/deploy: sends the revert text to the session (409 unless it is stopped with no draft); other kinds: { draft }
//   GET  /api/manager/wakes?day=YYYY-MM-DD → {summary, wakes} per wake of the manager agent, from its Claude transcript (manager-wakes.js, cached 60 s)
//   GET  /api/leases/view       → the Leases view data: authority (legacy|central), leases (mode, holder, ttl, idle, heartbeat), tickets, deploys, shadow
//   POST /api/leases/owner/release | /owner/mode  {id[, mode:'pin']} → owner force-release / downgrade (central only; legacy: 409); logged with the owner's identity
//   GET  /api/leases/watch      → lease-watch snapshot: mode, holders {status live|ended|remote|unknown|system, plan}, unknown count
//   GET  /api/ci-watch          → ci-watch snapshot: mode, last verdict, action, red streak (ci-watch.js)
//   GET  /api/rules-watch       → rules-watch snapshot: sessions on outdated AGENTS.md, who was told (rules-watch.js)
//   GET  /api/done-check        → done-check snapshot: sessions whose STATUS done disagrees with git (done-check.js)
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
//   GET  /api/v2/tasks, /api/v2/tasks/:id → V2 task board (orchestration/http.js); GHOSTY_V2=1 only, else 404 and nothing is built
//   POST /api/v2/tasks          → create a task (run by the goal loop, orchestration/v2-runtime.js); POST /api/v2/tasks/:id/cancel | approve | deny
//   GET  /api/v2/ops/status|telemetry|incidents (read-only); POST /api/v2/ops/requests (request only, nothing executes)
//   GET  /*                     → static files in ./public

import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, stat, readdir, mkdir, open as openFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { homedir, hostname, loadavg, cpus } from 'node:os';
import { createLeaseStore, sshRun as leaseRun } from './leases.js';
import { createLeaseWatch } from './lease-watch.js';
import { createLeaseNudge } from './lease-nudge.js';
import { createLeaseService } from './lease-service.js';
import { createLeaseRoutes, PREFIX as LEASE_API } from './lease-routes.js';
import { createRemoteStops, PREFIX as REMOTE_API } from './remote-stops.js';
import * as managerApi from './manager.js';
import { createReadyStore } from './ready-window.js';
import { createLeaseSource, createSessionTracker, summarize as leaseSummary, createLiveness, pinOverrideNote, requestIdentity, eventRecord, eventNote, eventSession, isNoteEvent, noteAllowed, activeHolds } from './lease-source.js';
import { idleHoldEvent } from './lease-ask.js';
import { createCiWatch } from './ci-watch.js';
import { createRulesWatch } from './rules-watch.js';
import { createDoneCheck } from './done-check.js';
import { statusLine } from './stall.js';
import { machinesOf, holdingsOf, deployWaitOf, agentSession, agentSessionCandidates } from './public/platforms.js';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sampleHealth } from './health.js';
import { createPush, createAlerts, tierConfig, isQuietHours } from './push.js';
import { launchConfig, launchWarnings } from './launch-config.js';
import { trustFolder } from './trust.js';
import { sessionDirectory } from './session-directory.js';
import { createLayoutStore } from './layout.js';
import { createSessionMeta } from './session-meta.js';
import { createSessionHistory } from './session-history.js';
import { createHistoryView } from './history-view.js';
import { createQuota } from './quota.js';
import { createCredits } from './credits.js';
import { createUsage, usageFile } from './usage-view.js';
import { createTurnMeter, statusMeterLine } from './turn-meter.js';
import { evaluatePolicy } from './public/policy.js';
import { isPriority } from './public/prio.js';
import { createTts } from './tts.js';
import { publicLinks, loadAssetlinks } from './assetlinks.js';
import { revertPlan } from './decided.js';
import { initManager, logEvent, observe, forget as managerForget, prune as pruneManager, stallOf, autoOf, cancelAuto, todayCounts, managerConfig, setManagerConfig, labelStall, unlabelStall, logOwnerChoice, reviewDeck, triageOf, triageAction, aiSummary, jevAiTab, decisionsView, policyConfig, releaseHold, heldOf, reevaluateHolds, deployRunnerOn, wakeAnnotate, wakeOutcomeTick, LOG_FILE, jevBreaker, readJournal, decidedView, decidedItem, logRevert, decidedDigestTick, revertedIds, stillStopped, canType, countSent, roundtripsView, noteAnswerer } from './manager.js';
import { cachedScorecard } from './scorecard.js';
import { createDeployRunner, defaultRegistry as defaultDeployRegistry } from './deploy-runner.js';
import { quotaLine, leasesLine, deploysLine } from './triage.js';
import { createReporter, isLoopback, TOKEN_HEADER } from './reporter.js';
import { createClaudeIndex, claudeOfPane, minimaxOfPane, busyChildren, lastActivityOf, leasesOfSession, capView, createParking, readManualNotes, SESSION_CAP } from './parking.js';
import { actorOf, agentFromArgs, createAlertApi, DEFAULT_ACTOR, shouldRefuse } from './api-extras.js';
import { createManagerEvents, classifyKey, readActions } from './manager-events.js';
import { createHandoffs } from './handoffs.js';
import { createVptLockStore } from './vpt-locks.js';
import { appendRegret, readRegrets, effectiveRegrets, regretKey } from './regret.js';
import { createWakesView, startWakesLogger } from './manager-wakes.js';
import { wakeFacts, quotaPercents } from './wake-shadow.js';
import { createTranscriber, extFor, MAX_AUDIO } from './transcribe.js';
import { readOpenAsks } from './owner-asks.js';
import { createOwnJobs } from './own-jobs.js';
import { createMockups } from './mockups.js';
import { createVoice, feedActions, stopItem as voiceStopItem, decidedFor as voiceDecidedFor } from './voice.js';

const exec = promisify(execFile);
const PORT = Number(process.env.PORT || 7777);
const launch = launchConfig();
const HOST = launch.host;
for (const warning of launchWarnings()) console.warn(`[launch] ${warning}`);
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

let listOk = true;   // false after a tmux error other than "no server running" (an empty list is then not trusted)
async function listSessions() {
  const fmt = '#{session_name}|#{session_attached}|#{session_activity}|#{session_windows}|#{session_created}';
  let raw = '';
  try {
    ({ stdout: raw } = await exec(TMUX, ['list-sessions', '-F', fmt]));
  } catch (err) {
    listOk = /no server running/.test(err.stderr || '');
    if (!listOk) {
      console.error('[listSessions] failed:', err.code || err.message, 'stderr=', err.stderr || '');
    }
    return [];
  }
  listOk = true;
  const now = Math.floor(Date.now() / 1000);
  const sessions = raw.trim().split('\n').filter(Boolean).map((line) => {
    const [name, attached, activity, windows, created] = line.split('|');
    return {
      name,
      attached: Number(attached) > 0,
      windows: Number(windows) || 1,
      created: Number(created) || null,
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

// Pid of the shallowest agent process under a pane (same walk as agentFromTree), or null.
function agentPidFromTree(pid, table) {
  let level = [pid];
  const seen = new Set();
  for (let depth = 0; level.length && depth < 8; depth++) {
    const next = [];
    for (const p of level) {
      if (seen.has(p)) continue;
      seen.add(p);
      const a = table.args.get(p);
      if (a && agentFromArgs(a)) return p;
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
  // Always go through a tmux paste-buffer (QF-06). `send-keys -l` needs an
  // attached client on some tmux versions and the user hit "no current
  // client" with single-line text on codeboxv2. `paste-buffer` works without
  // one. Bracketed-paste mode (`-p`) keeps it as one chunk so Claude Code's
  // paste-detection still fires on multi-line prompts.
  const text = String(keys || '');
  if (text.length > 1_000_000) throw httpError(400, 'text too large (max 1MB)');
  const lines = text.split('\n');
  if (lines.length > 5000) throw httpError(400, 'too many lines (max 5000)');
  if (text.length) {
    const buf = `ghosty-send-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await exec(TMUX, ['set-buffer', '-b', buf, '--', text]);
    await exec(TMUX, ['paste-buffer', '-p', '-d', '-b', buf, '-t', tgt(session)]);
  }
  if (enter) {
    await new Promise((r) => setTimeout(r, lines.length > 1 || text.length > 200 ? 400 : 80));
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
  const v = leaseSource.peek();
  if (!v?.ok) return [];
  return holdingsOf(session, v.leases, deployRunner.snapshot().deploys, sessionNames, MACHINES).map(({ id, agent, ...r }) => r);
}
function deployWaitFor(session, sessionNames, stall) {
  const v = leaseSource.peek();
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
const LINKS = publicLinks();   // langfuse / https PUBLIC_URL for the UI, from env only
let assetlinks = null;         // /.well-known/assetlinks.json body from ANDROID_APP_* env or $STATE_DIR/assetlinks.json
loadAssetlinks(process.env, STATE_DIR).then((a) => {
  if (a?.error) console.warn(`[assetlinks] not served: ${a.error}`); else assetlinks = a;
}).catch(() => {});
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
const mockups = createMockups({
  file: join(STATE_DIR, 'mockups.jsonl'), push, tokenOk: (t) => reporter.tokenOk(t), windowMin: () => managerConfig().mockupWindowMin,
  send: async (session, text, by) => { await assertAgentPane(session, by); await sendKeys(session, text, true); logSend(session, by, { keys: text }); noteAnswerer(session, by, 'mockup'); },   // the same guarded send as every other owner send
});
const alertApi = createAlertApi({ alert, tokenOk: (t) => reporter.tokenOk(t) });
const sessionMeta = createSessionMeta({ file: join(STATE_DIR, 'sessions.json') });
const history = createSessionHistory({ file: join(STATE_DIR, 'session-history.jsonl'), missMs: 2 * Number(process.env.TICK_MS || 1000) });   // start/end log of sessions; open instances are rebuilt from the file at boot
const historyView = createHistoryView({ history, ledgerFile: join(STATE_DIR, 'usage-ledger.jsonl') });
const historyStarting = new Set();   // names being created right now: the tick must not record them as 'unknown'
const historyLog = (rec) => history.append(rec).catch((e) => console.error('[history]', e.message));   // history never breaks a session action
const layoutStore = createLayoutStore({ file: join(STATE_DIR, 'layout.json') });   // order / pins / groups of the session list
const turnMeter = createTurnMeter({ ledgerFile: join(STATE_DIR, 'usage-ledger.jsonl') });   // elapsed + tokens of a finished turn, shown with its STATUS line (turn-meter.js)
const usage = createUsage({ file: usageFile(process.env, STATE_DIR) });   // USAGE_SUMMARY overrides the path
// Lease authority (lease-source.js): manager.json `leaseAuthority` "legacy" (default: the registry over ssh) | "central" (the in-process lease service).
// Read once at boot: switching needs a restart, so one process never has two authorities.
const leaseAuthority = (() => { try { return JSON.parse(readFileSync(join(STATE_DIR, 'manager.json'), 'utf8')).leaseAuthority === 'central' ? 'central' : 'legacy'; } catch { return 'legacy'; } })();
// Liveness for the service: true / false for a codebox tmux session, undefined (never releases anything) when unknown: a failed tmux listing,
// no poll yet, or an agent that is not a codebox session. A re-created name is handled by the session tracker (sessionGone, immediate).
const leaseLiveness = createLiveness({ ready: () => listOk && !!latest?.status, resolve: (s) => agentSession(s, Object.keys(latest?.status || {}), MACHINES),
  maybe: (s) => agentSessionCandidates(s, Object.keys(latest?.status || {}), MACHINES).length > 0 });
// The central lease service (round 10) is always constructed: lease clients in shadow mode report to it even while the
// dashboard reads the legacy registry. `leaseAuthority` only decides which one the dashboard, the deploy runner and the
// manager trust. Unknown liveness (undefined) never releases anything.
const leaseService = createLeaseService({ dir: join(STATE_DIR, 'leases'), now: Date.now, sessions: { isAlive: leaseLiveness.isAlive, trackable: leaseLiveness.trackable },
  onEvent: (ev) => onLeaseEvent(ev).catch((e) => console.error('[lease] event', e.message)),
  config: { envs: (process.env.LEASE_ENVS || '').split(',').map((x) => x.trim()).filter(Boolean) } });
const leaseSource = createLeaseSource({ authority: leaseAuthority, legacy: { store: leaseStore, registry: defaultDeployRegistry() }, getService: () => leaseService });
const leaseTracker = createSessionTracker({ source: leaseSource });
const deployRunner = createDeployRunner({
  stateDir: STATE_DIR, alert, isEnabled: deployRunnerOn, registry: leaseSource.deployRegistry(), catchUp: leaseAuthority !== 'central',
  pollMs: Number(process.env.DEPLOY_POLL_MS || 30000), timeoutMs: Number(process.env.DEPLOY_TIMEOUT_MS || 45 * 60 * 1000),
  onChange: (d) => broadcastStatus({ type: 'deploys', deploys: d }),
});
// Lease <-> session binding (lease-watch.js): lease:* manager events, release of ended holders, narrow of idle server leases.
// manager.json key `leaseBind`: "live" (default) | "dry" (log what it would do) | "off".
const handoffs = createHandoffs({ file: join(STATE_DIR, 'handoffs.json'), machines: MACHINES, record: (e) => managerEvents.record(e), log: console });
const leaseWatch = createLeaseWatch({
  stateDir: STATE_DIR, run: leaseRun, machines: MACHINES, observeOnly: () => !leaseSource.acts(), listRows: () => leaseSource.get(true),
  listSessionNames: async () => (await listSessions()).map((x) => x.name),
  activityOf: (name) => reporter.activityOf(name),
  record: async (e) => { await handoffs.onLeaseEvent(e).catch((err) => console.error('[handoffs] lease event', err.message)); return managerEvents.record(e); },
  onChange: (snap) => { handoffs.onHolders(snap.holders).catch((err) => console.error('[handoffs] holders', err.message)); },
  mode: () => { try { const m = JSON.parse(readFileSync(managerConfigFile, 'utf8')).leaseBind; return m === 'dry' || m === 'off' ? m : 'live'; } catch { return 'live'; } },
});
// The orchestrator asks a holder to release or narrow (lease-nudge.js): every 2 min, for a queued deploy or ticket that waits > 10 min.
// manager.json key `leaseNudge`: "live" (default) | "dry" | "off". Never releases or narrows by itself.
const leaseNudge = createLeaseNudge({
  stateDir: STATE_DIR,
  getInputs: async () => ({ deploys: deployRunner.snapshot().deploys || [], view: await leaseSource.view(false) }),
  sessionOf: (agent) => agentSession(agent, Object.keys(latest?.status || {}), MACHINES),
  // the same signal as lease-watch: minutes since the session's last finished turn; a working session is never idle
  idleMinOf: (l, session) => {
    if (!session) return l.idleMin ?? null;
    const act = reporter.activityOf(session);
    if (!act) return null;
    if (act.working) return 0;
    const at = Math.max(act.turnAt || 0, act.promptAt || 0);
    return at ? Math.floor((Date.now() - at) / 60000) : null;
  },
  canSend: (session) => noteAllowed(latest?.status?.[session]),   // stopped on a finished turn, no draft, no menu
  send: async (session, text) => { await assertAgentPane(session, 'lease-nudge'); await sendKeys(session, text, true); logSend(session, 'lease-nudge', { keys: text }); },
  record: (e) => managerEvents.record(e),
  mode: () => { try { const m = JSON.parse(readFileSync(managerConfigFile, 'utf8')).leaseNudge; return m === 'dry' || m === 'off' ? m : 'live'; } catch { return 'live'; } },
});
// Events of the lease service (central): the feed, the handoffs, and a one-line note to a codebox session whose exclusive lease
// became a pin (or whose pin was overlapped). The note goes through the guarded send, by 'lease-service', only to a session that is
// stopped on a finished turn with nothing typed; otherwise the feed event is all there is.
async function onLeaseEvent(ev) {
  const rec = eventRecord(ev);
  if (rec) {
    if (/^lease:(?:released|expired|forced)$/.test(rec.key)) await handoffs.onLeaseEvent(rec).catch((err) => console.error('[handoffs] lease event', err.message));
    await managerEvents.record(rec);
  }
  if (/^pin[-_]overlap$/i.test(String(ev.kind || ''))) {   // the deploy log lists the pins a deploy overrode (lease just granted: look it up after the mutation)
    setTimeout(async () => { try { const v = await leaseSource.view(false); const n = pinOverrideNote(ev, v); if (n) await deployRunner.note(n.deployId, n.line); } catch (e) { console.error('[lease] pin note', e.message); } }, 100).unref?.();
  }
  if (!isNoteEvent(ev)) return;
  const names = Object.keys(latest?.status || {});
  const session = eventSession(ev, (a) => agentSession(a, names, MACHINES));
  const note = eventNote(ev);
  if (!session || !note || !noteAllowed(latest?.status?.[session])) return;
  try {
    await assertAgentPane(session, 'lease-service');
    await sendKeys(session, note, true);
    logSend(session, 'lease-service', { keys: note });
  } catch (e) { console.error('[lease] note', session, e.message); }
}
// A stop whose STATUS says waiting / blocked: central -> the service (it downgrades an exclusive hold); legacy -> a feed flag when the session holds one.
function onStopStatus(session, status, text = '') {
  if (leaseSource.authority() === 'central') { leaseSource.sessionStatus(session, status, text).catch(() => {}); return; }
  const names = Object.keys(latest?.status || {});
  const rows = (leaseSource.peek()?.leases || []).filter((l) => agentSession(l.agent, names, MACHINES) === session);
  const ev = idleHoldEvent({ session, status, rows });
  if (ev) managerEvents.record(ev).catch((err) => console.error('[lease] flag', err.message));
}
// CI watch (ci-watch.js): main red -> a fixer session (scripts/cbsession), nudged while idle, owner asked when stuck.
// manager.json key `ciWatch`: "live" (default) | "dry" | "off". Needs <stateDir>/ci-watch.json, else it stays idle.
const ciWatch = createCiWatch({
  stateDir: STATE_DIR,
  run: async (cmd, args) => (await exec(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: 120000 })).stdout,
  sessionState: async (name) => {
    const exists = await sessionExists(name);
    const live = exists ? await liveAgentOf(name) : null;
    // Claude reports turns through the plugin; MiniMax only shows on screen, so the dashboard's own state counts too.
    return { exists, alive: !!live, working: !!(live && (reporter.activityOf(name)?.working || latest?.status?.[name]?.state === 'working')) };
  },
  startSession: async ({ name, cwd, provider, model, promptFile }) => {
    if (await sessionExists(name)) await exec(TMUX, ['kill-session', '-t', `=${name}`]);   // only reached with no live agent in it
    await exec(join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'cbsession'), ['-n', name, '-d', cwd, '-p', provider, ...(model ? ['-m', model] : []), '-f', promptFile], { timeout: 180000 });
  },
  sendToSession: (name, text) => sendKeys(name, text),
  record: (e) => managerEvents.record(e),
  alert,
  mode: () => { try { const m = JSON.parse(readFileSync(managerConfigFile, 'utf8')).ciWatch; return m === 'dry' || m === 'off' ? m : 'live'; } catch { return 'live'; } },
});
// Load per core and RAM available %, for the watchers that message sessions (a message can wake a session into work).
function hostPressure() {
  const m = /MemTotal:\s+(\d+)[\s\S]*MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'));
  return { loadPerCore: loadavg()[0] / cpus().length, ramAvailPct: m ? (Number(m[2]) / Number(m[1])) * 100 : 100 };
}

// Done check (done-check.js): an idle session whose last STATUS is done is checked against git (commits not on main,
// uncommitted files); a mismatch is told once to the session and the feed. manager.json `doneCheck`: live | dry | off.
const doneCheck = createDoneCheck({
  stateDir: STATE_DIR,
  git: async (cwd, args) => (await exec('git', ['-C', cwd, ...args], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 })).stdout,
  listDone: async () => {
    const panes = await listPanes(), mgrs = new Set(loadManagerSessions()), out = [];
    for (const [name, p] of panes) {
      if (mgrs.has(name) || sessionMeta.isPaused(name) || p.dead || / \(deleted\)$/.test(p.cwd)) continue;
      const st = latest?.status?.[name];
      const ex = st?.stall?.excerpt;
      if (!ex || st.state === 'working' || statusLine(String(ex).split('\n'))?.kind !== 'done') continue;
      out.push({ name, cwd: p.cwd, text: String(ex).slice(-3000), working: !!reporter.activityOf(name)?.working });
    }
    return out;
  },
  send: (name, text) => sendKeys(name, text),
  pressure: hostPressure,
  record: (e) => managerEvents.record(e),
  mode: () => { try { const m = JSON.parse(readFileSync(managerConfigFile, 'utf8')).doneCheck; return m === 'dry' || m === 'off' ? m : 'live'; } catch { return 'live'; } },
});

// Rules watch (rules-watch.js): a session started before AGENTS.md last changed on its repo's origin/main is told once,
// while idle, to re-read it. manager.json key `rulesWatch`: "live" (default) | "dry" | "off".
const rulesWatch = createRulesWatch({
  stateDir: STATE_DIR,
  git: async (cwd, args) => (await exec('git', ['-C', cwd, ...args], { timeout: 60000 })).stdout,
  listTargets: async () => {
    const panes = await listPanes(), table = await processTable(), mgrs = new Set(loadManagerSessions());
    const pids = [...panes.values()].map((p) => agentPidFromTree(p.pid, table)).filter(Boolean);
    const age = new Map();
    if (pids.length) {
      try { for (const l of (await exec('ps', ['-o', 'pid=,etimes=', '-p', pids.join(',')])).stdout.split('\n')) { const m = l.trim().split(/\s+/); if (m.length === 2) age.set(Number(m[0]), Number(m[1])); } } catch {}
    }
    const out = [];
    for (const [name, p] of panes) {
      if (mgrs.has(name) || sessionMeta.isPaused(name) || p.dead || / \(deleted\)$/.test(p.cwd)) continue;
      const pid = agentPidFromTree(p.pid, table);
      if (!pid || !age.has(pid)) continue;
      out.push({ name, cwd: p.cwd, startedAt: Date.now() - age.get(pid) * 1000,
        working: !!(reporter.activityOf(name)?.working || latest?.status?.[name]?.state === 'working') });
    }
    return out;
  },
  send: (name, text) => sendKeys(name, text),
  pressure: hostPressure,
  record: (e) => managerEvents.record(e),
  mode: () => { try { const m = JSON.parse(readFileSync(managerConfigFile, 'utf8')).rulesWatch; return m === 'dry' || m === 'off' ? m : 'live'; } catch { return 'live'; } },
});
const credits = createCredits({ jevUrl: process.env.JEV_URL || '', apiKey: process.env.JEV_API_KEY || '', alert, onChange: (c) => broadcastStatus({ type: 'credits', credits: c }) });
const quota = createQuota({ alert, onChange: (q) => broadcastStatus({ type: 'quota', quota: q }) });

// The voice item of a session's open stop right now (voice.js), or null. Reads the manager's live view, not `latest` (notifySession runs mid-poll).
function voiceItemOf(session, kind, stateHint = null) {
  try {
    const state = stateHint ?? latest?.status?.[session]?.state ?? (kind === 'waiting' ? 'waiting' : 'done');
    return voiceStopItem(session, { state, stall: stallOf(session), triage: triageOf(session), auto: autoOf(session), lastActivitySec: 0 }, { mgrs: new Set(loadManagerSessions()), isPaused: (n) => sessionMeta.isPaused(n) });
  } catch { return null; }
}
// Debounced per session and kind, so a "done" never swallows a "needs you" that follows it.
function notifySession(session, kind, body, meta, stateHint = null) {
  if ((kind === 'waiting' || kind === 'asks') && loadManagerSessions().includes(session)) return;   // the manager's own session never pushes the owner
  const waiting = kind === 'waiting' || kind === 'asks';
  // The agent's STATUS verdict + what the turn took (elapsed, tokens) + its own info, first in the body so every cut keeps it.
  const lt = turnMeter.get(session);
  const turn = lt && meta?.status ? { ...lt, status: meta.status, info: meta.info ?? lt.info } : lt;
  const line = turn ? statusMeterLine(turn) : null;
  if (line) body = [line, body && !/^\s*[*_`]*STATUS:/i.test(String(body)) ? body : null].filter(Boolean).join('\n');   // a body that is the STATUS line itself is replaced by the metered one
  const vi = waiting ? voiceItemOf(session, kind, stateHint) : null;   // a stop the owner can answer by voice / from the notification buttons
  alert(`${session}:${kind}`, {
    ...(vi ? { voiceId: vi.id, actions: feedActions(vi) || undefined } : {}),
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

// The pane as far as activity goes: the MiniMax footer rotates a "Tip: …" hint every 30 s, which is not work
// (it flipped done sessions to working for WORKING_HOLD_MS every 30 s).
function activityText(pane) {
  return pane.replace(/ {2,}(?:\x1b\[[0-9;]*m)*Tip: [^\n]*/g, '');
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
    const act = offline ? null : activityText(pane);
    if (!offline) {
      changed = !prev || prev.pane !== pane || prev.cols !== p.cols || prev.rows !== p.rows;
      if (changed) {
        lastSnapshots.set(s.name, { pane, act, cols: p.cols, rows: p.rows, depth });
        changedSessions.push(s.name);
      }
    }
    const t = track.get(s.name) || { changeAt: 0, workingSince: null, lastWorkAt: 0, realWork: false, prevState: undefined, doneAt: null, ackFor: null, ackAt: null, reply: null, replyHash: null, contextLeft: null, model: null };
    // A change of capture depth (card opened/closed) or of window size (a card was fitted to the pane: the text only reflows) is not activity.
    const paneChanged = !!(changed && prev && prev.act !== act && prev.depth === depth && prev.cols === p.cols && prev.rows === p.rows);
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
        project: meta.project ?? null, cwd: meta.cwd || null, lastSendAt: sentAt, lastSendText: lastSendText.get(s.name) ?? null, now,
        rep: agent === 'claude' && reporter.liveOf(s.name) ? { turnStart: () => reporter.activityOf(s.name)?.promptAt || null, turnForStop: (since) => reporter.turnForStop(s.name, since), promptSince: (since) => reporter.promptSince(s.name, since) } : null });
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
  pruneManager(new Set([...Object.keys(status), ...remote.names()]));   // Mac sessions (mac:<name>) have no tmux pane: they are not pruned with the tmux list
  reporter.prune(new Set(Object.keys(status)));
  turnMeter.prune(new Set(Object.keys(status)));
  sessionMeta.sync(Object.keys(status));
  if (listOk) leaseTracker.observe(new Map(sessions.map((x) => [x.name, x.created]))).catch((e) => console.error('[lease] sessionGone', e.message));   // central: a vanished tmux session loses its leases
  if (listOk) {   // never judge sessions gone from a failed tmux listing
    const createdOf = new Map(sessions.map((x) => [x.name, x.created]));
    history.sync(new Map(Object.entries(status).map(([k, v]) => [k, { provider: v.agent ?? null, model: v.model ?? null, cwd: v.cwd ?? null, created: createdOf.get(k) ?? null }])), { skip: historyStarting })
      .catch((e) => console.error('[history] sync', e.message));
  }
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
  Object.assign(status, remote.statusRows());   // round 9: sessions of other machines, posted by the Mac Stop hook (remote-stops.js)
  for (const [k, v] of Object.entries(status)) { const rw = readyStore.chipFor(k, `${v.stall?.question || ''}\n${v.stall?.excerpt || ''}`); v.ready = rw && (rw.scope === 'session' || v.stall) ? rw : null; }   // round 9 item 8: the window covering this session, for the chip
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

const getLeases = (force) => leaseSource.get(force);
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
// raw request body (audio upload), capped
async function readRawBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { if (size - c.length <= max) reject(Object.assign(new Error('body too large'), { status: 413 })); chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => { if (size <= max) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
const transcriber = createTranscriber();
const MAX_IMAGE = 15 * 1024 * 1024;
// TTS (TASK-70 Part 1): piper renders wake briefs into WAV at <STATE_DIR>/tts/<hash>.wav (Q95=1,
// 14-day prune at boot). Frontend POSTs {text} with the URL hash; Q96=1 async+poll — POST returns 202
// immediately, GET /status polls until ready, GET /api/tts/<hash>.wav streams the file.
const TTS_CACHE_DIR = join(STATE_DIR, 'tts');
const tts = createTts({ cacheDir: TTS_CACHE_DIR });
// Long-prompt inputs: the client uploads text here when the dock input is bigger
// than the inline-paste threshold. Hash-keyed so identical content reuses one entry.
const INPUTS_DIR = join(STATE_DIR, 'inputs');
const ttsJobs = new Map();   // hash -> {state: 'pending'|'ready'|'failed', error?: string, at: number}
function ttsJobOf(hash) {
  const j = ttsJobs.get(hash);
  if (j) return j;
  // synthesize a job record from the cache file on disk (handles restarts / first-request races)
  const out = tts.cachePath(hash);
  const st = existsSync(out);
  return { state: st ? 'ready' : 'pending', at: Date.now() };
}
// /api/upload accepts images (png/jpeg/gif/webp) and .md files. The .md MIME types
// vary by OS and browser: macOS often sends text/plain, Linux text/x-markdown,
// recent browsers text/markdown. The filename check at the route covers text/plain.
const UPLOAD_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'text/markdown': 'md', 'text/x-markdown': 'md' };
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

// V2 task engine: opt-in (GHOSTY_V2=1). Off means nothing is imported or constructed: no store, no timers, no lease.
// On: orchestration/v2-runtime.js assembles the engine (one store handle for routes and goal loop) and starts the loop
// under the controller lease; another live controller -> routes stay read-only here.
const V2_ON = process.env.GHOSTY_V2 === '1';
let v2 = null;
if (V2_ON) {
  const { createV2Runtime } = await import('./orchestration/v2-runtime.js');
  v2 = await createV2Runtime({ stateDir: STATE_DIR, env: process.env, repoRoot: dirname(fileURLToPath(import.meta.url)),
    onRun: (r) => historyLog(r.event === 'start'
      ? { kind: 'session.started', name: r.name, provider: r.provider, model: r.model, cwd: r.cwd, started_by: 'v2', prompt_ref: null, handover_ref: null }
      : { kind: 'session.ended', name: r.name, reason: 'exited' }) });
  // The runtime cancels its workers on a graceful stop (v2-runtime stop()), so open v2 instances here belong to a previous process
  // that is gone (a hard crash may orphan a worker, which is then no longer tracked). The real end time is unknown: boot time is used.
  for (const i of history.instances()) if (i.end == null && i.started_by === 'v2') await historyLog({ kind: 'session.ended', name: i.name, reason: 'exited' });   // runs of a previous process are over
  v2.start().catch((e) => console.error(`[v2] start failed: ${e?.code || e?.message}`));
}

// ---------------------------------------------------------------------------
// Session lifecycle + directory picker
// ---------------------------------------------------------------------------

const HOME = homedir();
const NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const AGENT_CMDS = launch.commands;
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

async function tmuxCreated(name) {   // tmux #{session_created} (seconds), or null: tells a reused name from the same session
  try { const { stdout } = await exec(TMUX, ['display-message', '-p', '-t', `=${name}:`, '#{session_created}']); return Number(stdout.trim()) || null; } catch { return null; }
}

async function createSession({ name, agent, cwd, priority, model, prompt, handover }) {
  if (priority !== undefined && !isPriority(priority)) throw httpError(400, 'priority must be P0, P1 or P2');
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw httpError(400, 'invalid name (A-Z a-z 0-9 _ . -, max 40)');
  if (!Object.hasOwn(AGENT_CMDS, agent)) throw httpError(400, 'agent must be claude|codex|minimax|bash');
  const dir = await sessionDirectory(cwd || HOME, HOME);
  // tmux silently rewrites '.' and ':' in session names to '_'.
  const real = name.replace(/[.:]/g, '_');
  if (await sessionExists(real)) throw httpError(409, 'session already exists');
  historyStarting.add(real);
  try {
  try {
    await exec(TMUX, ['new-session', '-d', '-s', real, '-c', dir, '-x', '120', '-y', '40']);
  } catch (err) {
    throw httpError(/duplicate session/.test(err.stderr || '') ? 409 : 500, String(err.stderr || err.message).trim().slice(0, 200));
  }
  try { await trustFolder(agent, dir); } catch { /* best effort: the agent just asks */ }
  // Claude always gets Remote Control under the session name (owner, 2026-10-15), unless an AGENT_CMD_CLAUDE override sets it.
  const cmd = agent === 'claude' && AGENT_CMDS.claude && !/--remote-control\b/.test(AGENT_CMDS.claude)
    ? `${AGENT_CMDS.claude} --remote-control '${real}' -n '${real}'` : AGENT_CMDS[agent];
  if (cmd) {
    await exec(TMUX, ['send-keys', '-t', `=${real}:`, '-l', '--', cmd]);
    await exec(TMUX, ['send-keys', '-t', `=${real}:`, 'Enter']);
  }
  await historyLog({ kind: 'session.started', name: real, provider: agent, model: model ?? null, cwd: dir, started_by: 'dashboard', prompt_ref: prompt ?? null, handover_ref: handover ?? null, tmux_created: await tmuxCreated(real) });
  sessionMeta.reset(real);
  sessionMeta.sync([real]);   // a new session starts at P2 (or the chosen priority), not paused
  if (priority) sessionMeta.set(real, { priority });
  latest = null;
  } finally { historyStarting.delete(real); }
  return { ok: true, name: real, agent, cwd: dir, priority: sessionMeta.priority(real) };
}

async function killSession(name, confirm) {
  if (confirm !== name) throw httpError(400, 'confirm must equal the session name');
  if (!(await sessionExists(name))) throw httpError(404, 'no such session');
  await exec(TMUX, ['kill-session', '-t', `=${name}`]);
  if (history.openOf(name)) await historyLog({ kind: 'session.ended', name, reason: 'killed' });
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
    sendCtrlC: (name) => exec(TMUX, ['send-keys', '-t', `=${name}:`, 'C-c']),
    create: (name, cwd) => exec(TMUX, ['new-session', '-d', '-s', name, '-c', cwd, '-x', '120', '-y', '40']),
  },
});
const pidAlive = async (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function parkFacts(name) {
  if (!(await sessionExists(name))) throw httpError(404, 'no such session');
  const panes = await listPanes();
  const table = await processTable();
  const idx = await claudeIndex.get(true);
  const pane = panes.get(name);
  const claude = claudeOfPane(pane?.pid || 0, table, idx);
  // MiniMax (minimax-code / mcode) is the other agent we park; no session file, so cwd comes from the pane.
  const minimax = claude ? null : minimaxOfPane(pane?.pid || 0, table, pane?.cwd || HOME);
  const sess = (await listSessions()).find((x) => x.name === name);
  const st = (latest && latest.status[name]) || null;
  const lz = await getLeases(true);
  let leases = null;
  if (lz?.ok) leases = leasesOfSession(lz.leases, [name, claude?.info?.name || '']);
  let rssMb = null;
  const agentPid = claude?.pid || minimax?.pid;
  if (agentPid) { try { rssMb = Math.round(Number((await exec('ps', ['-o', 'rss=', '-p', String(agentPid)])).stdout.trim()) / 1024); } catch {} }
  const rw = reporter.detail(name);
  return {
    claude, minimax,
    state: st?.state || null, attached: !!sess?.attached, reporterWaiting: !!(rw && reporter.waitingNow(name, 0)),
    backgroundWork: rw?.lastTurn?.backgroundWork || 0,
    busy: claude ? busyChildren(claude.pid, table) : (minimax ? busyChildren(minimax.pid, table) : []),
    leases, rssMb, priority: sessionMeta.priority(name),
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
  // Claude entries have no `agent` field (legacy); MiniMax entries store agent: 'minimax'. Dispatch on that.
  const isMinimax = rec.agent === 'minimax';
  const base = isMinimax ? AGENT_CMDS.minimax : AGENT_CMDS.claude;
  const trustAgent = isMinimax ? 'minimax' : 'claude';
  const out = await parking.resume(name, {
    base,
    validate: async (r) => { r.cwd = await sessionDirectory(r.cwd, HOME); },
    start: async (n, r, cmd) => {
      try { await trustFolder(trustAgent, r.cwd); } catch { /* best effort */ }
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
  noteAnswerer(session, by);   // round 9: who answered, for owner-roundtrips.jsonl
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

async function handleHttp(req, res) {
  // Tight CORS — bound to Tailscale only anyway, but be explicit.
  res.setHeader('referrer-policy', 'no-referrer');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p.startsWith(REMOTE_API) && await remote.handle(req, res)) return;   // bearer-token API for the Mac Stop hook; own address and auth checks
  if (p.startsWith(LEASE_API) && await leaseRoutes.handle(req, res)) return;   // bearer-token API for lease clients; own address and auth checks

  if (req.method !== 'GET' && !originOk(req)) return json(res, 403, { ok: false, error: 'cross-origin request refused' });
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE'
      && req.method !== 'OPTIONS' && !/application\/json/i.test(req.headers['content-type'] || '')
      && !(p === '/api/transcribe' && /^audio\//i.test(req.headers['content-type'] || ''))
      && !(p === '/api/upload' && (/^image\//i.test(req.headers['content-type'] || '') || /^text\/(markdown|x-markdown|plain)$/i.test(req.headers['content-type'] || '')))) {   // image/* and text/markdown are not CORS-safelisted either
    return json(res, 415, { ok: false, error: 'content-type must be application/json' });
  }

  // --- V2 task routes (behind the Origin + JSON content-type checks above) ---
  if (p.startsWith('/api/v2/')) {
    if (!v2) return json(res, 404, { ok: false, error: 'V2 engine is off (set GHOSTY_V2=1)' });
    const r = await v2.http.handle({ method: req.method, pathname: p, readBody: () => readJsonBody(req) });
    if (r) return json(res, r.status, r.body);
    return json(res, 404, { ok: false, error: 'not found' });
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
  if (req.method === 'POST' && p === '/api/upload') {   // dock attach / paste / drop: image or .md body -> saved on the codebox -> { path }
    try {
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      let ext = UPLOAD_EXT[ct];
      // text/plain (macOS often sends this for .md) is treated as .md so the owner can
      // attach notes from TextEdit, Notes, etc. without a special picker filter.
      if (!ext && ct === 'text/plain') ext = 'md';
      if (!ext) return json(res, 415, { ok: false, error: 'png, jpeg, gif, webp images or .md files only' });
      const img = await readRawBody(req, MAX_IMAGE);
      if (!img.length) return json(res, 400, { ok: false, error: 'empty file' });
      const dir = join(homedir(), '.ghosty', 'uploads');
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`);
      await writeFile(file, img, { mode: 0o600 });
      return json(res, 200, { ok: true, path: file });
    } catch (err) { return json(res, err.status || 500, { ok: false, error: err.message }); }
  }
  if (req.method === 'POST' && p === '/api/transcribe') {   // dock mic: audio body -> { text }
    try {
      const audio = await readRawBody(req, MAX_AUDIO);
      if (!audio.length) return json(res, 400, { ok: false, error: 'empty recording' });
      const r = await transcriber.transcribe(audio, { ext: extFor(req.headers['content-type']), lang: url.searchParams.get('lang') || null });
      return json(res, 200, { ok: true, ...r });
    } catch (err) { return json(res, err.status || 500, { ok: false, error: err.message }); }
  }
  // ---- TTS (TASK-70 Part 1): wake brief -> piper -> MP3, async+poll ----
  // The body is JSON {text}; the URL hash must equal tts.hashText(text). If piper isn't installed
  // (no binary at PIPER_BIN / ~/.local/share/piper/piper) the render fails with ENOENT — the
  // frontend chip keeps the loading pulse until the status endpoint reports failed, and the owner
  // sees a clear error. Re-POST to retry after `scripts/install-piper.sh`.
  if (req.method === 'POST' && p.startsWith('/api/tts/') && !p.endsWith('/status') && !p.endsWith('.wav')) {
    const hash = decodeURIComponent(p.slice('/api/tts/'.length));
    try {
      const { text } = await readJsonBody(req);
      if (!text || typeof text !== 'string') return json(res, 400, { ok: false, error: 'text required' });
      const wantHash = tts.hashText(text);
      if (hash !== wantHash) return json(res, 400, { ok: false, error: `hash mismatch: URL=${hash}, text=${wantHash}` });
      const out = tts.cachePath(hash);
      // cache hit: file already rendered — return ready immediately
      if (existsSync(out) && statSync(out).size > 0) {
        ttsJobs.set(hash, { state: 'ready', at: Date.now() });
        return json(res, 200, { ok: true, hash, ready: true, url: `/api/tts/${hash}.wav` });
      }
      // kick off render in the background (Q96=1); the POST returns 202 immediately
      ttsJobs.set(hash, { state: 'pending', at: Date.now() });
      tts.render(text, hash).then((r) => {
        ttsJobs.set(hash, { state: 'ready', at: Date.now() });
        console.log(`[tts] ready ${hash}${r.cached ? ' (cached)' : ''}`);
      }).catch((err) => {
        ttsJobs.set(hash, { state: 'failed', error: err.message, at: Date.now() });
        console.error(`[tts] failed ${hash}: ${err.message}`);
      });
      return json(res, 202, { ok: true, hash, ready: false });
    } catch (err) { return json(res, err.status || 500, { ok: false, error: err.message }); }
  }
  if (req.method === 'GET' && p.startsWith('/api/tts/') && p.endsWith('/status')) {
    const hash = decodeURIComponent(p.slice('/api/tts/'.length, -'/status'.length));
    if (!/^[0-9a-f]{16,64}$/i.test(hash)) return json(res, 400, { ok: false, error: 'bad hash' });
    const j = ttsJobOf(hash);
    const body = { ok: true, hash, state: j.state };
    if (j.state === 'ready') body.url = `/api/tts/${hash}.wav`;
    if (j.state === 'failed') body.error = j.error || 'render failed';
    return json(res, 200, body);
  }
  if (req.method === 'GET' && p.startsWith('/api/tts/') && p.endsWith('.wav')) {
    const hash = decodeURIComponent(p.slice('/api/tts/'.length, -'.wav'.length));
    if (!/^[0-9a-f]{16,64}$/i.test(hash)) return json(res, 400, { ok: false, error: 'bad hash' });
    const out = tts.cachePath(hash);
    if (!existsSync(out)) return json(res, 404, { ok: false, error: 'not rendered yet' });
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': statSync(out).size, 'cache-control': 'public, max-age=86400' });
    createReadStream(out).on('error', () => { try { res.end(); } catch {} }).pipe(res);
    return;
  }
  // --- session history (session-history.js): cbsession reports its start here (loopback + reporter token); the rest is read-only ---
  if (req.method === 'POST' && p === '/api/history/started') {
    if (!isLoopback(req.socket.remoteAddress)) return json(res, 403, { ok: false, error: 'loopback only' });
    // A reverse proxy (Tailscale Serve) connects from 127.0.0.1 too: a proxied request is not a local caller.
    if (['x-forwarded-for', 'forwarded', 'tailscale-user-login'].some((h) => req.headers[h] !== undefined)) return json(res, 403, { ok: false, error: 'proxied requests refused' });
    if (!reporter.tokenOk(req.headers[TOKEN_HEADER])) return json(res, 401, { ok: false, error: 'bad token' });
    try {
      const { ts: _ts, tmux_created: _tc, ...b } = await readJsonBody(req);   // server time and tmux facts only, never the client's
      const r = await history.append({ ...b, kind: 'session.started', started_by: 'cbsession', tmux_created: typeof b.name === 'string' ? await tmuxCreated(b.name) : null });
      return json(res, 200, { ok: true, record: r });
    } catch (err) { return json(res, err instanceof SyntaxError || err instanceof TypeError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'GET' && p === '/api/history') {
    try { return json(res, 200, await historyView.list(Object.fromEntries(url.searchParams))); }
    catch (err) { return json(res, err.status || 500, { ok: false, error: err.message }); }
  }
  if (req.method === 'GET' && p.startsWith('/api/history/')) {
    let name; try { name = decodeURIComponent(p.slice('/api/history/'.length)); } catch { return json(res, 400, { ok: false, error: 'bad URL encoding' }); }
    const row = await historyView.detail(name, url.searchParams.get('start'));
    return row ? json(res, 200, { ok: true, session: row }) : json(res, 404, { ok: false, error: 'no such session in history' });
  }
  if (req.method === 'POST' && p === '/api/alert') {   // the manager agent's channel to the owner: loopback + reporter token
    try {
      const r = await alertApi.handle({ remoteAddress: req.socket.remoteAddress, headers: req.headers, readBody: () => readJsonBody(req) });
      return json(res, r.status, r.body);
    } catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'POST' && p === '/api/mockups') {   // a session posts a mockup to the owner's feed (loopback + reporter token)
    try {
      const r = await mockups.post({ remoteAddress: req.socket.remoteAddress, headers: req.headers, body: await readJsonBody(req) });
      return json(res, r.status, r.body);
    } catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  const mo = req.method === 'POST' ? /^\/api\/mockups\/([\w-]{1,40})\/object$/.exec(p) : null;
  if (mo) {   // the owner's "object" tap on a mockup in the feed: the session is told to wait for the owner's notes
    try {
      const b = await readJsonBody(req);
      const r = await mockups.object(mo[1], { by: actorOf(b || {}) });
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
    res.end(JSON.stringify({ sessions: r.sessions, status, links: LINKS }));
    return;
  }
  if (p.startsWith('/api/voice/')) {
    const r = await voice.route({ method: req.method, path: p, query: url.searchParams, readBody: () => readJsonBody(req) });
    if (r) return json(res, r.status, r.body);
  }
  if (req.method === 'GET' && p === '/api/owner-asks') {   // the manager's open questions for the owner (NEEDS YOU strip)
    return json(res, 200, { asks: await readOpenAsks(join(STATE_DIR, 'manager-owner-asks.jsonl')) });
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
  if (req.method === 'GET' && p === '/api/leases/view') {   // the Leases view: authority, held leases (mode, holder, ttl, idle), tickets, deploy queue, shadow disagreements
    const v = await leaseSource.view(true);
    const sessionNames = Object.keys(latest?.status || {});
    return json(res, 200, v.ok ? { ...v, hostname: hostname(), leases: v.leases.map((l) => ({ ...l, holderSession: agentSession(l.session || l.agent, sessionNames, MACHINES) || agentSession(l.agent, sessionNames, MACHINES) || null })), deploys: deployRunner.snapshot().deploys || v.deploys } : { ...v, authority: leaseSource.authority() });
  }
  if (req.method === 'POST' && (p === '/api/leases/owner/release' || p === '/api/leases/owner/mode')) {   // owner actions, central only (second tap is client-side); always by 'owner'
    let b;
    try { b = await readJsonBody(req); } catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
    const id = typeof b?.id === 'string' ? b.id.trim() : '';
    if (!id || id.length > 80) return json(res, 400, { ok: false, error: 'id required' });
    const identity = requestIdentity(req.headers);   // who really tapped: Serve's login, only when the request came through the proxy; else `loopback`
    const r = p.endsWith('/release') ? await leaseSource.ownerRelease(id, identity) : await leaseSource.ownerMode(id, b?.mode, identity);
    if (r.ok) { logEvent({ type: 'lease_owner_action', action: p.endsWith('/release') ? 'release' : 'mode', id, identity, ...(b?.mode ? { mode: String(b.mode).slice(0, 12) } : {}), by: 'owner' }); leaseTick(); }
    return json(res, r.ok ? 200 : r.status, r.ok ? { ok: true } : { ok: false, error: r.error });
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
  // Write a long prompt to a file and return its absolute path. The client
  // sends "Read /path" instead of pasting the whole body, so the chat log
  // shows one line instead of a 200-line paste. (chat-raised 2026-10-09)
  if (req.method === 'POST' && p === '/api/inputs') {
    try {
      const body = await readJsonBody(req);
      const text = String(body?.text || '');
      if (!text.trim()) return json(res, 400, { ok: false, error: 'text required' });
      if (text.length > 1_000_000) return json(res, 400, { ok: false, error: 'text too large (max 1MB)' });
      await mkdir(INPUTS_DIR, { recursive: true });
      const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
      const filePath = join(INPUTS_DIR, `${hash}.txt`);
      if (!existsSync(filePath)) await writeFile(filePath, text, { mode: 0o600 });
      const st = statSync(filePath);
      return json(res, 200, { ok: true, path: filePath, size: st.size, hash });
    } catch (err) {
      return json(res, err.status || 500, { ok: false, error: err.message });
    }
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
  if (req.method === 'GET' && p === '/api/manager/merge-decisions') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    return json(res, 200, { decisions: (await readJournal()).filter((r) => r.kind === 'merge').slice(-limit).reverse() });
  }
  if (req.method === 'GET' && p === '/api/manager/decided') {
    const q = url.searchParams;
    try { return json(res, 200, await decidedView({ hours: q.get('hours') || 24, since: q.get('since') || null, limit: q.get('limit') || 100 })); }
    catch (err) { return json(res, err.status || 500, { ok: false, error: err.message }); }
  }
  if (p === '/api/ready' && req.method === 'GET') return json(res, 200, { ok: true, windows: readyStore.list() });
  if (p === '/api/ready' && req.method === 'POST') {   // {device|host|session, minutes}: "ready for N minutes" (tap); no name = any session. {clear: <id>|'all'} closes windows
    try {
      const body = await readJsonBody(req);
      if (body.clear) return json(res, 200, { ok: true, cleared: readyStore.clear(String(body.clear)) });
      return json(res, 200, { ok: true, window: readyStore.set({ device: body.device, host: body.host, session: body.session, minutes: body.minutes, by: actorOf(body) }) });
    } catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'GET' && p === '/api/manager/roundtrips') {   // owner wait ledger (owner-roundtrips.jsonl): { hours, summary: { median_s, mean_s, byClass, text }, records }
    try { return json(res, 200, await roundtripsView({ hours: url.searchParams.get('hours') || 24 })); }
    catch (err) { return json(res, err.status || 500, { ok: false, error: err.message }); }
  }
  const rv = req.method === 'POST' && /^\/api\/manager\/decided\/([^/]+)\/revert$/.exec(p);
  if (rv) {
    try {
      const id = decodeURIComponent(rv[1]);
      const b = await readJsonBody(req);
      const by = actorOf(b || {});
      const item = await decidedItem(id);
      const exists = item ? await sessionExists(item.session) : false;
      const st = exists && ['merge', 'push', 'deploy'].includes(item.kind) ? (await poll()).status?.[item.session] : null;
      const plan = revertPlan(item, { exists, state: st?.state ?? null, draft: !!st?.stall?.draft, menu: (st?.stall?.options?.length || 0) > 0, reverted: item ? (await revertedIds()).has(id) : false });
      if (plan.error) throw httpError(plan.status, plan.error);
      if (plan.draft) return json(res, 200, { ok: true, draft: plan.draft, label: plan.label, session: item.session });
      await assertAgentPane(item.session, by);   // the same guarded send path as every other owner send
      await sendKeys(item.session, plan.send, true);
      logSend(item.session, by, { keys: plan.send });
      await logRevert({ id, session: item.session, by });
      return json(res, 200, { ok: true, sent: true, session: item.session, text: plan.send });
    } catch (err) { return json(res, err instanceof SyntaxError ? 400 : (err.status || 500), { ok: false, error: err.message }); }
  }
  if (req.method === 'GET' && p === '/api/manager/events') {   // tail of manager-events.jsonl (newest last); a freshly-started manager agent catches up
    const q = url.searchParams;
    const since = q.get('since') || '';
    const limit = Math.min(2000, Math.max(1, Number(q.get('limit')) || 50));
    return json(res, 200, { events: await managerEvents.tail({ since, limit }) });
  }
  if (req.method === 'GET' && p === '/api/done-check') return json(res, 200, doneCheck.snapshot());   // sessions whose STATUS done disagrees with git
  if (req.method === 'GET' && p === '/api/rules-watch') return json(res, 200, rulesWatch.snapshot());   // sessions on outdated rules, and who was told
  if (req.method === 'GET' && p === '/api/ci-watch') return json(res, 200, ciWatch.snapshot());   // last verdict, action and red streak
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
  if (req.method === 'GET' && p === '/.well-known/assetlinks.json') {
    if (!assetlinks) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.end(assetlinks.json);
    return;
  }
  if (req.method === 'GET') {
    await serveStatic(req, res, p);
    return;
  }

  res.writeHead(405); res.end('method not allowed');
}
// A handler that throws (a malformed %-escape in a path, a bug) must answer, never crash the process.
// Hands-free loop (voice.js): the queue / answer / digest router. Sends go through the guarded send (agent panes only) as 'owner-voice'.
async function readTailLines(file, bytes = 2_000_000) {
  try {
    const fh = await openFile(file, 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();   // a cut first line
      return lines.flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
    } finally { await fh.close(); }
  } catch { return []; }
}
const readyStore = createReadyStore({ file: join(STATE_DIR, 'ready-windows.json') });   // round 9 item 8: "ready for N minutes" windows
const voice = createVoice({
  status: async () => ((latest && Date.now() - latest.at < 1500) ? latest : await poll()).status,
  ownerAsks: () => readOpenAsks(join(STATE_DIR, 'manager-owner-asks.jsonl')),
  managerSessions: loadManagerSessions,
  isPaused: (n) => sessionMeta.isPaused(n),
  priority: (n) => sessionMeta.priority(n),
  send: async ({ session, answer, by }) => {
    if (!(await sessionExists(session))) throw httpError(404, 'no such session');
    await assertAgentPane(session, by);
    const out = answer.key != null ? await sendKey(session, String(answer.key)) : await sendKeys(session, answer.text || '', true);
    logSend(session, by, answer.key != null ? { key: answer.key } : { keys: answer.text });
    return out;
  },
  logChoice: logOwnerChoice,
  setReady: async ({ minutes, device, session, by }) => readyStore.set({ minutes, device, session, by }),   // voice: "ready for 30 minutes [on <device>]"
  leaseView: () => leaseSource.view(false),
  digestSources: async ({ since, minutes }) => {   // decided-for-you is read in-process (manager.js decidedView), never over HTTP
    const [stalls, hist, decided] = await Promise.all([
      readTailLines(LOG_FILE),
      historyView.list({ limit: 200 }).catch(() => ({ sessions: [] })),
      voiceDecidedFor(decidedView, { since, minutes, now: Date.now() }),
    ]);
    return { stalls, history: hist.sessions || [], decided, deploys: deployRunner.snapshot().deploys || [], quota: quota.get() };
  },
});

const leaseRoutes = createLeaseRoutes({ service: leaseService, dir: join(STATE_DIR, 'leases'),
  viaServe: (req) => ['x-forwarded-for', 'forwarded'].some((h) => req.headers[h] !== undefined) });   // same proxy test as requestIdentity: only a Serve-proxied request may name a tailnet login

const remote = createRemoteStops({ manager: managerApi, dir: join(STATE_DIR, 'leases'), stateDir: STATE_DIR,
  viaServe: (req) => ['x-forwarded-for', 'forwarded'].some((h) => req.headers[h] !== undefined) });   // POST /api/remote/v1/stops from the Mac Stop hook (token of a `remote` client)

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    console.error('[http]', req.method, String(req.url).slice(0, 80), err?.message);
    if (!res.headersSent) { try { json(res, err instanceof URIError ? 400 : 500, { ok: false, error: err instanceof URIError ? 'bad URL encoding' : 'internal error' }); } catch { /* socket gone */ } }
    else res.end();
  });
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
      if (leaseSource.peek()?.ok) ws.send(JSON.stringify(leasesPayload(leaseSource.peek())));
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

// Central: a codebox session that is working (or just finished a turn) is driving what it holds: tell the service, so the idle clock does not run.
async function leaseActivityTick() {
  const names = Object.keys(latest?.status || {});
  const view = leaseSource.peekView();
  if (!view?.ok) return;
  const by = activeHolds({ leases: view.leases, sessionOf: (l) => agentSession(l.session || l.agent, names, MACHINES) || agentSession(l.agent, names, MACHINES), activityOf: (n) => reporter.activityOf(n), now: Date.now() });
  for (const session of by.keys()) await leaseSource.activity(session);   // the lease's own session string
}
async function leaseTick() {
  const v = await getLeases(true);
  if (leaseSource.authority() === 'central') leaseActivityTick().catch((e) => console.error('[lease] activity', e.message));
  if (v.ok) broadcastStatus(leasesPayload(v));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

server.listen(PORT, HOST, async () => {
  console.log(`[ghosty] listening on http://${HOST}:${PORT}`);
  // TTS prune (Q95=1): 14-day keep matching daily-checks.json. Runs once at boot; the cache is
  // tiny (one MP3 per unique wake brief) so the IO is cheap. Errors are non-fatal — piper not
  // installed yet (scripts/install-piper.sh) just means future renders will fail with ENOENT.
  try {
    const r = await tts.prune();
    if (r.removed) console.log(`[tts] pruned ${r.removed} stale mp3 file${r.removed === 1 ? '' : 's'} from ${TTS_CACHE_DIR}`);
  } catch (e) { console.error('[tts] prune', e.message); }
  try { console.log(`[ghosty] reporter token: ${await reporter.init()}`); } catch (e) { console.error('[ghosty] reporter token', e.message); }
  // The manager agent's own auto-answers and resumes are never the owner, so gate every
  // typed send with assertAgentPane first. A bash / sleep shell with old MiniMax JSON in
  // its scrollback would otherwise be mistaken for an agent (see agentFromText) — this
  // wrapper only consults the live process tree.
  const guardSendKey = async (session, key, stopId) => { if (remote.owns(session)) return remote.deliverKey(session, key, stopId); await assertAgentPane(session, 'manager'); return sendKey(session, key); };   // a mac: session is answered through the hook's long-poll
  const guardSendKeys = async (session, keys, enter, stopId) => { if (stopId === undefined) noteAnswerer(session, 'own-job'); /* the manager's answers pass their stop id; a send without one is a harness wake (own-jobs): the manager, not the owner */ if (remote.owns(session)) return remote.deliver(session, keys, stopId); await assertAgentPane(session, 'manager'); return sendKeys(session, keys, enter); };
  // Sessions waiting on a job of their own (STATUS blocked / waiting on a pid, log, run id or deploy id) are woken when it ends. The send goes through
  // the same guarded sendKeys: it pastes the text, waits, then sends Enter as a second tmux call.
  const ownJobs = createOwnJobs({
    table: processTable,
    agentPid: async (name) => { const p = (await listPanes()).get(name); return p?.pid ? agentPidFromTree(p.pid, await processTable()) : null; },
    startedAt: async (pids) => { const m = new Map(); try { for (const l of (await exec('ps', ['-o', 'pid=,etimes=', '-p', pids.join(',')])).stdout.split('\n')) { const x = l.trim().split(/\s+/); if (x.length === 2) m.set(Number(x[0]), Date.now() - Number(x[1]) * 1000); } } catch {} return m; },
    deployState: (id) => { const d = (deployRunner.snapshot().deploys || []).find((x) => String(x.id) === String(id)); return d ? { state: d.state, finished: d.finished ? d.finished * (d.finished < 1e12 ? 1000 : 1) : null } : null; },
    stillWaiting: stillStopped, canSend: canType,
    send: async (name, text) => { await guardSendKeys(name, text, true); countSent(name); },   // a wake counts in the session's hourly cap
    record: (e) => managerEvents.record(e),
    log: (r) => logEvent(r),
  });
  setInterval(() => ownJobs.tick().catch((e) => console.error('[own-jobs] tick', e.message)), 20000).unref?.();
  await initManager({
    ownJobs,
    managerSessions: loadManagerSessions,
    credits: () => credits.peek(),
    onOwnerNeeded: (session, stall, reason, state) => notifySession(session, 'asks', [reason, stall.question || stall.case, stall.aiLine ? `AI ${stall.aiLine}` : null].filter(Boolean).join('\n'), { case: stall.case, question: stall.question || reason, answer: stall.aiLine, status: stall.status, info: stall.status ? stall.question : undefined }, state),
    context: (session) => ({ priority: sessionMeta.priority(session), quota: quotaLine(quota.get()), leases: leasesLine(leaseSource.peek()), deploys: deploysLine(deployRunner.snapshot()) }),
    sendKey: guardSendKey, sendKeys: guardSendKeys, paused: (n) => sessionMeta.isPaused(n),
    policy: (n, agent) => evaluatePolicy({ priority: sessionMeta.priority(n), agent, quota: quota.get(), now: Date.now(), config: policyConfig() }),
    heldStore: { get: (n) => sessionMeta.held(n), set: (n, h) => sessionMeta.setHeld(n, h) },
    onHold: (n, kind, reason) => alert(`${n}:${kind}`, {
      title: kind === 'hold' ? `${n} held: ${reason} (${sessionMeta.priority(n)})` : `${n} resumed`,
      body: kind === 'hold' ? 'continues when the quota recovers; Resume to override' : reason,
      priority: 'default', ntfyTags: kind === 'hold' ? 'pause_button' : 'arrow_forward', url: `/?s=${encodeURIComponent(n)}`, tag: `ghosty-hold-${n}`,
    }, 0),
    onHandoff: async (session, text, at) => { await handoffs.fromStop(session, text, at); },
    onMergeCancelled: (session, r) => push.record({ title: `Merge reply not sent: ${session}`, body: String(r.reason).slice(0, 300), url: `/?s=${encodeURIComponent(session)}`, tag: 'merge-decision' }),
    // a merge the manager decided or escalated: a notice in the owner's feed (no push)
    onMergeDecision: (session, r) => {
      const kind = r.kind === 'push' || r.kind === 'deploy' ? r.kind : 'merge', yes = r.chosen === kind, Kind = kind[0].toUpperCase() + kind.slice(1);
      const what = kind === 'merge' ? `${r.branch} -> ${r.target}` : kind === 'push' ? `${r.branch} -> origin/${r.dest}` : `${r.ref} -> ${r.env} (${r.scope})`;
      const undo = kind === 'merge' ? 'Revert: git revert -m 1 <merge sha>' : kind === 'push' ? 'Revert: git revert the pushed commits' : String(r.rollback || '');
      push.record({ title: `${Kind} ${yes ? 'approved (reply pending)' : 'escalated'}: ${session}`, body: `${what}: ${yes ? r.rationale : (r.reasons || []).join('; ') || r.rationale}${yes && undo ? ` ${undo}` : ''}`,
        url: `/?s=${encodeURIComponent(session)}`, tag: 'merge-decision' });
    },
    decideContext: () => { const snap = deployRunner.snapshot(); return { deploys: snap, leases: leaseSource.peek(), envs: snap.envs || [] }; },
    // one feed item per day: pushed (notify = record + wake) while the owner is awake, only recorded in quiet hours
    onDigest: ({ count, text }) => {
      const item = { title: `Decided for you today: ${count}`, body: text, url: '/?decided=1', tag: 'decided-digest' };
      if (isQuietHours(Date.now(), pushTierConfig())) push.record(item); else push.notify(item).catch((e) => console.error('[decided-digest] push', e.message));
    },
    onNotice: (body) => push.record({ title: 'Autonomy on', body, url: '/', tag: 'autonomy' }),
    readyStore,   // ready windows: the manager answers a hardware-step ask while one covers the session
    leaseView: () => leaseSource.view(true),   // the manager answers a lease question from this (lease-ask.js), never escalates it
    onStatus: onStopStatus,
    // a lease or deploy stop is a manager item: one feed event for the manager agent, no owner push (ops-ask.js)
    onManagerItem: (it) => {
      const key = it.kind === 'deploy' ? `deploy:${String(it.id || 'ask').replace(/[^\w-]/g, '').slice(0, 24)}:manager-item` : 'lease:manager-item';
      managerEvents.record({ key, title: `${it.session}: ${it.kind} stop for the manager`, body: `${it.session} ${it.case === 'waiting_deploy' ? 'waits for a deploy' : 'asks'}: ${it.question || it.reason}`.slice(0, 300), url: `/?s=${encodeURIComponent(it.session)}`, priority: 'default', session: it.session })
        .catch((e) => console.error('[manager-item]', e.message));
    },
  });
  console.log(`[ghosty] public dir: ${PUBLIC_DIR}`);
  // First poll, then on tick.
  await tick();
  setInterval(tick, TICK_MS);
  leaseTick();
  setInterval(leaseTick, 15000);
  setInterval(() => leaseService.tick().catch((e) => console.error('[lease-service] tick', e.message)), 5000).unref?.();
  setInterval(digestTick, 60000);   // digest tier: one push per 30 min while the owner is awake
  setInterval(() => decidedDigestTick().catch((e) => console.error('[decided-digest]', e.message)), 60000).unref?.();   // "Decided for you today", once a day
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
  leaseNudge.start();
  ciWatch.start();
  rulesWatch.start();
  doneCheck.start();
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
  process.on(s, async () => {
    console.log(`[ghosty] ${s}, shutting down`);
    wss.clients.forEach((c) => c.close());
    // V2 on: stop scheduling and release the V2 controller lease first (bounded), so a restart takes over at once.
    if (v2) await v2.stop({ timeoutMs: 5000 }).catch((e) => console.error(`[v2] stop: ${e?.code || e?.message}`));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}