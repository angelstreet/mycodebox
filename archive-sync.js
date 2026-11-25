// Archived in the Claude app -> parked / removed in ghosty (owner 2026-11-25, docs/tasks/TASK-mac-archive-sync.md).
// The one signal: the Claude Code sessions API (`GET /v1/code/sessions`, what the CLI itself lists for --teleport) gives every Remote
// Control session `status: active | archived`. Only `archived` acts; idle, completed, disconnected, rate-limited or missing never do.
// The token is the account's own OAuth access token on this box, read in memory for this GET only: never logged, stored or refreshed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { titleSlug } from './remote-stops.js';

export const API_URL = 'https://api.anthropic.com/v1/code/sessions?limit=100';
export const MARGIN_MS = 60e3;

// `session_<X>` (claude.ai/code URL, bridgeSessionId) and `cse_<X>` (API id) name the same session.
export const cseOf = (s) => { const m = /(?:^|[/_=])(?:session|cse)_([A-Za-z0-9]{10,64})(?![A-Za-z0-9])/.exec(String(s || '')); return m ? `cse_${m[1]}` : null; };

// API page -> [{ id, title, status, updatedAt }]; anything malformed is skipped.
export function parseList(j) {
  const out = [];
  for (const x of Array.isArray(j?.data) ? j.data : []) {
    if (!x || typeof x.id !== 'string' || !/^cse_[A-Za-z0-9]{10,64}$/.test(x.id)) continue;
    const t = Date.parse(x.updated_at);
    out.push({ id: x.id, title: typeof x.title === 'string' ? x.title : '', status: x.status === 'archived' ? 'archived' : String(x.status || ''), updatedAt: Number.isFinite(t) ? t : 0 });
  }
  return out;
}

export const archivedIds = (list) => new Set(list.filter((x) => x.status === 'archived').map((x) => x.id));

// Mac rows to remove: rows = [{ name, titleKey, rcUrl, lastSeen }]. Returns [{ name, id, by: 'id'|'title' }].
export function macRowsToDrop(rows, list, { marginMs = MARGIN_MS } = {}) {
  const byId = new Map(list.map((x) => [x.id, x]));
  const byTitle = new Map();
  for (const x of list) { const k = titleSlug(x.title); if (!k) continue; if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(x); }
  const out = [];
  for (const r of rows) {
    const id = cseOf(r.rcUrl);
    if (id && byId.has(id)) {   // the row knows its session: that one decides, never a title
      const it = byId.get(id);
      if (it.status === 'archived' && !(r.lastSeen > it.updatedAt + marginMs)) out.push({ name: r.name, id, by: 'id' });
      continue;
    }
    const group = r.titleKey ? byTitle.get(r.titleKey) : null;
    if (!group?.length || !group.every((x) => x.status === 'archived')) continue;
    const at = Math.max(...group.map((x) => x.updatedAt));
    if (r.lastSeen > at + marginMs) continue;   // it posted after the archive: unarchived, or still running
    out.push({ name: r.name, id: group.length === 1 ? group[0].id : group.map((x) => x.id).join(','), by: 'title' });
  }
  return out;
}

// An account's access token, or null (missing, malformed or expiring within a minute: the CLI renews it, we never do).
export function readToken(configDir, now = Date.now(), read = (p) => readFileSync(p, 'utf8')) {
  try {
    const o = JSON.parse(read(join(configDir || join(homedir(), '.claude'), '.credentials.json')))?.claudeAiOauth;
    if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return null;
    if (Number(o.expiresAt) && Number(o.expiresAt) < now + 60e3) return null;
    return o.accessToken;
  } catch { return null; }
}

// One poll over every account: the union of their sessions. Errors are reported by account id, never with the token.
export async function fetchAll({ accounts, fetchImpl = fetch, now = Date.now(), timeoutMs = 15000, read } = {}) {
  const list = [], errors = [];
  for (const a of accounts) {
    const token = readToken(a.configDir, now, read);
    if (!token) continue;
    try {
      const r = await fetchImpl(API_URL, { headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) { errors.push(`${a.id}: HTTP ${r.status}`); continue; }
      list.push(...parseList(await r.json()));
    } catch (e) { errors.push(`${a.id}: ${String(e?.message || e).slice(0, 120)}`); }
  }
  const seen = new Set();
  return { list: list.filter((x) => (seen.has(x.id) ? false : seen.add(x.id))), errors };
}
