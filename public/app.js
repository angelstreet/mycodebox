// Ghosty Sessions — app.js
// Mobile-first tmux pane controller. terminal | grid | sidebar.
// Custom names in localStorage. Swipe-from-edge to open sidebar.

const $  = (q) => document.querySelector(q);
const $$ = (q) => Array.from(document.querySelectorAll(q));

const els = {
  topbar:      $('#topbar'),
  appTitle:    $('#appTitle'),
  tabs:        $('#tabs'),
  main:        $('#main'),
  cardPane:    $('#cardPane'),
  gridPane:    $('#gridPane'),
  listPane:    $('#listPane'),
  dock:        $('#dock'),
  dockTarget:  $('#dockTarget'),
  sendInput:   $('#sendInput'),
  sendBtn:     $('#sendBtn'),
  side:        $('#side'),
  sessionList: $('#sessionList'),
  sessionCount:$('#sessionCount'),
  refreshBtn:  $('#refreshBtn'),
  menuBtn:     $('#menuBtn'),
  backBtn:     $('#backBtn'),
  edgeSwipe:   $('#edgeSwipe'),
  modeBar:     $('#modeBar'),
  gridSizes:   $('#gridSizes'),
  toast:       $('#toast'),
  installBtn:  $('#installBtn'),
};

const state = {
  sessions:   [],
  status:     {},
  active:     null,
  mode:       'card',          // card | grid | list
  gridSize:   8,               // 2 | 4 | 8 | 12 | 16
  ws:        new Map(),
  statusWs:  null,
  terms:     new Map(),
  paneText:  new Map(),       // session -> latest ANSI text (for preview)
  rename:    {},              // tmux session name -> custom display name
  toastTimer:null,
  side:      false,
  installPrompt: null,        // beforeinstallprompt event
};

// ---------- localStorage: custom names ----------
const LS_RENAMES = 'ghosty.renames';
const LS_GRID    = 'ghosty.gridSize';

function loadRenames() {
  try { state.rename = JSON.parse(localStorage.getItem(LS_RENAMES) || '{}') || {}; }
  catch { state.rename = {}; }
}
function saveRenames() {
  localStorage.setItem(LS_RENAMES, JSON.stringify(state.rename));
}
function customFor(name) { return state.rename[name] || ''; }
function displayName(name) { return customFor(name) || name; }

function loadGrid() {
  const v = Number(localStorage.getItem(LS_GRID) || 8);
  state.gridSize = [4, 8, 12, 16].includes(v) ? v : 8;
}
function saveGrid() { localStorage.setItem(LS_GRID, String(state.gridSize)); }

// ---------- utilities ----------
function toast(msg, ms=1800) {
  els.toast.textContent = msg;
  els.toast.classList.add('on');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.remove('on'), ms);
}

function pillClass(s) {
  if (s === 'idle') return 'idle';
  if (s === 'busy') return 'busy';
  if (s === 'wait') return 'wait';
  return 'offline';
}

function fmtIdle(sec) {
  if (sec < 5)   return 'just now';
  if (sec < 60)  return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
  return `${Math.floor(sec/3600)}h ago`;
}

// Strip ANSI control sequences + collapse whitespace.
function stripAnsi(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')   // CSI
    .replace(/\x1b\][^\x07]*\x07/g, '')        // OSC
    .replace(/\x1b[()][A-Za-z0-9]/g, '')       // charset
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// Build a short preview from the last visible pane text.
// Shows the prompt + last ~3 lines, trimmed to ~80 chars.
function buildPreview(paneText) {
  const text = stripAnsi(paneText);
  // split on lines and trim trailing blanks
  const lines = text.split('\n').map((l) => l.replace(/\s+$/g, ''));
  // find last non-empty block (max 3 lines)
  const tail = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < 3; i--) {
    if (lines[i].length || tail.length) tail.unshift(lines[i]);
  }
  // fall back to last 80 chars if we still have nothing useful
  const joined = tail.join('\n').trim();
  const out = (joined || text).slice(-160);
  // collapse excess whitespace within lines
  return out.replace(/[ \t]{2,}/g, ' ');
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
    if (force_skip(entry, pane) && !relaid) {
      // identical text and same grid: nothing to do
    } else {
      entry.lastPane = pane;
      paintTerm(session);
    }
  }
  onPane(session, pane);
}
function force_skip(entry, pane) { return entry.lastPane === pane; }

