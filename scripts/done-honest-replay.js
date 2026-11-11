#!/usr/bin/env node
// Replay the deterministic done check over stalls.jsonl done rows (harness-done-honest, 2026-11-11).
// usage: node scripts/done-honest-replay.js [stalls.jsonl] [since-iso]   -> one line per distinct done line that is caught
import fs from 'node:fs';
import { doneButFailedOf, lastStatus } from '../status-honesty.js';
const file = process.argv[2] || `${process.env.GHOSTY_STATE_DIR || `${process.env.HOME}/.local/state/ghosty`}/stalls.jsonl`;
const since = process.argv[3] || '2026-11-11';
const seen = new Set(); let done = 0; const caught = [];
for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
  let r; try { r = JSON.parse(l); } catch { continue; }
  if (r.type !== 'stall' || r.at < since || r.status !== 'done') continue;
  const st = lastStatus(r.excerpt); if (!st) continue;
  const key = `${r.session}|${st.line.replace(/\s+/g, ' ')}`;
  if (seen.has(key)) continue; seen.add(key); done++;
  const f = doneButFailedOf(r.excerpt, '');
  if (f) caught.push({ session: r.session, hits: f.hits.map((h) => `${h.label}: ${h.clause}`).join(' | ') });
}
for (const c of caught) console.log(`${c.session}\t${c.hits.slice(0, 220)}`);
console.log(`distinct done lines ${done}, caught ${caught.length}`);
