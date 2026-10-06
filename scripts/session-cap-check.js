#!/usr/bin/env node
// Daily check (scripts/daily-checks.js protocol): are there more live Claude sessions than the cap (parking.js SESSION_CAP)?
// Reads ghosty's own GET /api/parking. Over the cap AND RAM short (MemAvailable < 4 GB) = one finding that lists the idle-longest
// sessions; over the cap with RAM to spare is only reported (owner 2026-10-06: "don't park if no resource issue"). Nothing is parked here.
import { readFileSync } from 'node:fs';
import { fmtIdle } from '../parking.js';

const base = process.env.GHOSTY_URL || 'http://127.0.0.1:7777';
export const LOW_RAM_MB = 4096;
export function memAvailableMb(text = (() => { try { return readFileSync('/proc/meminfo', 'utf8'); } catch { return ''; } })()) {
  const m = /MemAvailable:\s+(\d+) kB/.exec(text); return m ? Math.round(Number(m[1]) / 1024) : null;
}
export function summarize(v, availMb = memAvailableMb()) {
  const parked = v.parked?.length || 0;
  const line = `${v.live} live Claude sessions (cap ${v.cap}), ${parked} parked, ${v.ramSavedMb || 0} MB saved by parking`;
  if (!v.over) return { summary: line, report: line, findings: [] };
  if (availMb != null && availMb >= LOW_RAM_MB) return { summary: `${line}; over the cap by ${v.over} but ${availMb} MB RAM free, no action`, report: line, findings: [] };
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
