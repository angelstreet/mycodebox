// The manager's ledger of questions for the owner (~/.local/state/ghosty/manager-owner-asks.jsonl, see TASK-44-MANAGER.md):
// one line per question {at,id,session,question,options,recommendation,floor,what,why,state:"open"}, later lines per resolution
// {id,state:"answered|superseded|partial|amended"} or {action:"ledger-close|ledger-amend|log_intent"}. The open ones are what
// the owner still has to answer; the page shows them in the NEEDS YOU strip.
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const CLOSED = new Set(['answered', 'superseded', 'closed', 'resolved', 'withdrawn']);

export function openAsks(lines) {
  const byId = new Map();
  for (const line of lines) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || !r.id) continue;
    const prev = byId.get(r.id) || { id: r.id, open: false };
    if (r.action === 'ledger-close' || CLOSED.has(r.state)) { prev.open = false; byId.set(r.id, prev); continue; }
    if (r.state === 'open' || r.action === 'log_intent' || r.action === 'ledger-amend' || r.state === 'partial' || r.state === 'amended') {
      prev.open = true;
      for (const k of ['at', 'session', 'question', 'recommendation']) if (r[k]) prev[k] = r[k];
      if (Array.isArray(r.options) && r.options.length) prev.options = r.options;
    }
    byId.set(r.id, prev);
  }
  return [...byId.values()].filter((a) => a.open && a.question).map(({ open, ...a }) => a)
    .sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));
}

// One open ask per session (round 9, item 5): the newest of a session stands, the older ones are shown no more. `asks` is newest first.
export function newestPerSession(asks) {
  const seen = new Set();
  return asks.filter((a) => { if (!a.session) return true; if (seen.has(a.session)) return false; seen.add(a.session); return true; });
}

export async function readOpenAsks(file) {
  try { return newestPerSession(openAsks((await readFile(file, 'utf8')).split('\n').filter(Boolean))); } catch { return []; }
}

// A session escalated a new ask: every older open ask of that session is marked superseded by it (appended to the ledger, never edited).
// -> the superseded ids. A missing ledger is not created.
export async function supersedeOlder(file, session, newId, { now = new Date(), before = null } = {}) {
  if (!session || !newId) return [];
  let lines; try { lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean); } catch { return []; }
  // `before` (ms): only asks written before the stop that raised the new one; an ask with no readable time is left alone
  const older = openAsks(lines).filter((a) => a.session === session && a.id !== newId && (before == null || Date.parse(a.at) < before));
  if (!older.length) return [];
  await appendFile(file, older.map((a) => JSON.stringify({ at: now.toISOString(), id: a.id, state: 'superseded', by: newId })).join('\n') + '\n');
  return older.map((a) => a.id);
}

// ---- the ask gate (owner rule 2026-10-20): a question reaches the owner only when it touches the hard floor ----
// The manager files owner questions through scripts/owner-ask.js only; this is the check it runs, so a script call, a
// hand-written ledger line and a test all agree on what counts as a floor question.
export const FLOORS = ['money', 'credentials', 'customers', 'deleting_data', 'host_units', 'production_migration', 'history_rewrite', 'owner_fact'];

// A bare internal identifier in the owner's wording: a session/integration id (int-a1b2c3d4), a commit sha
// (7-40 hex, word-bounded so "added" is not a sha) or an ask reference (Q12). These mean nothing to the owner, so the
// text must explain the thing next to the id ("the integration request int-a1b2c3d4 that stalled") to pass. Kept
// deliberately simple: three patterns, one documented escape (the explanation in the same text).
const BARE_ID_RES = [
  /\bint-[a-z0-9]{8,}\b/i,
  /\b[0-9a-f]{7,40}\b/i,
  /\bQ\d+\b/,
];
export function bareInternalIds(text) {
  const s = String(text || '');
  const hits = [];
  for (const re of BARE_ID_RES) { const m = s.match(re); if (m) hits.push(m[0]); }
  return [...new Set(hits)];
}

// Why the floor applies, per floor: the words that make it a real hard-floor item (AGENTS.md autonomy by default).
const FLOOR_HINT = {
  money: /\b(?:pay|payment|money|bill|invoice|budget|credit card|charge|cost|spend|subscription|refund|funds?)\b/i,
  credentials: /\b(?:credential|secret|password|passphrase|api[_ -]?key|token|key|cert|certificate|login|sudoers?)\b/i,
  customers: /\b(?:customer|client|user account|tenant|subscriber|paying)\b/i,
  deleting_data: /\b(?:delete|deleting|remove|destroy|drop|wipe|purge|erase|prune|truncate|shared data|database|table)\b/i,
  host_units: /\b(?:sudoers?|systemd|units?|service|daemon|crontab|sudo|root|host)\b/i,
  production_migration: /\b(?:migration|migrate|schema change|production database|prod db)\b/i,
  history_rewrite: /\b(?:force[- ]?push|history rewrite|rebase|amend|rewrit|tag|tags|publish|package)\b/i,
  owner_fact: /\b(?:owner|only you|nobody else|you decided|your decision|preference|personal)\b/i,
};

