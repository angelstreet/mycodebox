// Ghosty Sessions — app.js
// Mobile-first controller: tabs, grid, list, send-keys, status pills.

const $  = (q) => document.querySelector(q);
const $$ = (q) => Array.from(document.querySelectorAll(q));

const els = {
  topbar:    $('#topbar'),
  appTitle:  $('#appTitle'),
  tabs:      $('#tabs'),
  main:      $('#main'),
  focusPane: $('#focusPane'),
  gridPane:  $('#gridPane'),
  listPane:  $('#listPane'),
  termHost:  $('#termHost'),
  dock:      $('#dock'),
  dockTarget:$('#dockTarget'),
  sendInput: $('#sendInput'),
  sendBtn:   $('#sendBtn'),
  side:      $('#side'),
  sessionList: $('#sessionList'),
  sessionCount: $('#sessionCount'),
  refreshBtn:$('#refreshBtn'),
  menuBtn:   $('#menuBtn'),
  toast:     $('#toast'),
};

const state = {
  sessions: [],          // [{name, attached, lastActivitySec, cmd, ...}]
  status:   {},          // name -> {state, lastActivitySec, ...}
  active:   null,        // currently focused session name
  mode:     'focus',     // focus | grid | list
  ws:       new Map(),   // session -> WebSocket
  statusWs: null,
  terms:    new Map(),   // session -> {term, fit}
  reconnectTimer: null,
  toastTimer: null,
};

// ---------- utilities ----------
function toast(msg, ms=1800) {
  els.toast.textContent = msg;
  els.toast.classList.add('on');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.remove('on'), ms);
}

function pillClass(state) {
  if (state === 'idle') return 'idle';
  if (state === 'busy') return 'busy';
  if (state === 'wait') return 'wait';
  return 'offline';
}

function fmtIdle(sec) {
  if (sec < 5)   return 'just now';
  if (sec < 60)  return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
  return `${Math.floor(sec/3600)}h ago`;
}

// ---------- xterm setup ----------
function getTerm(session) {
  let entry = state.terms.get(session);
  if (entry) return entry;

  const term = new Terminal({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: 'bar',
    convertEol: false,
    scrollback: 4000,
    disableStdin: true,           // we don't accept local typing; use the dock
    allowProposedApi: true,
    theme: {
      background: '#0f1014',
      foreground: '#e6e8ee',
      cursor:     '#6ed1c0',
      cursorAccent:'#0f1014',
      selectionBackground: 'rgba(232,154,74,0.25)',
      black: '#0f1014',  red: '#ff7a7a',   green: '#4ec07a', yellow: '#e89a4a',
      blue:  '#7aa7ff', magenta: '#c08cf0', cyan: '#6ed1c0', white: '#e6e8ee',
      brightBlack: '#5f6571', brightRed: '#ff9a9a',  brightGreen: '#7ed99a',
      brightYellow:'#ffc4a0', brightBlue:  '#9ab1ff', brightMagenta: '#d4adff',
      brightCyan: '#9adcd0',  brightWhite:'#ffffff',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  entry = { term, fit };
  state.terms.set(session, entry);
  return entry;
}

function mountTerm(session, host, opts={}) {
  const { term, fit } = getTerm(session);
  host.innerHTML = '';
  host.appendChild(term.element);
  term.open(host);
  // Resize after open + a tick so the host has measured size.
  requestAnimationFrame(() => { try { fit.fit(); } catch {} });
  setTimeout(() => { try { fit.fit(); } catch {} }, 80);
  if (opts.snapshot !== undefined) term.write(opts.snapshot);
}

function writeToTerm(session, pane) {
  const entry = state.terms.get(session);
  if (!entry) return;
  // Re-write the full visible pane each tick. xterm.js handles ANSI efficiently
  // and avoids drift from diff-based patching of escape codes.
  entry.term.write('\x1b[2J\x1b[H'); // clear screen + cursor home
  entry.term.write(pane);
}

// ---------- WebSocket ----------
function connectSession(session) {
  if (state.ws.get(session)?.readyState === 1) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(session)}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') writeToTerm(msg.session, msg.pane);
    } catch {}
  };
  ws.onclose = () => {
    state.ws.delete(session);
    setTimeout(() => connectSession(session), 2000);
  };
  ws.onerror = () => ws.close();
  state.ws.set(session, ws);
}

