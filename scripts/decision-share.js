#!/usr/bin/env node
// G8 (P0) measurement: what share of the decisions the coding sessions ask for were
// handled without the owner, and the regret rate.
//   node scripts/decision-share.js [--days N] [--json] [--list]
//
// Inputs (GHOSTY_STATE_DIR, default ~/.local/state/ghosty):
//   stalls.jsonl          stall/answer/choice/send/pause/escalated/... records
//   manager-actions.jsonl manager's own actions; decision starting with "answer" =
//                         the manager answered a stop itself
//   manager.json          managerSessions: stops from those sessions are excluded

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
const STALLS = join(STATE_DIR, 'stalls.jsonl');
const ACTIONS = join(STATE_DIR, 'manager-actions.jsonl');
const CONFIG = join(STATE_DIR, 'manager.json');

// Identity of a stop's text regardless of how the pane wraps it: a resized window
// re-wraps the same words (and the 16-line excerpt then starts elsewhere), so
// compare the tail with all whitespace removed. Matches manager.js#stopKey.
export const stopKey = (text) => String(text || '').replace(/\s+/g, '').slice(-400);

const safeRead = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

const parseLines = (text) => {
  if (!text) return [];
  return text.split('\n').flatMap((l) => {
    if (!l) return [];
    try { return [JSON.parse(l)]; } catch { return []; }
  });
};

const readManagerSessions = () => {
  try {
    const j = JSON.parse(safeRead(CONFIG));
    return Array.isArray(j.managerSessions) ? j.managerSessions : [];
  } catch { return []; }
};

// manager-actions.session may be "all", "-", or "s1,s2,s3" — match the target session.
const actionMatchesSession = (actionSession, target) => {
  if (!actionSession || actionSession === '-' || actionSession === 'all') return true;
  if (actionSession === target) return true;
  return actionSession.split(',').map((s) => s.trim()).includes(target);
};