// checkAsk: the gate. -> { ok: true } | { ok: false, why }. Pure, so the CLI, a test and any future caller share it.
// Requires: a question, a plain "what it is / where / what each option does", the options and a recommendation, a floor
// from FLOORS, and a why that says why that floor applies. Refuses bare internal ids in the owner's wording.
export function checkAsk({ question, what, options, recommend, floor, why } = {}) {
  const q = String(question || '').trim(), w = String(what || '').trim(), y = String(why || '').trim();
  const opts = Array.isArray(options) ? options.map((o) => String(o).trim()).filter(Boolean) : [];
  if (!q) return { ok: false, why: '--question is empty: write the question in plain words' };
  if (!w) return { ok: false, why: '--what is empty: 2-4 lines saying what it is, where, and what each option does' };
  if (!y) return { ok: false, why: '--why is empty: say why the floor applies to the chosen action' };
  if (!floor) return { ok: false, why: `--floor is required: one of ${FLOORS.join(', ')}` };
  if (!FLOORS.includes(floor)) return { ok: false, why: `--floor must be one of ${FLOORS.join(', ')} (got "${floor}")` };
  if (opts.length < 2) return { ok: false, why: '--options needs at least two options: "1 what it does|2 what it does"' };
  const n = Number(recommend);
  if (!Number.isInteger(n) || n < 1 || n > opts.length) return { ok: false, why: `--recommend must be an option number 1-${opts.length} (got "${recommend}")` };
  const ids = [...bareInternalIds(q), ...bareInternalIds(w)];
  if (ids.length) return { ok: false, why: `internal id without an explanation (${ids.join(', ')}): name the thing in plain words, and quote the id only where you explain it` };
  if (!FLOOR_HINT[floor].test(`${q} ${w} ${y}`)) return { ok: false, why: `--why does not show why the "${floor}" floor applies: say in one line what makes this a hard-floor item` };
  return { ok: true };
}

// The ledger id of the next ask: Q<n> after the highest one already in the ledger (the strip's own numbering).
async function nextAskId(file) {
  let lines = []; try { lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean); } catch { return 'Q1'; }
  let max = 0;
  for (const l of lines) { let r; try { r = JSON.parse(l); } catch { continue; } const m = /^Q(\d+)$/.exec(String(r?.id || '')); if (m) max = Math.max(max, Number(m[1])); }
  return `Q${max + 1}`;
}

// fileAsk: the gate, then one ledger line {at,id,session,question,options,recommendation,floor,what,why,state:"open"}.
// -> { ok: true, id, record } | { ok: false, why } (nothing is written when refused).
export async function fileAsk(file, ask, { now = new Date() } = {}) {
  const check = checkAsk(ask);
  if (!check.ok) return check;
  const id = await nextAskId(file);
  const record = {
    at: now.toISOString(), id, session: String(ask.session || '').trim(), question: String(ask.question).trim(),
    options: ask.options.map((o) => String(o).trim()), recommendation: String(ask.recommend),
    floor: ask.floor, what: String(ask.what).trim(), why: String(ask.why).trim(), state: 'open',
  };
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(record) + '\n');
  return { ok: true, id, record };
}

// The "Decided for you" journal record (manager-decisions.jsonl, the file manager.js appendJournal writes and
// decided.js reads): the shape of decide-policy.js menuRecord, so the owner sees one item with what / why / undo.
export function ownerDecisionRecord({ id, session = '', decision, why, undo, at = new Date() } = {}) {
  const ts = at instanceof Date ? at.toISOString() : typeof at === 'number' ? new Date(at).toISOString() : String(at);
  return {
    decision_id: `owner-ask-${id}`, task_id: `manager:${session || 'unknown'}`, kind: 'menu', ts,
    question: decision, chosen: String(decision || '').slice(0, 80), expected_effect: decision, rationale: why,
    evidence: [`decided: ${decision}`, `undo: ${undo}`], actor: { role: 'manager', runtime: null, model: null },
    confidence: 1, policy_ref: 'OWNER_DECISIONS §15', reversible: !!undo, rollback: undo,
    session, source: 'owner-ask', what: decision, undo,
  };
}

// fileDecision: one journal line through the decided mechanism. -> { ok: true, id, record } | { ok: false, why }.
export async function fileDecision(file, { session = '', decision, why, undo, at = new Date(), id = null } = {}) {
  const d = String(decision || '').trim(), y = String(why || '').trim(), u = String(undo || '').trim();
  if (!d) return { ok: false, why: '--decision is empty: say what was decided' };
  if (!y) return { ok: false, why: '--why is empty: give the reason the owner sees' };
  if (!u) return { ok: false, why: '--undo is empty: say how to revert it, one line' };
  const record = ownerDecisionRecord({ id: id || `d${Date.parse(at) || Date.now()}`, session, decision: d, why: y, undo: u, at });
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(record) + '\n');
  return { ok: true, id: record.decision_id, record };
}
