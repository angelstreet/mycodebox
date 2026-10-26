#!/usr/bin/env node
// Daily check (scripts/daily-checks.js protocol): the harness' own numbers for the last 24 h.
// The owner only sees a harness regression when he asks for it, so this writes the day's numbers as ONE line in
// <stateDir>/harness-health.jsonl and flags what got worse: new owner asks and how many were answered or superseded,
// decisions the manager took for the owner, the integration lane's final states, CI red minutes, box load / RAM / disk,
// and live sessions with a needs-you state.
//
// Read-only on the state dir except the appended harness-health.jsonl line. A missing or malformed file counts as 0 and
// is listed in the report as "not found": a silent zero would read as a healthy day. Nothing here throws; a check that
// crashes is itself a finding (daily:check-broken:harness-health).
//
// Sources (all under GHOSTY_STATE_DIR, default ~/.local/state/ghosty):
//   manager-owner-asks.jsonl  {at,id,session,question} per ask, {id,state:"answered"|"superseded"} or {id,answered:true} per resolution
//   manager-decisions.jsonl   one line per decision the manager took for the owner
//   integration/requests.jsonl one line per state change; latest record per id wins
//   ci-watch.jsonl            {at,type,red?} per tick; type 'green' closes a red streak
//   /proc/loadavg, /proc/meminfo, statfs('/')  box
//   GET ${GHOSTY_URL:-http://127.0.0.1:7777}/api/sessions  {sessions[], status{name:{state}}}, best effort
//
// Thresholds (a finding only above them): ONE session's owner asks > 3 (the limit is a per-session budget, so parallel
// topic sessions each get their own), lane returned > 5 (a return that a later request for the same repo+branch landed is
// resolved and does not count), CI red > 120 min, disk > 90 %, MemAvailable < 2 GB, any approvalRefused.
// Registered by the manager in the private <stateDir>/daily-checks.json (id "harness-health"); this repo never edits it.
import { readFileSync, statfsSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FLOORS } from '../owner-asks.js';

export const HOURS = 24;
export const ASKS_MAX = 3;
export const LANE_RETURNED_MAX = 5;
export const CI_RED_MIN_MAX = 120;
export const DISK_PCT_MAX = 90;
export const MEM_MIN_MB = 2048;
export const FINAL_STATES = ['merged', 'deployed', 'returned', 'merged_ci_red', 'deploy_failed', 'cancelled'];

export const stateDir = () => process.env.GHOSTY_STATE_DIR || join(homedir(), '.local/state/ghosty');
export const sessionsUrl = () => `${process.env.GHOSTY_URL || 'http://127.0.0.1:7777'}/api/sessions`;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
// A line is inside the window when its own timestamp parses into it. An unreadable timestamp is never "in" the window.
export const inWindow = (at, now, hours = HOURS) => { const t = Date.parse(at); return Number.isFinite(t) && t >= now - hours * 3600000 && t <= now; };

// ---- owner asks (pure) ---------------------------------------------------------------------------------------------
// A new ask is a line carrying the question itself. It counts as closed when a LATER line of the same id resolves it;
// owner-asks.js writes {id,state:"answered"} for an answer and {id,state:"superseded",by:<newId>} when a newer question
// replaced it, an operator script may write {id,answered:true}. All three close the ask: a superseded ask is closed,
// not waiting, so counting only answers left every replaced question reading as open. A resolution line that arrives
// BEFORE its ask line does not close it (it belongs to an earlier question), and answering wins over superseding, so an
// ask answered and later superseded is counted once, as answered.
// Only an ask that passed the gate counts: a record with no valid floor never reached the owner (owner, 2026-10-25),
// so it is a defect for the manager, not an ask of the day.
export function askStats(lines, { now, hours = HOURS }) {
  const asks = new Map(); // id -> {answered, superseded, session}
  let asked = 0;
  for (const line of lines) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object') continue;
    if (r.question && FLOORS.includes(String(r.floor || '').trim()) && inWindow(r.at, now, hours)) {
      if (!asks.has(r.id)) { asks.set(r.id, { answered: false, superseded: false, session: String(r.session || '') }); asked++; }
      continue;
    }
    const prev = asks.get(r.id);
    if (!prev) continue;
    if (r.answered === true || r.state === 'answered') prev.answered = true;
    else if (r.state === 'superseded') prev.superseded = true;
  }
  let answered = 0, superseded = 0;
  for (const a of asks.values()) {
    if (a.answered) answered++;
    else if (a.superseded) superseded++;
  }
  // ASKS_MAX is a per-session budget: parallel topic sessions (each with its own session name) each get their own budget,
  // so only ONE session asking over the limit is a regression. The fleet total stays the fleet total. An ask without a
  // session name cannot be attributed to a session, so it counts in the total only.
  const perSession = new Map();
  for (const a of asks.values()) {
    if (!a.session) continue;
    perSession.set(a.session, (perSession.get(a.session) || 0) + 1);
  }
  const worst = [...perSession.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0] || null;
  return {
    asked, answered, superseded, open: asked - answered - superseded,
    bySession: Object.fromEntries(perSession),
    worstSession: worst ? { session: worst[0], count: worst[1] } : null,
  };
}

