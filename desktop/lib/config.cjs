'use strict';
// Server address + window state, stored as JSON in the app's userData dir. No Electron import: tests run it as is.
const fs = require('node:fs');
const path = require('node:path');

// -> { url, origin, host } or null. Only http(s) with a host; path, query and hash are dropped.
function parseServerUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname || u.username || u.password) return null;
  return { url: u.origin + '/', origin: u.origin, host: u.host };
}

// Is `target` (a URL string) on the stored server's origin?
function sameOrigin(target, serverUrl) {
  try { return new URL(target).origin === new URL(serverUrl).origin; } catch { return false; }
}

function loadConfig(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch { return {}; }
}

function saveConfig(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Saved bounds only if sane; otherwise defaults.
function sanitizeBounds(b) {
  const n = (v) => Number.isFinite(v) ? Math.round(v) : undefined;
  const out = { width: 1280, height: 860 };
  if (b && n(b.width) >= 400 && n(b.height) >= 300) { out.width = n(b.width); out.height = n(b.height); }
  if (b && n(b.x) !== undefined && n(b.y) !== undefined) { out.x = n(b.x); out.y = n(b.y); }
  return out;
}

module.exports = { parseServerUrl, sameOrigin, loadConfig, saveConfig, sanitizeBounds };
