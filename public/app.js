// Ghosty Sessions — app.js
// Mobile-first dev cockpit over tmux: card | grid | board, plus send dock.
// State-first UI: every session shows agent, state (working / needs you /
// idle / offline) and elapsed time. Custom names live in localStorage.

import { byPriority, PRIORITIES, DEFAULT_PRIORITY } from '/prio.js';
import { suggestAgent } from '/policy.js';
import { deriveButtons, needsOwner, lastQuestion } from '/buttons.js';
import { deployedView, targetLabel } from '/deployed.js';
import { chipModel, platformsView, machinesOf, holdingsOf } from '/platforms.js';
import { fmtTok, fmtUsd, sessionRows, topEntries, dayBars, summaryFresh } from '/usage.js';

const $  = (q) => document.querySelector(q);
const $$ = (q) => Array.from(document.querySelectorAll(q));

const els = {
  topbar:      $('#topbar'),
  appTitle:    $('#appTitle'),
  summary:     $('#summary'),
  attention:   $('#attention'),
  health:      $('#health'),
  quota:       $('#quota'),
  tabs:        $('#tabs'),
  main:        $('#main'),
  cardPane:    $('#cardPane'),
  gridPane:    $('#gridPane'),
  listPane:    $('#listPane'),
  dock:        $('#dock'),
  keys:        $('#keys'),
  sendInput:   $('#sendInput'),
  sendBtn:     $('#sendBtn'),
  side:        $('#side'),
  sessionList: $('#sessionList'),
  sessionCount:$('#sessionCount'),
  refreshBtn:  $('#refreshBtn'),
  menuBtn:     $('#menuBtn'),
  backBtn:     $('#backBtn'),
  notifyBtn:   $('#notifyBtn'),
  mgrBtn:      $('#mgrBtn'),
  usageBtn:    $('#usageBtn'),
  edgeSwipe:   $('#edgeSwipe'),
  gridSizes:   $('#gridSizes'),
  toast:       $('#toast'),
  installBtn:  $('#installBtn'),
  filterBtn:   $('#filterBtn'),
  filterBar:   $('#filterBar'),
};

const state = {
  sessions:   [],
  status:     {},
  statusAt:   Date.now(),       // when state.status was received (for local elapsed ticking)
  active:     null,
  mode:       'grid',           // card | grid | list
  prevMode:   'grid',           // where the back arrow returns to
  gridSize:   4,                // 2 | 4 | 6 | 9 | 16 (all)
  filter:     null,             // null | 'waiting' | 'working'
  ws:        new Map(),
  statusWs:  null,
  terms:     new Map(),
  paneText:  new Map(),         // session -> latest ANSI text
  rename:    {},                // tmux session name -> custom display name
  sentAt:    {},                // session -> ms epoch of last send from this device
  prevState: {},                // session -> last seen state (for transition alerts)
  leases:    null,
  deploys:   null,              // {ok, error, enabled, deploys[], running, lastRef} from the registry via the runner
  notify:    false,
  pushOn:    false,
  toastTimer:null,
  side:      false,
  installPrompt: null,
};

// ---------- localStorage ----------
const LS_RENAMES = 'ghosty.renames';
const LS_GRID    = 'ghosty.gridSize';
const LS_MODE    = 'ghosty.mode';
const LS_ORDER   = 'ghosty.order';
const LS_NOTIFY  = 'ghosty.notify';
const GRID_SIZES = [2, 4, 8, 16];

function lsGet(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

function loadRenames() {
  try { state.rename = JSON.parse(lsGet(LS_RENAMES, '{}')) || {}; }
  catch { state.rename = {}; }
}
function saveRenames() { lsSet(LS_RENAMES, JSON.stringify(state.rename)); }
function customFor(name) { return state.rename[name] || ''; }
function displayName(name) { return customFor(name) || name; }

function loadOrder() {
  try { state.order = JSON.parse(lsGet(LS_ORDER, '[]')) || []; } catch { state.order = []; }
}
function loadPrefs() {
  loadOrder();
  const g = Number(lsGet(LS_GRID, 4));
  // old saved sizes (6 / 9) map to the nearest current one
  state.gridSize = GRID_SIZES.includes(g) ? g : (g > 4 ? 8 : 4);
  const m = lsGet(LS_MODE, 'grid');
  state.mode = ['card', 'grid', 'list'].includes(m) ? m : 'grid';
  state.notify = lsGet(LS_NOTIFY, '0') === '1';
}

// ---------- utilities ----------
function toast(msg, ms=1800) {
  els.toast.textContent = msg;
  els.toast.classList.add('on');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.remove('on'), ms);
}

function stateOf(name) {
  return state.status[name]?.state || 'offline';
}
const prioOf = (n) => state.status[n]?.priority || DEFAULT_PRIORITY;
const pausedOf = (n) => !!state.status[n]?.paused;
const heldOf = (n) => (state.status[n]?.paused ? null : state.status[n]?.held || null);   // the manager's quota hold
// Pill text for the owner's pause or the manager's hold, '' when neither.
const holdPill = (n) => (pausedOf(n) ? 'paused' : heldOf(n) ? 'held: quota' : '');
const prioBadgeHtml = (n) => `<button class="prio ${prioOf(n)}" data-prio="${escapeHtml(n)}" aria-label="Priority ${prioOf(n)}, tap to change" title="Priority ${prioOf(n)}">${prioOf(n)}</button>`;
// Visual state: a session blocked on a deploy shows purple ('deploy'); a live needs-you prompt always wins.
function vstateOf(name) {
  const s = stateOf(name);
  return state.status[name]?.deployWait && s !== 'waiting' && s !== 'offline' ? 'deploy' : s;
}
const deployWaitTip = (name) => state.status[name]?.deployWait?.text || '';
const STATE_RANK = { waiting: 0, deploy: 1, done: 2, working: 3, idle: 4, offline: 5 };
const STATE_LABEL = { working: 'working', waiting: 'needs you', done: 'done', idle: 'idle', offline: 'offline' };
const isPhone = () => window.matchMedia('(max-width: 720px)').matches;

function agentOf(name) {
  const st = state.status[name] || {};
  if (st.agent) return st.agent;
  // fallback for the old server: guess from pane_current_command
  const cmd = (st.cmd || state.sessions.find((s) => s.name === name)?.cmd || '').toLowerCase();
  if (cmd.includes('claude')) return 'claude';
  if (cmd.includes('codex'))  return 'codex';
  if (cmd.includes('minimax') || cmd.includes('mcode')) return 'minimax';
  return 'bash';
}
const AGENT_LABEL = { claude: 'claude', codex: 'codex', minimax: 'minimax', bash: 'bash', other: 'sh' };

function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60)    return `${sec}s`;
  if (sec < 3600)  return `${Math.floor(sec/60)}m${String(sec%60).padStart(2,'0')}s`;
  if (sec < 86400) return `${Math.floor(sec/3600)}h${String(Math.floor(sec%3600/60)).padStart(2,'0')}m`;
  return `${Math.floor(sec/86400)}d`;
}

// Compact duration for 'done 12m'.
function fmtShort(sec) {
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60)    return `${sec}s`;
  if (sec < 3600)  return `${Math.floor(sec/60)}m`;
  if (sec < 86400) return `${Math.floor(sec/3600)}h`;
  return `${Math.floor(sec/86400)}d`;
}

// Text for the state badge, including elapsed time.
//   working  → time since the last command was sent (or since it started working)
//   waiting  → how long it has been waiting on you
//   idle     → time since last output
// card / board badge: the pulsing dot already says "working", so show only the elapsed time
function badgeText(name) { return stateText(name).replace(/^working ?/, ''); }
function stateText(name) {
  const st = state.status[name] || {};
  const s = stateOf(name);
  if (vstateOf(name) === 'deploy') return '\u23f3 waiting deploy';
  const now = Date.now();
  const drift = (now - state.statusAt) / 1000;
  if (s === 'working') {
    const sent = Math.max(st.lastSendAt || 0, state.sentAt[name] || 0);
    const from = (sent && (!st.workingSinceMs || sent <= st.workingSinceMs + 5000)) ? sent : st.workingSinceMs;
    return from ? `working ${fmtDur((now - from) / 1000)}` : 'working';
  }
  const idleFor = (st.lastActivitySec ?? 0) + drift;
  if (s === 'done') return `done ${fmtShort(st.doneAt ? (now - st.doneAt) / 1000 : idleFor)}`;
  if (s === 'waiting') return `needs you ${fmtDur(idleFor)}`;
  if (s === 'idle')    return `idle ${fmtDur(idleFor)}`;
  return 'offline';
}

function stateBadgeHtml(name) {
  const s = vstateOf(name);
  const tip = s === 'deploy' ? ` data-wd="${escapeHtml(state.status[name].deployWait.id || '')}" title="${escapeHtml(deployWaitTip(name))}"` : '';
  return `<span class="state ${s}"${tip}><i class="dot ${s}"></i><span class="st">${escapeHtml(badgeText(name))}</span></span>`;
}
function agentBadgeHtml(name) {
  const a = agentOf(name);
  const m = (state.status[name] || {}).model;
  return `<span class="agent ${a}">${AGENT_LABEL[a] || a}</span>${m ? `<span class="agent-model"> · ${escapeHtml(m)}</span>` : ''}${reporterMarkHtml(name)}`;
}

// ⚡ = the ghosty-reporter plugin is live in this Claude session (exact answers / prompts, subagents). The
// tooltip lists the subagents: count and statuses.
function reporterMarkHtml(name) {
  const r = (state.status[name] || {}).reporter;
  if (!r) return '';
  const subs = (r.agentList || []).map((x) => `${x.type || 'agent'} (${x.status})${x.description ? ': ' + x.description : ''}`);
  const tip = ['reporter live', r.agents && r.agents.count ? `${r.agents.count} subagent${r.agents.count === 1 ? '' : 's'}: ${Object.entries(r.agents.by).map(([k, v]) => `${v} ${k}`).join(', ')}` : 'no subagents', r.backgroundWork ? `${r.backgroundWork} background task${r.backgroundWork === 1 ? '' : 's'} running` : '', ...subs].filter(Boolean).join('\n');
  const n = r.agents && r.agents.count ? `<sup>${r.agents.count}</sup>` : '';
  return `<span class="rp" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip.split('\n')[0])}">&#9889;${n}</span>`;
}

// Strip ANSI control sequences.
function stripAnsi(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')   // CSI
    .replace(/\x1b\][^\x07]*\x07/g, '')        // OSC
    .replace(/\x1b[()][A-Za-z0-9]/g, '')       // charset
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// Last meaningful line of a pane, for the board view: what the agent last
// said. Cuts off the input box (the last pair of ──── rules) and the footer
// below it, then skips spinners / timing / hint lines.
const RULE_RE  = /^\s*[─━═]{8,}/;
const CHROME_RE = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║>❯›$#%·•\-_=]*$/;
const NOISE_RE = /^\s*(?:[✻✶✳✢·*]\s+\S+ for \d|└ Completed in|⎿\s*$)|Message · Enter send|^\s*(?:⎿\s*)?Tip:|for shortcuts|bypass permissions|Context \d+% left|esc to interrupt|Update installed|\/clear to save|^\s*\/rc\s*$/i;
function lastLine(paneText) {
  const lines = stripAnsi(paneText).split('\n');
  let end = lines.length;
  for (let i = lines.length - 1, seen = 0; i >= 0 && i >= lines.length - 14; i--) {
    if (RULE_RE.test(lines[i]) && ++seen === 2) { end = i; break; }
  }
  for (let i = end - 1; i >= 0; i--) {
    const l = lines[i].replace(/[│┃]/g, ' ').trim();
    if (l && !CHROME_RE.test(l) && !NOISE_RE.test(l)) {
      return l.replace(/^[⏺●•]\s*/, '').replace(/\s{2,}/g, ' ').slice(0, 200);
    }
  }
  return '';
}

// ---------- xterm setup ----------
const FONT_MIN = 8, FONT_MAX = 20;
const FONT_FAMILY = "'JetBrains Mono', monospace";
const LS_FONT = 'ghosty.font', LS_FIT = 'ghosty.fit', LS_CTRL = 'ghosty.cardctl';
const clampFont = (n) => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
state.font = clampFont(Number(lsGet(LS_FONT, 0)) || (matchMedia('(max-width: 720px)').matches ? 11 : 12));
state.fit = lsGet(LS_FIT, '1') !== '0';
state.cardCtl = lsGet(LS_CTRL, '1') !== '0';
document.body.classList.toggle('no-cardctl', !state.cardCtl);
function setCardCtl(on) {
  state.cardCtl = on;
  lsSet(LS_CTRL, on ? '1' : '0');
  document.body.classList.toggle('no-cardctl', !on);
  $('#ctlToggle')?.classList.toggle('on', on);
}
document.documentElement.style.setProperty('--tf', String(state.font));

