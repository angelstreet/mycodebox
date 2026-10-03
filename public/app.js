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
const LS_NOTIFY  = 'ghosty.notify';
const GRID_SIZES = [2, 4, 6, 9, 16];

function lsGet(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

function loadRenames() {
  try { state.rename = JSON.parse(lsGet(LS_RENAMES, '{}')) || {}; }
  catch { state.rename = {}; }
}
function saveRenames() { lsSet(LS_RENAMES, JSON.stringify(state.rename)); }
function customFor(name) { return state.rename[name] || ''; }
function displayName(name) { return customFor(name) || name; }

function loadPrefs() {
  const g = Number(lsGet(LS_GRID, 4));
  state.gridSize = GRID_SIZES.includes(g) ? g : 4;
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
const STATE_RANK = { waiting: 0, working: 1, idle: 2, offline: 3 };
const STATE_LABEL = { working: 'working', waiting: 'needs you', idle: 'idle', offline: 'offline' };

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
const MIN_FONT = 6, MAX_FONT = 14;
const FONT_FAMILY = "'JetBrains Mono', monospace";
let _charRatio = 0;
function charRatio() {
  if (_charRatio) return _charRatio;
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `100px ${FONT_FAMILY}`;
    const w = ctx.measureText('M').width / 100;
    if (w > 0.3 && w < 0.9) return (_charRatio = w);
  } catch {}
  return 0.6;
}

function getTerm(session) {
  let entry = state.terms.get(session);
  if (entry) return entry;
  const term = new Terminal({
    fontFamily: FONT_FAMILY,
    fontSize: 12,
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
  entry = { term, fit, host: null, ro: null, lastPane: null, cols: 0, rows: 0, paneCols: 0, laidOut: '' };
  state.terms.set(session, entry);
  return entry;
}

// Size the xterm to the tmux pane's cols exactly; scale the font so those
// cols fit the host width (crop horizontally below MIN_FONT). Rows come from
// FitAddon. Returns true if the grid dimensions changed (=> content must be
// rewritten, since reflow is lossy).
function layoutTerm(session) {
  const entry = state.terms.get(session);
  if (!entry || !entry.host || !entry.term.element || !entry.host.isConnected) return false;
  const { term, fit, host } = entry;
  const w = host.clientWidth, h = host.clientHeight;
  if (w < 20 || h < 20) return false;
  const cols = entry.paneCols || state.status?.[session]?.cols || 80;
  host.style.overflow = 'hidden';
  let fs = Math.floor((w / (cols * charRatio())) * 2) / 2;
  fs = Math.max(MIN_FONT, Math.min(MAX_FONT, fs));
  if (term.options.fontSize !== fs) term.options.fontSize = fs;
  // Verify with xterm's own measurement and step down until the cols fit.
  for (let i = 0; i < 6 && fs > MIN_FONT; i++) {
    let p = null;
    try { p = fit.proposeDimensions(); } catch {}
    if (!p || p.cols >= cols) break;
    fs = Math.max(MIN_FONT, fs - 0.5);
    term.options.fontSize = fs;
  }
  let rows = term.rows;
  try {
    const p = fit.proposeDimensions();
    if (p && p.rows) rows = p.rows;
  } catch {}
  rows = Math.max(2, rows);
  const key = `${cols}x${rows}`;
  if (term.cols === cols && term.rows === rows) { entry.laidOut = key; return false; }
  try { term.resize(cols, rows); } catch { return false; }
  entry.laidOut = key;
  return true;
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
    if (dims && dims.cols && dims.cols !== entry.paneCols) {
      entry.paneCols = dims.cols;
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
        for (const name of state.terms.keys()) relayoutTerm(name);
        onStatus();
      } else if (msg.type === 'leases') {
        onLeases(msg.leases);
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
    if (state.active && !names.includes(state.active)) state.active = null;
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
  if (row) row.textContent = lastLine(pane) || ' ';
}

// Stable alphabetical order by display name. Cards must not jump around
// under your thumb; "needs you" is surfaced by the banner, not by reordering.
function sortSessions() {
  state.sessions.sort((a, b) => displayName(a.name).localeCompare(displayName(b.name)));
}
function byUrgency(list) {
  return [...list].sort((a, b) =>
    (STATE_RANK[stateOf(a.name)] - STATE_RANK[stateOf(b.name)]) ||
    displayName(a.name).localeCompare(displayName(b.name)));
}
function visibleSessions() {
  if (!state.filter) return state.sessions;
  return state.sessions.filter((s) => stateOf(s.name) === state.filter);
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

// ---------- summary + attention ----------
function renderSummary() {
  const counts = { waiting: 0, working: 0, idle: 0, offline: 0 };
  for (const s of state.sessions) counts[stateOf(s.name)]++;
  const chips = [
    ['waiting', counts.waiting, 'need you'],
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

// ---------- tabs ----------
function renderTabStrip() {
  els.tabs.innerHTML = '';
  for (const s of state.sessions) {
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
function renderSide() {
  els.sessionList.innerHTML = '';
  els.sessionCount.textContent = `${state.sessions.length}`;
  for (const s of state.sessions) {
    const custom = customFor(s.name);
    const li = document.createElement('li');
    li.dataset.session = s.name;
    li.innerHTML = `
      <i class="dot"></i>
      <div class="meta">
        <div class="name">${escapeHtml(custom || s.name)}</div>
        <div class="sub"><span class="ag"></span><span class="st"></span>${custom ? `<span>· ${escapeHtml(s.name)}</span>` : ''}</div>
      </div>
      <button class="edit" aria-label="Rename">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>`;
    li.querySelector('.meta').onclick = (e) => {
      e.stopPropagation();
      closeSide();
      openCard(s.name);
    };
    li.querySelector('.edit').onclick = (e) => { e.stopPropagation(); beginRename(li, s.name); };
    els.sessionList.appendChild(li);
  }
  syncSide();
}
function syncSide() {
  for (const li of els.sessionList.children) {
    const n = li.dataset.session;
    if (!n || li.classList.contains('editing')) continue;
    li.classList.toggle('active', n === state.active);
    li.querySelector('.dot').className = `dot ${stateOf(n)}`;
    li.querySelector('.ag').innerHTML = agentBadgeHtml(n);
    li.querySelector('.st').textContent = stateText(n);
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
  els.leaseCount.textContent = l.length ? `${l.length}` : '';
  els.leaseList.innerHTML = l.length
    ? l.map((x) => `<li><b>${escapeHtml(x.resource || '*')}</b> @ ${escapeHtml(x.env || '')}<br>
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
    if (v && v !== name) state.rename[name] = v;
    else delete state.rename[name];
    saveRenames();
    sortSessions();
    renderAll();
    toast(v && v !== name ? `renamed to "${v}"` : 'name reset');
  };
  const cancel = () => { if (done) return; done = true; renderSide(); };
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
      <span class="name">${escapeHtml(displayName(s.name))}</span>
      <span class="stw"></span>
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
    <div class="b"></div>`;
  wireTap(cell, () => focusSession(s.name), () => { if (state.mode !== 'card') openCard(s.name); });
  cell.querySelector('.open').onclick = (e) => { e.stopPropagation(); openCard(s.name); };
  for (const b of cell.querySelectorAll('.ask button')) {
    b.onclick = (e) => { e.stopPropagation(); focusSession(s.name); sendKey(s.name, b.dataset.key); };
  }
  syncCell(cell);
  return cell;
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
  cell.className = `cell ${s}${n === state.active ? ' focus' : ''}`;
  const ag = agentBadgeHtml(n);
  const agEl = cell.querySelector('.ag');
  if (agEl.innerHTML !== ag) agEl.innerHTML = ag;
  const stw = cell.querySelector('.stw');
  if (stw.dataset.s !== s) { stw.dataset.s = s; stw.innerHTML = stateBadgeHtml(n); }
  else stw.querySelector('.st').textContent = stateText(n);
  const ask = cell.querySelector('.ask');
  ask.classList.toggle('hidden', s !== 'waiting');
  if (s === 'waiting') ask.querySelector('.q').textContent = state.status[n]?.waitReason || 'waiting for your answer';
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

function renderCard() {
  const active = state.sessions.find((s) => s.name === state.active) || state.sessions[0];
  if (active) state.active = active.name;
  renderInto(els.cardPane, active ? [active] : []);
}
function renderGrid() {
  els.gridPane.className = `grid-pane size-${state.gridSize}`;
  const all = visibleSessions();
  const limit = state.gridSize >= 16 ? all.length : state.gridSize;
  // Keep the active session on screen when the grid is limited.
  let targets = all.slice(0, limit);
  const act = all.find((s) => s.name === state.active);
  if (act && !targets.includes(act) && limit > 0) targets = [...targets.slice(0, limit - 1), act];
  renderInto(els.gridPane, targets);
}

// ---------- board (list view) ----------
function renderList() {
  els.listPane.innerHTML = '';
  for (const s of byUrgency(visibleSessions())) {
    const row = document.createElement('div');
    row.className = 'row-item';
    row.dataset.session = s.name;
    row.innerHTML = `
      <div class="top"><span class="ag"></span><span class="name">${escapeHtml(displayName(s.name))}</span></div>
      <span class="stw"></span>
      <div class="last"></div>`;
    row.querySelector('.last').textContent = (stateOf(s.name) === 'waiting' && state.status[s.name]?.waitReason)
      || lastLine(state.paneText.get(s.name) || '') || ' ';
    row.onclick = () => { focusSession(s.name); openCard(s.name); };
    els.listPane.appendChild(row);
    connectSession(s.name);
  }
  syncList();
}
function syncList() {
  // Reorder only when urgency order changed; otherwise update text in place.
  const order = byUrgency(visibleSessions()).map((s) => s.name).join('|');
  const cur = [...els.listPane.children].map((r) => r.dataset.session).join('|');
  if (order !== cur) { renderList(); return; }
  for (const row of els.listPane.children) {
    const n = row.dataset.session;
    const s = stateOf(n);
    row.className = `row-item ${s}${n === state.active ? ' focus' : ''}`;
    const ag = agentBadgeHtml(n);
    const agEl = row.querySelector('.ag');
    if (agEl.innerHTML !== ag) agEl.innerHTML = ag;
    const stw = row.querySelector('.stw');
    if (stw.dataset.s !== s) { stw.dataset.s = s; stw.innerHTML = stateBadgeHtml(n); }
    else stw.querySelector('.st').textContent = stateText(n);
    if (s === 'waiting' && state.status[n]?.waitReason) row.querySelector('.last').textContent = state.status[n].waitReason;
  }
}

// ---------- sync (status tick) ----------
function syncAll() {
  renderSummary();
  renderAttention();
  syncTabs();
  syncSide();
  for (const host of [els.cardPane, els.gridPane]) for (const c of host.children) syncCell(c);
  if (state.mode === 'list') syncList();
  if (state.filter && state.mode === 'grid') renderGrid();
  syncDock();
}

// Elapsed timers tick locally between server updates.
function tickClock() {
  for (const el of document.querySelectorAll('.stw[data-s] .st')) {
    const host = el.closest('[data-session]');
    if (host) el.textContent = stateText(host.dataset.session);
  }
  for (const li of els.sessionList.children) {
    const st = li.querySelector('.st');
    if (st && li.dataset.session) st.textContent = stateText(li.dataset.session);
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
  for (const b of $$('.mode-btn')) b.classList.toggle('on', b.dataset.mode === mode);
  els.gridSizes.classList.toggle('hidden', mode !== 'grid');
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
  for (const b of $$('.size-btn')) b.classList.toggle('on', Number(b.dataset.size) === n);
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

// ---------- send ----------
async function postSend(name, body) {
  const r = await fetch(`/api/send/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  state.sentAt[name] = Date.now();
}

async function send() {
  const keys = els.sendInput.value;
  const name = state.active;
  if (!name || !keys.trim()) return;
  els.sendBtn.disabled = true;
  try {
    await postSend(name, { keys });
    els.sendInput.value = '';
    autoGrow();
    toast(`→ ${displayName(name)}`, 1000);
  } catch (err) {
    toast(`send failed: ${err.message}`);
  } finally {
    els.sendBtn.disabled = false;
  }
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

function syncDock() {
  const n = state.active;
  els.sendInput.disabled = !n;
  els.sendBtn.disabled = !n;
  els.sendInput.placeholder = n ? `→ ${displayName(n)}` : 'no session';
  els.dock.classList.toggle('target-waiting', !!n && stateOf(n) === 'waiting');
}

function autoGrow() {
  els.sendInput.style.height = 'auto';
  els.sendInput.style.height = `${Math.min(els.sendInput.scrollHeight, window.innerHeight * 0.3)}px`;
}

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

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function cssEscape(s) { return (window.CSS?.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

// ---------- wire up ----------
els.menuBtn.onclick   = openSide;
els.backBtn.onclick   = () => setMode(state.prevMode || 'grid');
els.refreshBtn.onclick= () => { fetchInitial(); for (const s of state.sessions) connectSession(s.name); };
els.installBtn.onclick= () => promptInstall();
els.notifyBtn.onclick = () => toggleNotify();
for (const b of $$('.mode-btn')) b.onclick = () => setMode(b.dataset.mode);
for (const b of $$('.size-btn')) b.onclick = () => setGridSize(Number(b.dataset.size));
for (const b of els.keys.querySelectorAll('button')) {
  // keep the soft keyboard open when tapping a quick key
  b.onpointerdown = (e) => e.preventDefault();
  b.onclick = () => sendKey(state.active, b.dataset.key);
}
els.sendBtn.onpointerdown = (e) => e.preventDefault();
els.sendBtn.onclick   = send;
els.sendInput.oninput = autoGrow;
els.sendInput.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
};

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
  els.notifyBtn.classList.toggle('on', state.notify);
  setGridSize(state.gridSize);
  const wanted = new URLSearchParams(location.search).get('s');
  if (wanted) { state.active = wanted; state.mode = 'card'; }
  const view = new URLSearchParams(location.search).get('view');
  if (['card', 'grid', 'list'].includes(view)) state.mode = view;
  setMode(state.mode);
  hideInstallIfInstalled();
  await fetchInitial();
  connectStatus();
  wireSwipe();
  setInterval(tickClock, 1000);
  setInterval(fetchLeases, 60000);
})();