function updatePreviewForCell(session, pane) {
  const cell = els.gridPane.querySelector(`[data-session="${cssEscape(session)}"]`);
  if (!cell) return;
  const pv = cell.querySelector('.preview');
  if (!pv) return;
  const prev = buildPreview(pane);
  pv.textContent = prev;
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

// ---------- data ----------
async function fetchInitial() {
  try {
    const r = await fetch('/api/sessions');
    const data = await r.json();
    state.sessions = data.sessions || [];
    state.status   = data.status   || {};
    if (!state.active && state.sessions[0]) state.active = state.sessions[0].name;
    renderAll();
  } catch (err) {
    toast('failed to load — retrying');
    setTimeout(fetchInitial, 2000);
  }
}

// ---------- rendering: tabs ----------
function renderTabs() {
  els.tabs.innerHTML = '';
  for (const s of state.sessions) {
    const cls = pillClass(state.status[s.name]?.state);
    const tab = document.createElement('div');
    tab.className = `tab ${cls}${s.name === state.active ? ' active' : ''}`;
    const label = displayName(s.name);
    tab.innerHTML = `<span class="pill"></span><span class="label">${escapeHtml(label)}</span>`;
    tab.onclick = () => focusSession(s.name);
    els.tabs.appendChild(tab);
  }
}

// ---------- rendering: sidebar session list (the "home" list) ----------
function renderSideList() {
  els.sessionList.innerHTML = '';
  els.sessionCount.textContent = `${state.sessions.length} active`;
  for (const s of state.sessions) {
    const cls = pillClass(state.status[s.name]?.state);
    const custom = customFor(s.name);
    const li = document.createElement('li');
    if (s.name === state.active) li.classList.add('active');
    li.dataset.session = s.name;
    li.innerHTML = `
      <span class="pill ${cls}"></span>
      <div class="meta">
        <div class="name ${custom ? 'has-custom' : ''}">${escapeHtml(custom || s.name)}</div>
        <div class="sub">${escapeHtml(custom ? s.name : (s.cmd || '—'))}</div>
      </div>
      <button class="edit" aria-label="Rename">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>`;
    li.querySelector('.meta').onclick = (e) => {
      e.stopPropagation();
      focusSession(s.name);
      closeSide();
    };
    li.querySelector('.edit').onclick = (e) => {
      e.stopPropagation();
      beginRename(li, s.name);
    };
    els.sessionList.appendChild(li);
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

  const commit = () => {
    const v = inp.value.trim();
    if (v && v !== name) state.rename[name] = v;
    else if (!v) delete state.rename[name];
    saveRenames();
    li.classList.remove('editing');
    renderSideList();
    renderTabs();
    renderGrid();
    toast(v && v !== name ? `renamed to "${v}"` : 'name reset');
  };
  const cancel = () => {
    li.classList.remove('editing');
    renderSideList();
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };
  inp.onblur = commit;
}

// ---------- rendering: card / grid / list ----------
// All three views use the same card markup. The host element decides the layout.
function buildCell(s) {
  const cls = pillClass(state.status[s.name]?.state);
  const cell = document.createElement('div');
  cell.dataset.session = s.name;
  cell.className = `cell${s.name === state.active ? ' focus' : ''}`;
  const preview = buildPreview(state.paneText.get(s.name) || '');
  cell.innerHTML = `
    <div class="h ${cls}">
      <span class="name">${escapeHtml(displayName(s.name))}</span>
      <span class="pill"></span>
    </div>
    <div class="preview">${escapeHtml(preview)}</div>
    <div class="b"></div>`;
  cell.onclick = (e) => {
    e.stopPropagation();
    // single tap → select this card (route send-keys here, stay in current view)
    selectSession(s.name);
  };
  cell.ondblclick = (e) => {
    e.stopPropagation();
    // double tap → focus + go to single-card view
    focusSession(s.name);
    setMode('card');
  };
  return cell;
}

function renderInto(host, sessions) {
  host.innerHTML = '';
  for (const s of sessions) {
    const cell = buildCell(s);
    host.appendChild(cell);
    mountTerm(s.name, cell.querySelector('.b'));
    connectSession(s.name);
  }
}

function renderCard() {
  // card mode = one big card for the active session
  const active = state.sessions.find((s) => s.name === state.active) || state.sessions[0];
  if (active) state.active = active.name;
  renderInto(els.cardPane, active ? [active] : []);
  renderDocState();
}
function renderGrid() {
  els.gridPane.className = `grid-pane size-${state.gridSize}`;
  const targets = state.sessions.slice(0, state.gridSize);
  renderInto(els.gridPane, targets);
}
function renderList() {
  // list mode = cards stacked vertically, full width
  renderInto(els.listPane, state.sessions);
}

function updateAllHeaders() {
  // update header pills + focus ring without remounting xterm
  for (const host of [els.cardPane, els.gridPane, els.listPane]) {
    for (const cell of host.children) {
      const name = cell.dataset.session;
      if (!name) continue;
      const cls = pillClass(state.status[name]?.state);
      cell.querySelector('.h').classList.remove('idle','busy','wait','offline');
      cell.querySelector('.h').classList.add(cls);
      cell.classList.toggle('focus', name === state.active);
    }
  }
}

// ---------- focus session ----------
function focusSession(name) {
  state.active = name;
  els.dockTarget.textContent = displayName(name);
  els.appTitle.textContent = displayName(name);
  connectSession(name);
  // mount in whichever host is currently visible (so card mode swaps content too)
  const host = (state.mode === 'card') ? els.cardPane.querySelector('.b')
            : (state.mode === 'list') ? els.listPane.querySelector(`.cell[data-session="${cssEscape(name)}"] .b`)
            : els.gridPane.querySelector(`.cell[data-session="${cssEscape(name)}"] .b`);
  if (host) {
    const entry = state.terms.get(name);
    if (!entry || !entry.term.element || !host.contains(entry.term.element)) {
      mountTerm(name, host);
    }
  }
  renderTabs();
  renderSideList();
  updateAllHeaders();
  renderDocState();
}

// Select = activate that card for send-keys without leaving the current view.
// In grid mode this puts the focus ring on the card; in terminal mode it's a no-op
// since you're already on the focused session.
function selectSession(name) {
  focusSession(name);
}

// ---------- mode switching ----------
function setMode(mode) {
  state.mode = mode;
  els.main.classList.remove('view-card','view-grid','view-list');
  els.main.classList.add(`view-${mode}`);
  for (const b of $$('.mode-btn')) b.classList.toggle('on', b.dataset.mode === mode);
  // grid size picker is meaningful in grid mode, hidden otherwise
  els.gridSizes.classList.toggle('hidden', mode !== 'grid');
  // back arrow only in card mode (to return to grid/list)
  els.backBtn.classList.toggle('hidden', mode !== 'card');
  // dock visible whenever there is a session to send keys to
  els.dock.classList.toggle('hidden', mode === 'list');
  if (mode === 'card')  renderCard();
  if (mode === 'grid')  renderGrid();
  if (mode === 'list')  renderList();
  renderDocState();
}

function setGridSize(n) {
  state.gridSize = n;
  saveGrid();
  for (const b of $$('.size-btn')) b.classList.toggle('on', Number(b.dataset.size) === n);
  if (state.mode === 'grid') renderGrid();
}

// ---------- sidebar (the "home" list) ----------
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
}
function closeSide() {
  if (!state.side) return;
  state.side = false;
  els.side.classList.remove('on');
  const back = document.querySelector('.side-back');
  if (back) back.classList.remove('on');
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
    toast(`sent to ${displayName(state.active)}`);
  } catch (err) {
    toast(`send failed: ${err.message}`);
  } finally {
    setTimeout(renderDocState, 600);
  }
}