function getTerm(session) {
  let entry = state.terms.get(session);
  if (entry) return entry;
  const term = new Terminal({
    fontFamily: FONT_FAMILY,
    fontSize: state.font,
    lineHeight: 1.2,
    cursorBlink: false,
    cursorStyle: 'bar',
    convertEol: true,
    scrollback: 1000,
    disableStdin: true,
    allowProposedApi: true,
    theme: {
      background: '#0f1014', foreground: '#e6e8ee', cursor: '#6ed1c0',
      cursorAccent:'#0f1014', selectionBackground: 'rgba(232,154,74,0.25)',
      black:'#0f1014', red:'#ff7a7a', green:'#4ec07a', yellow:'#e89a4a',
      blue:'#7aa7ff', magenta:'#c08cf0', cyan:'#6ed1c0', white:'#e6e8ee',
      brightBlack:'#5f6571', brightRed:'#ff9a9a', brightGreen:'#7ed99a',
      brightYellow:'#ffc4a0', brightBlue:'#9ab1ff', brightMagenta:'#d4adff',
      brightCyan:'#9adcd0', brightWhite:'#ffffff',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  entry = { term, fit, host: null, ro: null, lastPane: null, cols: 0, rows: 0, paneCols: 0, paneRows: 0, laidOut: '', reqKey: '', reqTimer: 0, noFit: false };
  state.terms.set(session, entry);
  return entry;
}

// One global font for every xterm. The xterm grid is always the tmux pane's
// cols (so hard-wrapped agent output lines up); rows follow the host. When the
// session may be resized we ask tmux to match the host (scheduleFit); otherwise
// the host scrolls horizontally if the pane is wider than the card.
// Returns true if the grid dimensions changed (=> content must be rewritten,
// since reflow is lossy).
function layoutTerm(session) {
  const entry = state.terms.get(session);
  if (!entry || !entry.host || !entry.term.element || !entry.host.isConnected) return false;
  const { term, fit, host } = entry;
  const w = host.clientWidth, h = host.clientHeight;
  if (w < 20 || h < 20) return false;
  if (term.options.fontSize !== state.font) term.options.fontSize = state.font;
  let p = null;
  try { p = fit.proposeDimensions(); } catch {}
  const cols = entry.paneCols || state.status?.[session]?.cols || (p && p.cols) || 80;
  const scrollX = !!(p && cols > p.cols);
  // a horizontal scrollbar eats one row of the host
  const rows = Math.max(2, ((p && p.rows) || term.rows) - (scrollX ? 1 : 0));
  entry.fitCols = p ? p.cols : 0; entry.fitRows = p ? p.rows : 0;
  host.style.overflowY = 'hidden';
  host.style.overflowX = scrollX ? 'auto' : 'hidden';
  scheduleFit(session);
  const key = `${cols}x${rows}`;
  if (term.cols === cols && term.rows === rows) { entry.laidOut = key; return false; }
  try { term.resize(cols, rows); } catch { return false; }
  entry.laidOut = key;
  return true;
}

// Ask the server to resize the (detached) tmux window to what fits the host.
function scheduleFit(session) {
  const entry = state.terms.get(session);
  if (!entry) return;
  clearTimeout(entry.reqTimer);
  if (!state.fit || entry.noFit) return;
  entry.reqTimer = setTimeout(() => sendFit(session), 400);
}
async function sendFit(session) {
  const entry = state.terms.get(session);
  const st = state.status?.[session];
  if (!entry || !st || !state.fit || document.hidden) return;
  if (st.attached) { entry.noFit = true; return; }
  const { host } = entry;
  if (!host || !host.isConnected || host.clientWidth < 20 || host.clientHeight < 20) return;
  const r = host.getBoundingClientRect();
  if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return;
  if (!entry.fitCols || !entry.fitRows) return;
  const cols = Math.max(20, Math.min(400, entry.fitCols)), rows = Math.max(5, Math.min(200, entry.fitRows));
  const key = `${cols}x${rows}`;
  if (cols === st.cols && rows === st.rows) { entry.reqKey = key; return; }
  if (entry.reqKey === key) return;
  entry.reqKey = key;
  try {
    const res = await fetch(`/api/resize/${encodeURIComponent(session)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cols, rows }),
    });
    if (res.status === 409) entry.noFit = true;
    else if (!res.ok) setTimeout(() => { if (entry.reqKey === key) entry.reqKey = ''; }, 15000);
  } catch { entry.reqKey = ''; }
}

// Several views/devices can show one session at different sizes. Each client
// asks once per size, so a later resize from elsewhere would stick. Re-claim
// the size whenever the user actually interacts with this client: window
// focus, coming back to the tab, or touching a card.
function refit(name) {
  const e = state.terms.get(name);
  if (!e) return;
  e.reqKey = '';
  scheduleFit(name);
}
function refitVisible() { for (const name of state.terms.keys()) refit(name); }
window.addEventListener('focus', refitVisible);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refitVisible(); });
document.addEventListener('pointerdown', (e) => {
  const cell = e.target.closest?.('.cell[data-session]');
  if (cell) refit(cell.dataset.session);
}, true);

function setFont(n) {
  n = clampFont(n);
  if (n === state.font) return;
  state.font = n;
  lsSet(LS_FONT, String(n));
  document.documentElement.style.setProperty('--tf', String(n));
  for (const name of state.terms.keys()) relayoutTerm(name);
  syncFontUi();
}
function setFit(on) {
  state.fit = !!on;
  lsSet(LS_FIT, on ? '1' : '0');
  for (const e of state.terms.values()) { e.noFit = false; e.reqKey = ''; }
  for (const name of state.terms.keys()) relayoutTerm(name);
  syncFontUi();
}
function syncFontUi() {
  const sz = $('#fontSize'); if (sz) sz.textContent = String(state.font);
  const f = $('#fitToggle'); if (f) f.classList.toggle('on', state.fit);
}

function relayoutTerm(session) {
  const entry = state.terms.get(session);
  if (!entry) return;
  if (layoutTerm(session) && entry.lastPane != null) paintTerm(session, true);
}

function mountTerm(session, host) {
  if (!host) return;
  const entry = getTerm(session);
  const { term } = entry;
  entry.reqKey = '';   // newly shown here: claim the size again (last viewer wins)
  try {
    if (term.element && term.element.parentNode === host && entry.host === host) {
      // already mounted here
    } else {
      // Clear anything else in the host except our own element.
      for (const ch of Array.from(host.childNodes)) {
        if (ch !== term.element) host.removeChild(ch);
      }
      if (term.element) {
        host.appendChild(term.element);
      } else {
        term.open(host);
      }
    }
  } catch (err) {
    console.warn('[mountTerm]', session, err);
    return;
  }
  if (entry.host !== host) {
    entry.host = host;
    if (entry.ro) entry.ro.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      let raf = 0;
      entry.ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => relayoutTerm(session));
      });
      entry.ro.observe(host);
    }
  }
  requestAnimationFrame(() => relayoutTerm(session));
  setTimeout(() => relayoutTerm(session), 120);
  if (entry.lastPane != null) paintTerm(session, true);
}

// Write clear + content in ONE write() so there is never a blank frame, and
// keep the user's scroll position if they had scrolled up.
function paintTerm(session, force) {
  const entry = state.terms.get(session);
  if (!entry || entry.lastPane == null || !entry.term.element) return;
  const { term } = entry;
  const buf = term.buffer.active;
  const atBottom = buf.viewportY >= buf.baseY;
  const fromBottom = buf.baseY - buf.viewportY;
  let text = entry.lastPane.replace(/\n+$/, '');
  term.write('\x1b[?25l\x1b[3J\x1b[2J\x1b[H' + text, () => {
    const b = term.buffer.active;
    if (atBottom) term.scrollToBottom();
    else term.scrollToLine(Math.max(0, b.baseY - fromBottom));
  });
}

function writeToTerm(session, pane, dims) {
  state.paneText.set(session, pane);
  const entry = state.terms.get(session);
  if (entry) {
    let relaid = false;
    if (dims && dims.cols && (dims.cols !== entry.paneCols || dims.rows !== entry.paneRows)) {
      entry.paneCols = dims.cols; entry.paneRows = dims.rows;
      relaid = layoutTerm(session);
    }
    if (entry.lastPane === pane && !relaid) {
      // identical text and same grid: nothing to do
    } else {
      entry.lastPane = pane;
      paintTerm(session);
    }
  }
  onPane(session, pane);
}

// ---------- WebSocket ----------
function wantSession(session) {
  // Before the first status/session list we can't know; after, only connect
  // sockets for sessions that exist.
  const known = Object.keys(state.status || {});
  return !known.length || known.includes(session);
}

function closeStale() {
  const known = Object.keys(state.status || {});
  if (!known.length) return;
  for (const [name, ws] of Array.from(state.ws.entries())) {
    if (!known.includes(name)) {
      state.ws.delete(name);
      try { ws.close(); } catch {}
    }
  }
}

function connectSession(session) {
  if (!wantSession(session)) return;
  const cur = state.ws.get(session);
  if (cur && (cur.readyState === 0 || cur.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(session)}`);
  let tries = (cur && cur._tries) || 0;
  ws._tries = tries;
  ws.onopen = () => { ws._tries = 0; };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') writeToTerm(msg.session, msg.pane, { cols: msg.cols, rows: msg.rows });
    } catch {}
  };
  ws.onclose = () => {
    if (state.ws.get(session) === ws) state.ws.delete(session);
    else return;               // superseded / intentionally closed
    if (!wantSession(session)) return;
    const delay = Math.min(15000, 2000 * Math.pow(1.6, ws._tries || 0));
    setTimeout(() => {
      connectSession(session);
      const next = state.ws.get(session);
      if (next) next._tries = (ws._tries || 0) + 1;
    }, delay);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  state.ws.set(session, ws);
}

function connectStatus() {
  if (state.statusWs && (state.statusWs.readyState === 0 || state.statusWs.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/status`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'status') {
        state.status = msg.status;
        closeStale();
        for (const [name, e] of state.terms) {
          if (e.noFit && !msg.status[name]?.attached) { e.noFit = false; e.reqKey = ''; }
          relayoutTerm(name);
        }
        onStatus();
      } else if (msg.type === 'leases') {
        onLeases(msg);
      } else if (msg.type === 'deploys') {
        onDeploys(msg.deploys);
      } else if (msg.type === 'health') {
        onHealth(msg.health);
      } else if (msg.type === 'quota') {
        onQuota(msg.quota);
      }
    } catch {}
  };
  ws.onclose = () => { state.statusWs = null; setTimeout(connectStatus, 2000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
  state.statusWs = ws;
}


// ---------- server event hooks ----------
// Called by connectStatus / writeToTerm. Everything below updates the DOM in
// place (no innerHTML rebuild per tick) so cards never flash or remount.

function onStatus() {
  state.statusAt = Date.now();
  // Session set comes from the status keys; keep our stable order.
  const names = Object.keys(state.status);
  const known = state.sessions.map((s) => s.name);
  const changedSet = names.length !== known.length || names.some((n) => !known.includes(n));
  if (changedSet) {
    state.sessions = names.map((n) => state.sessions.find((s) => s.name === n) || { name: n, cmd: state.status[n].cmd || '' });
    sortSessions();
    if (state.active && !names.includes(state.active) && !pendingNew(state.active)) state.active = null;
    if (!state.active && state.sessions[0]) state.active = state.sessions[0].name;
    renderAll();
  } else {
    syncAll();
  }
  alertTransitions();
}

// ---------- deploy queue (TASK-44 phase 7) ----------
const DEP_PENDING = ['queued', 'running'];
function onDeploys(d) {
  state.deploys = d;
  if (state.platSheet) state.platSheet();
  const waiting = (d?.deploys || []).filter((x) => x.state === 'awaiting-approval').length;
  els.mgrBtn.classList.toggle('badge', waiting > 0);
  $('#moreBtn')?.classList.toggle('badge', waiting > 0);
  els.mgrBtn.title = waiting ? `AI manager · ${waiting} deploy${waiting > 1 ? 's' : ''} need approval` : 'AI manager: auto-answers, log';
  if (state.depSheet) state.depSheet();
}

function onLeases(msg) {
  state.leases = msg;       // {leases, waiters, hostname} or {error}
  if (state.platSheet) state.platSheet();
}

function onPane(session, pane) {
  if (state.mode !== 'list') return;
  const row = els.listPane.querySelector(`[data-session="${cssEscape(session)}"] .last`);
  if (row) row.textContent = rowLast(session);
}

// Stable alphabetical order by display name. Cards must not jump around
// under your thumb; "needs you" is surfaced by the banner, not by reordering.
// Grid order: the user's saved order first (drag / arrows), then the rest
// alphabetically. Cards never reorder on their own.
function sortSessions() {
  const idx = new Map((state.order || []).map((n, i) => [n, i]));
  const rank = (n) => idx.has(n) ? idx.get(n) : Infinity;
  state.sessions.sort((a, b) => (rank(a.name) - rank(b.name)) ||
    displayName(a.name).localeCompare(displayName(b.name)));
}

// Move a session to index `to` in the full order and persist it.
function moveSessionTo(name, to) {
  const names = state.sessions.map((s) => s.name);
  const from = names.indexOf(name);
  if (from < 0) return;
  to = Math.max(0, Math.min(names.length - 1, to));
  if (to === from) return;
  names.splice(from, 1);
  names.splice(to, 0, name);
  state.order = names;
  lsSet(LS_ORDER, JSON.stringify(names));
  sortSessions();
  renderTabStrip();
  if (state.mode === 'grid') renderGrid();
  syncAll();
}
// Arrow move inside the grid: left/right = ±1, up/down = ± one row.
function gridCols() {
  const cols = getComputedStyle(els.gridPane).gridTemplateColumns.split(' ').filter(Boolean).length;
  return Math.max(1, cols);
}
function moveSession(name, dir) {
  const i = state.sessions.findIndex((s) => s.name === name);
  const step = { left: -1, right: 1, up: -gridCols(), down: gridCols() }[dir];
  moveSessionTo(name, i + step);
}
function byUrgency(list) {
  return [...list].sort((a, b) =>
    byPriority(prioOf(a.name), prioOf(b.name)) ||
    (STATE_RANK[vstateOf(a.name)] - STATE_RANK[vstateOf(b.name)]) ||
    displayName(a.name).localeCompare(displayName(b.name)));
}
// Filters: status (state.filter, also set by the top-bar count chips),
// project (GitHub repo / folder) and agent. All views show only matches.
const LS_FILTERS = 'ghosty.filters';
function projectOf(n) { return state.status[n]?.project || state.status[n]?.repo || ''; }
function matchesFilter(n) {
  if (state.filter && stateOf(n) !== state.filter) return false;
  if (state.fProject && projectOf(n) !== (state.fProject === '-' ? '' : state.fProject)) return false;
  if (state.fAgent && agentOf(n) !== state.fAgent) return false;
  return true;
}
function anyFilter() { return !!(state.filter || state.fProject || state.fAgent); }
function visibleSessions() {
  if (!anyFilter()) return state.sessions;
  return state.sessions.filter((s) => matchesFilter(s.name));
}

// ---------- data ----------
async function fetchInitial() {
  try {
    const r = await fetch('/api/sessions');
    const data = await r.json();
    state.sessions = data.sessions || [];
    state.status   = data.status   || {};
    state.statusAt = Date.now();
    sortSessions();
    if (!state.active && state.sessions[0]) state.active = state.sessions[0].name;
    for (const s of state.sessions) state.prevState[s.name] = stateOf(s.name);
    renderAll();
  } catch (err) {
    toast('failed to load — retrying');
    setTimeout(fetchInitial, 2000);
  }
  fetchLeases();
  fetch('/api/deploys').then((r) => r.json()).then(onDeploys).catch(() => {});
}

async function fetchLeases() {
  try {
    const r = await fetch('/api/leases');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    onLeases(data.ok ? data : { error: data.error || 'unavailable' });
  } catch (err) {
    onLeases({ error: err.message });
  }
}

// ---------- codebox health strip ----------

// web layout: health sits in the top bar next to the title; phones keep the strip below it
{
  const mq = window.matchMedia('(min-width: 721px)');
  const place = () => {
    if (mq.matches) els.health.classList.add('inbar'), $('#appTitle').after(els.health), $('#topbar').after(els.quota);
    else els.health.classList.remove('inbar'), $('#topbar').after(els.health), els.health.after(els.quota);
  };
  mq.addEventListener('change', place);
  place();
}

function onHealth(h) {
  const el = els.health;
  if (!h) { el.classList.add('hidden'); return; }
  const pct = (v) => (v == null ? '–' : `${Math.round(v)}%`);
  const gb = (b) => `${(b / 2 ** 30).toFixed(b < 10 * 2 ** 30 ? 1 : 0)}G`;
  const item = (level, label, main, sub, title) =>
    `<span class="hi ${level}" title="${escapeHtml(title)}"><b>${label}</b>${main}${sub ? `<i>${sub}</i>` : ''}</span>`;
  // red from 90 % (stricter than the server's push thresholds)
  const lvl = (p, l) => (p >= 90 ? 'crit' : l);
  h = { ...h, cpu: { ...h.cpu, level: lvl(h.cpu.pct, h.cpu.level) },
    load: { ...h.load, level: lvl((h.load.avg[0] / h.load.cores) * 100, h.load.level) },
    mem: h.mem && { ...h.mem, level: lvl(h.mem.pct, h.mem.level) },
    disks: h.disks.map((d) => ({ ...d, level: lvl(d.pct, d.level) })) };
  const parts = [
    item(h.cpu.level, 'cpu', pct(h.cpu.pct), '', 'CPU busy, all cores'),
    item(h.load.level, 'load', h.load.avg[0].toFixed(1), `/${h.load.cores}`,
      `load average 1/5/15 min: ${h.load.avg.map((v) => v.toFixed(2)).join(' ')} on ${h.load.cores} cores`),
  ];
  if (h.mem) parts.push(item(h.mem.level, 'ram', pct(h.mem.pct), `${gb(h.mem.used)}/${gb(h.mem.total)}`,
    `RAM used ${gb(h.mem.used)} of ${gb(h.mem.total)} (${gb(h.mem.free)} available)`));
  for (const d of h.disks) parts.push(item(d.level, d.path === '/' ? 'disk' : `disk ${d.path}`, pct(d.pct), `${gb(d.free)} free`,
    `${d.path}: ${gb(d.used)} used, ${gb(d.free)} free of ${gb(d.total)}`));
  const worst = ['crit', 'warn'].find((l) => [h.cpu, h.load, h.mem, ...h.disks].some((x) => x?.level === l)) || 'ok';
  el.className = `health ${worst}`;
  el.innerHTML = parts.join('');
}

// ---------- summary + attention ----------
function renderSummary() {
  const counts = { waiting: 0, done: 0, working: 0, idle: 0, offline: 0 };
  for (const s of state.sessions) counts[stateOf(s.name)]++;
  const chips = [
    ['waiting', counts.waiting, 'need you'],
    ['done',    counts.done,    'done'],
    ['working', counts.working, 'working'],
    ['idle',    counts.idle,    'idle'],
  ];
  const html = chips
    .filter(([k, n]) => n > 0 || k === 'working')
    .map(([k, n, t]) => `<button class="chip ${k}${state.filter === k ? ' on' : ''}" data-filter="${k}" title="${t}" aria-label="${n} ${t}"><i class="dot ${k}"></i>${n}</button>`)
    .join('');
  if (els.summary.innerHTML !== html) {
    els.summary.innerHTML = html;
    for (const b of els.summary.querySelectorAll('.chip')) {
      b.onclick = () => setFilter(state.filter === b.dataset.filter ? null : b.dataset.filter);
    }
  }
  // tab title badge so the PWA / browser tab shows how many need you
  document.title = counts.waiting ? `(${counts.waiting}) codebox` : 'codebox';
}

function renderAttention() {
  // waiting sessions, plus finished ones whose closing question the AI reviewer sent to the owner
  const aiAsk = (n) => { const st = state.status[n]; return st && st.state === 'done' && needsOwner(st) && st.triage && st.triage.state !== 'pending'; };
  const waiting = state.sessions.filter((s) => stateOf(s.name) === 'waiting' || aiAsk(s.name)).sort((a, b) => byPriority(prioOf(a.name), prioOf(b.name)));
  els.attention.classList.toggle('hidden', waiting.length === 0);
  const line = (n) => { const a = state.status[n]?.triage?.ai; return a ? (a.proposed_reply ? `AI: \u201c${a.proposed_reply}\u201d` : 'AI: needs you') : ''; };
  const key = waiting.map((s) => s.name + prioOf(s.name) + line(s.name)).join('|');
  if (els.attention.dataset.key === key) return;
  els.attention.dataset.key = key;
  els.attention.innerHTML = `<span class="lbl">NEEDS YOU</span>` +
    waiting.map((s) => `<button data-session="${escapeHtml(s.name)}">${prioOf(s.name) === DEFAULT_PRIORITY ? '' : `<b class="prio ${prioOf(s.name)}">${prioOf(s.name)}</b>`}${escapeHtml(displayName(s.name))}${line(s.name) ? `<span class="ai1">${escapeHtml(line(s.name))}</span>` : ''}</button>`).join('');
  for (const b of els.attention.querySelectorAll('button')) {
    b.onclick = () => openCard(b.dataset.session);
  }
}

function setFilter(f) {
  state.filter = f;
  renderAll();
}
function setFilters(patch) {
  Object.assign(state, patch);
  lsSet(LS_FILTERS, JSON.stringify({ p: state.fProject || null, a: state.fAgent || null }));
  renderAll();
}
function loadFilters() {
  try { const f = JSON.parse(lsGet(LS_FILTERS, '{}')) || {}; state.fProject = f.p || null; state.fAgent = f.a || null; }
  catch { state.fProject = state.fAgent = null; }
}

// Filter bar: one horizontal row of chip groups. Rebuilt only when its
// content (counts / options / selection) changes.
function renderFilterBar() {
  const bar = els.filterBar;
  const show = state.filterOpen || anyFilter();
  bar.classList.toggle('hidden', !show);
  els.filterBtn.classList.toggle('on', anyFilter());
  if (!show) return;
  const all = state.sessions.map((s) => s.name);
  const count = (pred) => all.filter(pred).length;
  const chip = (group, val, label, n, cls = '') =>
    `<button class="fchip ${cls}${(state[group] || null) === val ? ' on' : ''}" data-g="${group}" data-v="${val ?? ''}">${label}${n != null ? `<span class="n">${n}</span>` : ''}</button>`;
  const states = ['waiting', 'done', 'working', 'idle', 'offline'];
  const projects = [...new Set(all.map(projectOf))].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  const agents = ['claude', 'codex', 'minimax', 'bash'].filter((a) => all.some((n) => agentOf(n) === a));
  const html =
    `<span class="fl">status</span>` + chip('filter', null, 'all') +
    states.filter((k) => count((n) => stateOf(n) === k)).map((k) => chip('filter', k, `<i class="dot ${k}"></i>${STATE_LABEL[k]}`, count((n) => stateOf(n) === k))).join('') +
    `<span class="fsep"></span><span class="fl">project</span>` + chip('fProject', null, 'all') +
    projects.map((p) => chip('fProject', p || '-', p ? escapeHtml(p) : '<i>no git</i>', count((n) => projectOf(n) === p))).join('') +
    `<span class="fsep"></span><span class="fl">agent</span>` + chip('fAgent', null, 'all') +
    agents.map((a) => chip('fAgent', a, `<span class="agent ${a}">${AGENT_LABEL[a]}</span>`, count((n) => agentOf(n) === a))).join('') +
    (anyFilter() ? `<span class="fsep"></span><button class="fclear">clear ×</button>` : '');
  if (bar.dataset.h === html) return;
  bar.dataset.h = html;
  bar.innerHTML = html;
  for (const b of bar.querySelectorAll('.fchip')) {
    b.onclick = () => {
      const g = b.dataset.g, v = b.dataset.v || null;
      const next = state[g] === v ? null : v;
      if (g === 'filter') setFilter(next); else setFilters({ [g]: next });
    };
  }
  bar.querySelector('.fclear')?.addEventListener('click', () => { state.filter = null; setFilters({ fProject: null, fAgent: null }); });
}

// ---------- task document (.md) ----------
// Sessions named taskNN get an MD button when the server finds a TASK-NN*.md (or task.md) for them.
state.taskDocs = new Map();   // session -> { files: [] , at }
function probeTaskDoc(cell, n) {
  const btn = cell.querySelector('.td');
  if (!btn) return;
  let d = state.taskDocs.get(n);
  if (!/^task\d+/i.test(n)) { btn.classList.add('hidden'); return; }
  if (!d || (!d.busy && Date.now() - d.at > 120000)) {
    d = d || { files: [], at: 0 };
    d.busy = true; state.taskDocs.set(n, d);
    fetch(`/api/taskdocs/${encodeURIComponent(n)}`).then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((j) => { d.files = j.files || []; })
      .catch(() => {})
      .finally(() => { d.busy = false; d.at = Date.now(); const c = document.querySelector(`.cell[data-session="${cssEscape(n)}"]`); if (c) probeTaskDoc(c, n); });
  }
  btn.classList.toggle('hidden', !d.files.length);
}
function mdInline(t) {
  return escapeHtml(t)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function renderMd(src) {
  const lines = String(src).replace(/\t/g, '    ').split('\n');
  const out = [];
  let i = 0, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; } };
  const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      flush(); const code = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++; out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`); continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { flush(); out.push(`<div class="mdh h${Math.min(h[1].length, 4)}">${mdInline(h[2])}</div>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flush(); const head = row(l); i += 2; const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<div class="mdt"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>\s?/.test(l)) {
      flush(); const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${mdInline(q.join(' '))}</blockquote>`); continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) {
      flush();
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) { items.push({ d: Math.min(Math.floor(m[1].length / 2), 4), num: /\d/.test(m[2]), t: m[3] }); i++; }
        else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1].t += ' ' + lines[i].trim(); i++; }
        else break;
      }
      out.push('<div class="mdl">' + items.map((it) => {
        const cb = /^\[( |x|X)\]\s+(.*)$/.exec(it.t);
        const mark = cb ? `<span class="cb${cb[1] === ' ' ? '' : ' on'}"></span>` : `<span class="bu">${it.num ? '\u2022' : '\u2022'}</span>`;
        return `<div class="mdi" style="margin-left:${it.d * 14}px">${mark}<span>${mdInline(cb ? cb[2] : it.t)}</span></div>`;
      }).join('') + '</div>');
      continue;
    }
    para.push(l.trim()); i++;
  }
  flush();
  return out.join('');
}
async function toggleTaskDoc(cell, n, file) {
  if (cell.classList.contains('doc-on') && !file) { cell.classList.remove('doc-on'); return; }
  const dv = cell.querySelector('.docview');
  const d = state.taskDocs.get(n) || { files: [] };
  const cur = file || dv.dataset.file || d.files[0];
  if (!cur) return;
  dv.dataset.file = cur;
  cell.classList.add('doc-on');
  dv.innerHTML = '<div class="rd-empty">loading\u2026</div>';
  try {
    const r = await fetch(`/api/taskdoc/${encodeURIComponent(n)}?f=${encodeURIComponent(cur)}`);
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const opts = d.files.length > 1
      ? `<select class="mdsel">${d.files.map((f) => `<option value="${escapeHtml(f)}"${f === j.name ? ' selected' : ''}>${escapeHtml(f)}</option>`).join('')}</select>`
      : `<span class="mdname">${escapeHtml(j.name)}</span>`;
    dv.innerHTML = `<div class="mdbar"><button class="mdback">\u2190 session</button>${opts}</div><div class="mdbody">${renderMd(j.text)}</div>`;
    dv.querySelector('.mdback').onclick = (e) => { e.stopPropagation(); cell.classList.remove('doc-on'); };
    const sel = dv.querySelector('.mdsel');
    if (sel) sel.onchange = () => toggleTaskDoc(cell, n, sel.value);
  } catch {
    dv.innerHTML = '<div class="mdbar"><button class="mdback">\u2190 session</button></div><div class="rd-empty">could not load the task document</div>';
    dv.querySelector('.mdback').onclick = (e) => { e.stopPropagation(); cell.classList.remove('doc-on'); };
  }
}

