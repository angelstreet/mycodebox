// Ghosty Sessions — app.js
// Mobile-first dev cockpit over tmux: card | grid | board, plus send dock.
// State-first UI: every session shows agent, state (working / needs you /
// idle / offline) and elapsed time. Custom names live in localStorage.

const $  = (q) => document.querySelector(q);
const $$ = (q) => Array.from(document.querySelectorAll(q));

const els = {
  topbar:      $('#topbar'),
  appTitle:    $('#appTitle'),
  summary:     $('#summary'),
  attention:   $('#attention'),
  health:      $('#health'),
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
  leaseList:   $('#leaseList'),
  leaseCount:  $('#leaseCount'),
  refreshBtn:  $('#refreshBtn'),
  menuBtn:     $('#menuBtn'),
  backBtn:     $('#backBtn'),
  notifyBtn:   $('#notifyBtn'),
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
  notify:    false,
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
const STATE_RANK = { waiting: 0, done: 1, working: 2, idle: 3, offline: 4 };
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
function stateText(name) {
  const st = state.status[name] || {};
  const s = stateOf(name);
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
  const s = stateOf(name);
  return `<span class="state ${s}"><i class="dot ${s}"></i><span class="st">${escapeHtml(stateText(name))}</span></span>`;
}
function agentBadgeHtml(name) {
  const a = agentOf(name);
  return `<span class="agent ${a}">${AGENT_LABEL[a] || a}</span>`;
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
const LS_FONT = 'ghosty.font', LS_FIT = 'ghosty.fit';
const clampFont = (n) => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
state.font = clampFont(Number(lsGet(LS_FONT, 0)) || (matchMedia('(max-width: 720px)').matches ? 11 : 12));
state.fit = lsGet(LS_FIT, '1') !== '0';
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
        onLeases(msg.leases);
      } else if (msg.type === 'health') {
        onHealth(msg.health);
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

function onLeases(leases) {
  state.leases = leases;
  renderLeases();
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
    (STATE_RANK[stateOf(a.name)] - STATE_RANK[stateOf(b.name)]) ||
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
}

async function fetchLeases() {
  try {
    const r = await fetch('/api/leases');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    onLeases(data.ok ? (data.leases || []) : { error: data.error || 'unavailable' });
  } catch (err) {
    onLeases({ error: err.message });
  }
}

// ---------- codebox health strip ----------

function onHealth(h) {
  const el = els.health;
  if (!h) { el.classList.add('hidden'); return; }
  const pct = (v) => (v == null ? '–' : `${Math.round(v)}%`);
  const gb = (b) => `${(b / 2 ** 30).toFixed(b < 10 * 2 ** 30 ? 1 : 0)}G`;
  const item = (level, label, main, sub, title) =>
    `<span class="hi ${level}" title="${escapeHtml(title)}"><b>${label}</b>${main}${sub ? `<i>${sub}</i>` : ''}</span>`;
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
    .map(([k, n, t]) => `<button class="chip ${k}${state.filter === k ? ' on' : ''}" data-filter="${k}"><i class="dot ${k}"></i>${n}<span class="t">&nbsp;${t}</span></button>`)
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
  const waiting = state.sessions.filter((s) => stateOf(s.name) === 'waiting');
  els.attention.classList.toggle('hidden', waiting.length === 0);
  const key = waiting.map((s) => s.name).join('|');
  if (els.attention.dataset.key === key) return;
  els.attention.dataset.key = key;
  els.attention.innerHTML = `<span class="lbl">NEEDS YOU</span>` +
    waiting.map((s) => `<button data-session="${escapeHtml(s.name)}">${escapeHtml(displayName(s.name))}</button>`).join('');
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
    const s = stateOf(n);
    tab.className = `tab ${s}${n === state.active ? ' active' : ''}`;
    tab.querySelector('.dot').className = `dot ${s}`;
  }
}

// ---------- sidebar ----------
const SIDE_GROUPS = [['waiting', 'Needs you'], ['done', 'Done'], ['working', 'Working'], ['idle', 'Idle']];
function sideGroupOf(n) {
  const s = stateOf(n);
  return s === 'waiting' || s === 'done' || s === 'working' ? s : 'idle';
}
function repoBranch(n) {
  const st = state.status[n] || {};
  return [st.repo, st.branch].filter(Boolean).join(' · ');
}
function sideSig() {
  return state.sessions.map((s) => `${s.name}:${customFor(s.name)}`).join(',');
}
// Full rebuild only when the session set / names change; group moves are done in layoutSide().
function renderSide() {
  const list = els.sessionList;
  if (list.querySelector('li.editing')) return;   // never wipe an in-progress rename
  list.innerHTML = '';
  state.sideHdr = {};
  els.sessionCount.textContent = `${state.sessions.length}`;
  list.dataset.sig = sideSig();
  for (const s of state.sessions) list.appendChild(buildSideRow(s));
  layoutSide();
  syncSide();
}
function layoutSide() {
  const list = els.sessionList;
  const hdrs = state.sideHdr || (state.sideHdr = {});
  const rows = new Map([...list.children].filter((li) => li.dataset.session).map((li) => [li.dataset.session, li]));
  let cursor = list.firstChild;
  const place = (n) => { if (n === cursor) cursor = cursor.nextSibling; else list.insertBefore(n, cursor); };
  for (const [g, label] of SIDE_GROUPS) {
    const members = state.sessions.filter((s) => sideGroupOf(s.name) === g && matchesFilter(s.name));
    if (!members.length) {
      const old = hdrs[g];
      if (old) { if (old === cursor) cursor = cursor.nextSibling; old.remove(); delete hdrs[g]; }
      continue;
    }
    let h = hdrs[g];
    if (!h) { h = hdrs[g] = document.createElement('li'); h.className = `grp ${g}`; }
    const t = `${label} \u00b7 ${members.length}`;
    if (h.textContent !== t) h.textContent = t;
    place(h);
    for (const m of members) { const row = rows.get(m.name); if (row) place(row); }
  }
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
      <div class="sub"><span class="ag"></span><span class="sst"></span></div>
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
    li.querySelector('.dot').className = `dot ${stateOf(n)}`;
    const ag = agentBadgeHtml(n);
    const agEl = li.querySelector('.ag');
    if (agEl.innerHTML !== ag) agEl.innerHTML = ag;
    li.querySelector('.sst').textContent = stateText(n);
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

function renderLeases() {
  const l = state.leases;
  if (!l) return;
  if (l.error) {
    els.leaseCount.textContent = '';
    els.leaseList.innerHTML = `<li class="dim">registry unreachable · ${escapeHtml(l.error)}</li>`;
    return;
  }
  const mine = (x) => /codebox/i.test(x.agent || '');
  els.leaseCount.textContent = l.length ? `${l.length}${l.some(mine) ? ' · ' + l.filter(mine).length + ' here' : ''}` : '';
  els.leaseList.innerHTML = l.length
    ? l.map((x) => `<li class="${mine(x) ? 'mine' : ''}"><b>${escapeHtml(x.resource || '*')}</b> @ ${escapeHtml(x.env || '')}<br>
        ${escapeHtml(x.agent || '?')} <span class="ttl">· ${x.ttlLeftMin != null ? `${x.ttlLeftMin}m left` : ''}${x.purpose ? ` · ${escapeHtml(x.purpose)}` : ''}</span></li>`).join('')
    : '<li class="dim">no active leases — platforms free</li>';
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
      <span class="ag"></span>
      <div class="nm"><span class="name">${escapeHtml(displayName(s.name))}</span><span class="mt">&nbsp;</span></div>
      <span class="proj"></span>
      <span class="pos"></span>
      <span class="tgt">&rarr; send target</span>
      <span class="mv" title="Move card">
        <button data-dir="left" aria-label="Move left">&#9664;</button><button data-dir="up" aria-label="Move up">&#9650;</button><button data-dir="down" aria-label="Move down">&#9660;</button><button data-dir="right" aria-label="Move right">&#9654;</button>
      </span>
      <span class="stw"></span>
      <button class="rd" aria-label="Toggle reader" title="Reader / terminal"></button>
      <button class="open" aria-label="Open full screen" title="Open">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
      </button>
    </div>
    <div class="ask hidden">
      <span class="q"></span>
      <button class="yes" data-key="1">1 · yes</button>
      <button data-key="2">2</button>
      <button data-key="3">3</button>
      <button data-key="Escape">esc</button>
    </div>
    <div class="reader"></div>
    <div class="b"></div>
    <div class="jump">
      <button data-j="top" aria-label="Jump to oldest output" title="Top (oldest)">&#10514;</button>
      <button data-j="bottom" aria-label="Jump to newest output" title="Bottom (newest)">&#10515;</button>
    </div>`;
  cell.querySelector('.rd').onclick = (e) => { e.stopPropagation(); toggleReader(); };
  for (const b of cell.querySelectorAll('.jump button')) {
    b.onclick = (e) => { e.stopPropagation(); jumpTo(cell, s.name, b.dataset.j); };
  }
  wireTap(cell, () => focusSession(s.name), () => { if (state.mode !== 'card') openCard(s.name); });
  cell.querySelector('.open').onclick = (e) => { e.stopPropagation(); openCard(s.name); };
  for (const b of cell.querySelectorAll('.mv button')) {
    b.onclick = (e) => { e.stopPropagation(); moveSession(s.name, b.dataset.dir); };
  }
  wireDrag(cell, s.name);
  for (const b of cell.querySelectorAll('.ask button')) {
    b.onclick = (e) => { e.stopPropagation(); focusSession(s.name); sendKey(s.name, b.dataset.key); };
  }
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

function syncCell(cell) {
  const n = cell.dataset.session;
  const s = stateOf(n);
  const inCard = cell.parentElement === els.cardPane;
  cell.className = `cell ${s}${n === state.active ? ' focus' : ''}${inCard && state.reader ? ' rd-on' : ''}`;
  const ag = agentBadgeHtml(n);
  const agEl = cell.querySelector('.ag');
  if (agEl.innerHTML !== ag) agEl.innerHTML = ag;
  const stw = cell.querySelector('.stw');
  if (stw.dataset.s !== s) { stw.dataset.s = s; stw.innerHTML = stateBadgeHtml(n); }
  else stw.querySelector('.st').textContent = stateText(n);
  const ask = cell.querySelector('.ask');
  ask.classList.toggle('hidden', s !== 'waiting');
  if (s === 'waiting') ask.querySelector('.q').textContent = state.status[n]?.waitReason || 'waiting for your answer';
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
function headMetaHtml(n) {
  const st = state.status[n] || {};
  const parts = [];
  const c = ctxHtml(st);
  if (c) parts.push(c);
  if (stateOf(n) === 'working' && st.activity) parts.push(`<span class="act">${escapeHtml(st.activity)}</span>`);
  return parts.join(' · ') || '&nbsp;';
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
  if (st.lease?.resource) chips.push(`<span class="chip-m lease">&#128274; ${escapeHtml(st.lease.resource)}${st.lease.ttlLeftMin != null ? ` ${st.lease.ttlLeftMin}m` : ''}</span>`);
  if (st.model) chips.push(`<span class="chip-m">${escapeHtml(st.model)}</span>`);
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
  const html = text && text.trim() ? renderReply(text) : '<div class="rd-empty">no reply yet \u2014 tap &gt;_ for terminal</div>';
  if (el.dataset.h === html) return;
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
function renderReply(text) {
  if (!text || !text.trim()) return '<div class="rd-empty">No reply yet.</div>';
  const lines = String(text).replace(/\t/g, '    ').split('\n');
  const out = [];
  let para = [], code = null, fence = false;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const flushCode = () => { if (code) { out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`); code = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
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
    para.push(inlineMd(line.replace(/^(\s*)[-*] /, '$1\u2022 ')));
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
  const act = all.find((s) => s.name === state.active);
  if (act && !targets.includes(act) && limit > 0) targets = [...targets.slice(0, limit - 1), act];
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
      <div class="l1"><span class="ag"></span><span class="name">${escapeHtml(displayName(s.name))}</span><span class="stw"></span></div>
      <div class="last"></div>
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
    const s = stateOf(n);
    row.className = `row-item ${s}${n === state.active ? ' focus' : ''}`;
    const ag = agentBadgeHtml(n);
    const agEl = row.querySelector('.ag');
    if (agEl.innerHTML !== ag) agEl.innerHTML = ag;
    const stw = row.querySelector('.stw');
    if (stw.dataset.s !== s) { stw.dataset.s = s; stw.innerHTML = stateBadgeHtml(n); }
    else stw.querySelector('.st').textContent = stateText(n);
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
  for (const el of document.querySelectorAll('.stw[data-s] .st')) {
    const host = el.closest('[data-session]');
    if (host) el.textContent = stateText(host.dataset.session);
  }
}

// ---------- focus ----------
function focusSession(name) {
  if (!name) return;
  state.active = name;
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
const LS_LEASES  = 'ghosty.leasesOpen';
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
  requestAnimationFrame(() => back.classList.add('on'));
  return api;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetEl) closeSheet(); });

const RANK2 = { waiting: 0, done: 1, working: 2, idle: 3, offline: 4 };
function sortedByNeed() {
  return [...state.sessions].sort((a, b) =>
    ((RANK2[stateOf(a.name)] ?? 5) - (RANK2[stateOf(b.name)] ?? 5)) ||
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
          <span class="state ${stateOf(n)}"><i class="dot ${stateOf(n)}"></i>${escapeHtml(stateText(n).split(' ')[0])}</span>
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
  let dirs = null, nameTouched = false;
  openSheet('New session', ({ body, foot, close }) => {
    body.innerHTML = `
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
    body.querySelector('#nsAgent').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
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
        const r = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, agent, cwd }) });
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
  const sec = $('.side-sec'), sub = sec && sec.querySelector('.side-sub');
  if (sub) {
    sec.classList.toggle('collapsed', lsGet(LS_LEASES, '1') === '0');
    sub.onclick = () => { sec.classList.toggle('collapsed'); lsSet(LS_LEASES, sec.classList.contains('collapsed') ? '0' : '1'); };
  }
  setInterval(tickSide, 1000);
})();
loadDock();

