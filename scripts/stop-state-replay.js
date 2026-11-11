#!/usr/bin/env node
// Replay stop-state.js over stalls.jsonl (harness-computed-state, 2026-11-11): how many blocked / done / failed / no-status stops would have been WAITING,
// and how many manager escalations that removes. Facts rebuilt offline from what the journals hold: backgroundWork on the row, lane requests of the
// session open at the stop (integration/requests.jsonl), ticket ids named in the line, a named time not yet passed. NOT replayed (state at the time is
// not journalled): worker sessions still running, a live child process. So the numbers are a floor.
// usage: node scripts/stop-state-replay.js [since-iso] [--list]
import fs from 'node:fs';
import { lastStatus } from '../status-honesty.js';
import { parkedDeps } from '../own-jobs.js';
import { computeStopState } from '../stop-state.js';
const state = process.env.GHOSTY_STATE_DIR || `${process.env.HOME}/.local/state/ghosty`;
const since = process.argv.find((a, i) => i > 1 && /^\d{4}-/.test(a)) || '2026-11-11';
const jl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }); } catch { return []; } };
const lane = new Map();   // id -> last snapshot
for (const r of jl(`${state}/integration/requests.jsonl`)) if (r.id) lane.set(r.id, r);
const bySession = new Map();
for (const r of lane.values()) if (r.session) (bySession.get(r.session) || bySession.set(r.session, []).get(r.session)).push({ id: r.id, from: Date.parse(r.createdAt), to: r.endedAt ? Date.parse(r.endedAt) : Infinity });
const rows = jl(`${state}/stalls.jsonl`).filter((r) => r.at >= since);
const escalated = new Set(rows.filter((r) => r.type === 'escalated' && (!r.target || r.target === 'manager' || true)).map((r) => r.id));
const seen = new Set(); const tally = {}; const listed = []; let removed = 0, stops = 0;
for (const r of rows) {
  if (r.type !== 'stall') continue;
  const st = lastStatus(r.excerpt);
  const said = st?.kind || (r.status || '');
  const text = st?.text || '';
  const key = `${r.session}|${st?.line || r.id}`;
  if (seen.has(key)) continue; seen.add(key); stops++;
  const t = Date.parse(r.at);
  const facts = {
    bgJobs: Number(r.backgroundWork || 0),
    integrations: (bySession.get(r.session) || []).filter((x) => x.from <= t && t < x.to).map((x) => x.id),
    tickets: [...new Set((text.match(/\bt-[0-9a-f]{6,}\b/gi) || []).map((x) => x.toLowerCase()))],
    workers: [],
    timeMs: (parkedDeps(text, null, { now: t }).find((d) => d.kind === 'time') || {}).id ? Number(parkedDeps(text, null, { now: t }).find((d) => d.kind === 'time').id) : null,
  };
  const c = computeStopState({ said, facts, now: t });
  tally[c.said] ||= { stops: 0, waiting: 0, running: 0, removedEscalations: 0 };
  tally[c.said].stops++;
  if (c.mismatch) { tally[c.said][c.computed]++; if (escalated.has(r.id)) { tally[c.said].removedEscalations++; removed++; } listed.push(`${r.session}\t${c.said}->${c.computed}\t${c.reasons.map((x) => `${x.kind} ${x.id}`).join(', ')}\t${escalated.has(r.id) ? 'escalation removed' : ''}`); }
}
if (process.argv.includes('--list')) console.log(listed.join('\n'));
console.log(`distinct stops ${stops} since ${since}`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1].stops - a[1].stops)) console.log(`said ${k.padEnd(13)} stops ${String(v.stops).padStart(4)}  would be waiting ${String(v.waiting).padStart(4)}  running ${String(v.running).padStart(4)}  manager escalations removed ${v.removedEscalations}`);
console.log(`manager escalations removed in total: ${removed} (of ${escalated.size} escalated stops since ${since})`);