// ---- integration lane (pure) ---------------------------------------------------------------------------------------
// One line per state change, so the last line per id is the current record; only records whose last update is in the
// window count, so a request that finished yesterday is not counted again today.
// A returned request that the requester re-requested (same repo + same branch) and that later reached merged or deployed
// is resolved by the mechanism working: only the returns that never came back as a merge need a hand. Data only, no git.
const branchKey = (r) => {
  const repo = typeof r?.repo === 'string' ? r.repo.trim() : '';
  const branch = typeof r?.branch === 'string' ? r.branch.trim() : '';
  return repo && branch ? `${repo}\u0000${branch}` : null;   // a request without a repo/branch cannot be matched
};
const tsOf = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };

export function laneStats(lines, { now, hours = HOURS }) {
  const latest = new Map();
  for (const line of lines) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object' || !r.id) continue;
    latest.set(r.id, r);
  }
  // The latest request time of every request that landed merged or deployed, per repo+branch.
  const landed = new Map();
  for (const r of latest.values()) {
    if (r.state !== 'merged' && r.state !== 'deployed') continue;
    const k = branchKey(r);
    const t = tsOf(r.createdAt);
    if (!k || !t) continue;
    if (!landed.has(k) || landed.get(k) < t) landed.set(k, t);
  }
  const states = Object.fromEntries(FINAL_STATES.map((s) => [s, 0]));
  let total = 0, approvalRefused = 0, returnedResolved = 0;
  for (const r of latest.values()) {
    if (!inWindow(r.updatedAt, now, hours)) continue;
    total++;
    if (r.approvalRefused) approvalRefused++;
    if (r.state === 'returned') {
      // Resolved only by a LATER request for the same branch: a merge that predates the return is a different request.
      const k = branchKey(r);
      const later = k ? landed.get(k) || 0 : 0;
      if (later && later > tsOf(r.endedAt || r.updatedAt)) { returnedResolved++; continue; }
      states.returned++;
      continue;
    }
    if (FINAL_STATES.includes(r.state)) states[r.state]++;
  }
  return { states, total, approvalRefused, returnedResolved, merges: states.merged + states.deployed };
}

// ---- CI (pure) ------------------------------------------------------------------------------------------------------
// A record with `red` is a red streak tick (start / nudge / stuck), type 'green' closes it. Red minutes are measured from
// a red record to the next green, clipped to the window: a streak that started before it is not a day-long outage, and
// one still open at `now` only counts up to now.
export function ciStats(lines, { now, hours = HOURS }) {
  const since = now - hours * 3600000;
  const recs = [];
  for (const line of lines) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object') continue;
    const t = Date.parse(r.at);
    if (!Number.isFinite(t)) continue;
    const red = !!r.red || r.type === 'start' || r.type === 'nudge' || r.type === 'stuck';
    const green = r.type === 'green';
    if (!red && !green) continue;
    recs.push({ t, red, green });
  }
  recs.sort((a, b) => a.t - b.t);
  let redTransitions = 0, greenTransitions = 0, redMinutes = 0;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.red && r.t >= since && r.t <= now) redTransitions++;
    if (r.green && r.t >= since && r.t <= now) greenTransitions++;
    if (!r.red) continue;
    let end = now;
    for (let j = i + 1; j < recs.length; j++) if (recs[j].green) { end = recs[j].t; break; }
    const from = Math.max(r.t, since), to = Math.min(end, now);
    if (to > from) redMinutes += (to - from) / 60000;
  }
  return { redTransitions, greenTransitions, redMinutes: Math.round(redMinutes) };
}