const REGRET_PREFIX = /^\s*(no|stop|wait|don't|undo|revert)\b/i;
const REGRET_MS = 30 * 60 * 1000;
const WINDOW_MS = 2 * 60 * 60 * 1000;

// Compute the G8 share from already-parsed records.
// opts: { days, now (ms|ISO), managerSessions: string[] }
export function computeShare(records, actions, opts = {}) {
  const days = Math.max(1, Number(opts.days) || 7);
  const nowMs = opts.now ? new Date(opts.now).getTime() : Date.now();
  const sinceMs = nowMs - days * 86400000;
  const managerSessions = new Set(opts.managerSessions || []);

  // Group stalls by (session, stopKey(excerpt||question)). Same stop logged many
  // times counts once (the pre-2b repaint bug etc.).
  const groups = new Map();
  for (const r of records) {
    if (!r || r.type !== 'stall') continue;
    if (!r.id || !r.session) continue;
    if (r.case === 'done' || r.case === 'background_wait') continue;
    if (managerSessions.has(r.session)) continue;
    if (Date.parse(r.at) < sinceMs) continue;
    const k = `${r.session}\u0000${stopKey(r.excerpt || r.question)}`;
    const g = groups.get(k) || { session: r.session, ids: new Set(), firstAt: r.at, last: r };
    if (Date.parse(r.at) < Date.parse(g.firstAt)) g.firstAt = r.at;
    g.ids.add(r.id);
    g.last = r;   // keep the latest by file order for display
    groups.set(k, g);
  }

  // Sort by firstAt so we can find each group's next-group window in the same session.
  const list = [...groups.values()].sort((a, b) => Date.parse(a.firstAt) - Date.parse(b.firstAt));
  const sessionTimes = new Map();   // session -> sorted array of firstAt ms
  for (const g of list) {
    const arr = sessionTimes.get(g.session) || [];
    arr.push(Date.parse(g.firstAt));
    sessionTimes.set(g.session, arr);
  }
  for (const arr of sessionTimes.values()) arr.sort((a, b) => a - b);
  const nextAt = (session, firstAtMs) => {
    const arr = sessionTimes.get(session);
    if (!arr) return null;
    for (const t of arr) if (t > firstAtMs) return t;
    return null;
  };

  // Index answer / send / choice / pause records within the window for fast lookup.
  const answers = records.filter((r) => r && r.type === 'answer' && r.id);
  const sends = records.filter((r) => r && r.type === 'send' && r.session);
  const choices = records.filter((r) => r && r.type === 'choice');
  const pauses = records.filter((r) => r && r.type === 'pause' && r.by === 'owner');

  const decisions = [];
  for (const g of list) {
    const firstAtMs = Date.parse(g.firstAt);
    const next = nextAt(g.session, firstAtMs);
    const windowEndMs = next != null ? next : firstAtMs + WINDOW_MS;

    let outcome = 'owner-handled';
    let via = null;

    // 1. autonomous via answer record with the same id (within the window)
    const matchedAnswer = answers.find((a) => g.ids.has(a.id) && Date.parse(a.at) >= firstAtMs && Date.parse(a.at) <= windowEndMs);
    if (matchedAnswer) { outcome = 'autonomous'; via = `answer (${matchedAnswer.source || 'unknown'})`; }

    // 2. autonomous via manager-agent send to that session in the window
    if (outcome === 'owner-handled') {
      const send = sends.find((s) => s.session === g.session && s.by && s.by !== 'owner' && Date.parse(s.at) >= firstAtMs && Date.parse(s.at) <= windowEndMs);
      if (send) { outcome = 'autonomous'; via = `send (${send.by})`; }
    }

    // 3. autonomous via manager-actions line whose decision starts with "answer" for that session
    if (outcome === 'owner-handled') {
      const act = actions.find((a) => a && a.at && actionMatchesSession(a.session, g.session)
        && String(a.decision || '').toLowerCase().startsWith('answer')
        && Date.parse(a.at) >= firstAtMs && Date.parse(a.at) <= windowEndMs);
      if (act) { outcome = 'autonomous'; via = `manager-actions (${act.decision})`; }
    }

    // 4. owner-confirmed AI proposal: choice with agreeAi, by id or by session in window
    if (outcome === 'owner-handled') {
      const choice = choices.find((c) => {
        if (!c || !c.agreeAi) return false;
        const t = Date.parse(c.at); if (!(t >= firstAtMs && t <= windowEndMs)) return false;
        return g.ids.has(c.id) || (c.session && c.session === g.session);
      });
      if (choice) { outcome = 'owner-confirmed'; via = 'choice'; }
    }

    // Regret: autonomous followed within 30 min by an owner pause of that session,
    // or by an owner send whose text starts with no/stop/wait/don't/undo/revert.
    let regret = null;
    if (outcome === 'autonomous') {
      const regretEndMs = firstAtMs + REGRET_MS;
      const pause = pauses.find((p) => p.session === g.session && Date.parse(p.at) >= firstAtMs && Date.parse(p.at) <= regretEndMs);
      if (pause) regret = { via: 'pause', at: pause.at };
      else {
        const rs = sends.find((s) => s.session === g.session && s.by === 'owner' && Date.parse(s.at) >= firstAtMs && Date.parse(s.at) <= regretEndMs && REGRET_PREFIX.test(String(s.text || '')));
        if (rs) regret = { via: 'send', at: rs.at, text: rs.text };
      }
    }

    decisions.push({
      at: g.firstAt,
      session: g.session,
      case: g.last?.case || null,
      question: (g.last?.question || g.last?.excerpt || '').toString(),
      outcome,
      via,
      regret,
    });
  }

  return { days, decisions };
}

// Per-UTC-day rollup of a share result.
export function dailyRollup(share) {
  const byDay = new Map();
  for (const d of share.decisions) {
    const day = d.at.slice(0, 10);   // UTC YYYY-MM-DD
    const r = byDay.get(day) || { day, decisions: 0, autonomous: 0, owner_confirmed: 0, owner_handled: 0, regret: 0 };
    r.decisions++;
    if (d.outcome === 'autonomous') r.autonomous++;
    else if (d.outcome === 'owner-confirmed') r.owner_confirmed++;
    else r.owner_handled++;
    if (d.regret) r.regret++;
    byDay.set(day, r);
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  const total = { day: 'total', decisions: 0, autonomous: 0, owner_confirmed: 0, owner_handled: 0, regret: 0 };
  for (const r of days) for (const k of ['decisions', 'autonomous', 'owner_confirmed', 'owner_handled', 'regret']) total[k] += r[k];
  return { days, total };
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

const printTable = (rollup) => {
  const lines = [];
  lines.push(`decisions since ${new Date(Date.now() - rollup.total.decisions * 0).toISOString().slice(0, 10)} (last ${rollup.days[0] ? Math.ceil((Date.now() - new Date(rollup.days[0].day + 'T00:00:00Z').getTime()) / 86400000) : 0} UTC days)`);
  lines.push('');
  const widths = [10, 9, 10, 15, 13, 9, 7, 8];
  const header = ['day', 'decisions', 'autonomous', 'owner-confirmed', 'owner-handled', 'autonomy%', 'regret', 'regret%'];
  lines.push(header.map((h, i) => h.padStart(widths[i])).join(' '));
  for (const r of rollup.days) {
    const row = [r.day, r.decisions, r.autonomous, r.owner_confirmed, r.owner_handled, pct(r.autonomous, r.decisions) + '%', r.regret, pct(r.regret, r.autonomous) + '%'];
    lines.push(row.map((v, i) => String(v).padStart(widths[i])).join(' '));
  }
  const t = rollup.total;
  const totalRow = [t.day, t.decisions, t.autonomous, t.owner_confirmed, t.owner_handled, pct(t.autonomous, t.decisions) + '%', t.regret, pct(t.regret, t.autonomous) + '%'];
  lines.push(totalRow.map((v, i) => String(v).padStart(widths[i])).join(' '));
  return lines.join('\n') + '\n';
};

const printList = (share) => {
  const lines = [];
  for (const d of share.decisions) {
    const tag = d.regret ? `${d.outcome} (regret)` : d.outcome;
    lines.push(`${d.at} ${d.session} [${d.case}] ${tag}  via ${d.via || '–'}`);
    lines.push(`  Q: ${d.question.slice(0, 80)}`);
  }
  return (lines.length ? lines.join('\n') + '\n' : '(no decisions)\n');
};

const toJson = (share, rollup, list) => {
  const out = { days: share.days, daily: rollup.days, total: rollup.total };
  if (list) out.decisions = share.decisions.map((d) => ({
    at: d.at, session: d.session, case: d.case, outcome: d.outcome, via: d.via,
    question: d.question.slice(0, 80),
    regret: d.regret || null,
  }));
  return out;
};

function main() {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const flag = (k) => process.argv.includes(k);
  const days = Number(arg('--days', 7));
  const asJson = flag('--json');
  const list = flag('--list');

  const records = parseLines(safeRead(STALLS));
  const actions = parseLines(safeRead(ACTIONS));
  const managerSessions = readManagerSessions();

  const share = computeShare(records, actions, { days, managerSessions });
  const rollup = dailyRollup(share);

  if (asJson) {
    process.stdout.write(JSON.stringify(toJson(share, rollup, list), null, 2) + '\n');
  } else {
    process.stdout.write(printTable(rollup));
    if (list) process.stdout.write('\n' + printList(share));
  }
}

// Only run when invoked directly (so the test file can import without side effects).
if (import.meta.url === `file://${process.argv[1]}`) main();

export { main as run };