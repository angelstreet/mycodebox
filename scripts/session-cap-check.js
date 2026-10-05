#!/usr/bin/env node
// Daily check (scripts/daily-checks.js protocol): are there more live Claude sessions than the cap (parking.js SESSION_CAP)?
// Reads ghosty's own GET /api/parking. Over the cap = one finding that lists the idle-longest sessions; nothing is parked here.
import { fmtIdle } from '../parking.js';

const base = process.env.GHOSTY_URL || 'http://127.0.0.1:7777';
export function summarize(v) {
  const parked = v.parked?.length || 0;
  const line = `${v.live} live Claude sessions (cap ${v.cap}), ${parked} parked, ${v.ramSavedMb || 0} MB saved by parking`;
  if (!v.over) return { summary: line, report: line, findings: [] };
  const list = v.candidates.map((c) => `- ${c.name}: idle ${fmtIdle(c.idleMin)}${c.rssMb ? `, ${c.rssMb} MB` : ''}`).join('\n');
  return {
    summary: line,
    report: `${line}\n\nOver the cap by ${v.over}. Idle longest (park candidates):\n${list}`,
    findings: [{ key: 'session-cap', title: `${v.live} live Claude sessions, cap ${v.cap}`, body: `Over by ${v.over}. Idle longest: ${v.candidates.map((c) => `${c.name} (${fmtIdle(c.idleMin)})`).join(', ')}. Owner decides what to park.`.slice(0, 300), priority: 'normal' }],
  };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await fetch(`${base}/api/parking`);
  if (!r.ok) throw new Error(`/api/parking HTTP ${r.status}`);
  console.log(JSON.stringify(summarize(await r.json())));
}