// ---- box (pure over the raw text / statfs numbers) ------------------------------------------------------------------
export function loadAvgs(text) {
  const m = /([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(text || '');
  return m ? { load1: Number(m[1]), load5: Number(m[2]), load15: Number(m[3]) } : { load1: null, load5: null, load15: null };
}
export function memAvailableMb(text) { const m = /MemAvailable:\s+(\d+) kB/.exec(text || ''); return m ? Math.round(Number(m[1]) / 1024) : null; }
// df's arithmetic: used / (used + available), so reserved blocks are not counted as used.
export function diskPct(stats) {
  if (!stats) return null;
  const { blocks, bfree, bavail } = stats;
  if (!Number.isFinite(blocks) || blocks <= 0) return null;
  const used = blocks - (bfree || 0);
  const avail = Number.isFinite(bavail) ? bavail : used;
  return Math.round((used / (used + avail)) * 100);
}
const readSafe = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
export function boxStats() {
  return {
    ...loadAvgs(readSafe('/proc/loadavg')),
    memAvailableMb: memAvailableMb(readSafe('/proc/meminfo')),
    diskPct: diskPct((() => { try { return statfsSync('/'); } catch { return null; } })()),
  };
}

// ---- sessions (best effort) -----------------------------------------------------------------------------------------
// Never fails the check: no server, a timeout or a changed response shape gives sessions: null (reported as "n/a"), never
// a crash and never a fabricated 0.
export async function fetchSessions(fetchImpl = fetch, url = sessionsUrl()) {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (!r || !r.ok) return { sessions: null, needsYou: null };
    const b = await r.json();
    const list = Array.isArray(b?.sessions) ? b.sessions : null;
    if (!list) return { sessions: null, needsYou: null };
    const status = b?.status && typeof b.status === 'object' ? b.status : {};
    // The dashboard's NEEDS YOU strip is a session in state 'waiting' (a stop the owner can answer) or 'asks'.
    const needsYou = list.filter((s) => {
      const st = status[s?.name]?.state || s?.state;
      return st === 'waiting' || st === 'asks';
    }).length;
    return { sessions: list.length, needsYou };
  } catch { return { sessions: null, needsYou: null }; }
}

// ---- collect (io) ---------------------------------------------------------------------------------------------------
const readLines = (p) => { try { return { lines: readFileSync(p, 'utf8').split('\n').filter(Boolean), ok: true }; } catch { return { lines: [], ok: false }; } };

export function collect({ stateDir: dir = stateDir(), now = Date.now(), hours = HOURS, box = boxStats() } = {}) {
  const win = { now, hours };
  const notFound = [];
  const src = (name) => { const r = readLines(join(dir, name)); if (!r.ok) notFound.push(name); return r.lines; };
  const asks = askStats(src('manager-owner-asks.jsonl'), win);
  const decisions = src('manager-decisions.jsonl').filter((l) => { let r; try { r = JSON.parse(l); } catch { return false; } return inWindow(r?.at, now, hours); }).length;
  const lane = laneStats(src(join('integration', 'requests.jsonl')), win);
  const ci = ciStats(src('ci-watch.jsonl'), win);
  return { date: new Date(now).toISOString().slice(0, 10), ...asks, decisions, ...lane, ci, box, notFound };
}

// ---- summarize (pure) -----------------------------------------------------------------------------------------------
const n = (v) => (v == null ? 'n/a' : String(v));
export function summarize(today, prev) {
  // Derived from the buckets, not read from today.merges: the summary line and the table must never disagree.
  const merges = (today.states?.merged || 0) + (today.states?.deployed || 0);
  const line = `${merges} merges, ${today.states?.returned || 0} returned, ${today.asked || 0} owner asks, `
    + `CI red ${today.ci?.redMinutes || 0} min, disk ${n(today.box?.diskPct)} %`;
  const findings = [];
  const add = (key, title, body) => findings.push({ key: `harness-health:${key}`, title, body: body.slice(0, 300), priority: 'normal' });
  // A superseded ask is closed, so the bucket is only named when the day actually has one (today.superseded is undefined
  // for a ledger line written before this check learned about superseding).
  const sup = (today.superseded || 0) > 0 ? `, ${today.superseded} superseded` : '';
  // ASKS_MAX is a per-session budget: only a session that asked over the limit is a regression. The fleet total stays in
  // the summary line and the table row, it is information and not a finding.
  const worst = today.worstSession || null;
  if (worst && worst.count > ASKS_MAX) {
    const name = String(worst.session).slice(0, 40);
    const over = Object.values(today.bySession || {}).filter((c) => c > ASKS_MAX).length;
    add('owner-asks', `${worst.count} new owner asks in 24 h from session ${name}`,
      `${today.asked || 0} new asks in total (limit ${ASKS_MAX} per session), ${worst.count} of them from session ${name}.`
      + `${over > 1 ? ` ${over} sessions are above the limit.` : ''} ${today.answered || 0} answered${sup}, ${today.open || 0} still open.`
      + ' A day above the limit usually means a session stopped waiting for the manager.');
  }
  if ((today.states?.returned || 0) > LANE_RETURNED_MAX) add('lane-returned', `${today.states.returned} integration requests returned`, `${today.states.returned} of ${today.total || 0} lane requests came back to the requester and were not re-landed (limit ${LANE_RETURNED_MAX}). ${today.returnedResolved || 0} more were re-requested and landed merged or deployed. Repeated returns point at a branch that needs a hand.`);
  if ((today.ci?.redMinutes || 0) > CI_RED_MIN_MAX) add('ci-red', `CI red ${today.ci.redMinutes} min in 24 h`, `${today.ci.redTransitions || 0} red tick(s), ${today.ci.greenTransitions || 0} green. Above ${CI_RED_MIN_MAX} min main was unusable for sessions waiting on a deploy.`);
  if (today.box?.diskPct != null && today.box.diskPct > DISK_PCT_MAX) add('disk', `root disk ${today.box.diskPct} %`, `Above ${DISK_PCT_MAX} % on /. health-watch cleans its share; the rest is worktrees, tmp and caches.`);
  if (today.box?.memAvailableMb != null && today.box.memAvailableMb < MEM_MIN_MB) add('memory', `${today.box.memAvailableMb} MB MemAvailable`, `Below ${MEM_MIN_MB} MB. New sessions and parking both need headroom; load 1 min was ${n(today.box?.load1)}.`);
  if ((today.approvalRefused || 0) > 0) add('approval-refused', `${today.approvalRefused} lane approval(s) refused`, `${today.approvalRefused} integration request(s) carried approvalRefused: the lane was asked to push or deploy and stopped. A refusal is a floor stop, not a bug — but a day with several means the autonomy switches disagree with the requesters.`);

  const p = prev || null;
  const rows = [
    ['owner asks', `${today.asked} (${today.answered} answered${sup}, ${today.open} open)`, p ? `${n(p.asked)} (${n(p.answered)} answered)` : 'n/a'],
    ['decisions for owner', `${today.decisions}`, p ? n(p.decisions) : 'n/a'],
    ['lane merged / deployed', `${today.states.merged} / ${today.states.deployed}`, p ? `${n(p.states?.merged)} / ${n(p.states?.deployed)}` : 'n/a'],
    ['lane returned', `${today.states.returned} returned, ${today.returnedResolved || 0} resolved`, p ? n(p.states?.returned) : 'n/a'],
    ['lane merged_ci_red / deploy_failed', `${today.states.merged_ci_red} / ${today.states.deploy_failed}`, p ? `${n(p.states?.merged_ci_red)} / ${n(p.states?.deploy_failed)}` : 'n/a'],
    ['lane approvalRefused', `${today.approvalRefused}`, p ? n(p.approvalRefused) : 'n/a'],
    ['CI red', `${today.ci.redMinutes} min (${today.ci.redTransitions} red / ${today.ci.greenTransitions} green)`, p ? `${n(p.ci?.redMinutes)} min` : 'n/a'],
    ['load 1 / 5 min', `${n(today.box.load1)} / ${n(today.box.load15)}`, p ? n(p.box?.load1) : 'n/a'],
    ['MemAvailable', `${n(today.box.memAvailableMb)} MB`, p ? `${n(p.box?.memAvailableMb)} MB` : 'n/a'],
    ['disk /', `${n(today.box.diskPct)} %`, p ? `${n(p.box?.diskPct)} %` : 'n/a'],
    ['sessions (needs you)', `${n(today.sessions)} (${n(today.needsYou)})`, p ? `${n(p.sessions)} (${n(p.needsYou)})` : 'n/a'],
  ];
  const report = ['| metric | today (24 h) | previous day |', '| --- | --- | --- |',
    ...rows.map(([k, t, pv]) => `| ${k} | ${t} | ${pv} |`),
    '',
    today.notFound?.length ? `not found (counted as 0): ${today.notFound.join(', ')}` : 'all sources read.',
    ...(findings.length ? ['', ...findings.map((f) => `- \`${f.key}\` [${f.priority}] ${f.title}: ${f.body}`)] : ['', 'No regression above the thresholds.']),
  ].join('\n');
  return { summary: line, report, findings };
}

// ---- run (io) -------------------------------------------------------------------------------------------------------
// The line is appended before the result is built, so the check always records the day it measured. `prev` is the last
// well-formed line of the ledger: a truncated last write (a killed run) is skipped instead of hiding today's numbers.
export function prevLine(path) {
  let raw; try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  for (const line of raw.split('\n').filter(Boolean).reverse()) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r && typeof r === 'object' && !Array.isArray(r) && typeof r.date === 'string') return r;
  }
  return null;
}

export async function run({ stateDir: dir = stateDir(), now = Date.now(), hours = HOURS, out = console.log, fetchImpl = fetch } = {}) {
  const file = join(dir, 'harness-health.jsonl');
  const prev = prevLine(file);
  const today = collect({ stateDir: dir, now, hours });
  Object.assign(today, await fetchSessions(fetchImpl)); // sessions may be null: a best-effort source, never a failure
  const record = { ...today };
  try { appendFileSync(file, JSON.stringify(record) + '\n'); } catch (e) { out(`harness-health: could not append to ${file}: ${e.message}`); }
  const result = summarize(record, prev);
  out(JSON.stringify(result));
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run();
}