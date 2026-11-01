// Ids a session puts in `STATUS: waiting: ...` besides pids, logs, deploys and integrations (own-jobs.js watches those): a platform script run /
// execution / task id (full uuid, or an 8-hex prefix cut with "..."), a lease ticket (`t-<hex>`) and a lease id. Pure parsing plus two read-only
// resolvers. No secrets: the platform key is passed in by the caller and never logged.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const RUN_WORD = /\b(?:(?:validation|script|test|campaign)\s+)?(?:run|execution|task|exec)(?:\s+id)?\s*[:#=]?\s*/i;
// "validation run c083bd9c..." : a cut id is only an id behind a run word
const PREFIX = new RegExp(`${RUN_WORD.source}([0-9a-f]{8})(?:\\.\\.\\.|\\u2026)`, 'i');
const TICKET = /\b(t-[0-9a-f]{6,12})\b/i;
const LEASE = /\blease(?:\s+id)?\s*[:#=]?\s*([0-9a-f]{8})\b(?!-)/i;

// -> { script: <uuid|prefix|null>, ticket: <t-..|null>, lease: <hex8|null> }
export function waitIds(text) {
  const t = String(text ?? '');
  const u = UUID.exec(t);
  const p = u ? null : PREFIX.exec(t);
  const k = TICKET.exec(t), l = LEASE.exec(t);
  return { script: u ? u[0].toLowerCase() : p ? p[1].toLowerCase() : null, ticket: k ? k[1].toLowerCase() : null, lease: l ? l[1].toLowerCase() : null };
}
export const hasWaitId = (t) => { const w = waitIds(t); return !!(w.script || w.ticket || w.lease); };

const ENDED = /pass|fail|abort|error|cancel|timeout|timed[ _-]?out|success|complete|stopp|discard|skip/i;
const ACTIVE = /run|queue|pend|start|progress|execut|wait/i;
const ms = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; const n = Date.parse(v); return Number.isFinite(n) ? n : null; };

// A platform row (summary payload or script_results row) -> { state: 'running'|'ended'|'unknown', at, status, message }.
// A run that says "running" for longer than `maxRunMin` is treated as ended (stuck): the status call is known to stay "running" for ever (bug-2fe8617b).
export function runState(row, { now = Date.now(), maxRunMin = 120 } = {}) {
  if (!row || typeof row !== 'object') return { state: 'unknown' };
  const message = String(row.metadata?.error ?? row.error_msg ?? row.error ?? row.message ?? '').replace(/\s+/g, ' ').slice(0, 160);
  const completed = ms(row.completed_at), started = ms(row.started_at);
  let status = String(row.status ?? '').toLowerCase();
  if (!status && completed) status = row.success === false ? 'failed' : 'passed';
  if (ENDED.test(status) && !/^running$/.test(status)) return { state: 'ended', at: completed || now, status, message };
  if (completed) return { state: 'ended', at: completed, status: status || 'ended', message };
  if (!status || ACTIVE.test(status)) {
    if (started && now - started > maxRunMin * 60000) return { state: 'ended', at: started + maxRunMin * 60000, status: 'stuck', message: `still "${status || 'running'}" after ${maxRunMin} min with no end` };
    return { state: 'running', status: status || 'running' };
  }
  return { state: 'unknown', status };
}

// Read-only platform source: the server's own HTTP API with the key the manager already holds for Jev (JEV_API_KEY, origin of JEV_URL, VPT_TEAM_ID).
// GET only. A full uuid is read through /server/run-management/summary/script/<id>; an 8-hex prefix is looked up in the recent script results.
export function createScriptRunSource({ jevUrl = '', apiKey = '', teamId = '', fetchFn = (...a) => fetch(...a), timeoutMs = 6000 } = {}) {
  let base = ''; try { base = new URL(jevUrl).origin; } catch { /* unset */ }
  const get = async (path, params) => {
    const q = new URLSearchParams({ team_id: teamId, ...params });
    const r = await fetchFn(`${base}${path}?${q}`, { method: 'GET', headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return r.json().catch(() => null);
  };
  return async function scriptRun(id) {
    if (!base || !apiKey || !teamId || !id) return null;
    try {
      if (UUID.test(id)) return await get(`/server/run-management/summary/script/${id}`, {});
      const j = await get('/server/script-results/getAllScriptResults', { limit: '300' });
      const rows = j?.script_results || j?.results || (Array.isArray(j) ? j : []);
      return rows.find((r) => String(r?.id || '').toLowerCase().startsWith(id)) || null;
    } catch { return null; }
  };
}
