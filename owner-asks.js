// The manager's ledger of questions for the owner (~/.local/state/ghosty/manager-owner-asks.jsonl, see TASK-44-MANAGER.md):
// one line per question {at,id,session,question,options,recommendation,floor,what,why,state:"open"}, later lines per resolution
// {id,state:"answered|superseded|partial|amended"} or {action:"ledger-close|ledger-amend|log_intent"}. The open ones are what
// the owner still has to answer; the page shows them in the NEEDS YOU strip.
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { routineHostUnit } from './host-unit-routine.js';

const CLOSED = new Set(['answered', 'superseded', 'closed', 'resolved', 'withdrawn']);

// ---- tolerant ledger reads ----
// The ledger is the evidence of which owner questions are still open, so one damaged line must never hide the
// rest of the file: a line that does not parse is skipped, never allowed to abort the read, and never passed on
// silently. Damage is counted and located (line numbers only, never the text: a ledger line is owner wording).
export function openAsksFromRecords(records) {
  const byId = new Map();
  for (const r of records) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || !r.id) continue;
    const prev = byId.get(r.id) || { id: r.id, open: false };
    if (r.action === 'ledger-close' || CLOSED.has(r.state)) { prev.open = false; byId.set(r.id, prev); continue; }
    if (r.state === 'open' || r.action === 'log_intent' || r.action === 'ledger-amend' || r.state === 'partial' || r.state === 'amended') {
      prev.open = true;
      // floor, what and why travel with the ask: the floor is the evidence that the ask passed the gate
      // (a record without one is a defect, never shown to the owner) and the owner reads what and why.
      for (const k of ['at', 'session', 'question', 'recommendation', 'floor', 'what', 'why', 'jev']) if (r[k]) prev[k] = r[k];
      if (Array.isArray(r.options) && r.options.length) prev.options = r.options;
    }
    byId.set(r.id, prev);
  }
  return [...byId.values()].filter((a) => a.open && a.question).map(({ open, ...a }) => a)
    .sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));
}

// A row of the ledger that is itself a question: it carries the owner's wording. A resolution, a supersede
// record or a stop id is not a question and must never stand in for one: a question may only be closed by
// another question that really exists (E22: a stop closed the session's questions and named a stop id as the
// replacement, so the question was gone with nothing in its place).
const isAskRow = (r) => !!(r && typeof r === 'object' && !Array.isArray(r) && r.id && typeof r.question === 'string' && r.question.trim());

// ---- the floor is the evidence that the ask passed the gate ----
// Every route into the ledger runs checkAsk (owner-asks.js) before it writes, and only a record that passed
// gets a floor. A record without a valid floor reached the ledger some other way - a hand-written line, an
// older writer, a script that skipped the gate - so it is never shown to the owner (Q231 reached the owner
// exactly that way, 2026-10-25). It is reported to the manager as a defect instead.
export function floorOf(record) {
  const f = String((record && record.floor) || '').trim();
  return FLOORS.includes(f) ? f : null;
}

// A record the owner may see: it has a question and a valid floor, so it passed the gate.
export function showable(record) {
  return !!(record && typeof record.question === 'string' && record.question.trim() && floorOf(record));
}

// The open asks the owner may see, newest first.
export function showableAsks(records) {
  return openAsksFromRecords(records).filter(showable);
}

// The open asks that never passed the gate: never shown to the owner, reported to the manager instead.
export function defectAsks(records) {
  return openAsksFromRecords(records).filter((a) => !showable(a))
    .map((a) => ({ id: a.id, session: a.session || '', at: a.at || '', why: 'no valid floor: this ask never passed the gate (owner-ask.js)' }));
}

