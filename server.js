// Ghosty Sessions — server
// Streams tmux panes for every Claude/Codex session on codebox over WebSocket.
// Bound to :7777 on Tailscale only. No public DNS, no auth prompt.
//
// Routes
//   GET  /api/sessions          → list tmux sessions + status pill
//   GET  /ws/:session           → WebSocket: streams pane content (1 Hz tick)
//   POST /api/send/:session     → body {keys: "..."} → tmux send-keys + Enter
//   GET  /api/snapshot/:session → last full pane snapshot (for first paint)
//   GET  /*                     → static files in ./public

import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import { spawn, execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '0.0.0.0';
const TICK_MS = Number(process.env.TICK_MS || 1000);
const PANE_LINES = Number(process.env.PANE_LINES || 300);
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
  const fmt = '#{session_name}|#{pane_pid}|#{pane_current_command}|#{pane_width}|#{pane_height}|#{pane_dead}|#{window_active}|#{pane_active}';
  const out = new Map();
  try {
    const { stdout } = await exec(TMUX, ['list-panes', '-a', '-F', fmt]);
    for (const line of stdout.split('\n').filter(Boolean)) {
      const [name, pid, cmd, cols, rows, dead, wa, pa] = line.split('|');
      const active = wa === '1' && pa === '1';
      if (out.has(name) && !active) continue;
      out.set(name, { pid: Number(pid), cmd, cols: Number(cols), rows: Number(rows), dead: dead === '1' });
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

const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash']);

async function capturePane(session) {
  // Visible pane + modest scrollback. No -J: keep tmux's own line breaks so
  // the client can size xterm to the pane's cols. -e keeps colour escapes.
  const { stdout } = await exec(TMUX, [
    'capture-pane', '-t', session, '-p', '-e', '-S', `-${PANE_LINES}`,
  ], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const lastSendAt = new Map();    // session -> ms epoch

const NAMED_KEYS = new Set(['Escape', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab', 'C-c', 'C-d', 'Space', 'BSpace']);
const LITERAL_KEYS = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'y', 'n']);

async function sendKey(session, key) {
  if (NAMED_KEYS.has(key)) {
    await exec(TMUX, ['send-keys', '-t', session, key]);
  } else if (LITERAL_KEYS.has(key)) {
    await exec(TMUX, ['send-keys', '-t', session, '-l', '--', key]);
  } else {
    const e = new Error('key not allowed'); e.status = 400; throw e;
  }
  lastSendAt.set(session, Date.now());
  return { ok: true, key };
}

async function sendKeys(session, keys, enter = true) {
  // Split on \n so a multi-line paste works.
  const lines = String(keys || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length) {
      await exec(TMUX, ['send-keys', '-t', session, '-l', '--', line]);
    }
    if (enter || i < lines.length - 1) await exec(TMUX, ['send-keys', '-t', session, 'Enter']);
  }
  lastSendAt.set(session, Date.now());
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
// In-memory cache + poll
// ---------------------------------------------------------------------------

const lastSnapshots = new Map(); // session -> { pane, cols, rows }
const track = new Map();         // session -> { changeAt, workingSince }

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
    if (!p.dead) {
      try { pane = await capturePane(s.name); } catch { failed = true; }
    }
    const offline = p.dead || failed;
    const prev = lastSnapshots.get(s.name);
    let changed = false;
    if (!offline) {
      changed = !prev || prev.pane !== pane || prev.cols !== p.cols || prev.rows !== p.rows;
      if (changed) {
        lastSnapshots.set(s.name, { pane, cols: p.cols, rows: p.rows });
        changedSessions.push(s.name);
      }
    }
    const t = track.get(s.name) || { changeAt: 0, workingSince: null };
    if (changed && prev && prev.pane !== pane) t.changeAt = now;   // first sight is not activity
    track.set(s.name, t);

    const tail = tailLines(offline ? '' : pane, 15);
    const tailText = tail.join('\n');
    const ag = (!offline && agentFromTree(p.pid, table)) || (!offline && agentFromText(tailText)) || null;
    const agent = ag ? ag.agent : (SHELLS.has(p.cmd) || p.cmd === 'sleep' || !p.cmd ? 'bash' : 'other');
    const agentCmd = ag ? ag.cmd : (p.cmd || 'bash');

    let state = 'idle';
    let waitReason = null;
    if (offline) state = 'offline';
    else if (agent !== 'bash' && (waitReason = findWaitReason(tail)) !== null) state = 'waiting';
    else if (now - t.changeAt < WORKING_HOLD_MS || (agent !== 'bash' && WORK_RE.test(tail.filter((l) => !/⏵⏵|bypass permissions|accept edits/.test(l)).join('\n')))) state = 'working';
    if (state !== 'waiting') waitReason = null;
    if (state === 'working') { if (!t.workingSince) t.workingSince = now; }
    else t.workingSince = null;

    status[s.name] = {
      state, agent, agentCmd, waitReason,
      lastActivitySec: s.lastActivitySec,
      lastSendAt: lastSendAt.get(s.name) ?? null,
      workingSinceMs: t.workingSince,
      cols: p.cols, rows: p.rows,
      attached: s.attached, windows: s.windows, cmd: p.cmd,
    };
  });
  for (const k of [...lastSnapshots.keys()]) if (!status[k]) lastSnapshots.delete(k);
  for (const k of [...track.keys()]) if (!status[k]) track.delete(k);
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

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Tight CORS — bound to Tailscale only anyway, but be explicit.
  res.setHeader('referrer-policy', 'no-referrer');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // --- API ---
  if (req.method === 'GET' && p === '/api/sessions') {
    const r = (latest && Date.now() - latest.at < 1500) ? latest : await poll();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: r.sessions, status: r.status }));
    return;
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
    catch {
      res.writeHead(400); res.end('bad json'); return;
    }
    try {
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
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/ws/status') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      statusSubs.add(ws);
      if (leaseCache.value?.ok) ws.send(JSON.stringify({ type: 'leases', leases: leaseCache.value.leases }));
      if (latest) ws.send(JSON.stringify({ type: 'status', status: latest.status }));
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
      if (cache) send(cache);
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
  console.log(`[ghosty] public dir: ${PUBLIC_DIR}`);
  // First poll, then on tick.
  await tick();
  setInterval(tick, TICK_MS);
  leaseTick();
  setInterval(leaseTick, 15000);
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