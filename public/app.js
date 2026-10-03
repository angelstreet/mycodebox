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
  termPane:    $('#termPane'),
  gridPane:    $('#gridPane'),
  termHost:    $('#termHost'),
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
  mode:       'terminal',     // terminal | grid
  gridSize:   8,              // 4 | 8 | 12 | 16
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
  entry = { term, fit };
  state.terms.set(session, entry);
  return entry;
}

function mountTerm(session, host) {
  const { term, fit } = getTerm(session);
  host.innerHTML = '';
  // xterm.js exposes `term.element` only after the first open().
  // On the first move we let open() create + attach it; on later moves
  // we reparent the existing element (the safer pattern).
  if (term.element) {
    if (term.element.parentNode !== host) host.appendChild(term.element);
  } else {
    term.open(host);
  }
  requestAnimationFrame(() => { try { fit.fit(); } catch {} });
  setTimeout(() => { try { fit.fit(); } catch {} }, 80);
}

function writeToTerm(session, pane) {
  state.paneText.set(session, pane);
  const entry = state.terms.get(session);
  if (!entry) return;
  // rewrite whole visible pane each tick — xterm.js handles ANSI efficiently
  entry.term.write('\x1b[2J\x1b[H');
  entry.term.write(pane);
  // also refresh preview in grid cards without re-mounting xterm
  if (state.mode === 'grid') updatePreviewForCell(session, pane);
}

function updatePreviewForCell(session, pane) {
  const cell = els.gridPane.querySelector(`[data-session="${cssEscape(session)}"]`);
  if (!cell) return;
  const pv = cell.querySelector('.preview');
  if (!pv) return;
  const prev = buildPreview(pane);
  pv.textContent = prev;
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
  ws.onclose = () => { state.ws.delete(session); setTimeout(() => connectSession(session), 2000); };
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
        renderSideList();
        updateAllHeaders();
        renderDocState();
      }
    } catch {}
  };
  ws.onclose = () => { state.statusWs = null; setTimeout(connectStatus, 2000); };
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

// ---------- rendering: grid (overview) ----------
function renderGrid() {
  els.gridPane.innerHTML = '';
  els.gridPane.className = `grid-pane size-${state.gridSize}`;
  const targets = state.sessions.slice(0, state.gridSize);

  for (const s of targets) {
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
      // single tap → select this card (route send-keys here)
      e.stopPropagation();
      selectSession(s.name);
    };
    cell.ondblclick = (e) => {
      // double tap → go fullscreen on this session
      e.stopPropagation();
      focusSession(s.name);
      setMode('terminal');
    };
    els.gridPane.appendChild(cell);
    mountTerm(s.name, cell.querySelector('.b'));
    connectSession(s.name);
  }
}

function updateAllHeaders() {
  // update header pills + border focus without remounting xterm
  for (const cell of els.gridPane.children) {
    const name = cell.dataset.session;
    if (!name) continue;
    const cls = pillClass(state.status[name]?.state);
    cell.querySelector('.h').classList.remove('idle','busy','wait','offline');
    cell.querySelector('.h').classList.add(cls);
    cell.classList.toggle('focus', name === state.active);
  }
}

// ---------- focus session ----------
function focusSession(name) {
  state.active = name;
  els.dockTarget.textContent = displayName(name);
  els.appTitle.textContent = displayName(name);
  const entry = state.terms.get(name);
  if (!entry || !entry.term.element || !els.termHost.contains(entry.term.element)) {
    mountTerm(name, els.termHost);
  }
  connectSession(name);
  renderTabs();
  renderSideList();
  updateAllHeaders();
  renderDocState();
  // if we were in grid, leave it; if terminal, just refresh.
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
  els.main.classList.remove('view-terminal','view-grid');
  els.main.classList.add(`view-${mode}`);
  for (const b of $$('.mode-btn')) b.classList.toggle('on', b.dataset.mode === mode);
  // show grid size picker only in grid mode
  els.gridSizes.classList.toggle('hidden', mode !== 'grid');
  // back arrow only in terminal mode (to return to grid)
  els.backBtn.classList.toggle('hidden', mode !== 'terminal');
  // dock only meaningful when a session is focused, in terminal mode
  els.dock.classList.toggle('hidden', mode === 'grid');
  if (mode === 'grid') renderGrid();
  if (mode === 'terminal' && state.active) {
    // ensure terminal is mounted
    if (!state.terms.has(state.active) || !els.termHost.contains(state.terms.get(state.active).term.element)) {
      mountTerm(state.active, els.termHost);
    }
  }
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
  if (state.active) {
    mountTerm(state.active, els.termHost);
    connectSession(state.active);
  }
  renderGrid();
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
  for (const { fit } of state.terms.values()) {
    try { fit.fit(); } catch {}
  }
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
  setMode('terminal');
  hideInstallIfInstalled();
  await fetchInitial();
  connectStatus();
  wireSwipe();
})();