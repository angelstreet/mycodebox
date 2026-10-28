// Found-bugs channel (owner, 2026-10-28): a session that hits a bug outside its scope fixes it or files it here; the
// manager sends a worker. Store: <stateDir>/found-bugs.jsonl (untracked). Pure helpers (redact, detector) + a small store.
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const FILE_NAME = 'found-bugs.jsonl';
export const DEDUPE_MS = 24 * 3600 * 1000;
export const REPORTED_MS = 3600 * 1000;   // a session that filed a bug in the last hour is not asked again

// Obvious secrets only: key=value pairs, bearer tokens, well-known token shapes, PEM blocks, URL credentials.
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted-key]'],
  [/\b(authorization|x-[a-z-]*token|bearer)\s*[:=]?\s*(?:bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\b((?:api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|vapid[_-]?[a-z]*|ntfy[_-]?topic|access[_-]?key)[a-z_-]*)\s*[:=]\s*["']?[^\s"',;]{4,}/gi, '$1=[redacted]'],
  [/\b(?:sk|pk|ghp|gho|github_pat|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{12,}/g, '[redacted-token]'],
  [/\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  [/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted-long]'],
];
export function redact(s) {
  let t = String(s ?? '');
  for (const [re, to] of SECRETS) t = t.replace(re, to);
  return t;
}

const FIELDS = { title: 200, endpoint: 300, repro: 1200, error: 1200, workaround: 600 };
const yes = (v) => v === true || /^(?:y|yes|true|1|blocking)$/i.test(String(v ?? ''));

// Pure. -> clean report or { error }
export function normalize(input, { now = Date.now() } = {}) {
  const o = input && typeof input === 'object' ? input : {};
  const title = redact(o.title).replace(/\s+/g, ' ').trim().slice(0, FIELDS.title);
  if (!title) return { invalid: 'title required' };
  const r = { at: new Date(now).toISOString(), session: String(o.session || 'unknown').replace(/[^\w.@-]/g, '').slice(0, 80) || 'unknown', title };
  for (const k of ['endpoint', 'repro', 'error', 'workaround']) r[k] = redact(o[k]).trim().slice(0, FIELDS[k]);
  r.blocking = yes(o.blocking);
  if (o.test) r.test = true;
  r.id = 'bug-' + createHash('sha1').update(r.session + '\0' + r.title.toLowerCase() + '\0' + r.at).digest('hex').slice(0, 8);
  return r;
}

export function createFoundBugs({ stateDir, onNew = async () => {}, now = Date.now } = {}) {
  const file = join(stateDir, FILE_NAME);
  async function all() {
    let text = '';
    try { text = await readFile(file, 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  let chain = Promise.resolve();
  // add(input) -> { ok, duplicate?, bug } | { ok: false, error }. Same title + session inside 24 h is a duplicate (not stored again).
  function add(input) {
    const p = chain.then(async () => {
      const r = normalize(input, { now: now() });
      if (r.invalid) return { ok: false, error: r.invalid };
      const key = (b) => b.session + '\0' + b.title.toLowerCase();
      const prev = (await all()).find((b) => key(b) === key(r) && !b.removed && now() - Date.parse(b.at) < DEDUPE_MS);
      if (prev) return { ok: true, duplicate: true, bug: prev };
      await mkdir(stateDir, { recursive: true });
      await appendFile(file, JSON.stringify(r) + '\n');
      try { await onNew(r); } catch (e) { console.error('[found-bugs] onNew', e.message); }
      return { ok: true, duplicate: false, bug: r };
    });
    chain = p.catch(() => {});
    return p;
  }
  // remove(id): test reports only are removed by the tool; a tombstone line keeps the file append-only.
  async function remove(id) {
    const b = (await all()).find((x) => x.id === id);
    if (!b) return { ok: false, error: 'no such bug' };
    if (!b.test) return { ok: false, error: 'only test reports can be removed' };
    await appendFile(file, JSON.stringify({ id, removed: true, at: new Date(now()).toISOString() }) + '\n');
    return { ok: true };
  }
  async function list({ limit = 100 } = {}) {
    const rows = await all(), gone = new Set(rows.filter((r) => r.removed).map((r) => r.id));
    return rows.filter((r) => !r.removed && !gone.has(r.id)).slice(-Math.max(1, Math.min(500, limit)));
  }
  async function counts() {
    const rows = await list({ limit: 500 }), day = now() - DEDUPE_MS;
    const real = rows.filter((b) => !b.test);
    return { total: real.length, blocking: real.filter((b) => b.blocking).length, last24h: real.filter((b) => Date.parse(b.at) >= day).length };
  }
  async function recentBy(session, ms = REPORTED_MS) {
    return (await list({ limit: 500 })).some((b) => b.session === session && now() - Date.parse(b.at) < ms);
  }
  return { add, remove, list, counts, recentBy, file };
}

// Detector: closing text that mentions a failure, an unrelated/pre-existing problem or a workaround but never filed it.
const PHRASE = /\b(?:could not|couldn'?t|returned an error|returns an error|unrelated|outside (?:of )?my (?:scope|perimeter)|out of (?:my )?scope|pre-?existing|not caused by me|work-?around)\b/i;
const FILED = /\bfound-bug\b|\/api\/bugs\b|\bbug-[0-9a-f]{8}\b/i;
const STATUS_LINE = /^\W*STATUS:/i;
// Pure. -> { sentence } | null. A text that already mentions found-bug / a bug id is clean.
export function unreportedBugOf(text) {
  const t = String(text || '');
  if (!t.trim() || FILED.test(t)) return null;
  for (const raw of t.replace(/[*_`]+/g, '').split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (!s || STATUS_LINE.test(s)) continue;
    if (PHRASE.test(s)) return { sentence: s.length > 240 ? s.slice(0, 239) + '…' : s };
  }
  return null;
}