// One view of the ledger, for everything that has to see more than the open set: the open asks, the ids that
// are questions, the ids the owner answered, and every superseded ask with the id that replaced it.
// The safety net needs the last part: a dropped question is closed, so the open set cannot show it (E24).
export function ledgerView(records) {
  const askRows = new Map(), answeredIds = new Set(), superseded = [];
  for (const r of records) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    if (isAskRow(r)) askRows.set(r.id, { session: String(r.session || ''), question: String(r.question) });
    if (r.state === 'answered') answeredIds.add(r.id);
    if (r.state === 'superseded' && r.by) superseded.push({ id: String(r.id), by: String(r.by), at: String(r.at || '') });
  }
  const open = openAsksFromRecords(records);
  return {
    open, openIds: new Set(open.map((a) => a.id)), askRows, askIds: new Set(askRows.keys()), answeredIds, superseded,
    supersededBy: new Map(superseded.map((s) => [s.id, s.by])),
  };
}

// What a superseded ask means for the owner: the replacement is still open (the older question is still
// waiting), the replacement was answered (the owner answered it, nothing is lost), or the replacement is not a
// question in the ledger (the question was dropped with no replacement: the E22 case).
export function supersededState(s, view) {
  if (view.openIds.has(s.by)) return 'open';
  if (view.answeredIds.has(s.by)) return 'answered';
  return 'dropped';
}

// One open ask per session (round 9, item 5): the newest of a session stands, the older ones are shown no more.
// `asks` is newest first; `supersededBy` maps an ask id to the id that replaced it.
// An older ask is hidden only when its replacement is itself listed: a question whose replacement is missing or
// closed is still waiting for the owner and must stay visible (E22: a stop closed the question and named no
// replacement, so the question was gone from the owner's list with nothing in its place).
export function newestPerSession(asks, supersededBy = new Map()) {
  const listed = new Set(asks.map((a) => a.id));
  const seen = new Set();
  const out = [];
  for (const a of asks) {
    if (!a.session) { out.push(a); continue; }
    if (!seen.has(a.session)) { seen.add(a.session); out.push(a); continue; }   // the newest of the session stands
    const by = supersededBy.get(a.id);
    if (by && listed.has(by)) continue;    // replaced by a question the owner can see
    out.push(a);                            // no visible replacement: the question stays visible
  }
  return out;
}

// A line that holds two appended records on one line (two objects written back to back, no newline between them)
// is split and both objects are recovered, in order. The split is brace-depth and string aware, so a `}` inside a
// quoted value does not cut a record in half. -> { parts, dangling }: the complete objects, and whatever text
// after them does not close into one (a truncated tail, or leading garbage) - content that cannot be recovered.
function splitConcatenated(line) {
  const parts = [];
  let depth = 0, start = -1, end = 0, inStr = false, esc = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; continue; }
    if (c === '}') { depth = Math.max(0, depth - 1); if (depth === 0 && start >= 0) { parts.push(line.slice(start, i + 1)); start = -1; end = i + 1; } }
  }
  return { parts, dangling: line.slice(end).trim() };
}

// Parse the whole ledger text, line by line. -> { records, damaged }.
// `records` are the objects that could be read, in file order. `damaged` describes every line that was not one
// clean JSON record, with its 1-based line number and length only - never its content. A missing, empty or
// unreadable file is handled by the caller (readLedger); this never throws.
export function parseLedgerText(text) {
  const records = [], damaged = [];
  const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let r = null;
    try { r = JSON.parse(line); } catch { r = null; }
    if (r && typeof r === 'object' && !Array.isArray(r)) { records.push(r); continue; }
    // Not one whole record: either two records written back to back on the line, or a truncated fragment.
    const { parts, dangling } = splitConcatenated(line);
    const good = [];
    let lost = dangling ? 1 : 0;
    for (const p of parts) {
      let o = null;
      try { o = JSON.parse(p); } catch { o = null; }
      if (o && typeof o === 'object' && !Array.isArray(o)) good.push(o); else lost++;
    }
    if (good.length) { records.push(...good); damaged.push({ line: i + 1, chars: line.length, recovered: good.length, lost, why: 'concatenated' }); }
    else damaged.push({ line: i + 1, chars: line.length, recovered: 0, lost: Math.max(1, lost), why: 'unparseable' });
  }
  return { records, damaged };
}