// ---------- tabs ----------
function renderTabStrip() {
  els.tabs.innerHTML = '';
  for (const s of visibleSessions()) {
    const tab = document.createElement('div');
    tab.dataset.session = s.name;
    tab.className = 'tab';
    tab.innerHTML = `<i class="dot"></i><span class="label">${escapeHtml(displayName(s.name))}</span>`;
    // grid: select + bring the card on screen; elsewhere: open the card
    tab.onclick = () => {
      if (state.mode !== 'grid') return openCard(s.name);
      focusSession(s.name);
      els.gridPane.querySelector(`[data-session="${cssEscape(s.name)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    els.tabs.appendChild(tab);
  }
  syncTabs();
}
function syncTabs() {
  for (const tab of els.tabs.children) {
    const n = tab.dataset.session;
    const s = vstateOf(n);
    tab.className = `tab ${s}${n === state.active ? ' active' : ''}`;
    tab.querySelector('.dot').className = `dot ${s}`;
  }
}

// ---------- sidebar ----------
function repoBranch(n) {
  const st = state.status[n] || {};
  return [st.repo, st.branch].filter(Boolean).join(' · ');
}
function sideSig() {
  return state.sessions.map((s) => `${s.name}:${customFor(s.name)}`).join(',');
}
// Full rebuild only when the session set / names change; ordering is done in layoutSide().
function renderSide() {
  const list = els.sessionList;
  if (list.querySelector('li.editing')) return;   // never wipe an in-progress rename
  list.innerHTML = '';
  els.sessionCount.textContent = `${state.sessions.length}`;
  list.dataset.sig = sideSig();
  for (const s of state.sessions) list.appendChild(buildSideRow(s));
  layoutSide();
  syncSide();
}
function layoutSide() {
  const list = els.sessionList;
  const rows = new Map([...list.children].filter((li) => li.dataset.session).map((li) => [li.dataset.session, li]));
  let cursor = list.firstChild;
  const place = (n) => { if (n === cursor) cursor = cursor.nextSibling; else list.insertBefore(n, cursor); };
  // flat, alphabetical by shown name: the state badge says the rest, so rows never jump around
  for (const h of [...list.querySelectorAll('li.grp')]) { if (h === cursor) cursor = cursor.nextSibling; h.remove(); }
  const shown = (s) => displayName(s.name).toLowerCase();
  const sorted = [...state.sessions].sort((x, y) => shown(x).localeCompare(shown(y), undefined, { numeric: true }));
  for (const m of sorted) { const row = rows.get(m.name); if (row) place(row); }
  for (const [n, row] of rows) row.hidden = !matchesFilter(n);
}
function buildSideRow(s) {
  const custom = customFor(s.name);
  const li = document.createElement('li');
  li.dataset.session = s.name;
  li.innerHTML = `
    <i class="dot"></i>
    <div class="meta">
      <div class="name">${escapeHtml(custom || s.name)}</div>
      <div class="sub"><span class="pr"></span><span class="ag"></span><span class="sst"></span><span class="uc hidden"></span><span class="pp hidden">paused</span></div>
      <div class="sub rb"></div>
    </div>
    <button class="edit" aria-label="Rename">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>
    <button class="edit kill" aria-label="Kill session">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
    </button>`;
  li.querySelector('.meta').onclick = (e) => {
    e.stopPropagation();
    closeSide();
    openCard(s.name);
  };
  li.querySelector('.edit:not(.kill)').onclick = (e) => { e.stopPropagation(); beginRename(li, s.name); };
  li.querySelector('.kill').onclick = (e) => { e.stopPropagation(); confirmKill(s.name); };
  return li;
}
function syncSide() {
  const editing = !!els.sessionList.querySelector('li.editing');
  if (els.sessionList.dataset.sig !== sideSig() && !editing) { renderSide(); return; }
  if (!editing) layoutSide();
  for (const li of els.sessionList.children) {
    const n = li.dataset.session;
    if (!n || li.classList.contains('editing')) continue;
    li.classList.toggle('active', n === state.active);
    li.querySelector('.dot').className = `dot ${vstateOf(n)}`;
    const ag = agentBadgeHtml(n);
    const agEl = li.querySelector('.ag');
    if (agEl.innerHTML !== ag) agEl.innerHTML = ag;
    li.querySelector('.sst').textContent = stateText(n);
    const pr = li.querySelector('.pr'), ph = prioBadgeHtml(n);
    if (pr.dataset.h !== ph) { pr.dataset.h = ph; pr.innerHTML = ph; }
    syncPill(li.querySelector('.pp'), n);
    syncUsageChip(li.querySelector('.uc'), n);
    const rb = li.querySelector('.rb');
    const t = [repoBranch(n), customFor(n) ? n : ''].filter(Boolean).join(' · ');
    if (rb.textContent !== t) rb.textContent = t;
    rb.classList.toggle('hidden', !t);
  }
}
function tickSide() {
  for (const li of els.sessionList.children) {
    const st = li.querySelector('.sst');
    if (st && li.dataset.session && !li.classList.contains('editing')) st.textContent = stateText(li.dataset.session);
  }
}

function beginRename(li, name) {
  if (li.classList.contains('editing')) return;
  li.classList.add('editing');
  const current = customFor(name) || name;
  const inp = document.createElement('input');
  inp.className = 'name-input';
  inp.value = current;
  inp.maxLength = 40;
  const meta = li.querySelector('.meta');
  meta.innerHTML = '';
  meta.appendChild(inp);
  setTimeout(() => { inp.focus(); inp.select(); }, 0);

  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const v = inp.value.trim();
    li.classList.remove('editing');
    if (v && v !== name) state.rename[name] = v;
    else delete state.rename[name];
    saveRenames();
    sortSessions();
    renderAll();
    toast(v && v !== name ? `renamed to "${v}"` : 'name reset');
  };
  const cancel = () => { if (done) return; done = true; li.classList.remove('editing'); renderSide(); };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };
  inp.onblur = commit;
}

// ---------- cards (card + grid views) ----------
function buildCell(s) {
  const cell = document.createElement('div');
  cell.dataset.session = s.name;
  cell.className = 'cell';
  cell.innerHTML = `
    <div class="h">
      <span class="pr"></span>
      <span class="ag"></span>
      <div class="nm"><span class="name">${escapeHtml(displayName(s.name))}</span><span class="mt">&nbsp;</span></div>
      <span class="proj"></span>
      <span class="pos"></span>
      <span class="tgt">&rarr; send target</span>
      <span class="mv" title="Move card">
        <button data-dir="left" aria-label="Move left">&#9664;</button><button data-dir="up" aria-label="Move up">&#9650;</button><button data-dir="down" aria-label="Move down">&#9660;</button><button data-dir="right" aria-label="Move right">&#9654;</button>
      </span>
      <span class="stw"></span>
      <span class="pp hidden">paused</span>
      <button class="pz" aria-label="Pause session" title="Pause (Esc, then hold)">&#9208;</button>
      <button class="td hidden" aria-label="Task document" title="Task document (.md)">MD</button>
      <button class="rd" aria-label="Toggle reader" title="Reader / terminal"></button>
      <button class="open" aria-label="Open full screen" title="Open">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
      </button>
    </div>
    <div class="ask hidden">
      <span class="q"></span>
      <div class="abtns"></div>
      <div class="tri hidden"></div>
    </div>
    <div class="apill hidden"></div>
    <div class="reader"></div>
    <div class="b"></div>
    <div class="docview"></div>
    <div class="jump">
      <button data-j="top" aria-label="Jump to oldest output" title="Top (oldest)">&#10514;</button>
      <button data-j="bottom" aria-label="Jump to newest output" title="Bottom (newest)">&#10515;</button>
    </div>`;
  cell.querySelector('.rd').onclick = (e) => { e.stopPropagation(); cell.classList.remove('doc-on'); toggleReader(); };
  cell.querySelector('.td').onclick = (e) => { e.stopPropagation(); toggleTaskDoc(cell, s.name); };
  for (const b of cell.querySelectorAll('.jump button')) {
    b.onclick = (e) => { e.stopPropagation(); jumpTo(cell, s.name, b.dataset.j); };
  }
  wireTap(cell, () => focusSession(s.name), () => { if (state.mode !== 'card') openCard(s.name); });
  cell.querySelector('.open').onclick = (e) => { e.stopPropagation(); openCard(s.name); };
  for (const b of cell.querySelectorAll('.mv button')) {
    b.onclick = (e) => { e.stopPropagation(); moveSession(s.name, b.dataset.dir); };
  }
  wireDrag(cell, s.name);
  cell.querySelector('.ask').onclick = (e) => { e.stopPropagation(); onAskClick(cell, s.name, e); };
  syncCell(cell);
  return cell;
}

// Desktop drag-to-reorder: grab a card by its header, drop it on another
// card to take that card's place. (Touch uses the ◀ ▲ ▼ ▶ buttons.)
function wireDrag(cell, name) {
  const h = cell.querySelector('.h');
  h.draggable = true;
  h.addEventListener('dragstart', (e) => {
    if (state.mode !== 'grid') { e.preventDefault(); return; }
    e.dataTransfer.setData('text/x-ghosty', name);
    e.dataTransfer.effectAllowed = 'move';
    cell.classList.add('dragging');
  });
  h.addEventListener('dragend', () => {
    cell.classList.remove('dragging');
    for (const c of els.gridPane.querySelectorAll('.drop-over')) c.classList.remove('drop-over');
  });
  cell.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-ghosty')) return;
    e.preventDefault();
    cell.classList.add('drop-over');
  });
  cell.addEventListener('dragleave', (e) => {
    if (!cell.contains(e.relatedTarget)) cell.classList.remove('drop-over');
  });
  cell.addEventListener('drop', (e) => {
    const from = e.dataTransfer.getData('text/x-ghosty');
    cell.classList.remove('drop-over');
    if (!from || from === name) return;
    e.preventDefault();
    moveSessionTo(from, state.sessions.findIndex((s) => s.name === name));
  });
}

// ⤒ / ⤓: jump to the oldest / newest output in whatever the card shows
// (reader text or the terminal's scrollback).
function jumpTo(cell, name, where) {
  if (cell.classList.contains('rd-on')) {
    const el = cell.querySelector('.reader');
    el.scrollTo({ top: where === 'top' ? 0 : el.scrollHeight, behavior: 'smooth' });
    return;
  }
  const term = state.terms.get(name)?.term;
  if (!term) return;
  if (where === 'top') term.scrollToTop(); else term.scrollToBottom();
}

// Single tap = select (send target), double tap = open the card.
// Listens in the capture phase so xterm's own mouse handling (text
// selection on the canvas) can't swallow the taps; mobile browsers don't
// fire dblclick reliably, so the double is detected by timing.
function wireTap(el, onSingle, onDouble) {
  let down = null, lastUp = 0;
  el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: Date.now() }; }, true);
  el.addEventListener('pointerup', (e) => {
    if (!down || e.target.closest('button')) { down = null; return; }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10;
    const long = Date.now() - down.t > 500;
    down = null;
    if (moved || long) return;                 // scroll / text selection
    const now = Date.now();
    if (now - lastUp < 350) { lastUp = 0; onDouble(); return; }
    lastUp = now;
    onSingle();
  }, true);
}

// ---------- answer buttons + AI proposal (TASK-44 phase 9) ----------
// The row under a card header shows buttons derived from the question (public/buttons.js), the AI reviewer's
// proposal with its reasoning, and the raw keys behind a toggle. A reply on a forbidden topic needs a second tap.
const askVisible = (n, st) => st && (st.state === 'waiting' || (st.state === 'done' && needsOwner(st)));
function triHtml(t, kind) {
  if (!t) return '';
  if (t.state === 'pending') return '<div class="tl dim">AI reviewer reading the stop…</div>';
  if (t.state === 'skipped') return `<div class="tl dim">AI skipped: ${escapeHtml(t.skipped)}</div>`;
  if (t.state === 'error') return `<div class="tl dim">AI reviewer failed: ${escapeHtml(String(t.error || '?').slice(0, 70))}</div>`;
  const a = t.ai;
  const sim = t.mode === 'simulate' ? ' <i class="sim">simulation: nothing is sent for you</i>' : '';
  const reply = a.proposed_reply ? `AI: \u201c${escapeHtml(a.proposed_reply)}\u201d` : `AI: needs you${a.owner_needed_why ? ` \u2014 ${escapeHtml(a.owner_needed_why)}` : ''}`;
  return `<div class="tl">${t.jev ? `<b>Jev</b> ${escapeHtml(t.jev)} \u00b7 ` : `<b>rules</b> ${escapeHtml(t.case || '')} \u00b7 `}${reply}${sim}</div>
    <div class="tr">${escapeHtml(a.reasoning || '')} <i>(confidence ${Number(a.confidence).toFixed(2)})</i></div>
    <div class="tb">${a.proposed_reply && (kind === 'menu' || kind === 'yesno') ? '<button class="yes" data-tri="send">Send AI reply</button>' : ''}${a.proposed_reply ? '<button data-tri="edit">Edit</button>' : ''}<button data-tri="dismiss">Dismiss</button></div>`;
}
function syncAsk(cell, n) {
  const st = state.status[n];
  const ask = cell.querySelector('.ask');
  const show = askVisible(n, st);
  ask.classList.toggle('hidden', !show);
  if (!show) { ask._d = null; ask.dataset.k = ''; return; }
  const t = st.triage || null;
  const d = deriveButtons({ state: st.state, stall: st.stall, triage: st.triage });
  const q = (st.state === 'waiting' ? st.waitReason : null) || (st.stall?.question ? lastQuestion(st.stall.question).slice(0, 220) : '') || 'waiting for your answer';
  const keysOpen = ask.dataset.keys === '1';
  const k = JSON.stringify([q, d, t, keysOpen]);
  if (ask.dataset.k === k) return;
  ask.dataset.k = k; ask._d = d; ask._t = st.triage || null; ask._id = st.stall?.id || st.triage?.id || null;
  ask.querySelector('.q').textContent = q;
  const btn = (b, i) => `<button class="${b.primary ? 'yes' : ''}${b.reply ? ' rep' : ''}" data-i="${i}">${escapeHtml(b.label)}</button>`;
  ask.querySelector('.abtns').innerHTML = d.buttons.map(btn).join('')
    + (d.esc ? '<button class="sm" data-esc="1">esc</button>' : '')
    + `<button class="sm kt" data-keys="1">keys ${keysOpen ? '\u25b4' : '\u25be'}</button>`
    + (keysOpen ? `<span class="rawkeys">${d.keys.map((b, i) => `<button class="${b.primary ? 'yes' : ''}" data-raw="${i}">${escapeHtml(b.label)}</button>`).join('')}</span>` : '');
  const tri = ask.querySelector('.tri');
  const html = triHtml(t, d.kind);
  tri.classList.toggle('hidden', !html);
  tri.innerHTML = html;
}
async function askSend(n, id, b, via) {
  focusSession(n);
  try {
    if (b.key != null) await postSend(n, { key: b.key });
    else await postSend(n, { keys: b.text });
    if (navigator.vibrate) navigator.vibrate(10);
    toast(`sent \u2192 ${displayName(n)}`, 900);
    if (id && via) fetch('/api/manager/triage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action: via, session: n }) }).catch(() => {});
  } catch (err) { toast(`send failed: ${err.message}`); }
}
function prefillDock(n, text) {
  focusSession(n);
  els.sendInput.value = text || '';
  autoGrow();
  els.sendInput.focus();
}
function onAskClick(cell, n, e) {
  const ask = cell.querySelector('.ask');
  const t = e.target.closest('button');
  if (!t) return;
  const id = ask._id;
  if (t.dataset.keys) { ask.dataset.keys = ask.dataset.keys === '1' ? '0' : '1'; ask.dataset.k = ''; syncAsk(cell, n); return; }
  if (t.dataset.esc) { focusSession(n); sendKey(n, 'Escape'); return; }
  if (t.dataset.raw != null) { const b = ask._d?.keys[Number(t.dataset.raw)]; if (b) { focusSession(n); sendKey(n, b.key); } return; }
  if (t.dataset.tri) {
    const ai = ask._t?.ai;
    if (t.dataset.tri === 'dismiss') {
      fetch('/api/manager/triage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ask._t?.id || id, action: 'dismissed', session: n }) }).catch(() => {});
      if (state.status[n]) state.status[n].triage = null;
      syncAll(); return;
    }
    if (!ai?.proposed_reply) return;
    if (t.dataset.tri === 'edit') {
      prefillDock(n, ai.proposed_reply);
      fetch('/api/manager/triage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ask._t?.id || id, action: 'edited', session: n }) }).catch(() => {});
      return;
    }
    confirmThen(t, !!(ai.forbidden || state.status[n]?.stall?.forbidden), () => askSend(n, ask._t?.id || id, { text: ai.proposed_reply }, 'sent'));
    return;
  }
  const b = ask._d?.buttons[Number(t.dataset.i)];
  if (!b) return;
  if (b.reply) { prefillDock(n, ''); return; }
  confirmThen(t, b.confirm, () => askSend(n, id, b, b.ai ? 'sent' : null));
}
// A reply on a forbidden topic (deploy, push, delete, secrets, money, customer) needs a second tap within 4 s.
function confirmThen(btn, needs, go) {
  if (!needs) { go(); return; }
  if (btn.dataset.armed === '1') { clearTimeout(btn._arm); btn.dataset.armed = ''; btn.classList.remove('arm'); go(); return; }
  btn.dataset.armed = '1'; btn.classList.add('arm'); btn._label = btn.textContent;
  btn.textContent = 'tap again: sensitive topic';
  btn._arm = setTimeout(() => { btn.dataset.armed = ''; btn.classList.remove('arm'); btn.textContent = btn._label; }, 4000);
}

function syncCell(cell) {
  const n = cell.dataset.session;
  const s = vstateOf(n);
  const inCard = cell.parentElement === els.cardPane;
  const docOn = inCard && cell.classList.contains('doc-on');
  cell.className = `cell ${s}${n === state.active ? ' focus' : ''}${inCard && state.reader ? ' rd-on' : ''}${docOn ? ' doc-on' : ''}`;
  probeTaskDoc(cell, n);
  const ag = agentBadgeHtml(n);
  const agEl = cell.querySelector('.ag');
  if (agEl.innerHTML !== ag) agEl.innerHTML = ag;
  syncPrioPause(cell, n);
  const stw = cell.querySelector('.stw');
  const sk = s + '|' + deployWaitTip(n);
  if (stw.dataset.s !== sk) { stw.dataset.s = sk; stw.innerHTML = stateBadgeHtml(n); }
  else stw.querySelector('.st').textContent = badgeText(n);
  syncAsk(cell, n);
  syncAutoPill(cell.querySelector('.apill'), n);
  const pj = cell.querySelector('.proj'), ph = projHtml(n);
  if (pj.dataset.h !== ph) { pj.dataset.h = ph; pj.innerHTML = ph; }
  const mt = cell.querySelector('.mt'), mh = headMetaHtml(n);
  if (mt.dataset.h !== mh) { mt.dataset.h = mh; mt.innerHTML = mh; }
  const rd = cell.querySelector('.rd');
  rd.textContent = state.reader ? '>_' : 'Aa';
  const pos = cell.querySelector('.pos');
  if (inCard) {
    const order = byUrgency(visibleSessions()), i = order.findIndex((x) => x.name === n);
    pos.textContent = order.length > 1 && i >= 0 ? `${i + 1} / ${order.length}` : '';
  } else pos.textContent = '';
  if (inCard && state.reader) syncReader(cell, n);
}

// ---------- meta (repo / branch / ctx / activity) ----------
function locText(st) {
  if (!st.repo && !st.branch) return '';
  const b = st.branch ? `${st.branch}${st.dirty ? '*' : ''}` : (st.dirty ? '*' : '');
  return st.repo && b ? `${st.repo}/${b}` : (st.repo || b);
}
function ctxHtml(st) {
  const v = st.contextLeft;
  if (v == null || isNaN(v)) return '';
  const cls = v < 15 ? ' crit' : v < 30 ? ' warn' : '';
  return `<span class="ctx${cls}">ctx ${Math.round(v)}%</span>`;
}
// 🔒 chip: only for a session that holds a lease; amber while a pending deploy waits on it. Tap -> Platforms at that resource.
function leaseChipHtml(st, cls) {
  const c = chipModel(st.lease);
  if (!c) return '';
  return `<button class="${cls} lease${c.blocks ? ' blocks' : ''}" data-plat="${escapeHtml(c.env + '|' + c.resource)}" title="Open Platforms">${escapeHtml(c.text)}</button>`;
}
function headMetaHtml(n) {
  const st = state.status[n] || {};
  const parts = [];
  const lc = leaseChipHtml(st, 'lease-chip');
  if (lc) parts.push(lc);
  const c = ctxHtml(st);
  if (c) parts.push(c);
  if (stateOf(n) === 'working' && st.activity) parts.push(`<span class="act">${escapeHtml(st.activity)}</span>`);
  return parts.join('<span class="sep"> \u00b7 </span>');
}
// Centre label of a card header: project · branch · worktree.
function projHtml(n) {
  const st = state.status[n] || {};
  const project = st.project || st.repo;
  if (!project) return '';
  const gh = st.github ? '<svg class="gh" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>' : '';
  const br = st.branch ? `<span class="br">\u2387 ${escapeHtml(st.branch)}${st.dirty ? '<b class="dirty">*</b>' : ''}</span>` : '';
  const wt = st.worktree ? `<span class="wt" title="git worktree">\u2442 ${escapeHtml(st.worktree)}</span>` : '';
  return `${gh}<b class="pj">${escapeHtml(project)}</b>${br}${wt}`;
}
function rowChipsHtml(n) {
  const st = state.status[n] || {};
  const chips = [];
  const loc = locText(st);
  if (loc) chips.push(`<span class="chip-m">${escapeHtml(loc)}</span>`);
  const c = ctxHtml(st);
  if (c) chips.push(c.replace('class="ctx', 'class="chip-m ctx'));
  const lc = leaseChipHtml(st, 'chip-m');
  if (lc) chips.push(lc);
  return chips.join('');
}

// ---------- reader (rendered last reply) ----------
const LS_READER = 'ghosty.reader';
state.reader = false;
state.replies = new Map();     // session -> { hash, at, text, failed, busy }
function toggleReader() {
  state.reader = !state.reader;
  lsSet(LS_READER, state.reader ? '1' : '0');
  for (const c of els.cardPane.children) syncCell(c);
  const a = state.active;
  if (a) { relayoutTerm(a); setTimeout(() => relayoutTerm(a), 60); }
}
// "earlier conversation": the whole captured history (prompts, replies, tool names) instead of just the last reply
function loadTranscript(n, c) {
  return fetch(`/api/transcript/${encodeURIComponent(n)}`).then((r) => r.ok ? r.json() : Promise.reject(r.status))
    .then((d) => { c.full = d.text || ''; }).catch(() => {});
}
function syncReader(cell, n) {
  const st = state.status[n] || {};
  const hash = st.replyHash ?? '';
  let c = state.replies.get(n);
  const now = Date.now();
  const stale = !c || (c.failed ? now - c.at > 3000 : (c.hash !== hash || (hash === '' && now - c.at > 5000)));
  if (stale && !(c && c.busy)) {
    c = c || { hash: null, at: 0, text: '' };
    c.busy = true; state.replies.set(n, c);
    fetch(`/api/reply/${encodeURIComponent(n)}`).then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((d) => {
        // keep the last good reply when the server has none right now (tool line is last)
        if (d.reply) c.text = String(d.reply);
        c.failed = false; c.hash = hash;
        if (c.full != null) return loadTranscript(n, c);
      })
      .catch(() => { c.failed = true; })
      .finally(() => {
        c.busy = false; c.at = Date.now();
        const cur = els.cardPane.querySelector(`[data-session="${cssEscape(n)}"]`);
        if (cur) paintReader(cur, n);
      });
  }
  paintReader(cell, n);
}
function paintReader(cell, n) {
  const c = state.replies.get(n);
  const el = cell.querySelector('.reader');
  let text = c ? c.text : '';
  // While waiting, the reply alone hides what is being asked: append the
  // prompt itself (last lines of the pane) as a code block.
  if (stateOf(n) === 'waiting') {
    const tail = stripAnsi(state.paneText.get(n) || '').split('\n')
      .map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() && !RULE_RE.test(l)).slice(-24).join('\n');
    if (tail) text = `${text}\n\n\`\`\`\n${tail.replace(/```/g, "'''")}\n\`\`\``;
  }
  const full = c && c.full != null;
  if (full && c.full) text = c.full;
  const body = text && text.trim() ? renderReply(text) : '<div class="rd-empty">no reply yet \u2014 tap &gt;_ for terminal</div>';
  const html = `<button class="rd-more" data-act="${full ? 'less' : 'more'}">${full ? 'last reply only' : '\u2191 earlier conversation'}</button>${body}`;
  if (el.dataset.h === html) return;
  // never swap the content under a finger / a fling: that cancels touch scrolling. Retry once it settles.
  if (el._busyUntil && Date.now() < el._busyUntil) {
    clearTimeout(el._retry);
    el._retry = setTimeout(() => paintReader(cell, n), el._busyUntil - Date.now() + 50);
    return;
  }
  if (!el._wired) {
    el._wired = true;
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('.rd-more');
      if (!b) return;
      e.stopPropagation();
      const cc = state.replies.get(n);
      if (!cc) return;
      if (b.dataset.act === 'more') { await loadTranscript(n, cc); } else { cc.full = null; }
      el.dataset.h = '';
      paintReader(cell, n);
      el.scrollTop = b.dataset.act === 'more' ? el.scrollHeight : 0;
    });
    const busy = () => { el._busyUntil = Date.now() + 1200; };
    for (const ev of ['touchstart', 'touchmove', 'wheel', 'scroll']) el.addEventListener(ev, busy, { passive: true });
  }
  const first = el.dataset.h === undefined;
  const top = el.scrollTop;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  el.dataset.h = html; el.innerHTML = html;
  // newest content is at the bottom: land there on first paint, then stick only if already there
  el.scrollTop = first || atBottom ? el.scrollHeight : top;
}
function inlineMd(t) {
  return escapeHtml(t)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
}
// Box-drawn tables (┌─┬─┐ │ a │ b │ ├─┼─┤ └─┘) -> HTML. A narrow tmux pane splits rows across lines, so
// fragments that don't start with a box character are glued onto the previous line first.
function boxTable(block) {
  const logical = [];
  for (const l of block) {
    const t = l.trim();
    if (!t) continue;
    if (/^[\u250c\u251c\u2514\u2502]/.test(t) || !logical.length) logical.push(t);
    else logical[logical.length - 1] += (/^[\u2500\u252c\u2534\u253c\u2510\u2518\u2524]/.test(t) ? '' : ' ') + t;
  }
  const rows = [];
  let cur = null;
  for (const t of logical) {
    if (/^[\u250c\u251c\u2514]/.test(t)) { if (cur) { rows.push(cur); cur = null; } continue; }
    const cells = t.replace(/^\u2502|\u2502$/g, '').split('\u2502').map((c) => c.trim());
    if (!cur) cur = cells; else cells.forEach((c, i) => { if (c) cur[i] = ((cur[i] || '') + ' ' + c).trim(); });
  }
  if (cur) rows.push(cur);
  if (!rows.length) return '';
  const [head, ...body] = rows;
  return `<div class="mdt"><table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>${
    body.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function renderReply(text) {
  if (!text || !text.trim()) return '<div class="rd-empty">No reply yet.</div>';
  const lines = String(text).replace(/\t/g, '    ').split('\n');
  const out = [];
  let para = [], code = null, fence = false;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const flushCode = () => { if (code) { out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`); code = null; } };
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.replace(/\s+$/, '');
    if (!fence && /^\s*\u250c/.test(line)) {
      let k = li;
      while (k < lines.length && !/^\s*\u2514/.test(lines[k]) && k - li < 200) k++;
      const html = boxTable(lines.slice(li, k + 1));
      // an unfinished table (still being typed) falls through as plain lines
      if (html && k < lines.length) { flushPara(); flushCode(); out.push(html); li = k; continue; }
    }
    if (/^\s*```/.test(line)) {
      if (fence) { fence = false; flushCode(); } else { flushPara(); flushCode(); fence = true; code = []; }
      continue;
    }
    if (fence) { code.push(line); continue; }
    if (/^ {4,}\S/.test(line)) { flushPara(); (code ||= []).push(line.slice(4)); continue; }
    if (code) { if (!line.trim()) { code.push(''); continue; } flushCode(); }
    if (!line.trim()) { flushPara(); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { flushPara(); out.push(`<div class="rh">${inlineMd(h[2])}</div>`); continue; }
    // tmux hard-wraps at the pane width (can be ~20 cols): glue wrapped lines back together,
    // but keep list items and table/box rows on their own line
    const item = /^\s*(?:[-*\u2022]|\d+[.)]) /.test(line);
    const boxy = /^\s*[\u2500-\u257f|]/.test(line) || (line.match(/[\u2500-\u257f]/g) || []).length > 2;
    if (para.length && !item && !boxy && !para.boxy) para[para.length - 1] += ' ' + inlineMd(line.trim());
    else { para.push(inlineMd(line.replace(/^(\s*)[-*] /, '$1\u2022 '))); para.boxy = boxy; }
  }
  flushPara(); flushCode();
  return out.join('');
}

function renderInto(host, sessions) {
  // Reuse existing cells (and their mounted xterm) where possible.
  const existing = new Map([...host.children].map((c) => [c.dataset.session, c]));
  const want = sessions.map((s) => s.name);
  for (const [n, c] of existing) if (!want.includes(n)) c.remove();
  sessions.forEach((s, i) => {
    let cell = existing.get(s.name);
    if (!cell) {
      cell = buildCell(s);
      host.insertBefore(cell, host.children[i] || null);
      mountTerm(s.name, cell.querySelector('.b'));
    } else {
      cell.querySelector('.name').textContent = displayName(s.name);
      if (host.children[i] !== cell) host.insertBefore(cell, host.children[i] || null);
      syncCell(cell);
    }
    connectSession(s.name);
  });
}

// A just-created session may not be in the (cached) list yet; don't jump to another card.
function pendingNew(name) {
  return !!name && state.pendingNew && state.pendingNew.name === name && Date.now() - state.pendingNew.at < 20000;
}
function renderCard() {
  let active = state.sessions.find((s) => s.name === state.active);
  if (!active && pendingNew(state.active)) {
    renderInto(els.cardPane, []);
    els.cardPane.innerHTML = `<div class="empty">starting ${escapeHtml(displayName(state.active))}\u2026</div>`;
    return;
  }
  if (!active) active = state.sessions[0];
  if (active) state.active = active.name;
  renderInto(els.cardPane, active ? [active] : []);
}
function renderGrid() {
  els.gridPane.className = `grid-pane size-${state.gridSize}`;
  const all = visibleSessions();
  const limit = state.gridSize;
  // Keep the active session on screen when the grid is limited.
  let targets = all.slice(0, limit);
  // Once a tab swapped a card in, keep that arrangement (slot order) instead of snapping back.
  if (state.gridView) {
    const byName = new Map(all.map((s) => [s.name, s]));
    const kept = state.gridView.filter((n) => byName.has(n)).map((n) => byName.get(n));
    for (const s of all) if (kept.length < limit && !kept.includes(s)) kept.push(s);
    targets = kept.slice(0, limit);
  }
  const act = all.find((s) => s.name === state.active);
  if (act && !targets.includes(act) && limit > 0) targets = [...targets.slice(0, limit - 1), act];
  state.gridView = state.gridView ? targets.map((s) => s.name) : null;
  renderInto(els.gridPane, targets);
}

// ---------- board (list view) ----------
// line 2 of a board row: what is it doing / what did it last say
function rowLast(n) {
  const st = state.status[n] || {};
  const s = stateOf(n);
  if (s === 'waiting' && st.waitReason) return st.waitReason;
  if (s === 'working' && st.activity) return st.activity;
  return st.lastMessage || lastLine(state.paneText.get(n) || '') || ' ';
}
function renderList() {
  els.listPane.innerHTML = '';
  const rows = byUrgency(visibleSessions());
  if (!rows.length) {
    els.listPane.innerHTML = `<div class="empty">${state.sessions.length
      ? `No session matches the filter.<br><button class="clear-f">show all ${state.sessions.length}</button>`
      : 'No tmux sessions yet.<br>Start one from the sidebar, or run <code>tmux new -s name</code>.'}</div>`;
    const cf = els.listPane.querySelector('.clear-f');
    if (cf) cf.onclick = () => { state.filter = null; setFilters({ fProject: null, fAgent: null }); };
    return;
  }
  for (const s of rows) {
    const row = document.createElement('div');
    row.className = 'row-item';
    row.dataset.session = s.name;
    row.innerHTML = `
      <div class="l1"><span class="pr"></span><span class="ag"></span><span class="name">${escapeHtml(displayName(s.name))}</span><span class="uc hidden"></span><span class="pp hidden">paused</span><span class="stw"></span><button class="pz" aria-label="Pause session" title="Pause (Esc, then hold)">&#9208;</button></div>
      <div class="last"></div>
      <div class="apill hidden"></div>
      <div class="meta"></div>`;
    row.querySelector('.last').textContent = rowLast(s.name);
    wireRow(row, s.name);
    els.listPane.appendChild(row);
    connectSession(s.name);
  }
  syncList();
}
// tap = open card, long-press = select as send target without opening
function wireRow(row, name) {
  let timer = 0, sx = 0, sy = 0, fired = false;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  row.addEventListener('pointerdown', (e) => {
    fired = false; sx = e.clientX; sy = e.clientY; cancel();
    timer = setTimeout(() => {
      timer = 0; fired = true;
      focusSession(name);
      if (navigator.vibrate) navigator.vibrate(10);
      toast(`\u2192 ${displayName(name)}`, 1000);
    }, 450);
  });
  row.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) row.addEventListener(t, cancel);
  row.addEventListener('contextmenu', (e) => e.preventDefault());
  row.addEventListener('click', () => {
    if (fired) { fired = false; return; }
    focusSession(name); openCard(name);
  });
}
function syncList() {
  // Reorder only when urgency order changed; otherwise update text in place.
  const order = byUrgency(visibleSessions()).map((s) => s.name).join('|');
  const cur = [...els.listPane.querySelectorAll('.row-item')].map((r) => r.dataset.session).join('|');
  if (order !== cur) {
    const want = order ? order.split('|') : [], have = cur ? cur.split('|') : [];
    if (want.length && want.length === have.length && want.every((n) => have.includes(n))) {
      const rowsBy = new Map([...els.listPane.querySelectorAll('.row-item')].map((r) => [r.dataset.session, r]));
      want.forEach((n, i) => {
        const row = rowsBy.get(n);
        if (els.listPane.children[i] !== row) els.listPane.insertBefore(row, els.listPane.children[i] || null);
      });
    } else { renderList(); return; }
  } else if (!order && !els.listPane.querySelector('.empty')) { renderList(); return; }
  for (const row of els.listPane.querySelectorAll('.row-item')) {
    const n = row.dataset.session;
    const s = vstateOf(n);
    row.className = `row-item ${s}${n === state.active ? ' focus' : ''}`;
    const ag = agentBadgeHtml(n);
    const agEl = row.querySelector('.ag');
    if (agEl.innerHTML !== ag) agEl.innerHTML = ag;
    syncPrioPause(row, n);
    const stw = row.querySelector('.stw');
    const sk = s + '|' + deployWaitTip(n);
    if (stw.dataset.s !== sk) { stw.dataset.s = sk; stw.innerHTML = stateBadgeHtml(n); }
    else stw.querySelector('.st').textContent = badgeText(n);
    syncAutoPill(row.querySelector('.apill'), n);
    const last = row.querySelector('.last'), lt = rowLast(n);
    if (last.textContent !== lt) last.textContent = lt;
    const mh = rowChipsHtml(n), meta = row.querySelector('.meta');
    if (meta.dataset.h !== mh) { meta.dataset.h = mh; meta.innerHTML = mh; }
    meta.classList.toggle('hidden', !mh);
  }
}

// ---------- sync (status tick) ----------
function syncAll() {
  renderSummary();
  renderFilterBar();
  renderAttention();
  syncTabs();
  syncSide();
  for (const host of [els.cardPane, els.gridPane]) for (const c of host.children) syncCell(c);
  if (state.mode === 'list') syncList();
  if (anyFilter() && state.mode === 'grid') renderGrid();
  syncDock();
}

// Elapsed timers tick locally between server updates.
function tickClock() {
  for (const el of document.querySelectorAll('.apill [data-at]')) el.textContent = autoLeft(Number(el.dataset.at));
  for (const el of document.querySelectorAll('.stw[data-s] .st')) {
    const host = el.closest('[data-session]');
    if (host) el.textContent = badgeText(host.dataset.session);
  }
}

// ---------- focus ----------
function focusSession(name) {
  if (!name) return;
  const prev = state.active;
  state.active = name;
  // grid: a session that isn't on screen takes the slot of the selected card, not the last one
  if (state.mode === 'grid' && prev && prev !== name
      && !els.gridPane.querySelector(`[data-session="${cssEscape(name)}"]`)
      && els.gridPane.querySelector(`[data-session="${cssEscape(prev)}"]`)) {
    state.gridView = [...els.gridPane.children].map((c) => (c.dataset.session === prev ? name : c.dataset.session));
  }
  els.appTitle.textContent = displayName(name);
  connectSession(name);
  if (state.mode === 'card') renderCard();
  if (state.mode === 'grid' && !els.gridPane.querySelector(`[data-session="${cssEscape(name)}"]`)) renderGrid();
  const tab = els.tabs.querySelector(`[data-session="${cssEscape(name)}"]`);
  if (tab) tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  syncAll();
}

function openCard(name) {
  focusSession(name);
  setMode('card');
}

// ---------- mode switching ----------
function setMode(mode) {
  if (mode !== 'card') state.prevMode = mode;
  state.mode = mode;
  lsSet(LS_MODE, mode);
  els.main.classList.remove('view-card','view-grid','view-list');
  els.main.classList.add(`view-${mode}`);
  document.body.dataset.mode = mode;
  for (const b of $$('.mode-btn')) b.classList.toggle('on', b.dataset.mode === mode);
  // size buttons are always visible; highlighted only while the grid is shown
  for (const b of $$('.size-btn')) b.classList.toggle('on', mode === 'grid' && Number(b.dataset.size) === state.gridSize);
  els.backBtn.classList.toggle('hidden', mode !== 'card');
  els.menuBtn.classList.toggle('hidden', mode === 'card');
  // Leaving a view: free its cells so xterm instances are reparented, not duplicated.
  if (mode !== 'card') els.cardPane.innerHTML = '';
  if (mode !== 'grid') els.gridPane.innerHTML = '';
  if (mode !== 'list') els.listPane.innerHTML = '';
  if (mode === 'card') renderCard();
  if (mode === 'grid') renderGrid();
  if (mode === 'list') renderList();
  syncAll();
}

function setGridSize(n) {
  state.gridSize = n;
  lsSet(LS_GRID, String(n));
  for (const b of $$('.size-btn')) b.classList.toggle('on', state.mode === 'grid' && Number(b.dataset.size) === n);
  if (state.mode === 'grid') { els.gridPane.innerHTML = ''; renderGrid(); }
}

// ---------- sidebar ----------
function openSide() {
  if (state.side) return;
  state.side = true;
  els.side.classList.add('on');
  let back = document.querySelector('.side-back');
  if (!back) {
    back = document.createElement('div');
    back.className = 'side-back';
    back.onclick = closeSide;
    document.body.appendChild(back);
  }
  requestAnimationFrame(() => back.classList.add('on'));
  fetchLeases();
}
function closeSide() {
  if (!state.side) return;
  state.side = false;
  els.side.classList.remove('on');
  const back = document.querySelector('.side-back');
  if (back) back.classList.remove('on');
}

// ---------- send dock ----------
const LS_PROMPTS = 'ghosty.prompts';
const LS_HIST    = 'ghosty.sendHistory';
const LS_RECENT  = 'ghosty.recentDirs';
const DEFAULT_PROMPTS = ['continue', 'yes, go ahead', 'commit and push', 'run the tests and fix failures', 'summarize status in 3 lines', '/clear'];
const HIST_MAX = 30;
const COARSE = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

const dk = {
  prompts: $('#prompts'), chips: $('#pchips'), histBtn: $('#histBtn'), multiBtn: $('#multiBtn'),
  mt: $('#mtargets'), stat: $('#dstat'), tchip: $('#tchip'), tdot: $('#tdot'), tname: $('#tname'),
};
const dock = {
  prompts: [], hist: [], multi: false, sel: new Set(), pending: null, hideTimer: 0,
  hidx: -1, recalled: null, chipsKey: '', mtKey: '',
};

function loadDock() {
  try { const p = JSON.parse(lsGet(LS_PROMPTS, 'null')); dock.prompts = Array.isArray(p) ? p.filter((x) => typeof x === 'string' && x.trim()) : DEFAULT_PROMPTS.slice(); }
  catch { dock.prompts = DEFAULT_PROMPTS.slice(); }
  try { const h = JSON.parse(lsGet(LS_HIST, '[]')); dock.hist = Array.isArray(h) ? h.slice(0, HIST_MAX) : []; }
  catch { dock.hist = []; }
}
function savePrompts() { lsSet(LS_PROMPTS, JSON.stringify(dock.prompts)); }
function pushHist(text) {
  const t = text.trim();
  if (!t) return;
  dock.hist = [text, ...dock.hist.filter((x) => x !== text)].slice(0, HIST_MAX);
  lsSet(LS_HIST, JSON.stringify(dock.hist));
  dock.hidx = -1;
}

// ---------- priority + pause + quota (TASK-44 phase 5) ----------
// Badge (P0 red / P1 amber / P2 grey) and the pause button on a card header or board row.
function syncPill(pp, n) {
  const t = holdPill(n);
  pp.classList.toggle('hidden', !t);
  if (t && pp.textContent !== t) pp.textContent = t;
  pp.title = heldOf(n) ? `held by the manager: ${heldOf(n).reason}` : '';
}
function syncPrioPause(el, n) {
  const pr = el.querySelector('.pr'), ph = prioBadgeHtml(n);
  if (pr.dataset.h !== ph) { pr.dataset.h = ph; pr.innerHTML = ph; }
  const paused = pausedOf(n) || !!heldOf(n);   // held: the button is Resume (releases the hold, sends "continue")
  el.classList.toggle('paused', paused);
  syncPill(el.querySelector('.pp'), n);
  syncUsageChip(el.querySelector('.uc'), n);
  const pz = el.querySelector('.pz');
  const glyph = paused ? '▶' : '⏸';
  if (pz.textContent !== glyph) {
    pz.textContent = glyph;
    pz.title = paused ? 'Resume (sends "continue")' : 'Pause (Esc, then hold)';
    pz.setAttribute('aria-label', paused ? 'Resume session' : 'Pause session');
  }
  pz.dataset.pause = n;
  pz.classList.toggle('on', paused);
}
// Today's API-equivalent cost chip (card header / board row); red + warning when the session is an outlier.
function syncUsageChip(c, n) {
  if (!c) return;
  const u = state.status[n]?.usage;
  const show = !!u && (u.todayTokens > 0 || u.outlier);
  c.classList.toggle('hidden', !show);
  if (!show) return;
  const t = u.todayCost != null ? `${fmtUsd(u.todayCost)} today` : `${fmtTok(u.todayTokens)} tok today`;
  const txt = u.outlier ? `\u26A0 ${t}` : t;
  if (c.textContent !== txt) c.textContent = txt;
  c.classList.toggle('out', !!u.outlier);
  c.dataset.uc = n;
  c.title = u.outlier ? `outlier: ${u.outlier}` : 'API-equivalent cost today (list prices), tap for usage';
}
async function metaPost(n, body) {
  const r = await fetch(`/api/session-meta/${encodeURIComponent(n)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  if (state.status[n]) { state.status[n].priority = j.priority; state.status[n].paused = j.paused; state.status[n].held = j.held || null; }
  return j;
}
// capture phase: these buttons sit inside cards / rows that open on tap
document.addEventListener('click', async (e) => {
  const pb = e.target.closest('[data-prio]');
  const zb = e.target.closest('[data-pause]');
  const ub = e.target.closest('[data-uc]');
  if (ub) {
    e.stopPropagation(); e.preventDefault();
    const u = state.status[ub.dataset.uc]?.usage;
    if (u?.outlier) toast(`outlier: ${u.outlier}`, 4000); else openUsage();
    return;
  }
  if (!pb && !zb) return;
  e.stopPropagation(); e.preventDefault();
  if (pb) { pickPriority(pb.dataset.prio); return; }
  const n = zb.dataset.pause;
  zb.disabled = true;
  try {
    const want = !(pausedOf(n) || heldOf(n));
    await metaPost(n, { paused: want });
    toast(want ? `paused ${displayName(n)} (Esc sent)` : `resumed ${displayName(n)}`);
    syncAll();
  } catch (err) { toast(`failed: ${err.message}`, 2500); }
  zb.disabled = false;
}, true);
function pickPriority(n) {
  openSheet(`Priority - ${displayName(n)}`, ({ body, close }) => {
    body.innerHTML = `<div class="prio-pick">${PRIORITIES.map((p) => `<button class="sbtn prio-opt ${p}${prioOf(n) === p ? ' cur' : ''}" data-p="${p}">${p}<span>${{ P0: 'urgent', P1: 'important', P2: 'normal' }[p]}</span></button>`).join('')}</div>`;
    body.onclick = async (e) => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      try { await metaPost(n, { priority: b.dataset.p }); close(); renderAll(); } catch (err) { toast(`failed: ${err.message}`, 2500); }
    };
  });
}

