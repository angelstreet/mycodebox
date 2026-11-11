#!/usr/bin/env node
// Replay for goal-first / time-box (harness-goal-box, 2026-11-11): of the sessions that stopped on a day, how many had a stored goal with checkable Done-when
// lines, and how many ran past 6 h (start = session-history `session.started`, else the stored goal's capture time; end = `session.ended`, else the last stall row).
// usage: node scripts/goal-box-replay.js [day=2026-11-11] [--list]
import fs from 'node:fs';
const state = process.env.GHOSTY_STATE_DIR || `${process.env.HOME}/.local/state/ghosty`;
const day = process.argv.find((a, i) => i > 1 && /^\d{4}-\d\d-\d\d$/.test(a)) || '2026-11-11';
const jl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }); } catch { return []; } };
let goals = {}; try { goals = JSON.parse(fs.readFileSync(`${state}/goals.json`, 'utf8')) || {}; } catch {}
const starts = new Map(), ended = new Map();
for (const r of jl(`${state}/session-history.jsonl`)) { if (r.kind === 'session.started') (starts.get(r.name) || starts.set(r.name, []).get(r.name)).push(r.ts); if (r.kind === 'session.ended') ended.set(r.name, Math.max(ended.get(r.name) ?? 0, r.ts)); }
const last = new Map(), first = new Map();
for (const r of jl(`${state}/stalls.jsonl`)) { if (r.type !== 'stall' || !String(r.at).startsWith(day) || String(r.session).startsWith('mac:')) continue; const t = Date.parse(r.at); last.set(r.session, Math.max(last.get(r.session) ?? 0, t)); first.set(r.session, Math.min(first.get(r.session) ?? Infinity, t)); }
let withGoal = 0, withParts = 0, over6 = 0; const rows = [];
for (const [name, lastAt] of last) {
  const g = goals[name]; const parts = g?.parts?.length || 0;
  if (g?.goal) withGoal++; if (parts) withParts++;
  const before = (starts.get(name) || []).filter((x) => x <= lastAt);   // the latest start of this name before its last stop: names are reused
  const startAt = before.length ? Math.max(...before) : (Number.isFinite(Date.parse(g?.at || '')) ? Date.parse(g.at) : first.get(name));
  const endAt = ended.get(name) && ended.get(name) >= lastAt ? ended.get(name) : lastAt;
  const hours = Number.isFinite(startAt) ? (endAt - startAt) / 3600e3 : null;
  if (hours != null && hours > 6) over6++;
  rows.push(`${name}\tgoal ${g?.goal ? 'yes' : 'no'}\tparts ${parts}\t${hours == null ? '?' : hours.toFixed(1)} h`);
}
if (process.argv.includes('--list')) console.log(rows.join('\n'));
console.log(`${day}: ${last.size} codebox sessions stopped; stored goal ${withGoal}; goal with checkable Done-when lines ${withParts}; ran past 6 h ${over6}`);
