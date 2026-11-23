// A ledger of image / file uploads (owner 2026-11-23: "I often see upload image issues, can I debug that from my Mac?").
// Two writers: the server logs every POST /api/upload it sees (side 'server': accepted, refused, too big, dropped mid-way),
// and the browser reports a final failure (side 'client': a request that never reached the server leaves no server line).
// <state>/uploads.jsonl, newest last, kept to a few hundred lines. Read by GET /api/upload-log and /upload-debug.html.
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';

export const MAX_LINES = 400;
const cut = (v, n) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, n);

// "Chrome 142 · Mac" from a user agent, enough to tell the Mac browser from the phone app
export function clientOf(ua) {
  const s = String(ua || '');
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : '?';
  const b = /Edg\/(\d+)/.exec(s) ? ['Edge', RegExp.$1] : /Firefox\/(\d+)/.exec(s) ? ['Firefox', RegExp.$1] : /Chrome\/(\d+)/.exec(s) ? ['Chrome', RegExp.$1] : /Version\/(\d+).*Safari/.exec(s) ? ['Safari', RegExp.$1] : ['?', ''];
  return `${b[0]}${b[1] ? ' ' + b[1] : ''} · ${os}`;
}

export function logUpload(file, rec) {
  try {
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n');
    if (statSync(file).size > 256 * 1024) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      writeFileSync(file, lines.slice(-MAX_LINES).join('\n') + '\n');
    }
  } catch { /* a ledger must never break an upload */ }
}

export function readUploadLog(file, n = 100) {
  let lines = [];
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const out = [];
  for (const l of lines.slice(-Math.max(1, Math.min(MAX_LINES, Number(n) || 100)))) { try { out.push(JSON.parse(l)); } catch { /* torn line */ } }
  return out;
}

// the browser's report of a failed upload, bounded: only these fields, short strings
export function cleanReport(b, ua) {
  const o = b && typeof b === 'object' ? b : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : undefined);
  return {
    side: 'client', ok: false, client: clientOf(ua),
    name: cut(o.name, 120), type: cut(o.type, 60), sent: cut(o.sent, 60), bytes: num(o.bytes), ms: num(o.ms), attempts: num(o.attempts),
    status: num(o.status), error: cut(o.error, 200), online: o.online === undefined ? undefined : !!o.online,
    net: cut(o.net, 60), page: cut(o.page, 80),
  };
}