// Quota row: "codex 5h 2% · wk 32% · claude ? · minimax 5h 2% wk ∞". Amber >= 80 %, red >= 95 %.
const qLevel = (p) => (p == null ? 'na' : p >= 95 ? 'crit' : p >= 80 ? 'warn' : 'ok');
const winShort = (n) => (n === 'week' ? 'wk' : n === 'month' ? 'mo' : n);
function onQuota(q) {
  state.quota = q;
  const el = els.quota;
  if (!q || !q.plans?.length) { el.classList.add('hidden'); return; }
  const parts = q.plans.map((p) => {
    const short = p.plan;
    if (!p.windows.length) return `<span class="qi na" title="${escapeHtml(p.error || 'no reading yet')}"><b>${short}</b> ${/login|expired/i.test(p.error || '') ? 'login expired' : '?'}</span>`;
    const ws = p.windows.map((w) => {
      if (w.usedPercent == null) return `<span class="qi na">${winShort(w.name)} ${w.unlimited ? '&infin;' : '?'}</span>`;
      return `<span class="qi ${qLevel(w.usedPercent)}${p.stale ? ' old' : ''}">${winShort(w.name)} ${Math.round(w.usedPercent)}%</span>`;
    });
    return `<b>${short}</b> ${ws.join(' ')}`;
  });
  const worst = ['crit', 'warn'].find((l) => q.plans.some((p) => p.windows.some((w) => qLevel(w.usedPercent) === l))) || 'ok';
  el.className = `quota ${worst}`;
  el.innerHTML = parts.join('<i class="sep">&middot;</i>');
}
const resetText = (w) => {
  if (w.expired) return 'window has reset';
  if (!w.resetsAt) return 'reset time unknown';
  const mins = Math.max(0, Math.floor((w.resetsAt * 1000 - Date.now()) / 60e3));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const left = d ? `${d}d ${h}h ${m}min` : h ? `${h}h ${m}min` : `${m}min`;
  const when = new Date(w.resetsAt * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  return `reset ${when} - ${left} left`;
};
function openQuota() {
  const q = state.quota;
  if (!q) return;
  openSheet('Subscription quota', ({ body, foot, close }) => {
    foot.classList.remove('hidden');
    foot.innerHTML = '<span class="grow"></span><button class="sbtn" data-a="close">close</button>';
    foot.onclick = (e) => { if (e.target.closest('[data-a="close"]')) close(); };
    body.innerHTML = q.plans.map((p) => `
      <div class="qplan">
        <div class="qh"><b>${escapeHtml(p.label)}</b><span class="dim">${escapeHtml(p.planName || p.price)}</span></div>
        ${p.expires ? `<div class="mnote">plan expires ${new Date(p.expires).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</div>` : ''}
        ${p.windows.map((w) => w.usedPercent == null
          ? `<div class="qw na"><span>${escapeHtml(w.name)}</span><span>${w.unlimited ? 'unlimited' : 'unknown'}</span>${w.unlimited ? '' : `<span class="dim">${escapeHtml(resetText(w))}</span>`}</div>`
          : `<div class="qw ${qLevel(w.usedPercent)}"><span>${escapeHtml(w.name)}</span><span class="qbar"><i style="width:${Math.min(100, w.usedPercent)}%"></i></span><span>${Math.round(w.usedPercent)}%</span><span class="dim">${escapeHtml(resetText(w))}</span></div>`).join('')}
        ${p.note ? `<div class="mnote">${escapeHtml(p.note)}</div>` : ''}
        ${p.error ? `<div class="mnote warn">${escapeHtml(p.error)}</div>` : ''}
        <div class="mnote">${escapeHtml(p.source)}${p.at ? `, read ${new Date(p.at).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}` : ''}${p.stale && p.windows.length ? ' (not live)' : ''}</div>
      </div>`).join('');
  });
}
els.quota.onclick = openQuota;

// ---------- AI manager: auto-answer countdown + panel ----------
const autoLeft = (at) => `${Math.max(0, Math.ceil((at - Date.now()) / 1000))}s`;
// Pill on a card / board row while an automatic answer is pending: "auto: Yes, continue. in 23s ✕".
function syncAutoPill(el, n) {
  const a = state.status[n]?.auto;
  if (!a) { if (!el.classList.contains('hidden')) { el.classList.add('hidden'); el.dataset.id = ''; el.innerHTML = ''; } return; }
  el.classList.remove('hidden');
  if (el.dataset.id !== a.id) {
    el.dataset.id = a.id;
    el.innerHTML = `<span class="ap"><b>auto:</b> <span class="aa">${escapeHtml(a.answer)}</span> in <i data-at="${a.sendAt}">${autoLeft(a.sendAt)}</i><button class="ax" data-cancel="${escapeHtml(n)}" aria-label="Cancel auto answer" title="Cancel">&#10005;</button></span>`;
  }
}
// capture phase: a tap on the pill must not open the card / select the row
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cancel]');
  if (!b) return;
  e.stopPropagation(); e.preventDefault();
  const n = b.dataset.cancel;
  b.disabled = true;
  try {
    const r = await fetch(`/api/manager/cancel/${encodeURIComponent(n)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    toast(r.ok ? `auto answer cancelled — ${displayName(n)}` : 'too late, already sent');
    if (r.ok && state.status[n]) { state.status[n].auto = null; syncAll(); }
  } catch { toast('cancel failed'); }
}, true);

async function mgrPost(body) {
  const r = await fetch('/api/manager', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function startReview() {
  closeSheet();
  const { openReview } = await import('/review.js');
  openReview({
    toast,
    onSession: (n) => { if (state.status[n]) { focusSession(n); openCard(n); } else toast('session is not running'); },
    onClose: () => { if (new URLSearchParams(location.search).get('review')) history.replaceState(null, '', '/'); },
  });
}
const CASE_LABEL = { continue: 'continue? → "Yes, continue."', menu_recommended: 'recommended option', stopped_short: 'stopped short → "Yes, continue."', ask_status: 'no status → "what is done / tested / left?"' };
const firstLine = (t) => (String(t || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(-1)[0] || '').slice(0, 140);
let mgrUnlabelled = false;   // panel filter: only stops the owner has not labelled yet
const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toTimeString().slice(0, 5); };
function logLine(r) {
  const sess = displayName(r.session || '');
  if (r.type === 'stall') {
    const w = r.wouldSend ? (r.wouldSend.text != null ? r.wouldSend.text : `option ${r.wouldSend.key}`) : null;
    return { cls: w ? 'would' : 'owner', tag: w ? 'would' : 'owner', sess, case: r.case, text: w || r.why || '', stop: true };
  }
  if (r.type === 'answer') return { cls: 'sent', tag: 'answered', sess, case: r.case, text: r.answer?.text ?? `option ${r.answer?.key}` };
  if (r.type === 'answer_cancelled') return { cls: 'canc', tag: 'cancelled', sess, case: r.case || '', text: r.reason || '' };
  if (r.type === 'hold') return { cls: 'canc', tag: 'held', sess, case: 'quota', text: r.reason || '' };
  if (r.type === 'resume' && r.by === 'manager') return { cls: 'sent', tag: 'resumed', sess, case: 'quota', text: r.reason || '' };
  if (r.type === 'triage') return { cls: 'would', tag: 'AI', sess, case: r.case || '', text: r.ai ? `${r.ai.owner_needed ? 'needs you' : '\u201c' + r.ai.proposed_reply + '\u201d'} (${Number(r.ai.confidence).toFixed(2)}) ${r.ai.reasoning || ''}` : (r.skipped || r.error || '') };
  if (r.type === 'escalated') return { cls: 'esc', tag: 'escalated', sess, case: r.case || '', text: r.reason || '' };
  return null;
}
function depRow(d, d0) {
  const last = d0?.lastRef?.[d.env];
  const warn = ['awaiting-approval', 'queued'].includes(d.state) && last && last.ref !== d.ref;
  const blocking = (d.blocking || []).map((l) => `${escapeHtml(l.resource)} (${escapeHtml(l.agent)}${l.ttlLeftMin != null ? ` ${l.ttlLeftMin}m` : ''})`).join(', ');
  const btns = d.state === 'awaiting-approval' ? `<button class="sbtn on" data-dep="approve" data-id="${d.id}">Approve</button><button class="sbtn" data-dep="cancel" data-id="${d.id}">Cancel</button>`
    : d.state === 'queued' ? `<button class="sbtn" data-dep="cancel" data-id="${d.id}">Cancel</button>` : '';
  const tag = d.state === 'awaiting-approval' ? 'approve?' : d.state;
  return `<div class="dep ${d.state}"><div class="d1"><span class="dtag ${d.state}">${escapeHtml(tag)}</span><b>${escapeHtml(d.env)}</b><span class="dscope">${escapeHtml(d.scope)}</span><span class="grow"></span>${btns}</div>
    <div class="d2">${escapeHtml(d.ref)} &middot; ${escapeHtml(d.agent)}${d.purpose ? ` &middot; ${escapeHtml(d.purpose)}` : ''}</div>
    ${blocking ? `<div class="d2 dwait">waiting on ${blocking}</div>` : ''}
    ${warn ? `<div class="d2 dwarn">&#9888; replaces ${escapeHtml(last.ref)}${last.version ? ` (${escapeHtml(last.version)})` : ''} last deployed here</div>` : ''}
    ${d.state === 'running' ? `<pre class="dlog" data-log="${d.id}">…</pre>` : ''}
    ${d.coalescedInto ? `<div class="d2">merged into ${escapeHtml(d.coalescedInto)}</div>` : ''}${d.reason ? `<div class="d2">${escapeHtml(d.reason)}</div>` : ''}</div>`;
}
// "Deployed now" rows of one env (view model from deployedView): per target version, ref, commit, when, who, newer failed attempt.
function deployedRowsHtml(rows) {
  return rows.map((r) => `
    <div class="d2 dnrow"><span class="dscope">${escapeHtml(targetLabel(r.targets))}</span> ${r.deployed
      ? `<b>${escapeHtml(r.version || '?')}</b> &middot; ${escapeHtml(r.ref || '?')}${r.commit ? ` &middot; ${escapeHtml(r.commit)}` : ''} &middot; ${escapeHtml(r.ago)}${r.by && r.by !== 'unknown' ? ` &middot; ${escapeHtml(r.by)}` : ''}${r.backfill ? ' &middot; <i>read from the target</i>' : ''}`
      : '<span class="dim">no successful deploy recorded</span>'}
      ${r.failed ? `<div class="dwarn">&#9888; last attempt failed ${escapeHtml(r.failed.ago)}${r.failed.version ? ` (${escapeHtml(r.failed.version)})` : ''}${r.failed.by ? ` by ${escapeHtml(r.failed.by)}` : ''}</div>` : ''}</div>`).join('');
}
// Manager panel keeps only the runner switch; the queue, leases and "deployed now" live on the Platforms page.
function deploysHtml(d0) {
  if (!d0) return '<div class="dim">loading…</div>';
  const waiting = (d0.deploys || []).filter((x) => x.state === 'awaiting-approval').length;
  return `<button class="mswitch${d0.enabled ? ' on' : ''}" data-set="deployRunner"><i></i><span>Runs deploys <b>${d0.enabled ? 'ON' : 'OFF'}</b></span></button>
    ${d0.enabled ? '' : '<div class="mnote">runner is off: requests only queue. Agents then follow the manual flow when you tell them to.</div>'}
    ${d0.ok === false ? `<div class="mnote dwarn">registry unreachable &middot; ${escapeHtml(d0.error || '')}</div>` : ''}
    <button class="sbtn pf-link" data-plat-open="1">Platforms &rsaquo;${waiting ? ` <b>${waiting} to approve</b>` : ''}</button>`;
}

// ---------- Platforms page: leases per env, deploy queue, deployed now ----------
const platOpen = new Set();          // "Deployed now" sections the owner expanded
function platformsData() {
  const l = state.leases;
  const d0 = state.deploys;
  const hostname = l?.hostname || '';
  return { l, d0, view: l && !l.error ? platformsView({ leases: l.leases || [], deploys: d0?.deploys || [], waiters: l.waiters || [], deployed: d0?.deployed || {}, sessionNames: state.sessions.map((s) => s.name), machines: machinesOf(hostname), nowMs: Date.now() }) : [] };
}
function platformsHtml() {
  const { l, d0, view } = platformsData();
  if (!l) return '<div class="sheet-empty">loading…</div>';
  const err = [l.error ? `registry unreachable &middot; ${escapeHtml(l.error)}` : '', d0 && d0.ok === false ? `deploy queue unreachable &middot; ${escapeHtml(d0.error || '')}` : ''].filter(Boolean);
  const head = `${err.map((e) => `<div class="mnote dwarn">${e}</div>`).join('')}<div class="mnote">Runs deploys <b>${d0?.enabled ? 'ON' : 'OFF'}</b> &middot; change it in the AI manager</div>`;
  if (!view.length) return `${head}<div class="sheet-empty">no leases, no deploys: every platform is free</div>`;
  return head + view.map((e) => {
    const recent = (d0?.deploys || []).filter((x) => x.env === e.env && !['awaiting-approval', 'queued', 'running'].includes(x.state)).sort((a, b) => (b.finished || 0) - (a.finished || 0)).slice(0, 3);
    return `<section class="pf-env" data-env="${escapeHtml(e.env)}">
      <div class="pf-h">${escapeHtml(e.env)}</div>
      ${e.resources.length ? `<table class="pf-t"><thead><tr><th>resource</th><th>held by</th><th>left</th><th>purpose</th></tr></thead><tbody>${e.resources.map((r) => `
        <tr data-res="${escapeHtml(e.env + '|' + r.resource)}" class="${r.blocksDeploy ? 'blk' : ''}"><td class="pf-r">${escapeHtml(r.resource)}${r.blocksDeploy ? '<br><span class="pf-b">blocks deploy</span>' : ''}</td>
        <td>${r.session ? `<button class="pf-sess" data-open="${escapeHtml(r.session)}">${escapeHtml(displayName(r.session))} &#9656;</button>` : `<span class="pf-unk" title="no live session has exactly this name">unknown: ${escapeHtml(r.unknown)}</span>`}</td>
        <td class="pf-l">${r.ttlLeftMin != null ? escapeHtml(ttlLeft(r.ttlLeftMin)) : ''}</td><td class="pf-p">${escapeHtml(r.purpose)}</td></tr>`).join('')}</tbody></table>` : '<div class="dim pf-none">no leases: free</div>'}
      <div class="pf-sub">Deploy queue</div>
      ${e.queue.map((x) => `<div data-depid="${x.id}">${depRow(x, d0)}</div>`).join('') || '<div class="dim pf-none">no deploy queued</div>'}
      ${e.waiters.length ? `<div class="d2 dim">waiting for it: ${e.waiters.map((w) => escapeHtml(w.agent)).join(', ')}</div>` : ''}
      ${recent.map((x) => `<div class="d2 dim">${escapeHtml(x.state)} &middot; ${escapeHtml(x.scope)} &middot; ${escapeHtml(x.ref)}${x.version ? ` &middot; ${escapeHtml(x.version)}` : ''} &middot; ${escapeHtml(x.agent)}</div>`).join('')}
      <button class="pf-sum" data-pf-toggle="${escapeHtml(e.env)}"><span class="uch${platOpen.has(e.env) ? ' on' : ''}"></span><span>Deployed now &middot; ${escapeHtml(e.deployedSummary)}</span></button>
      ${platOpen.has(e.env) ? `<div class="dep dnow">${deployedRowsHtml(e.deployedRows) || '<div class="dim">nothing recorded yet</div>'}</div>` : ''}
    </section>`;
  }).join('');
}
const ttlLeft = (m) => (m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`);
function openPlatforms(focus) {
  openSheet('Platforms', ({ body, close }) => {
    body.closest('.sheet').classList.add('platforms');
    let last = '', pending = focus || null;
    const pollLogs = () => body.querySelectorAll('[data-log]').forEach(async (el) => {
      try { el.textContent = (await (await fetch(`/api/deploys/${el.dataset.log}/log?tail=12`)).text()) || '…'; el.scrollTop = el.scrollHeight; } catch {}
    });
    const draw = () => {
      const h = platformsHtml();
      if (h !== last) { last = h; body.innerHTML = h; pollLogs(); }
      if (pending) {
        const el = pending.deploy ? body.querySelector(`[data-depid="${CSS.escape(pending.deploy)}"]`) : body.querySelector(`[data-res="${CSS.escape(pending.res || '')}"]`);
        if (el) { pending = null; el.scrollIntoView({ block: 'center' }); el.classList.add('pf-hit'); setTimeout(() => el.classList.remove('pf-hit'), 2500); }
        else if (state.leases && state.deploys) pending = null;
      }
    };
    state.platSheet = draw;
    draw();
    fetchLeases();
    const timer = setInterval(() => { if (!body.isConnected) { clearInterval(timer); if (state.platSheet === draw) state.platSheet = null; } else pollLogs(); }, 3000);
    body.onclick = async (e) => {
      const o = e.target.closest('[data-open]');
      if (o) { close(); focusSession(o.dataset.open); openCard(o.dataset.open); return; }
      const t = e.target.closest('[data-pf-toggle]');
      if (t) { const k = t.dataset.pfToggle; platOpen.has(k) ? platOpen.delete(k) : platOpen.add(k); draw(); return; }
      const db = e.target.closest('[data-dep]');
      if (db) {
        db.disabled = true;
        try { const r = await fetch(`/api/deploys/${db.dataset.id}/${db.dataset.dep}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); if (!r.ok) toast((await r.json()).error || 'failed'); } catch { toast('failed'); }
        fetch('/api/deploys').then((r) => r.json()).then(onDeploys).catch(() => {});
      }
    };
  });
}
// chips and purple badges open Platforms at their resource / deploy; the manager panel and the ⋮ menu link to it
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-plat]');
  if (c) { e.stopPropagation(); openPlatforms({ res: c.dataset.plat }); return; }
  const w = e.target.closest('.state[data-wd]');
  if (w) { e.stopPropagation(); openPlatforms({ deploy: w.dataset.wd }); return; }
  if (e.target.closest('[data-plat-open]')) openPlatforms();
}, true);
function openManager() {
  openSheet('AI manager', async ({ body, foot, close }) => {
    body.innerHTML = '<div class="sheet-empty">loading…</div>';
    foot.classList.remove('hidden');
    foot.innerHTML = '<span class="grow"></span><button class="sbtn" data-a="close">close</button>';
    foot.onclick = (e) => { if (e.target.closest('[data-a="close"]')) close(); };
    const draw = async () => {
      let cfg, log;
      try {
        [cfg, log] = await Promise.all([
          fetch('/api/manager').then((r) => r.json()),
          fetch('/api/manager/log?limit=800').then((r) => r.json()),
        ]);
      } catch { body.innerHTML = '<div class="sheet-empty">could not load</div>'; return; }
      const off = new Set(cfg.disabledSessions || []);
      const heldNow = state.sessions.map((s) => s.name).filter((n) => state.status[n]?.held);
      const t = cfg.today || {};
      const labels = new Map();   // stall id -> newest owner label
      for (const r of log.entries || []) { if (r.type === 'label' && r.label) labels.set(r.id, r); else if (r.type === 'unlabel') labels.delete(r.id); }
      const entries = (log.entries || []).filter((r) => logLine(r) && !(mgrUnlabelled && (r.type !== 'stall' || labels.has(r.id)))).slice(-30).reverse();
      const caseOpts = (cfg.cases || []).map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      const stopRow = (r, l) => {
        const lab = labels.get(r.id);
        const live = !!state.status[r.session];
        return `<div class="ml stop ${l.cls}"><span class="t">${hhmm(r.at)}</span><span class="s${live ? ' go' : ''}" ${live ? `data-open="${escapeHtml(r.session)}"` : ''}>${escapeHtml(l.sess)}</span><span class="g ${l.cls}">${l.tag}</span><span class="c">${escapeHtml(l.case)}</span>
          <span class="x"><b>${escapeHtml(l.case)}</b>${r.no_status ? ' <i class="ns">no status</i>' : ''} &middot; ${escapeHtml(l.text)}</span>
          <span class="q">${escapeHtml(firstLine(r.excerpt || r.question))}</span>
          <span class="lab">${lab ? `<span class="lbd ${escapeHtml(lab.label)}">${lab.label === 'no_reason' ? '👎 no reason' : lab.label === 'legit' ? '👍 legit' : `wrong case${lab.correctCase ? ' → ' + escapeHtml(lab.correctCase) : ''}`}${lab.label !== 'wrong_case' && lab.correctCase ? ` <span class="dim">(case → ${escapeHtml(lab.correctCase)})</span>` : ''}</span>${lab.note ? `<span class="dim"> ${escapeHtml(lab.note)}</span>` : ''}`
            : `<button class="sbtn lb" data-label="no_reason" data-id="${escapeHtml(r.id)}" title="stopped for no reason" aria-label="stopped for no reason">👎</button><button class="sbtn lb" data-label="legit" data-id="${escapeHtml(r.id)}" title="legit stop" aria-label="legit stop">👍</button><select class="lb" data-wrong="${escapeHtml(r.id)}" aria-label="wrong case"><option value="">wrong case…</option>${caseOpts}</select><input class="lbn" data-note="${escapeHtml(r.id)}" placeholder="note" maxlength="500">`}</span></div>`;
      };
      body.innerHTML = `
        <div class="side-sub nocollapse">Deploys</div><div id="depBox">${deploysHtml(state.deploys)}</div>
        <button class="mswitch${cfg.autoSend ? ' on' : ''}" data-set="autoSend"><i></i><span>Auto-answer <b>${cfg.autoSend ? 'ON' : 'OFF'}</b></span></button>
        <div class="mcases">${(cfg.validCases || []).map((c) => `<label class="mchk"><input type="checkbox" data-case="${c}" ${(cfg.autoCases || []).includes(c) ? 'checked' : ''}><span>${escapeHtml(CASE_LABEL[c] || c)}</span></label>`).join('')}</div>
        <div class="mnote">sends after ${Math.round(cfg.delayMs / 1000)}s (cancel from the pill) · Jev answers need ≥ ${cfg.minConfidence} · max ${cfg.maxPerSessionPerHour}/h per session · never deploy / push / delete / secrets / money</div>
        <div class="side-sub">AI reviewer</div>
        <div class="aimodes">${(cfg.aiModes || []).map((m) => `<button class="sbtn${cfg.aiTriage === m ? ' on' : ''}" data-aimode="${m}">${m}</button>`).join('')}</div>
        <div class="mnote">${cfg.aiTriage === 'simulate' ? 'simulation: proposes a reply and shows it with its reasoning; nothing is typed for you' : cfg.aiTriage === 'auto' ? `auto: owner-free proposals \u2265 ${cfg.aiMinConfidence} go through the same countdown and caps (needs Auto-answer ON); never deploy / push / delete / secrets / money / customer` : 'off: no AI calls'}${cfg.ai ? '' : ' \u00b7 <b>no reviewer server configured</b>'}</div>
        <div class="mcounts"><span class="dim">today</span><span class="sent"><b>${cfg.aiBudget ? cfg.aiBudget.calls : 0}</b>/${cfg.aiBudget ? cfg.aiBudget.dailyCalls : 0} calls</span><span class="esc"><b>$${cfg.aiBudget ? Number(cfg.aiBudget.cost).toFixed(3) : '0'}</b>/$${cfg.aiBudget ? Number(cfg.aiBudget.dailyUsd).toFixed(2) : '0'}</span></div>
        <div class="mnote">${cfg.aiStats ? `AI agreement: ${cfg.aiStats.agreement == null ? 'no ratings yet' : `<b>${Math.round(cfg.aiStats.agreement * 100)} %</b> (${cfg.aiStats.right} right / ${cfg.aiStats.wrong} wrong)`} \u00b7 ${cfg.aiStats.proposals} proposals, ${cfg.aiStats.unrated} unrated \u2014 rate them in the swipe review` : ''}</div>
        <div class="side-sub">Quota policy</div>
        <button class="mswitch${cfg.policyEnabled ? ' on' : ''}" data-set="policyEnabled"><i></i><span>Policy <b>${cfg.policyEnabled ? 'ON' : 'OFF'}</b></span></button>
        <div class="mnote">P0 always continues · P1 while the 5h window is under ${cfg.p1MaxPct}% · P2 is held at its next stop when 5h ≥ ${cfg.p2MaxPct}% or the week would run out before reset · a hold never interrupts a working session</div>
        <div class="mheld">${heldNow.map((n) => `<div class="mh"><b>${escapeHtml(displayName(n))}</b> ${escapeHtml(prioOf(n))} <span class="dim">${escapeHtml(state.status[n].held.reason)}</span></div>`).join('') || '<div class="dim">no session held</div>'}</div>
        <div class="mcounts"><span class="sent"><b>${t.answered ?? 0}</b> answered</span><span class="canc"><b>${t.cancelled ?? 0}</b> cancelled</span><span class="esc"><b>${t.escalated ?? 0}</b> escalated</span><span class="dim">today</span></div>
        <button class="mswitch on rvlink" data-review="1"><i></i><span>Review stops (${log.entries ? (log.entries || []).filter((r) => r.type === 'stall' && !labels.has(r.id)).length : 0}) &rarr; swipe</span></button>
        <div class="side-sub">Last ${entries.length}</div>
        <label class="mchk"><input type="checkbox" data-unlab ${mgrUnlabelled ? 'checked' : ''}><span>unlabelled stops only</span></label>
        <div class="mlog">${entries.map((r) => { const l = logLine(r); if (l.stop) return stopRow(r, l); return `<div class="ml ${l.cls}"><span class="t">${hhmm(r.at)}</span><span class="s">${escapeHtml(l.sess)}</span><span class="g ${l.cls}">${l.tag}</span><span class="c">${escapeHtml(l.case)}</span><span class="x">${escapeHtml(l.text)}</span></div>`; }).join('') || '<div class="dim">nothing logged yet</div>'}</div>
        <div class="side-sub">Sessions</div>
        <div class="msess">${state.sessions.filter((s) => ['claude', 'codex', 'minimax'].includes(agentOf(s.name))).map((s) => `<label class="mchk"><input type="checkbox" data-sess="${escapeHtml(s.name)}" ${off.has(s.name) ? '' : 'checked'}><span>${escapeHtml(displayName(s.name))}</span></label>`).join('') || '<div class="dim">no agent sessions</div>'}</div>`;
    };
    state.depSheet = () => { const box = body.querySelector('#depBox'); if (box) box.innerHTML = deploysHtml(state.deploys); };
    const logTimer = setInterval(() => { if (!body.isConnected) { clearInterval(logTimer); state.depSheet = null; } }, 3000);
    body.onclick = async (e) => {
      const o = e.target.closest('[data-open]');
      if (o) { close(); focusSession(o.dataset.open); openCard(o.dataset.open); return; }
      if (e.target.closest('[data-review]')) { startReview(); return; }
      const lb = e.target.closest('[data-label]');
      if (lb) {
        const id = lb.dataset.id;
        const note = body.querySelector(`[data-note="${CSS.escape(id)}"]`)?.value.trim() || undefined;
        try {
          const r = await fetch('/api/manager/label', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, label: lb.dataset.label, note }) });
          if (!r.ok) throw new Error(r.status);
        } catch { toast('label failed'); }
        draw(); return;
      }
      const am = e.target.closest('[data-aimode]');
      if (am) { try { await mgrPost({ aiTriage: am.dataset.aimode }); } catch { toast('save failed'); } draw(); return; }
      const sw = e.target.closest('[data-set]');
      if (sw) { try { await mgrPost({ [sw.dataset.set]: !sw.classList.contains('on') }); } catch { toast('save failed'); } draw(); }
    };
    body.onchange = async (e) => {
      const i = e.target;
      try {
        if (i.dataset.unlab !== undefined) { mgrUnlabelled = i.checked; draw(); return; }
        if (i.dataset.wrong !== undefined) {
          if (!i.value) return;
          const note = body.querySelector(`[data-note="${CSS.escape(i.dataset.wrong)}"]`)?.value.trim() || undefined;
          const r = await fetch('/api/manager/label', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: i.dataset.wrong, label: 'wrong_case', correctCase: i.value, note }) });
          if (!r.ok) throw new Error(r.status);
          draw(); return;
        }
        if (i.dataset.case) {
          const cases = [...body.querySelectorAll('[data-case]')].filter((x) => x.checked).map((x) => x.dataset.case);
          await mgrPost({ autoCases: cases });
        } else if (i.dataset.sess) await mgrPost({ session: i.dataset.sess, sessionEnabled: i.checked });
      } catch { toast('save failed'); }
      draw();
    };
    draw();
  });
}
els.mgrBtn.onclick = openManager;
$('#platBtn').onclick = () => openPlatforms();
document.getElementById('reviewBtn').onclick = startReview;
// top-bar "more" menu: AI manager, usage, alerts, install/APK, text size
{
  const mb = $('#moreBtn'), mp = $('#morePop');
  mb.onclick = (e) => { e.stopPropagation(); mp.classList.toggle('hidden'); };
  mp.onclick = (e) => { e.stopPropagation(); if (e.target.closest('.icon-btn')) mp.classList.add('hidden'); };
  document.addEventListener('click', () => mp.classList.add('hidden'));
}

// ---------- usage view (TASK-44 phase 3): API-equivalent cost, never money spent ----------
const LANGFUSE_URL = 'http://<tailscale-ip>:3100';   // tailnet
const SUBSCRIPTION = { claude: 'Claude Max 200 EUR/month', codex: 'ChatGPT Plus 20 EUR/month', minimax: 'MiniMax 40 EUR/month' };
const usd = (c, unit = '') => (c == null ? '<span class="dim" title="unpriced: no list price for this model">&mdash;</span>' : escapeHtml(fmtUsd(c)) + unit);
const tokLine = (e) => `<span class="ut">in ${fmtTok(e.input ?? e.in)} &middot; out ${fmtTok(e.output ?? e.out)} &middot; cache r ${fmtTok(e.cache_read ?? e.cr)} &middot; cache w ${fmtTok(e.cache_creation ?? e.cw)}</span>`;
function quotaOfAgent(a) {
  const p = state.quota?.plans?.find((x) => x.plan === a);
  if (!p || !p.windows?.length) return `<span class="dim" title="${escapeHtml(p?.error || '')}">${/login|expired/i.test(p?.error || '') ? 'login expired, open mcode once' : 'quota ?'}</span>`;
  return p.windows.map((w) => w.usedPercent == null
    ? `<span class="qi na">${winShort(w.name)} ${w.unlimited ? '&infin;' : '?'}</span>`
    : `<span class="qi ${qLevel(w.usedPercent)}${p.stale ? ' old' : ''}">${winShort(w.name)} ${Math.round(w.usedPercent)}%</span>`).join(' ');
}
// agent of a model name (perModel is global, but every model belongs to exactly one agent)
const modelAgent = (m) => (/^claude/i.test(m) ? 'claude' : /^gpt|codex|^o\d/i.test(m) ? 'codex' : /minimax|^m\d/i.test(m) ? 'minimax' : 'other');
const tokIO = (e) => `${fmtTok(e.total ?? e.tokens)} tok &middot; in ${fmtTok(e.input ?? e.in)} &middot; out ${fmtTok(e.output ?? e.out)}`;
const sumCost = (list) => (list.length && list.every((r) => r.cost == null) ? null : list.reduce((s, r) => s + (r.cost || 0), 0));
function groupRows(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const g = m.get(r[key]) || { name: r[key], list: [] };
    g.list.push(r); m.set(r[key], g);
  }
  return [...m.values()].map((g) => ({
    name: g.name, cost: sumCost(g.list), total: g.list.reduce((s, r) => s + r.tokens, 0),
    input: g.list.reduce((s, r) => s + r.in, 0), output: g.list.reduce((s, r) => s + r.out, 0),
    cache_read: g.list.reduce((s, r) => s + r.cr, 0), cache_creation: g.list.reduce((s, r) => s + r.cw, 0),
    models: [...new Set(g.list.flatMap((r) => r.models))],
  })).sort((x, y) => ((y.cost ?? -1) - (x.cost ?? -1)) || (y.total - x.total));
}
// Burn-rate projection for one quota window: where usage lands at the reset if it keeps this pace.
const WIN_MIN = { '5h': 300, week: 10080 };
const fmtMin = (m) => { m = Math.max(0, Math.round(m)); const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`; };
function paceOf(w) {
  const total = w.minutes || WIN_MIN[w.name];
  if (!total || w.usedPercent == null || !w.resetsAt || w.expired) return null;
  const left = (w.resetsAt * 1000 - Date.now()) / 60000, el = total - left;
  if (left <= 0 || el <= 0) return null;
  const frac = Math.min(1, el / total), rate = w.usedPercent / el;
  const toFull = rate > 0 ? (100 - w.usedPercent) / rate : Infinity;
  return { frac, left, proj: frac >= 0.05 ? w.usedPercent / frac : null, toFull, runsOut: frac >= 0.05 && toFull < left };
}
function quotaPaceHtml(q, onlyAgent) {
  const plans = (q?.plans || []).filter((p) => !onlyAgent || p.plan === onlyAgent);
  if (!plans.length) return '<div class="dim">no quota reading yet</div>';
  return plans.map((p) => {
    const head = `<div class="u1"><i class="adot ${escapeHtml(p.plan)}"></i><b>${escapeHtml(p.label || p.plan)}</b><span class="grow"></span><span class="dim">${escapeHtml(p.price || '')}</span></div>`;
    if (!p.windows?.length) return `<div class="urow">${head}<div class="u2 uo">${escapeHtml(/login|expired/i.test(p.error || '') ? 'login expired, open mcode once to refresh' : (p.error || 'no reading yet'))}</div></div>`;
    const rows = p.windows.map((w) => {
      if (w.usedPercent == null) return `<div class="qp"><span class="qn">${escapeHtml(w.name)}</span><span class="qb na"></span><span class="qt dim">${w.unlimited ? 'unlimited' : 'unknown'}</span></div>`;
      const pc = paceOf(w), used = Math.min(100, w.usedPercent);
      const lvl = qLevel(w.usedPercent) === 'na' ? 'ok' : qLevel(w.usedPercent);   // from what is used, not a forecast
      const verdict = resetText(w);
      return `<div class="qp"><span class="qn">${escapeHtml(w.name)}</span><span class="qb ${lvl}"><i style="width:${used}%"></i>${pc ? `<u style="left:${Math.round(pc.frac * 100)}%" title="time elapsed in this window"></u>` : ''}</span><span class="qv ${lvl}">${Math.round(w.usedPercent)}%</span></div><div class="u2 qverdict">${verdict}</div>`;
    }).join('');
    return `<div class="urow">${head}${rows}</div>`;
  }).join('');
}
// ui = { f: {agent, project, q}, open: {agent, project, session, day}, openAgents: Set }
function usageHtml(u, tab, ui) {
  const today = tab === 'today';
  if (today && !summaryFresh(u, Date.now())) return '<div class="sheet-empty">no usage today yet (summary is from an earlier day)</div>';
  if (today && !u.today) return '<div class="sheet-empty">today needs the updated ghosty-usage tailer (restart the unit)</div>';
  const src = today ? u.today : u;
  const { agent: fa, project: fp, q } = ui.f;
  const filtered = !!(fa || fp || q);
  const allRows = sessionRows(u, tab);
  const rows = allRows.filter((r) => (!fa || r.agent === fa) && (!fp || r.project === fp) && (!q || r.session === q));
  const live = (name) => !!state.status[name];
  const chev = (on) => `<i class="uch${on ? ' on' : ''}"></i>`;
  const sec = (key, title, count, cost, inner) => `<div class="usec-wrap"><button class="usec" data-sec="${key}">${chev(ui.open[key])}<span>${title}</span><span class="dim">${count}</span><span class="grow"></span>${cost === undefined ? '' : usd(cost)}</button>${ui.open[key] ? `<div class="usec-body">${inner}</div>` : ''}</div>`;

  // totals: the summary's own, or the sum of the filtered sessions
  let total = today ? u.today.total : u.total;
  if (filtered) {
    total = { cost: sumCost(rows) ?? 0, unpriced: rows.every((r) => r.cost == null) && rows.length ? 1 : 0, turns: rows.reduce((s, r) => s + r.turns, 0),
      input: rows.reduce((s, r) => s + r.in, 0), output: rows.reduce((s, r) => s + r.out, 0),
      cache_read: rows.reduce((s, r) => s + r.cr, 0), cache_creation: rows.reduce((s, r) => s + r.cw, 0) };
  }
  const totCost = total.cost === 0 && total.unpriced > 0 ? null : total.cost;
  const totalHtml = `<div class="utot"><span class="dim">${today ? 'today (UTC day)' : `last ${u.windowDays} days`}${filtered ? ' &middot; filtered' : ''} &middot; ${total.turns ?? 0} turns${!filtered && total.unpriced ? ` &middot; ${total.unpriced} unpriced` : ''}</span><br>${tokLine(total)}</div>`;

  // agents (with their models nested); derived from the filtered sessions when a project/session filter is on
  const narrowed = !!(fp || q);
  let agents = narrowed ? groupRows(rows, 'agent') : topEntries(src.perAgent).filter((a) => !fa || a.name === fa);
  const modelsOf = (a) => (narrowed
    ? a.models.map((m) => ({ name: m, nocost: true }))
    : topEntries(src.perModel).filter((m) => modelAgent(m.name) === a.name));
  const agentHtml = agents.map((a) => {
    const on = ui.openAgents.has(a.name), ms = modelsOf(a);
    return `<div class="urow ag"><div class="u1 tog" data-agent="${escapeHtml(a.name)}">${chev(on)}<i class="adot ${escapeHtml(a.name)}"></i><b>${escapeHtml(a.name)}</b><span class="dim">${ms.length} model${ms.length === 1 ? '' : 's'}</span><span class="grow"></span>${usd(a.cost)}</div>
      <div class="u2">${escapeHtml(SUBSCRIPTION[a.name] || 'subscription ?')} &middot; ${quotaOfAgent(a.name)}</div>
      <div class="u2">${tokLine(a)}</div>
      ${on ? `<div class="umodels">${ms.map((m) => `<div class="urow sub"><div class="u1"><b>${escapeHtml(m.name)}</b><span class="grow"></span>${m.nocost ? '' : usd(m.cost)}</div>${m.nocost ? '' : `<div class="u2">${tokIO(m)}</div>`}</div>`).join('') || '<div class="dim">none</div>'}</div>` : ''}</div>`;
  }).join('') || '<div class="dim">none</div>';

  const projects = (fa || q ? groupRows(rows, 'project') : topEntries(src.perProject, 10)).filter((p) => !fp || p.name === fp);
  const projHtml = projects.map((p) => `<div class="urow"><div class="u1"><b>${escapeHtml(p.name)}</b><span class="grow"></span>${usd(p.cost)}</div><div class="u2">${tokIO(p)}</div></div>`).join('') || '<div class="dim">none</div>';

  const shown = rows.slice(0, 40);
  const sessHtml = shown.map((r) => `<div class="urow${live(r.session) ? ' go' : ''}${r.outlier ? ' out' : ''}" ${live(r.session) ? `data-open="${escapeHtml(r.session)}"` : ''}>
      <div class="u1">${r.outlier ? '<span class="uw" title="outlier">&#9888;</span>' : ''}<i class="adot ${escapeHtml(r.agent)}"></i><b>${escapeHtml(r.session)}</b><span class="grow"></span>${usd(r.cost)}</div>
      <div class="u2">${escapeHtml(r.project)} &middot; ${tokIO({ tokens: r.tokens, in: r.in, out: r.out })} &middot; ${r.rate != null ? `${escapeHtml(fmtUsd(r.rate))}/h` : '&mdash;/h'}</div>
      ${r.outlier ? `<div class="u2 uo">outlier: ${escapeHtml(r.outlier)}</div>` : ''}</div>`).join('') || '<div class="dim">no session matches</div>';

  const days = today ? '' : sec('day', 'Per day', '', undefined, `<div class="ubars">${dayBars(u, u.windowDays).map((d) => `<div class="ubar"><span class="ud">${d.day.slice(5)}</span><span class="uw2"><i style="width:${Math.round(d.frac * 100)}%"></i></span><span class="uv">${d.cost == null ? `${fmtTok(d.total)} tok` : usd(d.cost)}</span></div>`).join('')}</div>`);
  return sec('quota', 'Quota &amp; pace', '', undefined, quotaPaceHtml(state.quota, fa))
    + sec('agent', 'Agents &amp; models', agents.length, undefined, agentHtml)
    + sec('project', 'Projects', projects.length, undefined, projHtml)
    + sec('session', 'Sessions', `${shown.length}${rows.length > shown.length ? ` of ${rows.length}` : ''}`, undefined, sessHtml)
    + sec('total', 'Total', '', totCost, totalHtml)
    + (filtered ? '' : days);
}
function openUsage() {
  openSheet('Usage · API-equivalent', ({ body, foot, close }) => {
    body.closest('.sheet').classList.add('usage');
    foot.classList.remove('hidden');
    foot.innerHTML = `<a class="sbtn lf" href="${LANGFUSE_URL}" target="_blank" rel="noopener"><img src="/langfuse.svg" width="16" height="16" alt="">Langfuse</a><span class="grow"></span><button class="sbtn" data-a="close">close</button>`;
    foot.onclick = (e) => { if (e.target.closest('[data-a="close"]')) close(); };
    const ui = { f: { agent: '', project: '', q: '' }, open: { total: true, quota: true, agent: true, project: true, session: true, day: true }, openAgents: new Set() };
    let tab = 'today', data = null;
    body.innerHTML = `<div class="utabs"><button class="sbtn on" data-tab="today">Today</button><button class="sbtn" data-tab="14d">14 days</button></div>
      <div class="ufilters"><select data-f="agent" aria-label="Filter by agent"><option value="">all agents</option></select><select data-f="project" aria-label="Filter by project"><option value="">all projects</option></select><div class="ucombo"><button type="button" class="ucb" data-combo aria-label="Filter by session"><span class="ucl">all sessions</span></button><div class="ucpanel hidden"><input class="ucs" type="search" placeholder="search session…" aria-label="Search sessions"><div class="uclist"></div></div></div></div>
      <div class="ucontent"><div class="sheet-empty">loading…</div></div>`;
    const content = body.querySelector('.ucontent');
    const fillOptions = () => {
      const rows = sessionRows(data, tab);
      const set = (sel, vals) => {
        const cur = ui.f[sel.dataset.f];
        const list = [...new Set(vals)].sort();
        if (cur && !list.includes(cur)) list.push(cur);
        sel.innerHTML = `<option value="">all ${sel.dataset.f === 'agent' ? 'agents' : 'projects'}</option>` + list.map((v) => `<option value="${escapeHtml(v)}"${v === cur ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
      };
      set(body.querySelector('[data-f="agent"]'), rows.map((r) => r.agent));
      set(body.querySelector('[data-f="project"]'), rows.map((r) => r.project));
      combo.names = [...new Set(rows.map((r) => r.session))].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
      drawCombo();
    };
    const combo = { names: [], term: '' };
    const drawCombo = () => {
      const cur = ui.f.q, term = combo.term.toLowerCase();
      body.querySelector('.ucl').textContent = cur || 'all sessions';
      body.querySelector('.ucb').classList.toggle('sel', !!cur);
      const items = [''].concat(combo.names).filter((n) => !n || !term || n.toLowerCase().includes(term));
      body.querySelector('.uclist').innerHTML = items.map((n) => `<button type="button" class="uci${n === cur ? ' on' : ''}" data-session-pick="${escapeHtml(n)}">${n ? escapeHtml(n) : 'all sessions'}</button>`).join('') || '<div class="dim">no match</div>';
    };
    const closeCombo = () => body.querySelector('.ucpanel').classList.add('hidden');
    const draw = () => {
      for (const b of body.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
      content.innerHTML = data ? usageHtml(data, tab, ui) : '<div class="sheet-empty">loading…</div>';
    };
    body.onclick = (e) => {
      const cb = e.target.closest('[data-combo]');
      if (cb) {
        const p = body.querySelector('.ucpanel'), open = p.classList.contains('hidden');
        p.classList.toggle('hidden', !open);
        if (open) { combo.term = ''; body.querySelector('.ucs').value = ''; drawCombo(); body.querySelector('.ucs').focus(); }
        return;
      }
      const pick = e.target.closest('[data-session-pick]');
      if (pick) { ui.f.q = pick.dataset.sessionPick; closeCombo(); drawCombo(); draw(); return; }
      if (!e.target.closest('.ucpanel')) closeCombo();
      const t = e.target.closest('[data-tab]');
      if (t) { tab = t.dataset.tab; if (data) fillOptions(); draw(); return; }
      const s = e.target.closest('[data-sec]');
      if (s) { ui.open[s.dataset.sec] = !ui.open[s.dataset.sec]; draw(); return; }
      const g = e.target.closest('[data-agent]');
      if (g) { const n = g.dataset.agent; if (!ui.openAgents.delete(n)) ui.openAgents.add(n); draw(); return; }
      const o = e.target.closest('[data-open]');
      if (o) { close(); focusSession(o.dataset.open); openCard(o.dataset.open); }
    };
    body.oninput = (e) => {
      if (e.target.classList.contains('ucs')) { combo.term = e.target.value.trim(); drawCombo(); return; }
      const f = e.target.dataset.f; if (!f) return; ui.f[f] = e.target.value.trim(); draw();
    };
    draw();
    fetch('/api/usage').then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((j) => { data = j; fillOptions(); draw(); })
      .catch(() => { content.innerHTML = '<div class="sheet-empty">no usage summary yet (is the ghosty-usage unit running?)</div>'; });
  });
}
els.usageBtn.onclick = openUsage;

// ----- generic bottom sheet -----
let sheetEl = null;
function closeSheet() {
  if (!sheetEl) return;
  const el = sheetEl; sheetEl = null;
  el.classList.remove('on');
  setTimeout(() => el.remove(), 180);
}
function openSheet(title, build) {
  closeSheet();
  const back = document.createElement('div');
  back.className = 'sheet-back';
  back.innerHTML = `<div class="sheet" role="dialog" aria-label="${escapeHtml(title)}">
    <div class="sheet-grab"></div>
    <div class="sheet-title">${escapeHtml(title)}</div>
    <div class="sheet-body"></div>
    <div class="sheet-foot hidden"></div></div>`;
  back.addEventListener('pointerdown', (e) => { if (e.target === back) closeSheet(); });
  document.body.appendChild(back);
  sheetEl = back;
  const api = { close: closeSheet, body: back.querySelector('.sheet-body'), foot: back.querySelector('.sheet-foot'), title: back.querySelector('.sheet-title') };
  build(api);
  // house rule: every popup has a visible frame (CSS) and a bordered close button
  if (api.foot.classList.contains('hidden') && !api.foot.children.length) {
    api.foot.classList.remove('hidden');
    api.foot.innerHTML = '<span class="grow"></span><button class="sbtn" data-a="close">close</button>';
    api.foot.onclick = (e) => { if (e.target.closest('[data-a="close"]')) closeSheet(); };
  }
  requestAnimationFrame(() => back.classList.add('on'));
  return api;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetEl) closeSheet(); });

const RANK2 = STATE_RANK;
function sortedByNeed() {
  return [...state.sessions].sort((a, b) =>
    byPriority(prioOf(a.name), prioOf(b.name)) ||
    ((RANK2[vstateOf(a.name)] ?? 6) - (RANK2[vstateOf(b.name)] ?? 6)) ||
    displayName(a.name).localeCompare(displayName(b.name)));
}
function agentDotHtml(n) { return `<i class="adot ${agentOf(n)}"></i>`; }

// ----- targets -----
function dockTargets() {
  if (dock.multi) return state.sessions.map((s) => s.name).filter((n) => dock.sel.has(n));
  return state.active ? [state.active] : [];
}

// ----- sending -----
async function postSend(name, body) {
  const r = await fetch(`/api/send/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  state.sentAt[name] = Date.now();
}

// Returns the list of session names that failed.
async function postMany(targets, keys) {
  let r = null;
  try {
    r = await fetch('/api/send-many', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessions: targets, keys }),
    });
  } catch { r = null; }
  if (r && r.ok) {
    const j = await r.json().catch(() => null);
    const now = Date.now();
    for (const n of targets) state.sentAt[n] = now;
    const res = j && (j.results || j);
    const failed = [];
    if (Array.isArray(res)) res.forEach((x, i) => { if (x && x.ok === false) failed.push(x.session || x.name || targets[i]); });
    else if (res && typeof res === 'object') for (const [k, v] of Object.entries(res)) if (v && v.ok === false && targets.includes(k)) failed.push(k);
    return failed;
  }
  if (r && r.status !== 404 && r.status !== 405) throw new Error(`HTTP ${r.status}`);
  const settled = await Promise.allSettled(targets.map((n) => postSend(n, { keys })));
  return targets.filter((_, i) => settled[i].status === 'rejected');
}

async function dispatch(text, targets, isRetry) {
  if (!targets.length || !text.trim()) return false;
  const at = Date.now();
  clearTimeout(dock.hideTimer);
  const snap = {};
  for (const n of targets) snap[n] = state.paneText.get(n);
  const p = dock.pending = { text, targets: targets.slice(), at, snap, phase: 'sending', done: new Set(), failed: [] };
  renderDockStatus();
  try {
    const failed = targets.length > 1 ? await postMany(targets, text) : (await postSend(targets[0], { keys: text }), []);
    if (dock.pending !== p) return true;
    p.failed = failed;
    p.phase = failed.length ? 'error' : 'sent';
    if (failed.length === targets.length) p.phase = 'error';
  } catch (err) {
    if (dock.pending !== p) return false;
    p.phase = 'error'; p.failed = targets.slice(); p.err = err.message;
  }
  if (p.phase !== 'error' && !isRetry) pushHist(text);
  renderDockStatus();
  checkDelivery();
  return p.phase !== 'error';
}

async function send() {
  const keys = els.sendInput.value;
  const targets = dockTargets();
  if (!keys.trim()) return;
  if (!targets.length) { toast(dock.multi ? 'pick at least one target' : 'no session'); return; }
  els.sendInput.value = '';
  autoGrow();
  dock.recalled = null;
  const ok = await dispatch(keys, targets);
  if (!ok && !els.sendInput.value) { els.sendInput.value = keys; autoGrow(); }
}

async function sendKey(name, key) {
  if (!name) return;
  try {
    await postSend(name, { key });
    if (navigator.vibrate) navigator.vibrate(10);
  } catch (err) {
    toast(`key failed: ${err.message}`);
  }
}

// ----- delivered tick -----
function checkDelivery() {
  const p = dock.pending;
  if (!p || p.phase === 'sending' || p.phase === 'error') return;
  for (const n of p.targets) {
    if (p.failed.includes(n) || p.done.has(n)) continue;
    const st = state.status[n] || {};
    const paneChanged = p.snap[n] !== undefined && state.paneText.get(n) !== undefined && state.paneText.get(n) !== p.snap[n];
    if ((st.lastSendAck && st.lastSendAck >= p.at - 3000) || paneChanged) p.done.add(n);
  }
  const want = p.targets.length - p.failed.length;
  const wasDelivered = p.phase === 'delivered';
  if (want > 0 && p.done.size >= want) p.phase = 'delivered';
  if (p.phase === 'delivered' && !wasDelivered) {
    renderDockStatus();
    dock.hideTimer = setTimeout(() => { if (dock.pending === p) { dock.pending = null; renderDockStatus(); } }, 2800);
  } else if (!wasDelivered && Date.now() - p.at > 20000) {
    dock.pending = null; renderDockStatus();
  } else if (dock.pending === p) renderDockStatus();
}

function renderDockStatus() {
  const p = dock.pending;
  const el = dk.stat;
  if (!p) { el.className = 'dstat'; el.textContent = ''; return; }
  const multi = p.targets.length > 1;
  let t = '';
  if (p.phase === 'sending') t = 'sending…';
  else if (p.phase === 'sent') t = multi ? `sent ✓ ${p.targets.length - p.failed.length}/${p.targets.length}` : 'sent ✓';
  else if (p.phase === 'delivered') t = multi ? `delivered ✓✓ ${p.done.size}/${p.targets.length}` : 'delivered ✓✓';
  else t = multi && p.failed.length < p.targets.length ? `${p.failed.length} failed · retry` : 'failed · retry';
  if (p.phase === 'sent' && multi && p.done.size) t = `delivered ${p.done.size}/${p.targets.length}`;
  const cls = `dstat on ${p.phase}`;
  if (el.className !== cls) el.className = cls;
  if (el.textContent !== t) el.textContent = t;
}
dk.stat.onclick = () => {
  const p = dock.pending;
  if (p && p.phase === 'error') dispatch(p.text, p.failed.length ? p.failed : p.targets, true);
};
setInterval(checkDelivery, 400);

// ----- dock sync -----
function syncDock() {
  const n = state.active;
  for (const s of Array.from(dock.sel)) if (!state.status[s]) dock.sel.delete(s);
  const tg = dockTargets();
  els.sendInput.disabled = !state.sessions.length;
  els.sendBtn.disabled = !tg.length;
  dk.multiBtn.classList.toggle('on', dock.multi);
  dk.mt.classList.toggle('hidden', !dock.multi);
  if (dock.multi) {
    dk.tdot.className = 'adot multi';
    dk.tname.textContent = `→ ${tg.length}`;
    els.sendInput.placeholder = tg.length ? `→ ${tg.length} session${tg.length === 1 ? '' : 's'}` : 'pick targets above';
    renderMultiRow();
  } else {
    dk.tdot.className = `adot ${n ? agentOf(n) : ''}`;
    dk.tname.textContent = n ? displayName(n) : 'none';
    els.sendInput.placeholder = n ? `→ ${displayName(n)}` : 'no session';
  }
  els.dock.classList.toggle('target-waiting', !!n && !dock.multi && stateOf(n) === 'waiting');
  renderPrompts();
  checkDelivery();
}

function renderMultiRow() {
  const list = sortedByNeed();
  const key = list.map((s) => `${s.name}:${dock.sel.has(s.name) ? 1 : 0}:${stateOf(s.name)}:${displayName(s.name)}`).join('|');
  if (key === dock.mtKey) return;
  dock.mtKey = key;
  dk.mt.innerHTML = `<button class="mt-act" data-act="all">all</button><button class="mt-act" data-act="none">none</button>` +
    list.map((s) => `<button class="mt-chip${dock.sel.has(s.name) ? ' on' : ''}" data-n="${escapeHtml(s.name)}">${agentDotHtml(s.name)}<span>${escapeHtml(displayName(s.name))}</span></button>`).join('');
}
dk.mt.onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'all') for (const s of state.sessions) dock.sel.add(s.name);
  else if (b.dataset.act === 'none') dock.sel.clear();
  else if (b.dataset.n) { dock.sel.has(b.dataset.n) ? dock.sel.delete(b.dataset.n) : dock.sel.add(b.dataset.n); }
  syncDock();
};
dk.multiBtn.onclick = () => {
  dock.multi = !dock.multi;
  if (dock.multi && !dock.sel.size) dock.sel.clear();     // starts with none selected
  dock.mtKey = '';
  syncDock();
  toast(dock.multi ? 'multi-send on · pick sessions' : 'multi-send off', 1200);
};
dk.multiBtn.onpointerdown = (e) => e.preventDefault();
dk.histBtn.onpointerdown = (e) => e.preventDefault();

// ----- quick prompts -----
function renderPrompts() {
  const key = dock.prompts.join('\u0001');
  if (key === dock.chipsKey) return;
  dock.chipsKey = key;
  dk.chips.innerHTML = dock.prompts.map((p, i) => `<button class="pchip" data-i="${i}">${escapeHtml(p)}</button>`).join('') +
    `<button class="pchip add" data-add="1" aria-label="Save input as prompt">+</button>`;
}
(function wireChips() {
  let timer = 0, sx = 0, sy = 0, longFired = false, cur = null;
  const stop = () => { clearTimeout(timer); timer = 0; };
  dk.chips.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.pchip');
    if (!b || b.dataset.add) return;
    e.preventDefault();                  // don't steal focus from the input
    cur = b; longFired = false; sx = e.clientX; sy = e.clientY;
    stop();
    timer = setTimeout(() => { longFired = true; if (navigator.vibrate) navigator.vibrate(15); editPrompt(Number(b.dataset.i)); }, 480);
  });
  dk.chips.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) stop(); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) dk.chips.addEventListener(ev, stop);
  dk.chips.addEventListener('contextmenu', (e) => e.preventDefault());
  dk.chips.addEventListener('click', (e) => {
    const b = e.target.closest('.pchip');
    if (!b) return;
    if (b.dataset.add) { addPromptFromInput(); return; }
    if (longFired) { longFired = false; return; }
    const text = dock.prompts[Number(b.dataset.i)];
    const targets = dockTargets();
    if (!targets.length) { toast(dock.multi ? 'pick at least one target' : 'no session'); return; }
    if (navigator.vibrate) navigator.vibrate(8);
    dispatch(text, targets);
  });
})();
function addPromptFromInput() {
  const v = els.sendInput.value.trim();
  if (!v) { editPrompt(-1); return; }
  if (!dock.prompts.includes(v)) { dock.prompts.push(v); savePrompts(); renderPrompts(); }
  toast('saved as quick prompt', 1200);
  dk.chips.scrollLeft = dk.chips.scrollWidth;
}
function editPrompt(i) {
  const isNew = i < 0;
  openSheet(isNew ? 'New quick prompt' : 'Edit quick prompt', ({ body, foot, close }) => {
    body.innerHTML = `<textarea class="sheet-ta" rows="3" placeholder="text to send…"></textarea>`;
    const ta = body.querySelector('textarea');
    ta.value = isNew ? '' : dock.prompts[i];
    foot.classList.remove('hidden');
    foot.innerHTML = `${isNew ? '' : '<button class="sbtn danger" data-a="del">delete</button>'}<span class="grow"></span><button class="sbtn" data-a="cancel">cancel</button><button class="sbtn primary" data-a="save">save</button>`;
    foot.onclick = (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (!a) return;
      if (a === 'save') {
        const v = ta.value.trim();
        if (v) { if (isNew) dock.prompts.push(v); else dock.prompts[i] = v; }
      } else if (a === 'del') dock.prompts.splice(i, 1);
      if (a !== 'cancel') { savePrompts(); renderPrompts(); }
      close();
    };
    setTimeout(() => ta.focus(), 120);
  });
}

// ----- history -----
function openHistory() {
  openSheet('Sent history', ({ body, foot, close }) => {
    if (!dock.hist.length) { body.innerHTML = '<div class="sheet-empty">nothing sent from this device yet</div>'; return; }
    body.innerHTML = dock.hist.map((h, i) => `<button class="hrow" data-i="${i}">${escapeHtml(h)}</button>`).join('');
    foot.classList.remove('hidden');
    foot.innerHTML = `<button class="sbtn danger" data-a="clear">clear history</button><span class="grow"></span><button class="sbtn" data-a="cancel">close</button>`;
    foot.onclick = (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'clear') { dock.hist = []; lsSet(LS_HIST, '[]'); }
      if (a) close();
    };
    body.onclick = (e) => {
      const b = e.target.closest('.hrow');
      if (!b) return;
      els.sendInput.value = dock.hist[Number(b.dataset.i)];
      autoGrow();
      close();
      els.sendInput.focus();
    };
  });
}
dk.histBtn.onclick = openHistory;

// Collapse / expand the quick prompts + quick keys rows (remembered per device).
const LS_DOCK_COLLAPSED = 'ghosty.dockCollapsed';
const dockToggle = $('#dockToggle');
function setDockCollapsed(on) {
  els.dock.classList.toggle('collapsed', on);
  dockToggle.setAttribute('aria-expanded', String(!on));
  lsSet(LS_DOCK_COLLAPSED, on ? '1' : '0');
  // the terminal area just changed height: let the xterms re-fit
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}
dockToggle.onpointerdown = (e) => e.preventDefault();   // keep the keyboard open
dockToggle.onclick = () => setDockCollapsed(!els.dock.classList.contains('collapsed'));
setDockCollapsed(lsGet(LS_DOCK_COLLAPSED, '0') === '1');

function onDockKey(e) {
  if (e.isComposing) return;
  // Empty input: Enter / Escape go straight to the session as keys (confirm a
  // prompt, interrupt the agent). Escape is always passed through.
  const empty = els.sendInput.value.trim() === '';
  if (e.key === 'Escape') { e.preventDefault(); for (const t of dockTargets()) sendKey(t, 'Escape'); toast('esc →', 700); return; }
  if (e.key === 'Enter' && !e.shiftKey && empty) { e.preventDefault(); for (const t of dockTargets()) sendKey(t, 'Enter'); toast('⏎ →', 700); return; }
  if (e.key === 'Enter' && !e.shiftKey && !COARSE) { e.preventDefault(); send(); return; }
  if (e.key === 'ArrowUp' && (els.sendInput.value === '' || els.sendInput.value === dock.recalled) && dock.hist.length) {
    e.preventDefault();
    dock.hidx = Math.min(dock.hidx + 1, dock.hist.length - 1);
    els.sendInput.value = dock.recalled = dock.hist[dock.hidx];
    autoGrow();
  } else if (e.key === 'ArrowDown' && dock.recalled !== null && els.sendInput.value === dock.recalled) {
    e.preventDefault();
    dock.hidx -= 1;
    els.sendInput.value = dock.recalled = dock.hidx >= 0 ? dock.hist[dock.hidx] : '';
    if (dock.hidx < 0) dock.recalled = null;
    autoGrow();
  }
}
(function wireInputSwipe() {
  let y0 = 0, x0 = 0;
  els.sendInput.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; }, { passive: true });
  els.sendInput.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    if (els.sendInput.value === '' && y0 - t.clientY > 45 && Math.abs(t.clientX - x0) < 35) openHistory();
  }, { passive: true });
})();

