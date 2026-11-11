// Found-bugs channel (owner, 2026-10-28): a session that hits a bug outside its scope fixes it or files it here; the
// manager sends a worker. Store: <stateDir>/found-bugs.jsonl (untracked). Pure helpers (redact, detector) + a small store.
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const FILE_NAME = 'found-bugs.jsonl';
export const STATES = ['fixed', 'wontfix', 'doc-only', 'duplicate'];   // duplicate: the note names the original id (bug-6829b74a)
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

// Why a bug was filed instead of fixed (owner, 2026-11-11: fix-first). Missing = an old client that does not send it.
export const WHY = ['large', 'other-area', 'host-or-device', 'credentials', 'owner-floor', 'live-session-task'];
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
  const why = String(o.why ?? o.whyNotFixed ?? '').trim().toLowerCase();
  r.why = WHY.includes(why) ? why : 'missing';
  r.reason = redact(o.reason).replace(/\s+/g, ' ').trim().slice(0, 300);
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
      const key = (b) => b.session + '\0' + String(b.title ?? '').toLowerCase();
      // tombstone lines ({ id, removed, at }) have no title: only real reports that were not removed dedupe
      const rows = await all(), gone = new Set(rows.filter((b) => b.removed).map((b) => b.id));
      const prev = rows.find((b) => b.title && !b.removed && !gone.has(b.id) && key(b) === key(r) && now() - Date.parse(b.at) < DEDUPE_MS);
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
  // fixed(id, note): marks a report fixed (a marker line; the report stays listed with fixed: true and leaves the open counts).
  async function fixed(id, note = '') {
    const b = (await all()).find((x) => x.id === id && x.title);
    if (!b) return { ok: false, error: 'no such bug' };
    await appendFile(file, JSON.stringify({ id, fixed: true, note: redact(note).slice(0, 300), at: new Date(now()).toISOString() }) + '\n');
    return { ok: true };
  }
  // resolve(id, { state, commit, note, by }): state fixed | wontfix | doc-only | duplicate. Marker line; the last one wins.
  async function resolve(id, { state = 'fixed', commit = '', note = '', by = '' } = {}) {
    if (!STATES.includes(state)) return { ok: false, error: `state must be one of ${STATES.join(', ')}` };
    const b = (await all()).find((x) => x.id === id && x.title);
    if (!b) return { ok: false, error: 'no such bug' };
    const clean = (v, n) => redact(v).replace(/\s+/g, ' ').trim().slice(0, n);
    if (state === 'fixed' && !clean(commit, 80)) return { ok: false, error: 'commit (sha or integration id) required for state fixed' };
    await appendFile(file, JSON.stringify({ id, resolved: true, state, commit: clean(commit, 80), note: clean(note, 300), by: clean(by, 80) || 'unknown', at: new Date(now()).toISOString() }) + '\n');
    return { ok: true };
  }
  async function list({ limit = 100, unresolved = false, state = '', offset = 0 } = {}) {
    const rows = await all(), gone = new Set(rows.filter((r) => r.removed).map((r) => r.id));
    const done = new Map(rows.filter((r) => r.fixed).map((r) => [r.id, r])), res = new Map(rows.filter((r) => r.resolved).map((r) => [r.id, r]));
    const out = rows.filter((r) => r.title && !r.removed && !gone.has(r.id)).map((r) => {
      const v = res.get(r.id), f = done.get(r.id);
      if (v) return { ...r, state: v.state, resolved: true, ...(v.state === 'fixed' ? { fixed: true } : {}), commit: v.commit, resolvedNote: v.note, resolvedBy: v.by, resolvedAt: v.at };
      if (f) return { ...r, state: 'fixed', resolved: true, fixed: true, fixedNote: f.note, fixedAt: f.at };
      return { ...r, state: 'open' };
    });
    // newest `limit` of the (filtered) rows; offset skips that many of the newest first, so a client pages back through 340+ reports
    const rows2 = state ? out.filter((r) => r.state === state) : unresolved ? out.filter((r) => !r.resolved) : out;
    const lim = Math.max(1, Math.min(5000, limit)), off = Math.max(0, offset | 0), end = rows2.length - off;
    return rows2.slice(Math.max(0, end - lim), Math.max(0, end));
  }
  async function counts() {
    const rows = await list({ limit: 5000 }), day = now() - DEDUPE_MS;
    const real = rows.filter((b) => !b.test && !b.resolved);
    return { total: real.length, blocking: real.filter((b) => b.blocking).length, last24h: real.filter((b) => Date.parse(b.at) >= day).length };
  }
  // week(days): filed vs fixed by their finder vs fixed by someone else (a worker), real reports filed in the window (scorecard)
  async function week(days = 7) {
    const since = now() - days * DEDUPE_MS, rows = (await list({ limit: 5000 })).filter((b) => !b.test && Date.parse(b.at) >= since);
    const fixed = rows.filter((b) => b.resolved && b.state === 'fixed'), mine = fixed.filter((b) => b.resolvedBy === b.session);
    const missing = rows.filter((b) => !b.why || b.why === 'missing').length;
    return { days, filed: rows.length, fixed: fixed.length, fixedByFinder: mine.length, fixedByWorker: fixed.length - mine.length, open: rows.filter((b) => !b.resolved).length, whyMissing: missing };
  }
  async function recentBy(session, ms = REPORTED_MS) {
    return (await list({ limit: 5000 })).some((b) => b.session === session && now() - Date.parse(b.at) < ms);
  }
  return { add, remove, fixed, resolve, list, counts, week, recentBy, file };
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

// Send-back (owner, 2026-11-11): a bug filed with no reason or as large/other-area, with a repro and not blocking, by a live session, goes back to
// its finder once: it knows the repro. Hard-floor topics never. Pure.
const FLOOR = /\b(?:credentials?|secrets?|tokens?|passwords?|api[- ]?keys?|sudoers?|delet(?:e|ion)s? of data|data loss|force-?push|money|payment|invoice|billing|customers?|production|prod host|migration)\b/i;
export function sendBackOf(b) {
  if (!b || b.test || b.blocking || !String(b.repro || '').trim()) return false;
  if (!['missing', 'large', 'other-area'].includes(b.why || 'missing')) return false;   // a report stored before the field existed has no why: missing
  return !FLOOR.test([b.title, b.repro, b.error, b.reason].join(' '));
}
export const sendBackText = (b) => `You filed ${b.id}. If it is small, fix it now in your own worktree and resolve it (found-bug --resolve ${b.id} --commit <sha|integration id>); otherwise reply with the reason (found-bug --why-not-fixed large|other-area|host-or-device|credentials|owner-floor|live-session-task).`;

// Sweep (owner, 2026-11-11): open reports from sessions that are still live, grouped per session: one kept wake each listing the ids. Pure.
export function sweepGroups(bugs, liveSessions, { perSession = 8 } = {}) {
  const live = liveSessions instanceof Set ? liveSessions : new Set(liveSessions), by = new Map();
  for (const b of bugs) if (!b.resolved && live.has(b.session) && sendBackOf(b)) by.set(b.session, [...(by.get(b.session) || []), b]);
  return [...by].map(([session, list]) => ({ session, count: list.length, text:
    `You have ${list.length} open bug report(s) you filed: ${list.slice(0, perSession).map((b) => `${b.id} (${b.title.slice(0, 70)})`).join('; ')}${list.length > perSession ? '; ...' : ''}. If any is small, fix it now in your own worktree and resolve it (found-bug --resolve <id> --commit <sha|integration id>); otherwise reply with the reason per bug.` }));
}