function renderDocState() {
  const s = state.status[state.active];
  const enabled = !!state.active && s?.state !== 'busy';
  els.sendBtn.disabled = !enabled;
  els.sendInput.disabled = !state.active;
}

function renderAll() {
  renderTabs();
  renderSideList();
  if (state.mode === 'card') renderCard();
  if (state.mode === 'grid') renderGrid();
  if (state.mode === 'list') renderList();
  renderDocState();
}

// ---------- swipe from left edge ----------
function wireSwipe() {
  let startX = 0, startY = 0, started = false, swiping = false;

  const onTouchStart = (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    const t = e.touches[0];
    // only initiate from the left 24px OR when sidebar is open
    const fromEdge = t.clientX < 24;
    const onOpen   = state.side;
    if (!fromEdge && !onOpen) return;
    startX = t.clientX; startY = t.clientY; started = true; swiping = false;
  };
  const onTouchMove = (e) => {
    if (!started) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiping = true;
      // open affordance while swiping right from edge
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

  // mouse-drag fallback (so desktop dev also works)
  let md = null;
  document.addEventListener('mousedown', (e) => {
    if (e.clientX > 24 && !state.side) return;
    md = { x: e.clientX };
  });
  document.addEventListener('mouseup', (e) => {
    if (!md) return;
    const dx = e.clientX - md.x;
    if (state.side && dx < -80) closeSide();
    else if (!state.side && dx > 60) openSide();
    md = null;
  });
}

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function cssEscape(s) { return String(s).replace(/"/g, '\\"'); }

// ---------- wire up ----------
els.menuBtn.onclick   = openSide;
els.backBtn.onclick   = () => setMode('grid');
els.refreshBtn.onclick= () => { fetchInitial(); for (const s of state.sessions) connectSession(s.name); };
els.installBtn.onclick= () => promptInstall();
for (const b of $$('.mode-btn')) b.onclick = () => setMode(b.dataset.mode);
for (const b of $$('.size-btn')) b.onclick = () => setGridSize(Number(b.dataset.size));
els.sendBtn.onclick   = send;
els.sendInput.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
};

window.addEventListener('resize', () => {
  for (const name of state.terms.keys()) relayoutTerm(name);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) connectStatus();
});

// ---------- PWA install prompt ----------
window.addEventListener('beforeinstallprompt', (e) => {
  // stash the prompt so we can fire it from a button
  e.preventDefault();
  state.installPrompt = e;
});

window.addEventListener('appinstalled', () => {
  state.installPrompt = null;
  els.installBtn.classList.add('hidden');
  toast('installed — open codebox from your home screen');
});

// If running already as installed (display-mode = standalone), no install button.
function hideInstallIfInstalled() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches
                  || window.navigator.standalone === true;
  if (standalone) els.installBtn.classList.add('hidden');
}

async function promptInstall() {
  if (!state.installPrompt) {
    // Either already installed, or browser doesn't expose the prompt
    // (HTTP / Tailscale IP / no SW). Show instructions instead.
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
}

// boot
(async function boot() {
  loadRenames();
  loadGrid();
  setGridSize(state.gridSize);   // applies .on to the right button
  setMode('card');
  hideInstallIfInstalled();
  await fetchInitial();
  connectStatus();
  wireSwipe();
})();