// ----- target chip + picker -----
function openPicker() {
  openSheet('Send to', (api) => {
    const draw = () => {
      api.title.textContent = dock.multi ? `Send to · ${dock.sel.size} selected` : 'Send to';
      api.body.innerHTML = sortedByNeed().map((s) => {
        const n = s.name, on = dock.multi ? dock.sel.has(n) : n === state.active;
        const rb = repoBranch(n);
        return `<button class="prow-s${on ? ' on' : ''}" data-n="${escapeHtml(n)}">${agentDotHtml(n)}
          <span class="pn"><b>${escapeHtml(displayName(n))}</b>${rb ? `<small>${escapeHtml(rb)}</small>` : ''}</span>
          <span class="state ${vstateOf(n)}"><i class="dot ${vstateOf(n)}"></i>${escapeHtml(stateText(n).split(' ')[0])}</span>
          ${dock.multi ? `<span class="chk">${on ? '✓' : ''}</span>` : ''}</button>`;
      }).join('') || '<div class="sheet-empty">no sessions</div>';
    };
    draw();
    api.body.onclick = (e) => {
      const b = e.target.closest('.prow-s');
      if (!b) return;
      const n = b.dataset.n;
      if (dock.multi) { dock.sel.has(n) ? dock.sel.delete(n) : dock.sel.add(n); draw(); syncDock(); }
      else { focusSession(n); api.close(); }
    };
    if (dock.multi) {
      api.foot.classList.remove('hidden');
      api.foot.innerHTML = `<button class="sbtn" data-a="none">none</button><span class="grow"></span><button class="sbtn primary" data-a="ok">done</button>`;
      api.foot.onclick = (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (a === 'none') { dock.sel.clear(); draw(); syncDock(); } else if (a) api.close();
      };
    }
  });
}
dk.tchip.onpointerdown = (e) => e.preventDefault();
dk.tchip.onclick = openPicker;

