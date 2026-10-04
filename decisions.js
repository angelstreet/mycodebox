// Jev decisions (TASK-44): the product's decision log as seen from ghosty. Pure helpers plus one small client.
//   - the manager's Jev calls are logged in the product (log:true, team_id, refs) and their outcome is written back
//   - the "Jev & AI" usage tab and the decisions page read GET /server/ai/decisions[/summary] when the server has it,
//     and fall back to ghosty's own stall log (the manager's calls only) when it does not.
// Server-to-server: X-API-Key from JEV_API_KEY, base = origin of JEV_URL (like triage.js).
import { readFile, writeFile } from 'node:fs/promises';

export const MANAGER_USAGE = 'text.decision.manager';
export const FALLBACK_USAGE = 'text.decision';
export const DAYS = 14;
const MIN = 60e3;

export const serverBase = (jevUrl) => { try { return new URL(jevUrl).origin; } catch { return ''; } };

// ---- the product's decision API ----
export function createDecisionsClient({ jevUrl, apiKey, teamId, fetchFn = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const base = serverBase(jevUrl);
  const configured = !!(base && apiKey && teamId);
  let probe = { at: -Infinity, ok: false };
  const call = async (method, path, { params, body, timeoutMs = 8000 } = {}) => {
    if (!configured) return { ok: false, status: 0, error: !teamId ? 'VPT_TEAM_ID not set' : 'server not configured' };
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    try {
      const r = await fetchFn(u, { method, headers: { 'X-API-Key': apiKey, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.success !== false) return { ok: true, status: r.status, json: j };
      return { ok: false, status: r.status, error: String(j?.error || `http ${r.status}`).slice(0, 200) };
    } catch (e) { return { ok: false, status: 0, error: e.message }; }
  };
  return {
    configured,
    teamId,
    // GET /server/ai/decisions/summary -> normalised, or { error }
    async summary() {
      const r = await call('GET', '/server/ai/decisions/summary', { params: { team_id: teamId } });
      probe = { at: now(), ok: r.ok };
      return r.ok ? { ok: true, ...normalizeSummary(r.json) } : { ok: false, status: r.status, error: r.error };
    },
    // Does the server know the decision log (and so text.decision.manager)? Cached: 5 min when yes, 1 min when no.
    async available() {
      if (now() - probe.at < (probe.ok ? 5 * MIN : MIN)) return probe.ok;
      return (await this.summary()).ok;
    },
    async list(f = {}) {
      const r = await call('GET', '/server/ai/decisions', { params: { team_id: teamId, usage: f.usage, since: f.since, until: f.until, ok: f.ok, has_outcome: f.hasOutcome,
        limit: Math.min(500, Math.max(1, Number(f.limit) || 100)), offset: Math.max(0, Number(f.offset) || 0) } });
      return r.ok ? { ok: true, rows: Array.isArray(r.json.decisions) ? r.json.decisions : [] } : { ok: false, status: r.status, error: r.error };
    },
    // 'sent' | 'retry' (any refusal is retried later: the endpoint or the decision may not exist yet)
    async postOutcome(decisionId, outcome) {
      const r = await call('POST', `/server/ai/decisions/${encodeURIComponent(decisionId)}/outcome`, { body: { team_id: teamId, outcome } });
      if (r.ok) return 'sent';
      return 'retry';   // never dropped here: an older server answers an unknown route with 400 or 404; the queue expires after 7 days
    },
  };
}

export function normalizeSummary(j) {
  const days = Array.isArray(j?.days) ? j.days : [];
  const usages = (Array.isArray(j?.usages) ? j.usages : []).map((u) => ({
    usage_key: u.usage_key, calls: Number(u.calls) || 0, failed: Number(u.failed) || 0, cost: Number(u.cost) || 0,
    last_at: u.last_at || null, with_outcome: Number(u.with_outcome) || 0, per_day: u.per_day && typeof u.per_day === 'object' ? u.per_day : {},
  })).filter((u) => u.usage_key);
  return { days, usages, truncated: !!j?.truncated };
}

// ---- outcome write-back ----
// What really happened, in the manager's own vocabulary (Jev's three options), or null when it says nothing.
const CASE_TRUTH = { continue: 'continue', stopped_short: 'continue', ask_status: 'continue', menu_recommended: 'take_recommended' };
export function outcomeFromReplyKind(kind) {
  if (kind === 'continue' || kind === 'take_recommended') return kind;
  if (kind === 'owner_specific') return 'ask_owner';   // the owner typed something of their own: it needed the owner
  return null;
}
// An owner label on a stop. legit = the stop was needed -> ask_owner; no_reason = it should not have stopped -> continue;
// wrong_case + the right case -> that case's meaning.
export function outcomeFromLabel({ label, correctCase } = {}) {
  if (label === 'legit') return 'ask_owner';
  if (label === 'no_reason') return 'continue';
  if (label === 'wrong_case') return correctCase ? (CASE_TRUTH[correctCase] || 'ask_owner') : null;
  return null;
}
export const outcomeBody = (label, by, stallId) => ({ label, by, stall_id: stallId });

// Small persistent retry queue: [{ decision_id, outcome, at }], newest write per decision wins, dropped after 7 days.
export function createOutcomeQueue({ file, send, now = () => Date.now(), maxAgeMs = 7 * 24 * 3600e3, max = 200 }) {
  let items = [], running = null, loaded = false;
  const save = () => writeFile(file, JSON.stringify(items)).catch(() => {});
  const load = async () => { if (loaded) return; loaded = true; try { const a = JSON.parse(await readFile(file, 'utf8')); if (Array.isArray(a)) items = a; } catch {} };
  const flush = () => (running ||= (async () => {
    await load();
    const keep = [];
    for (const it of items) {
      if (now() - it.at > maxAgeMs) continue;
      let res = 'retry';
      try { res = await send(it.decision_id, it.outcome); } catch {}
      if (res === 'retry') keep.push(it);
    }
    items = keep; await save();
    return items.length;
  })().finally(() => { running = null; }));
  return {
    async add(decisionId, outcome) {
      await load();
      items = items.filter((i) => i.decision_id !== decisionId);
      items.push({ decision_id: decisionId, outcome, at: now() });
      if (items.length > max) items = items.slice(-max);
      await save();
      return flush();
    },
    flush, size: () => items.length, items: () => items.slice(),
  };
}

// ---- reading the local stall log ----
const dayOf = (iso) => String(iso || '').slice(0, 10);
export function lastDays(n, now = Date.now()) {
  return Array.from({ length: n }, (_, i) => new Date(now - (n - 1 - i) * 86400e3).toISOString().slice(0, 10));
}
const blank = () => ({ calls: 0, failed: 0, cost: 0 });

// One Jev call = a stall record whose jev is a result (a choice or an error); skipped calls never reached the server.
export const jevCalls = (recs) => recs.filter((r) => r.type === 'stall' && r.jev && (r.jev.choice || r.jev.error));
export const reviewerCalls = (recs) => recs.filter((r) => r.type === 'triage' && (r.ai || r.error));

function perDay(list, days) {
  const m = new Map(days.map((d) => [d, blank()]));
  for (const r of list) {
    const e = m.get(dayOf(r.at)); if (!e) continue;
    const j = r.type === 'stall' ? r.jev : r;
    e.calls++; if (j.error) e.failed++; e.cost += Number(j.cost || 0);
  }
  return days.map((d) => ({ day: d, ...m.get(d) }));
}
// Current state of a call stream: the newest call, and how many calls in a row have failed.
function health(list) {
  if (!list.length) return { state: 'none' };
  const sorted = list.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const j = (r) => (r.type === 'stall' ? r.jev : r);
  let streak = 0; for (const r of sorted) { if (j(r).error) streak++; else break; }
  const last = sorted[0];
  return streak ? { state: 'failing', error: j(last).error, at: last.at, streak } : { state: 'ok', at: last.at };
}
const totals = (rows) => rows.reduce((t, r) => ({ calls: t.calls + r.calls, failed: t.failed + r.failed, cost: t.cost + r.cost }), blank());

// The "Jev & AI" tab: local streams always; the product's uses when `remote` (a summary result) is ok.
export function tabData({ recs, remote, now = Date.now(), days = DAYS }) {
  const ds = lastDays(days, now);
  const jc = jevCalls(recs), rc = reviewerCalls(recs);
  const stream = (list) => { const d = perDay(list, ds); return { days: d, total: totals(d), health: health(list) }; };
  const product = remote?.ok
    ? { available: true, usages: remote.usages.map((u) => ({ ...u, days: ds.map((d) => ({ day: d, calls: Number(u.per_day[d]) || 0 })) })), truncated: remote.truncated }
    : { available: false, reason: remote?.error || 'server not reachable' };
  return { windowDays: days, manager: stream(jc), reviewer: stream(rc), product };
}

// ---- decisions rows (the shape of the server's list, plus helpers) ----
// answers: { <question>: { choice, confidence, probabilities } } -> the first question's pick.
export function pickOf(answers) {
  const a = answers && typeof answers === 'object' ? Object.values(answers).find((x) => x && typeof x === 'object') : null;
  if (!a) return { pick: null, confidence: null };
  let pick = a.choice ?? a.value ?? a.label ?? null;
  if (pick === null && a.probabilities) pick = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  let c = Number(a.confidence);
  if (!Number.isFinite(c) && a.probabilities && pick != null) c = Number(a.probabilities[pick]);
  return { pick: pick == null ? null : String(pick), confidence: Number.isFinite(c) ? c : null };
}

// A row ready for the page: pick/confidence, what it is about, outcome + agreement (true/false/null).
export function viewRow(row, { stops } = {}) {
  const { pick, confidence } = pickOf(row.answers);
  const refs = row.refs && typeof row.refs === 'object' ? row.refs : {};
  const outLabel = row.outcome && typeof row.outcome === 'object' ? (row.outcome.label ?? null) : null;
  const manager = refs.source === 'ghosty-manager';
  const stop = manager && stops ? stops.get(refs.stall_id) || null : null;
  return {
    id: row.id, at: row.created_at, usage: row.usage_key, model: row.model || null, ok: row.ok !== false && !row.error, error: row.error || null,
    ms: row.ms ?? null, cost: row.cost == null ? null : Number(row.cost), pick, confidence, refs, manager,
    session: manager ? refs.session || null : null, stallId: manager ? refs.stall_id || null : null,
    about: manager ? `${refs.session || '?'} · ${refs.case || 'stop'}` : aboutOf(refs),
    outcome: outLabel == null ? null : { label: String(outLabel), by: row.outcome.by || null, at: row.outcome_at || null },
    agree: outLabel != null && pick != null ? String(outLabel) === pick : null,
    ...(stop ? { stop } : {}),
  };
}
function aboutOf(refs) {
  const k = Object.keys(refs).find((x) => /_id$/.test(x) && refs[x]);
  return k ? `${k} ${String(refs[k]).slice(0, 8)}` : Object.entries(refs).filter(([, v]) => typeof v !== 'object').slice(0, 2).map(([a, b]) => `${a} ${b}`).join(', ') || '';
}

// Local fallback: the manager's own Jev calls, rows shaped like the server's.
export function localRows(recs, { usage = FALLBACK_USAGE } = {}) {
  const outcomes = new Map(), labels = new Map();
  for (const r of recs) {
    if (r.type === 'outcome') outcomes.set(r.id, r);
    else if (r.type === 'label' && r.label) labels.set(r.id, r);
    else if (r.type === 'unlabel') labels.delete(r.id);
  }
  return jevCalls(recs).map((r) => {
    const j = r.jev;
    const o = labels.has(r.id)
      ? { label: outcomeFromLabel(labels.get(r.id)), by: 'owner', at: labels.get(r.id).at }
      : outcomes.has(r.id) && outcomes.get(r.id).via !== 'manager' ? { label: outcomeFromReplyKind(outcomes.get(r.id).kind), by: 'owner-reply', at: outcomes.get(r.id).at } : null;
    return {
      id: j.decision_id || r.id, created_at: r.at, usage_key: usage, model: j.model || null, ok: !j.error, error: j.error || null, ms: j.ms ?? null, cost: j.cost ?? null,
      answers: j.choice ? { choice: { choice: j.choice, confidence: j.confidence, probabilities: j.probabilities } } : {},
      refs: { source: 'ghosty-manager', session: r.session, stall_id: r.id, case: r.case },
      outcome: o && o.label ? { label: o.label, by: o.by } : null, outcome_at: o?.label ? o.at : null,
    };
  }).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export function stopsIndex(recs) {
  const m = new Map();
  for (const r of recs) if (r.type === 'stall' && r.id) m.set(r.id, { session: r.session, case: r.case, excerpt: String(r.excerpt || r.question || '').slice(-400) });
  return m;
}

// Filters the owner sets on the page: f = { usage, ok: 'true'|'false'|'', hasOutcome: 'true'|'false'|'', minConf }
export function filterView(rows, f = {}) {
  const min = Number(f.minConf);
  return rows.filter((r) => (!f.usage || (f.usage.endsWith('.') ? r.usage?.startsWith(f.usage) : r.usage === f.usage))
    && (f.ok !== 'true' && f.ok !== 'false' || r.ok === (f.ok === 'true'))
    && (f.hasOutcome !== 'true' && f.hasOutcome !== 'false' || !!r.outcome === (f.hasOutcome === 'true'))
    && (!(min > 0) || (r.confidence != null && r.confidence >= min)));
}

// Page data: the server's rows (all uses) when it answers, else the local manager rows, labelled.
export async function decisionsPage({ client, recs, f = {}, usageNow = FALLBACK_USAGE }) {
  const stops = stopsIndex(recs);
  const remote = client?.configured ? await client.list({ usage: f.usage, ok: f.ok, hasOutcome: f.hasOutcome, limit: f.limit, offset: f.offset, since: f.since }) : { ok: false, error: !client?.teamId ? 'VPT_TEAM_ID not set' : 'server not configured' };
  if (remote.ok) {
    const rows = filterView(remote.rows.map((r) => viewRow(r, { stops })), { minConf: f.minConf });
    return { source: 'server', rows, more: remote.rows.length >= (Math.min(500, Math.max(1, Number(f.limit) || 100))) };
  }
  const rows = filterView(localRows(recs, { usage: usageNow }).map((r) => viewRow(r, { stops })), f);
  const limit = Math.max(1, Number(f.limit) || 100), off = Math.max(0, Number(f.offset) || 0);
  return { source: 'local', note: `the server has no decision log yet (${remote.error}); showing the manager's own Jev calls from ghosty's log`, rows: rows.slice(off, off + limit), more: rows.length > off + limit };
}