// One appendFile per record, serialised per file path (the promise chain, as session-history.js does it): a record
// that the kernel splits across writes can then not interleave with another writer's record in this process.
// Two *processes* writing the same ledger are still only as safe as the filesystem's O_APPEND: cross-process
// serialisation is not guaranteed here, and is not claimed.
const writeChains = new Map();
export function withFileLock(file, fn) {
  const key = resolve(file);
  const prev = writeChains.get(key) || Promise.resolve();
  const run = prev.then(async () => { await mkdir(dirname(file), { recursive: true }); return fn(); });
  const chain = run.then(() => {}, () => {});
  writeChains.set(key, chain);
  // drop the entry once this writer is the last one, so a long-lived process does not keep a chain per file
  chain.then(() => { if (writeChains.get(key) === chain) writeChains.delete(key); });
  return run;
}

export function appendRecord(file, record) {
  return withFileLock(file, () => appendFile(file, JSON.stringify(record) + '\n'));
}

// reportDamage: one line per distinct damage signature, so a polled dashboard does not repeat itself, and never
// the ledger text itself.
const damageSeen = new Map();
export function reportDamage(file, damaged, readError = null) {
  const key = resolve(file);
  const sig = readError ? `err:${readError}` : `${damaged.length}:${damaged.map((d) => `${d.line}x${d.lost}`).join(',')}`;
  if (damageSeen.get(key) === sig) return;
  damageSeen.set(key, sig);
  if (readError) { console.error(`[owner-asks] ledger unreadable (${readError}): ${key} - open asks reported as none`); return; }
  if (!damaged.length) return;
  const where = damaged.map((d) => d.line).join(',');
  const lost = damaged.reduce((n, d) => n + (d.lost || 0), 0);
  console.error(`[owner-asks] ledger damaged: ${damaged.length} unusable line(s) at line ${where}, ${lost} record(s) lost - the file needs repair`);
}

// readLedger: the whole file, damage included. -> { records, damaged, readError }. Never throws: a missing file
// and a read failure both degrade to an empty read, but a read failure is reported as readError so it is not
// mistaken for "no questions are open".
export async function readLedger(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (e) {
    const code = e && e.code === 'ENOENT' ? null : String((e && e.code) || (e && e.message) || e);
    return { records: [], damaged: [], readError: code };
  }
  const { records, damaged } = parseLedgerText(text);
  return { records, damaged, readError: null };
}

// The open asks plus what was unreadable, for a caller (or a test) that must see the damage.
// -> { asks, defects, damaged, readError }. The damage is logged once per distinct signature.
// `asks` holds only the asks the owner may see: a record with no valid floor never passed the gate, so it is
// a defect (reported to the manager) and never reaches the owner (owner, 2026-10-25).
export async function readOpenAsksReport(file) {
  const { records, damaged, readError } = await readLedger(file);
  reportDamage(file, damaged, readError);
  const view = ledgerView(records);
  const asks = newestPerSession(view.open.filter(showable), view.supersededBy);
  return { asks, defects: defectAsks(records), damaged, readError };
}

export async function readOpenAsks(file) {
  return (await readOpenAsksReport(file)).asks;
}

// openAsks(lines): the open asks of a ledger already split into lines. Damaged lines are skipped, never fatal.
// Only the asks the owner may see: a record with no valid floor is a defect, not a question for the owner.
export function openAsks(lines) {
  const list = Array.isArray(lines) ? lines : String(lines == null ? '' : lines).split('\n');
  return showableAsks(parseLedgerText(list.join('\n')).records);
}

// A refused supersede says so: one line on stderr (ids only, never owner wording) and the caller's report.
const refuse = (report, msg) => {
  console.error(`[owner-asks] ${msg}`);
  if (typeof report === 'function') { try { report(msg); } catch { /* a broken reporter must not break the ledger */ } }
  return [];
};