function autoGrow() {
  els.sendInput.style.height = 'auto';
  els.sendInput.style.height = `${Math.min(els.sendInput.scrollHeight, window.innerHeight * 0.3)}px`;
}

// ----- new session -----
async function fetchDirs() {
  try {
    const r = await fetch('/api/dirs');
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j : (j.dirs || null);
  } catch { return null; }
}
function recentDirs() { try { return JSON.parse(lsGet(LS_RECENT, '[]')) || []; } catch { return []; } }
function addRecentDir(d) { lsSet(LS_RECENT, JSON.stringify([d, ...recentDirs().filter((x) => x !== d)].slice(0, 12))); }
function baseName(p) { return String(p || '').replace(/\/+$/, '').split('/').pop() || ''; }
function safeName(s) { return String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32); }
const NEW_AGENTS = ['claude', 'codex', 'minimax', 'bash'];

function openNewSession() {
  let agent = lsGet('ghosty.newAgent', 'claude');
  if (!NEW_AGENTS.includes(agent)) agent = 'claude';
  let dirs = null, nameTouched = false, agentTouched = false;
  let priority = DEFAULT_PRIORITY, mcfg = null;
  openSheet('New session', ({ body, foot, close }) => {
    body.innerHTML = `
      <div class="seg" id="nsPrio">${PRIORITIES.map((p) => `<button data-p="${p}" class="${p === priority ? 'on' : ''}">${p}</button>`).join('')}</div>
      <div class="mnote" id="nsSug"></div>
      <div class="seg" id="nsAgent">${NEW_AGENTS.map((a) => `<button data-a="${a}" class="${a === agent ? 'on' : ''} ${a}">${a}</button>`).join('')}</div>
      <label class="flab">name</label>
      <input class="sheet-in" id="nsName" maxlength="32" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="session name">
      <label class="flab">working dir <span class="dim" id="nsHint"></span></label>
      <input class="sheet-in" id="nsCwd" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="search or type a path…">
      <div class="dirs" id="nsDirs"><div class="sheet-empty">loading…</div></div>`;
    foot.classList.remove('hidden');
    foot.innerHTML = `<button class="sbtn" data-a="cancel">cancel</button><span class="grow"></span><button class="sbtn primary" id="nsGo" data-a="go">create</button>`;
    const nameIn = body.querySelector('#nsName'), cwdIn = body.querySelector('#nsCwd'), list = body.querySelector('#nsDirs');
    const taken = (n) => state.sessions.some((s) => s.name === n);
    const suggest = () => {
      if (nameTouched) return;
      let b = safeName(baseName(cwdIn.value)) || agent;
      if (agent === 'bash' && !baseName(cwdIn.value)) b = 'sh';
      let n = b, i = 2;
      while (taken(n)) n = `${b}-${i++}`;
      nameIn.value = n;
    };
    const drawDirs = () => {
      if (!dirs) { list.innerHTML = `<div class="sheet-empty">${dirs === null ? 'dir list unavailable — type a path' : 'loading…'}</div>`; return; }
      const q = cwdIn.value.trim().toLowerCase();
      const rec = recentDirs();
      const rank = (d) => { const i = rec.indexOf(d.path); return i < 0 ? 99 : i; };
      const items = dirs.filter((d) => !q || d.path.toLowerCase().includes(q) || (d.name || '').toLowerCase().includes(q))
        .sort((a, b) => rank(a) - rank(b) || (a.name || '').localeCompare(b.name || '')).slice(0, 60);
      list.innerHTML = items.map((d) => `<button class="drow" data-p="${escapeHtml(d.path)}"><span class="dn">${rank(d) < 99 ? '<i class="rec">●</i> ' : ''}<b>${escapeHtml(d.name || baseName(d.path))}</b>${d.branch ? `<em>${escapeHtml(d.branch)}</em>` : ''}</span><small>${escapeHtml(d.path)}</small></button>`).join('')
        || '<div class="sheet-empty">no match — it will use the typed path</div>';
    };
    list.onclick = (e) => {
      const b = e.target.closest('.drow');
      if (!b) return;
      cwdIn.value = b.dataset.p;
      suggest();
      drawDirs();
    };
    cwdIn.oninput = () => { suggest(); drawDirs(); };
    nameIn.oninput = () => { nameTouched = true; };
    // Suggestion only: preselect the agent with the most headroom for this priority until the owner picks one.
    const showAgent = () => { for (const x of body.querySelectorAll('#nsAgent button')) x.classList.toggle('on', x.dataset.a === agent); };
    const sug = body.querySelector('#nsSug');
    const applySuggestion = () => {
      if (!state.quota) { sug.textContent = ''; return; }
      const sg = suggestAgent(priority, state.quota, mcfg);
      for (const x of body.querySelectorAll('#nsAgent button')) x.classList.toggle('sug', x.dataset.a === sg.agent);
      sug.textContent = `suggested: ${sg.agent} (${sg.reason})`;
      if (!agentTouched) { agent = sg.agent; showAgent(); suggest(); }
    };
    fetch('/api/manager').then((r) => r.json()).then((c) => { mcfg = c; applySuggestion(); }).catch(() => {});
    body.querySelector('#nsPrio').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      priority = b.dataset.p;
      for (const x of body.querySelectorAll('#nsPrio button')) x.classList.toggle('on', x === b);
      applySuggestion();
    };
    body.querySelector('#nsAgent').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      agentTouched = true;
      agent = b.dataset.a; lsSet('ghosty.newAgent', agent);
      for (const x of body.querySelectorAll('#nsAgent button')) x.classList.toggle('on', x === b);
      suggest();
    };
    foot.onclick = async (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'cancel') return close();
      if (a !== 'go') return;
      const name = safeName(nameIn.value), cwd = cwdIn.value.trim();
      if (!name) { toast('name required'); return; }
      if (!cwd) { toast('pick a working dir'); return; }
      const go = foot.querySelector('#nsGo');
      go.disabled = true; go.textContent = 'creating…';
      try {
        const r = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, agent, cwd, priority }) });
        if (r.status === 404 || r.status === 405) { toast("server doesn't support this yet"); return; }
        if (r.status === 409) { toast(`"${name}" already exists`); return; }
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) { toast(`create failed: ${j.error || 'HTTP ' + r.status}`, 3000); return; }
        addRecentDir(cwd);
        close(); closeSide();
        const real = j.name || name;
        state.pendingNew = { name: real, at: Date.now() };
        await fetchInitial();
        openCard(real);
        toast(`started ${real}`);
      } catch (err) {
        toast(`create failed: ${err.message}`);
      } finally {
        go.disabled = false; go.textContent = 'create';
      }
    };
    suggest();
    applySuggestion();
    fetchDirs().then((d) => { dirs = d || null; if (d === null) dirs = null; drawDirs(); if (!d) list.innerHTML = '<div class="sheet-empty">dir list unavailable — type a path</div>'; });
  });
}