function connectStatus() {
  if (state.statusWs?.readyState === 1) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/status`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'status') {
        state.status = msg.status;
        renderTabs();
        renderList();
        renderGridHeader();
        renderSideList();
        renderDocState();
      }
    } catch {}
  };
  ws.onclose = () => {
    state.statusWs = null;
    setTimeout(connectStatus, 2000);
  };
  state.statusWs = ws;
}

// ---------- data ----------
async function fetchInitial() {
  try {
    const r = await fetch('/api/sessions');
    const data = await r.json();
    state.sessions = data.sessions || [];
    state.status   = data.status   || {};
    // pick first session as active if none
    if (!state.active && state.sessions[0]) state.active = state.sessions[0].name;
    renderAll();
  } catch (err) {
    toast('failed to load — retrying');
    setTimeout(fetchInitial, 2000);
  }
}

// ---------- rendering ----------
function renderTabs() {
  els.tabs.innerHTML = '';
  for (const s of state.sessions) {
    const cls = pillClass(state.status[s.name]?.state);
    const tab = document.createElement('div');
    tab.className = `tab ${cls}${s.name === state.active ? ' active' : ''}`;
    tab.innerHTML = `<span class="pill"></span>${escapeHtml(s.name)}`;
    tab.onclick = () => focusSession(s.name);
    els.tabs.appendChild(tab);
  }
}

function renderSideList() {
  els.sessionList.innerHTML = '';
  els.sessionCount.textContent = `${state.sessions.length} active`;
  for (const s of state.sessions) {
    const cls = pillClass(state.status[s.name]?.state);
    const li = document.createElement('li');
    if (s.name === state.active) li.classList.add('active');
    li.innerHTML = `<span>${escapeHtml(s.name)}</span><span class="pill ${cls}"></span>`;
    li.onclick = () => { focusSession(s.name); closeSide(); };
    els.sessionList.appendChild(li);
  }
}

function renderList() {
  els.listPane.innerHTML = '';
  for (const s of state.sessions) {
    const cls = pillClass(state.status[s.name]?.state);
    const row = document.createElement('div');
    row.className = `session-row ${cls}`;
    const cmd = s.cmd ? s.cmd.split('/').pop().slice(0, 24) : '';
    row.innerHTML = `
      <div class="meta">
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="sub">${escapeHtml(cmd || '—')} · ${fmtIdle(s.lastActivitySec)}</div>
      </div>
      <div class="pill"></div>`;
    row.onclick = () => focusSession(s.name);
    els.listPane.appendChild(row);
  }
}

function renderGrid() {
  els.gridPane.innerHTML = '';
  // pick up to 9 to tile
  const targets = state.sessions.slice(0, 9);
  // grid columns: 1 for 1, 2 for 2-4, 3 for 5-9
  els.gridPane.className = 'grid-pane' + (targets.length >= 5 ? ' cols-3' : ' cols-1');
  // Use 2 columns if the device is wide and we have 2-4 sessions
  if (targets.length > 1 && targets.length <= 4 && window.innerWidth >= 700) {
    els.gridPane.className = 'grid-pane'; // 2x2
  }

  for (const s of targets) {
    const cls = pillClass(state.status[s.name]?.state);
    const cell = document.createElement('div');
    cell.className = `cell${s.name === state.active ? ' focus' : ''}`;
    cell.innerHTML = `
      <div class="h ${cls}">
        <span>${escapeHtml(s.name)}</span>
        <span class="pill"></span>
      </div>
      <div class="b"></div>`;
    cell.querySelector('.h').onclick = () => focusSession(s.name);
    els.gridPane.appendChild(cell);
    mountTerm(s.name, cell.querySelector('.b'));
    connectSession(s.name);
  }
}

function renderGridHeader() {
  // update header pills without re-mounting xterm
  for (const cell of els.gridPane.children) {
    const name = cell.querySelector('.h span')?.textContent;
    if (!name) continue;
    const cls = pillClass(state.status[name]?.state);
    cell.querySelector('.h').classList.remove('idle','busy','wait','offline');
    cell.querySelector('.h').classList.add(cls);
  }
}

function focusSession(name) {
  state.active = name;
  els.dockTarget.textContent = name;
  els.appTitle.textContent = `→ ${name}`;
  // Re-mount focused term if needed
  if (!state.terms.has(name) || !els.termHost.contains(state.terms.get(name).term.element)) {
    mountTerm(name, els.termHost);
  }
  connectSession(name);
  renderTabs();
  renderSideList();
  // If in grid mode, refresh cell focus ring
  if (state.mode === 'grid') renderGrid();
}

function renderDocState() {
  // enable send button only if a session is active and not 'busy'
  const s = state.status[state.active];
  const enabled = !!state.active && s?.state !== 'busy';
  els.sendBtn.disabled = !enabled;
  els.sendInput.disabled = !state.active;
}

function renderAll() {
  renderTabs();
  renderList();
  renderSideList();
  // Mount focused term
  if (state.active) {
    mountTerm(state.active, els.termHost);
    connectSession(state.active);
  }
  renderGrid();
  renderDocState();
}

function setMode(mode) {
  state.mode = mode;
  els.main.classList.remove('view-focus','view-grid','view-list');
  els.main.classList.add(`view-${mode}`);
  for (const b of $$('.mode-btn')) b.classList.toggle('on', b.dataset.mode === mode);
  els.dock.classList.toggle('hidden', mode === 'list');
  if (mode === 'grid') renderGrid();
}

function openSide() {
  els.side.classList.add('on');
  if (!document.querySelector('.side-back')) {
    const back = document.createElement('div');
    back.className = 'side-back on';
    back.onclick = closeSide;
    document.body.appendChild(back);
  }
}
function closeSide() {
  els.side.classList.remove('on');
  document.querySelector('.side-back')?.remove();
}

// ---------- send-keys ----------
async function send() {
  const keys = els.sendInput.value;
  if (!state.active || !keys) return;
  els.sendBtn.disabled = true;
  try {
    const r = await fetch(`/api/send/${encodeURIComponent(state.active)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    els.sendInput.value = '';
    toast(`sent to ${state.active}`);
  } catch (err) {
    toast(`send failed: ${err.message}`);
  } finally {
    setTimeout(renderDocState, 600);
  }
}

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

// ---------- wire up ----------
els.menuBtn.onclick   = openSide;
els.refreshBtn.onclick= () => { fetchInitial(); for (const s of state.sessions) connectSession(s.name); };
for (const b of $$('.mode-btn')) {
  b.onclick = () => setMode(b.dataset.mode);
}
els.sendBtn.onclick   = send;
els.sendInput.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
};

window.addEventListener('resize', () => {
  for (const { fit } of state.terms.values()) {
    try { fit.fit(); } catch {}
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) connectStatus();
});

// boot
(async function boot() {
  setMode('focus');
  await fetchInitial();
  connectStatus();
})();