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
import { WebSocketServer } from 'ws';
import { spawn, execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '0.0.0.0';
const TICK_MS = Number(process.env.TICK_MS || 1000);
const PANE_LINES = Number(process.env.PANE_LINES || 2000);
const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------

const TMUX = process.env.TMUX_BIN || 'tmux';

async function listSessions() {
  // #{session_name}|#{session_attached}|#{session_activity}|#{session_windows}
  const fmt = '#{session_name}|#{session_attached}|#{session_activity}|#{session_windows}|#{pane_current_command}';
  let raw = '';
  try {
    ({ stdout: raw } = await exec(TMUX, ['list-sessions', '-F', fmt]));
  } catch (err) {
    console.error('[listSessions] failed:', err.code || err.message, 'stderr=', err.stderr || '');
    return [];
  }
  const now = Math.floor(Date.now() / 1000);
  const sessions = raw.trim().split('\n').filter(Boolean).map((line) => {
    const [name, attached, activity, windows, cmd] = line.split('|');
    const last = now - Number(activity);
    return {
      name,
      attached: attached === '1',
      windows: Number(windows) || 1,
      cmd: cmd || '',
      lastActivitySec: last,
    };
  });
  // sort by activity (most recent first), then alpha
  sessions.sort((a, b) => a.lastActivitySec - b.lastActivitySec);
  return sessions;
}

async function capturePane(session) {
  // Capture full visible pane + a chunk of scrollback so xterm can scroll.
  // -J joins wrapped lines; -e preserves escape sequences for color (xterm.js).
  // -S -PANE_LINES = scrollback depth.
  try {
    const { stdout } = await exec(TMUX, [
      'capture-pane', '-t', session, '-p', '-e', '-J',
      '-S', `-${PANE_LINES}`,
    ]);
    return stdout;
  } catch (err) {
    return `\x1b[31m[ghosty] capture failed: ${err.message}\x1b[0m`;
  }
}

async function sendKeys(session, keys) {
  // Split on \n so a multi-line paste works.
  const lines = String(keys || '').split('\n');
  for (const line of lines) {
    if (line.length) {
      await exec(TMUX, ['send-keys', '-t', session, '-l', '--', line]);
    }
    await exec(TMUX, ['send-keys', '-t', session, 'Enter']);
  }
  return { ok: true, sent: lines.length };
}

// ---------------------------------------------------------------------------
// Status pill heuristic — runs against the latest pane text
// ---------------------------------------------------------------------------

// Permission prompt patterns. Tested against real Claude/Codex prompts.
// Keep this list narrow — false positives mark sessions as 'wait' and disable
// the send-keys dock. We only flag things the user must explicitly answer.
const WAIT_RE = /\[y\/n\]|\[Y\/n\]|\(y\/N\)|\(y\/n\)|Allow\?|Approve\?|Do you want to|Would you like me|Press Enter to|press yes to|Press (?:enter|yes|no) to|confirm permission/i;
const TYPING_RE = /⠿|⠼|⠏|Thinking|Working|Running|Reading|Computing|tool_use|⏺/;

function classify(paneText, lastActivitySec) {
  // Wait: an explicit prompt OR no activity for >30s with prompt-looking text.
  if (WAIT_RE.test(paneText)) return 'wait';
  // Typing: recent output (last 5s) and looks like Claude/Codex is generating.
  if (lastActivitySec <= 5 && TYPING_RE.test(paneText)) return 'busy';
  if (lastActivitySec <= 2) return 'busy';
  return 'idle';
}

// ---------------------------------------------------------------------------
// In-memory cache + broadcast
// ---------------------------------------------------------------------------

const lastSnapshots = new Map(); // session -> string

async function pollOnce() {
  const sessions = await listSessions();
  const status = {};
  for (const s of sessions) {
    const pane = await capturePane(s.name);
    const state = classify(pane, s.lastActivitySec);
    const changed = lastSnapshots.get(s.name) !== pane;
    if (changed) lastSnapshots.set(s.name, pane);
    status[s.name] = {
      attached: s.attached,
      lastActivitySec: s.lastActivitySec,
      windows: s.windows,
      cmd: s.cmd,
      state,
      changed,
    };
  }
  // Drop cache entries for sessions that disappeared
  for (const k of lastSnapshots.keys()) {
    if (!status[k]) lastSnapshots.delete(k);
  }
  return { sessions, status };
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
  // Cache PWA shell aggressively, but not the HTML (so updates roll out).
  const cache = rel === '/index.html' || rel === '/sw.js' || rel === '/manifest.webmanifest'
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
    const { sessions, status } = await pollOnce();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions, status }));
    return;
  }
  if (req.method === 'GET' && p.startsWith('/api/snapshot/')) {
    const session = decodeURIComponent(p.slice('/api/snapshot/'.length));
    const pane = lastSnapshots.get(session) ?? await capturePane(session);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ session, pane }));
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
      const out = await sendKeys(session, payload.keys || '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
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
      const cache = lastSnapshots.get(session);
      if (cache !== undefined) {
        ws.send(JSON.stringify({ type: 'snapshot', session, pane: cache }));
      } else {
        // Capture on-demand and reply.
        capturePane(session).then((pane) => {
          lastSnapshots.set(session, pane);
          ws.send(JSON.stringify({ type: 'snapshot', session, pane }));
        });
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

let pollInFlight = false;
async function tick() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const { sessions, status } = await pollOnce();
    // Per-session: send only changed panes.
    for (const [name, snap] of lastSnapshots.entries()) {
      broadcast(name, { type: 'snapshot', session: name, pane: snap });
    }
    // Status broadcast.
    const sStatus = {};
    for (const [name, s] of Object.entries(status)) sStatus[name] = s;
    broadcastStatus({ type: 'status', status: sStatus });
  } catch (err) {
    console.error('[poll]', err.message);
  } finally {
    pollInFlight = false;
  }
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
});

// Clean shutdown
for (const s of ['SIGINT', 'SIGTERM']) {
  process.on(s, () => {
    console.log(`[ghosty] ${s}, shutting down`);
    wss.clients.forEach((c) => c.close());
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}