// ----- kill session -----
function confirmKill(name) {
  openSheet('Kill session', ({ body, foot, close }) => {
    body.innerHTML = `<p class="warn">This ends the tmux session <b>${escapeHtml(name)}</b> and everything running in it.</p>
      <label class="flab">type the session name to confirm</label>
      <input class="sheet-in" id="killIn" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${escapeHtml(name)}">`;
    foot.classList.remove('hidden');
    foot.innerHTML = `<button class="sbtn" data-a="cancel">cancel</button><span class="grow"></span><button class="sbtn danger solid" id="killGo" data-a="go" disabled>kill</button>`;
    const inp = body.querySelector('#killIn'), go = foot.querySelector('#killGo');
    inp.oninput = () => { go.disabled = inp.value.trim() !== name; };
    foot.onclick = async (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'cancel') return close();
      if (a !== 'go' || go.disabled) return;
      go.disabled = true;
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(name)}?confirm=${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (r.status === 404 || r.status === 405) {
          const j = await r.json().catch(() => null);
          toast(j && j.error ? j.error : "server doesn't support this yet");
          return;
        }
        if (!r.ok) { toast(`kill failed: HTTP ${r.status}`); return; }
        close();
        toast(`killed ${name}`);
        dock.sel.delete(name);
        await fetchInitial();
      } catch (err) {
        toast(`kill failed: ${err.message}`);
      } finally { go.disabled = inp.value.trim() !== name; }
    };
    setTimeout(() => inp.focus(), 120);
  });
}