function renderAll() {
  renderTabStrip();
  renderSide();
  if (state.mode === 'card') renderCard();
  if (state.mode === 'grid') renderGrid();
  if (state.mode === 'list') renderList();
  renderLeases();
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
  if (!state.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  navigator.serviceWorker?.ready.then((reg) => {
    for (const n of fresh) {
      reg.showNotification(`${displayName(n)} needs you`, {
        body: state.status[n]?.waitReason || 'waiting for your answer',
        tag: `ghosty-${n}`, renotify: true, icon: '/icon-192.png', data: { session: n },
      });
    }
  }).catch(() => {});
}

async function toggleNotify() {
  if (!state.notify) {
    if (!('Notification' in window)) { toast('notifications not supported here'); return; }
    const p = await Notification.requestPermission();
    if (p !== 'granted') { toast('notifications blocked (needs HTTPS URL)'); return; }
    state.notify = true;
    toast('will alert when a session needs you');
  } else {
    state.notify = false;
    toast('alerts off');
  }
  lsSet(LS_NOTIFY, state.notify ? '1' : '0');
  els.notifyBtn.classList.toggle('on', state.notify);
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

function hideInstallIfInstalled() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches
                  || window.navigator.standalone === true;
  if (standalone) els.installBtn.classList.add('hidden');
}

async function promptInstall() {
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
  els.notifyBtn.classList.toggle('on', state.notify);
  setGridSize(state.gridSize);
  const wanted = new URLSearchParams(location.search).get('s');
  // phone home = board, unless the grid was the last view used
  if (isPhone() && state.mode !== 'grid') { state.mode = 'list'; state.prevMode = 'list'; }
  const rd = lsGet(LS_READER, null);
  state.reader = rd == null ? isPhone() : rd === '1';
  if (wanted) { state.active = wanted; state.mode = 'card'; }
  const view = new URLSearchParams(location.search).get('view');
  if (['card', 'grid', 'list'].includes(view)) state.mode = view;
  setMode(state.mode);
  hideInstallIfInstalled();
  await fetchInitial();
  connectStatus();
  wireSwipe();
  wireCardSwipe();
  setInterval(tickClock, 1000);
  setInterval(fetchLeases, 60000);
})();
