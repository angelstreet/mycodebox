// Owner "wrong" taps on a manager action (G8 ground truth for regret, TASK-58 C9).
// <stateDir>/manager-regret.jsonl, append-only, one line per tap:
//   { type: 'regret' | 'unregret', at: <the action's own `at`>, session: <the action's session>, decision, labelledAt, by }
// An action is identified by (at, session). The newest line per action wins, so an unregret withdraws a mis-tap.
// decision-share.js reads this file for regret; the manager panel writes it via POST /api/manager/regret.

import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const REGRET_FILE = 'manager-regret.jsonl';
export const regretKey = (at, session) => `${at}|${session}`;

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

export async function appendRegret({ stateDir, at, session, decision = '', undo = false, by = 'owner', now = Date.now } = {}) {
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw bad('at must be the ISO time of the manager action');
  if (typeof session !== 'string' || !session.trim() || session.length > 200) throw bad('session must be a non-empty string');
  const rec = { type: undo ? 'unregret' : 'regret', at, session: session.trim(), decision: String(decision || '').slice(0, 200), labelledAt: new Date(now()).toISOString(), by: String(by || 'owner').slice(0, 40) };
  await appendFile(join(stateDir, REGRET_FILE), JSON.stringify(rec) + '\n');
  return rec;
}

export async function readRegrets({ stateDir } = {}) {
  let text = '';
  try { text = await readFile(join(stateDir, REGRET_FILE), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap((l) => { try { const r = JSON.parse(l); return r && typeof r === 'object' ? [r] : []; } catch { return []; } });
}

// Pure. Newest line per action wins; unregret removes it. Returns the standing regret labels.
export function effectiveRegrets(recs) {
  const m = new Map();
  for (const r of recs || []) {
    if (!r || (r.type !== 'regret' && r.type !== 'unregret') || !r.at || !r.session) continue;
    m.set(regretKey(r.at, r.session), r);
  }
  return [...m.values()].filter((r) => r.type === 'regret');
}

// Pure. Does this label sit on a manager action for `session` inside [fromMs, toMs]? Fleet-wide actions ("all", "-")
// are never one decision; "s1,s2" matches either.
export function regretAppliesTo(label, session, fromMs, toMs) {
  const s = String(label.session || '');
  if (!s || s === 'all' || s === '-') return false;
  if (s !== session && !s.split(',').map((x) => x.trim()).includes(session)) return false;
  const t = Date.parse(label.at);
  return t >= fromMs && t <= toMs;
}