// ----- sidebar wiring (new-session button, collapsible leases) -----
(function wireSide() {
  const nb = $('#newSessBtn');
  if (nb) nb.onclick = openNewSession;
  setInterval(tickSide, 1000);
})();
loadDock();

function renderAll() {
  renderTabStrip();
  renderSide();
  if (state.mode === 'card') renderCard();
  if (state.mode === 'grid') renderGrid();
  if (state.mode === 'list') renderList();
  syncAll();
}

// ---------- alerts: "needs you" transitions ----------
function alertTransitions() {
  const fresh = [];
  for (const s of state.sessions) {
    const now = stateOf(s.name);
    if (now === 'waiting' && state.prevState[s.name] && state.prevState[s.name] !== 'waiting') fresh.push(s.name);
    state.prevState[s.name] = now;
  }
  if (!fresh.length) return;
  if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
  if (!document.hidden) {
    toast(`${fresh.map(displayName).join(', ')} needs you`, 3000);
    return;
  }
  if (!state.notify || state.pushOn || !('Notification' in window) || Notification.permission !== 'granted') return;
  navigator.serviceWorker?.ready.then((reg) => {
    for (const n of fresh) {
      reg.showNotification(`${displayName(n)} needs you`, {
        body: state.status[n]?.waitReason || 'waiting for your answer',
        tag: `ghosty-${n}`, renotify: true, icon: '/icon-192.png', data: { session: n },
      });
    }
  }).catch(() => {});
}

// ---------- Web Push (bell) ----------
// The bell is "on" when this browser holds a real push subscription (works with the app closed).
// Without push support (plain HTTP, old browser) it falls back to in-page notifications.
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlB64ToBytes(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function paintBell() {
  els.notifyBtn.classList.toggle('on', state.notify || state.pushOn);
}
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
}
async function pushSubscribe(reg) {
  const { key } = await (await fetch('/api/push/key')).json();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with a different server key can never receive our pushes.
  if (sub && sub.options?.applicationServerKey) {
    const cur = new Uint8Array(sub.options.applicationServerKey);
    const want = urlB64ToBytes(key);
    if (cur.length !== want.length || cur.some((b, i) => b !== want[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(key) });
  await postJson('/api/push/subscribe', { subscription: sub.toJSON() });
  return sub;
}
async function pushUnsubscribe(reg) {
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await postJson('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}
// On load: reflect the real subscription, and silently re-subscribe if permission is granted
// and the user had notifications on but the subscription went missing.
async function syncPush() {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if ((sub || state.notify) && Notification.permission === 'granted') {
      sub = await pushSubscribe(reg);   // also re-registers with the server (e.g. after its subs file was lost)
    }
    state.pushOn = !!sub;
  } catch (err) { console.warn('[push] sync failed:', err.message); state.pushOn = false; }
  paintBell();
}

async function toggleNotify() {
  if (!('Notification' in window)) { toast('notifications not supported here'); return; }
  if (!(state.notify || state.pushOn)) {
    const before = Notification.permission;
    const p = await Notification.requestPermission();
    if (p !== 'granted') {
      // Tell the server what this browser reports, so a blocked bell in the APK can be diagnosed.
      fetch('/api/push/diag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        before, after: p, now: Notification.permission, secure: window.isSecureContext,
        standalone: matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches,
        referrer: document.referrer, ua: navigator.userAgent, origin: location.origin,
        push: pushSupported(), sw: !!navigator.serviceWorker?.controller,
      }) }).catch(() => {});
      toast(!window.isSecureContext ? 'needs the https://<tailnet-host>:7443 address'
        : Notification.permission === 'denied' ? 'notifications are off for this app - Android: App info > Notifications > allow, then tap the bell again'
        : 'permission not given - tap the bell again', 5000);
      return;
    }
    state.notify = true;
    if (pushSupported()) {
      try { await pushSubscribe(await navigator.serviceWorker.ready); state.pushOn = true; toast('push alerts on - works with the app closed'); }
      catch (err) { toast(`push failed: ${err.message}`, 5000); }
    } else toast('will alert when a session needs you');
  } else {
    state.notify = false;
    if (pushSupported()) { try { await pushUnsubscribe(await navigator.serviceWorker.ready); } catch {} }
    state.pushOn = false;
    toast('alerts off');
  }
  lsSet(LS_NOTIFY, state.notify ? '1' : '0');
  paintBell();
}

// ---------- swipe from left edge ----------
function wireSwipe() {
  let startX = 0, startY = 0, started = false, swiping = false;

  const onTouchStart = (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    const t = e.touches[0];
    const fromEdge = t.clientX < 24;
    if (!fromEdge && !state.side) return;
    startX = t.clientX; startY = t.clientY; started = true; swiping = false;
  };
  const onTouchMove = (e) => {
    if (!started) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiping = true;
      if (dx > 40 && startX < 24) els.edgeSwipe.classList.add('active');
    }
  };
  const onTouchEnd = (e) => {
    if (!started) return;
    els.edgeSwipe.classList.remove('active');
    const t = (e.changedTouches && e.changedTouches[0]) || { clientX: startX };
    const dx = t.clientX - startX;
    if (swiping) {
      if (state.side && dx < -80) closeSide();
      else if (!state.side && dx > 60 && startX < 24) openSide();
    }
    started = false; swiping = false;
  };

  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove',  onTouchMove,  { passive: true });
  document.addEventListener('touchend',   onTouchEnd,   { passive: true });
}

// ---------- card: swipe left/right = next/prev session (board order) ----------
function stepSession(dir) {
  const order = byUrgency(visibleSessions());
  const i = order.findIndex((x) => x.name === state.active);
  const next = order[i + dir];
  if (i < 0 || !next) return;
  focusSession(next.name);
  els.cardPane.classList.remove('sl-l', 'sl-r');
  void els.cardPane.offsetWidth;
  els.cardPane.classList.add(dir > 0 ? 'sl-r' : 'sl-l');
  clearTimeout(stepSession.t);
  stepSession.t = setTimeout(() => els.cardPane.classList.remove('sl-l', 'sl-r'), 260);
  if (navigator.vibrate) navigator.vibrate(8);
}
function wireCardSwipe() {
  let sx = 0, sy = 0, on = false;
  els.cardPane.addEventListener('touchstart', (e) => {
    on = false;
    if (state.mode !== 'card' || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t.clientX < 24) return;                          // left edge belongs to the sidebar
    if (!e.target.closest('.h, .reader') || e.target.closest('pre, button')) return;
    sx = t.clientX; sy = t.clientY; on = true;
  }, { passive: true });
  els.cardPane.addEventListener('touchend', (e) => {
    if (!on) return; on = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) stepSession(dx < 0 ? 1 : -1);
  }, { passive: true });
}

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function cssEscape(s) { return (window.CSS?.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

// ---------- wire up ----------
els.menuBtn.onclick   = openSide;
els.backBtn.onclick   = () => setMode(state.prevMode || (isPhone() ? 'list' : 'grid'));
els.refreshBtn.onclick= () => { fetchInitial(); for (const s of state.sessions) connectSession(s.name); };
els.installBtn.onclick= () => promptInstall();
els.filterBtn.onclick = () => { state.filterOpen = !state.filterOpen; renderFilterBar(); };
els.notifyBtn.onclick = () => toggleNotify();
for (const b of $$('.mode-btn')) b.onclick = () => setMode(b.dataset.mode);
// tapping a size always shows the grid at that size
for (const b of $$('.size-btn')) b.onclick = () => { setGridSize(Number(b.dataset.size)); if (state.mode !== 'grid') setMode('grid'); };
for (const b of els.keys.querySelectorAll('button')) {
  // keep the soft keyboard open when tapping a quick key
  b.onpointerdown = (e) => e.preventDefault();
  b.onclick = () => sendKey(state.active, b.dataset.key);
}
els.sendBtn.onpointerdown = (e) => e.preventDefault();
els.sendBtn.onclick   = send;
els.sendInput.oninput = autoGrow;
els.sendInput.onkeydown = onDockKey;

// ---------- font size / fit controls ----------
function wireFontUi() {
  const pop = $('#fontPop');
  $('#fontDec').onclick = () => setFont(state.font - 1);
  $('#fontInc').onclick = () => setFont(state.font + 1);
  $('#fontDec2').onclick = () => setFont(state.font - 1);
  $('#fontInc2').onclick = () => setFont(state.font + 1);
  $('#fontReset').onclick = () => setFont(isPhone() ? 11 : 12);
  $('#fitToggle').onclick = () => setFit(!state.fit);
  $('#ctlToggle').onclick = () => setCardCtl(!state.cardCtl);
  $('#ctlToggle').classList.toggle('on', state.cardCtl);
  $('#fontBtn').onclick = (e) => { e.stopPropagation(); pop.classList.toggle('hidden'); };
  pop.onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => pop.classList.add('hidden'));
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setFont(state.font + 1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); setFont(state.font - 1); }
    else if (e.key === '0') { e.preventDefault(); setFont(isPhone() ? 11 : 12); }
  });
  syncFontUi();
}
wireFontUi();

// ---------- Android back button ----------
// The app is one page, so back would leave it. Keep a sentinel history entry and use each back press
// to close the topmost thing (sheet, menu, task doc, card view); at the top level, press twice to exit.
function handleBack() {
  if (sheetEl) { closeSheet(); return true; }
  const mp = $('#morePop');
  if (mp && !mp.classList.contains('hidden')) { mp.classList.add('hidden'); return true; }
  const pop = $('#fontPop');
  if (pop && !pop.classList.contains('hidden')) { pop.classList.add('hidden'); return true; }
  if (state.side) { closeSide(); return true; }
  const doc = document.querySelector('.cell.doc-on');
  if (doc) { doc.classList.remove('doc-on'); return true; }
  if (state.mode === 'card') { setMode(state.prevMode || (isPhone() ? 'list' : 'grid')); return true; }
  return false;
}
{
  let lastBack = 0;
  history.replaceState({ root: 1 }, '');
  history.pushState({ app: 1 }, '');
  window.addEventListener('popstate', () => {
    if (handleBack()) { history.pushState({ app: 1 }, ''); return; }
    if (Date.now() - lastBack < 2000) { history.back(); return; }   // second press: leave the app
    lastBack = Date.now();
    toast('press back again to exit');
    history.pushState({ app: 1 }, '');
  });
}

window.addEventListener('resize', () => {
  for (const name of state.terms.keys()) relayoutTerm(name);
});


document.addEventListener('visibilitychange', () => {
  if (!document.hidden) connectStatus();
});

// ---------- PWA install prompt ----------
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
});

window.addEventListener('appinstalled', () => {
  state.installPrompt = null;
  els.installBtn.classList.add('hidden');
  toast('installed — open codebox from your home screen');
});

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
    || document.referrer.startsWith('android-app://');
}
function hideInstallIfInstalled() {
  if (isStandalone()) els.installBtn.classList.add('hidden');
}

async function promptInstall() {
  // Android browser: offer the real app (APK wrapper); the PWA prompt stays the fallback
  if (/Android/i.test(navigator.userAgent) && !isStandalone()) {
    toast('downloading codebox.apk — open it to install');
    location.href = '/codebox.apk';
    return;
  }
  if (!state.installPrompt) {
    toast('use browser menu → “Add to Home Screen”');
    return;
  }
  state.installPrompt.prompt();
  const choice = await state.installPrompt.userChoice;
  state.installPrompt = null;
  els.installBtn.classList.add('hidden');
  if (choice?.outcome === 'accepted') toast('installing…');
}

// ---------- service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((reg) => console.log('[sw] registered scope=', reg.scope))
      .catch((err) => console.warn('[sw] failed:', err.message));
  });
  // notification tap → focus that session
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data?.type === 'focus' && ev.data.session) openCard(ev.data.session);
  });
}

// boot
(async function boot() {
  loadRenames();
  loadPrefs();
  loadFilters();
  paintBell();
  syncPush();
  setGridSize(state.gridSize);
  const wanted = new URLSearchParams(location.search).get('s');
  // phone home = board, unless the grid was the last view used
  if (isPhone() && state.mode !== 'grid') { state.mode = 'list'; state.prevMode = 'list'; }
  const rd = lsGet(LS_READER, null);
  state.reader = rd == null ? isPhone() : rd === '1';
  if (wanted) { state.active = wanted; state.mode = 'card'; }
  if (new URLSearchParams(location.search).get('review')) startReview();
  const openPlat = ['platforms', 'deploys'].some((k) => new URLSearchParams(location.search).get(k));
  const view = new URLSearchParams(location.search).get('view');
  if (['card', 'grid', 'list'].includes(view)) state.mode = view;
  setMode(state.mode);
  hideInstallIfInstalled();
  await fetchInitial();
  if (openPlat) openPlatforms();
  connectStatus();
  wireSwipe();
  wireCardSwipe();
  setInterval(tickClock, 1000);
  setInterval(fetchLeases, 60000);
})();