// A session filed a second question: every older open ask of that session is marked superseded by it (appended to the ledger, never edited).
// -> the superseded ids. A missing ledger is not created.
// The replacement must be a question that exists in the ledger, for the same session: a stop id is not a
// question, so a stop that carries no owner question closes nothing (E22). A missing ledger, an unknown id or
// an id that is not a question closes nothing and is reported.
export async function supersedeOlder(file, session, newId, { now = new Date(), before = null, report = null } = {}) {
  if (!session || !newId) return [];
  const { records, readError } = await readLedger(file);
  if (readError) return refuse(report, `ledger unreadable (${readError}): nothing superseded`);
  const replacement = records.find((r) => r && typeof r === 'object' && !Array.isArray(r) && r.id === newId);
  if (!replacement) return refuse(report, `${newId} is not in the ledger: nothing superseded`);
  if (!isAskRow(replacement)) return refuse(report, `${newId} is not a question in the ledger: nothing superseded`);
  // a question that never passed the gate (no valid floor) closes nothing: the owner never saw it, so it must
  // not hide a question the owner is still waiting for (owner, 2026-10-25)
  if (!showable(replacement)) return refuse(report, `${newId} never passed the ask gate: nothing superseded`);
  if (String(replacement.session || '').trim() !== String(session).trim()) return refuse(report, `${newId} is a question of another session: nothing superseded`);
  // `before` (ms): only asks written before that moment; an ask with no readable time is left alone
  const older = openAsksFromRecords(records).filter((a) => a.session === session && a.id !== newId && (before == null || Date.parse(a.at) < before));
  if (!older.length) return [];
  // one appendFile per record: a single write of N lines can be chunked by the kernel, and a chunk boundary inside
  // one write is how a line ends up half-written. One record per write keeps the damage to one record.
  for (const a of older) await appendRecord(file, { at: now.toISOString(), id: a.id, state: 'superseded', by: newId });
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

// The risk each floor carries, per floor: what could be lost, exposed or restarted (owner, 2026-10-25). The
// "Why you" line must name one of them: a why that only repeats the floor's name ("it is a credentials
// question") tells the owner nothing about what is at stake, so it is refused.
const FLOOR_RISK = {
  money: /\b(?:pay|paid|paying|payment|spend|spent|spends|charge|charged|bill|billed|billing|invoice|subscription|lapse|lapsed|suspend|suspended|cost|money|funds|refund|price|pricing)\b/i,
  credentials: /\b(?:credential|credentials|secret|secrets|password|passphrase|api[_ -]?key|token|tokens|key|keys|cert|certificate|login|sudoers?|expose|exposed|exposes|leak|leaked|leaks|stolen|revoked|rotated|readable|published)\b/i,
  customers: /\b(?:customer|customers|client|clients|user account|tenant|subscriber|subscribers|paying|data|lost|gone|deleted|affected|visible|exposed|notified|down)\b/i,
  deleting_data: /\b(?:delete|deleting|deleted|remove|removed|destroy|destroyed|drop|dropped|wipe|wiped|purge|purged|erase|erased|prune|pruned|truncate|truncated|shared data|database|db|table|row|rows|record|records|lost|gone|unrecoverable|permanent|permanently)\b/i,
  host_units: /\b(?:sudoers?|systemd|units?|service|services|daemon|crontab|sudo|root|host|restart|restarted|reboot|rebooted|stopped|down|offline|unreachable|removed|disabled)\b/i,
  production_migration: /\b(?:migration|migrate|migrating|schema change|production database|prod db|locked|broken|rolled back|unrecoverable|lost|down)\b/i,
  history_rewrite: /\b(?:force[- ]?push|history rewrite|rewritten|rewriting|rebase|amend|rewrit\w*|tag|tags|publish|published|package|lost|unreachable|irrecoverable)\b/i,
  owner_fact: /\b(?:owner|only you|nobody else|you decided|your decision|preference|personal)\b/i,
};

// A recommended option that changes nothing is not a decision: there is nothing for the owner to answer
// (Q226, 2026-10-25: the recommended option was "keep as is / change nothing"). Such an ask must be decided by
// the manager itself and journaled with `owner-ask.js decide`.
const NOOP_RES = [
  /^(?:change nothing|do nothing|do not change|don't change|nothing changes|no changes?|no-op|status quo|nothing to decide)\b/i,
  /\b(?:keep|leave|stay|remain)\b[^.;|]{0,40}\b(?:as is|as it is|as-is|the same|unchanged|untouched)\b/i,
  /^\s*(?:keep|leave it|leave things|stay)\b\s*[.!]?\s*$/i,
];
// The option text without its number ("1 keep as is" -> "keep as is").
const optionLabel = (o) => String(o || '').replace(/^\s*\d+\s*[.):\-]?\s+/, '').trim();
export function isNoopOption(text) {
  const s = optionLabel(text);
  if (!s) return false;
  return NOOP_RES.some((re) => re.test(s));
}

// The words that name a consequence: what could be lost, exposed, restarted, paid or stopped.
const CONSEQUENCE_RE = /\b(?:could|would|might|may|lose|loses|lost|expose|exposed|exposes|leak|leaked|leaks|restart|restarted|reboot|delete|deleted|deleting|wipe|wiped|remove|removed|paid|pay|spend|spends|spent|charge|charged|bill|billed|suspend|suspended|revoke|revoked|rotate|rotated|publish|published|push|pushed|stop|stopped|down|offline|unreachable|irrecoverable|permanent|permanently|gone|break|breaks|broken|blocked|visible|readable)\b/i;

// A "Why you" that is only a list of technical words ("credentials, production migration, customer data")
// names no risk at all, so the owner cannot tell why the question is his (owner, 2026-10-25). Such a why is
// refused: the line must say in plain words what could be lost, exposed or restarted.
export function isBareTermList(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  const parts = s.split(/[,;/|]|\band\b|\bor\b/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;                                  // one phrase is a sentence, not a list
  return parts.every((p) => p.split(/\s+/).length <= 4 && !CONSEQUENCE_RE.test(p));
}

// The recommendation: an option number ("2") or a text that starts with one ("2 - pay it now, because ...").
// The text after the number is the manager's own view, the owner sees it as the recommendation.
export function recommendOf(recommend) {
  const s = String(recommend == null ? '' : recommend).trim();
  if (!s) return { n: null, text: '' };
  const m = /^(\d+)\b/.exec(s);
  if (!m) return { n: null, text: s };
  return { n: Number(m[1]), text: s.slice(m[0].length).replace(/^[\s\-–—:.)]+/, '').trim() };
}

// checkAsk: the gate. -> { ok: true } | { ok: false, why }. Pure, so the CLI, a test and any future caller share it.
// Requires: a question, a plain "what it is / where / what each option does", the options and a recommendation, a floor
// from FLOORS, and a one-line "why you" in plain words that names the floor's risk. Refuses bare internal ids in the
// owner's wording and a recommendation that changes nothing (owner, 2026-10-25).
export function checkAsk({ question, what, options, recommend, floor, why } = {}) {
  const q = String(question || '').trim(), w = String(what || '').trim(), y = String(why || '').trim();
  const opts = Array.isArray(options) ? options.map((o) => String(o).trim()).filter(Boolean) : [];
  if (!q) return { ok: false, why: '--question is empty: write the question in plain words' };
  if (!w) return { ok: false, why: '--what is empty: 2-4 lines saying what it is, where, and what each option does' };
  if (!y) return { ok: false, why: '--why is empty: say why the floor applies to the chosen action' };
  if (!floor) return { ok: false, why: `--floor is required: one of ${FLOORS.join(', ')}` };
  if (!FLOORS.includes(floor)) return { ok: false, why: `--floor must be one of ${FLOORS.join(', ')} (got "${floor}")` };
  if (opts.length < 2) return { ok: false, why: '--options needs at least two options: "1 what it does|2 what it does"' };
  const rec = recommendOf(recommend);
  if (rec.n === null || !Number.isInteger(rec.n) || rec.n < 1 || rec.n > opts.length) {
    return { ok: false, why: `--recommend must be an option number 1-${opts.length} (got "${recommend}")` };
  }
  // a recommendation that changes nothing is not a question for the owner: decide it yourself (owner, 2026-10-25)
  const noopLabel = isNoopOption(opts[rec.n - 1]);
  const noopText = !noopLabel && rec.text ? isNoopOption(rec.text) : false;
  if (noopLabel || noopText) {
    const what = noopLabel ? `"${optionLabel(opts[rec.n - 1])}"` : `the recommendation "${rec.text}"`;
    return { ok: false, why: `the recommended option (${rec.n}) changes nothing (${what}): there is nothing for the owner to decide - decide it yourself and journal it with "owner-ask.js decide"` };
  }
  const ids = [...bareInternalIds(q), ...bareInternalIds(w)];
  if (ids.length) return { ok: false, why: `internal id without an explanation (${ids.join(', ')}): name the thing in plain words, and quote the id only where you explain it` };
  if (floor === 'host_units') {
    const r = routineHostUnit(`${q} ${w} ${y} ${opts.join(' ')}`);
    if (r.routine) return { ok: false, why: `a routine unit / timer install is not a floor item (owner 2026-10-25): decide it yourself and journal it with "owner-ask.js decide" (${r.why})` };
  }
  // the "why you" is one line, in plain words, and it names the risk of this floor (owner, 2026-10-25)
  if (/[\r\n]/.test(y)) return { ok: false, why: '--why must be one line: the "why you" line says in plain words what could be lost, exposed or restarted' };
  if (isBareTermList(y)) return { ok: false, why: '--why is a list of technical terms: say in one plain line what could be lost, exposed or restarted (why it is yours)' };
  if (!FLOOR_RISK[floor].test(y)) return { ok: false, why: `--why does not name the "${floor}" risk: say in one plain line what could be lost, exposed or restarted` };
  if (!FLOOR_HINT[floor].test(`${q} ${w} ${y}`)) return { ok: false, why: `--why does not show why the "${floor}" floor applies: say in one line what makes this a hard-floor item` };
  return { ok: true };
}

// The ledger id of the next ask: Q<n> after the highest one already in the ledger (the strip's own numbering).
// Read tolerantly: a damaged line must not make the numbering reuse an id that the ledger already holds.
async function nextAskId(file) {
  const { records, readError } = await readLedger(file);
  if (readError) return 'Q1';
  let max = 0;
  for (const r of records) { const m = /^Q(\d+)$/.exec(String(r?.id || '')); if (m) max = Math.max(max, Number(m[1])); }
  return `Q${max + 1}`;
}

// fileAsk: the gate, then one ledger line {at,id,session,question,options,recommendation,floor,what,why,state:"open"}.
// -> { ok: true, id, record } | { ok: false, why } (nothing is written when refused).
// The floor in the line is the evidence that the ask passed the gate: a record without one never reaches the
// owner (owner-asks.js showable()).
export async function fileAsk(file, ask, { now = new Date() } = {}) {
  const check = checkAsk(ask);
  if (!check.ok) return check;
  // the next id is read and the record written under one lock: two asks in flight at once must not both read the
  // same "next" id and write two records under it, which would drop one of the questions from the open set
  const written = await withFileLock(file, async () => {
    const id = await nextAskId(file);
    const record = {
      at: now.toISOString(), id, session: String(ask.session || '').trim(), question: String(ask.question).trim(),
      options: ask.options.map((o) => String(o).trim()), recommendation: String(ask.recommendation || ask.recommend),
      floor: ask.floor, what: String(ask.what).trim(), why: String(ask.why).trim(), state: 'open',
    };
    if (ask.jev) record.jev = String(ask.jev).slice(0, 400);
    await appendFile(file, JSON.stringify(record) + '\n');
    return { id, record };
  });
  // A second question for a session replaces the session's older open questions (round 9, item 5): the older
  // ones are closed by this question, never by a stop id (E22). The lock is released before this runs.
  await supersedeOlder(file, written.record.session, written.id, { now });
  return { ok: true, id: written.id, record: written.record };
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
  await appendRecord(file, record);
  return { ok: true, id: record.decision_id, record };
}
