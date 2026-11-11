#!/usr/bin/env node
// Dry replay of the idle release (lease-holder-reaper.js idleHolders) over a day's idle nudges (lease-nudges.jsonl, reason "idle N min").
// For each: the session went idle at nudgeAt - N min, would have been released at idleStart + threshold. WRONG = the session's Claude transcript shows
// any entry between idleStart and the release (it was in fact working, or a background job reported back). Usage:
//   node scripts/lease-idle-replay.js [--day 2026-11-11] [--min 10] [--state <dir>] [--projects <dir>]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const day = arg('day', new Date().toISOString().slice(0, 10)), thr = Number(arg('min', 10));
const state = arg('state', process.env.GHOSTY_STATE_DIR || join(homedir(), '.local/state/ghosty'));
const projects = arg('projects', join(homedir(), '.claude/projects'));

export function transcriptTimes(session, dir = projects) {
  const out = [];
  let dirs = []; try { dirs = readdirSync(dir).filter((d) => d.endsWith(`-${session}`) || d.endsWith(`-${session.replace(/^codebox:/, '')}`)); } catch { /* none */ }
  for (const d of dirs) for (const f of readdirSync(join(dir, d)).filter((x) => x.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, d, f), 'utf8').split('\n')) { const m = /"timestamp":"([^"]+)"/.exec(line); if (m) out.push(Date.parse(m[1])); }
  }
  return out.sort((a, b) => a - b);
}

export function replay(rows, times) {
  const res = [];
  for (const r of rows) {
    const m = /^idle (\d+) min$/.exec((r.reasons || []).find((x) => /^idle /.test(x)) || '');
    if (!m || !r.session) continue;
    const at = Date.parse(r.at), idleStart = at - Number(m[1]) * 60000, rel = idleStart + thr * 60000;
    if (rel > at) { res.push({ ...r, verdict: 'not released (idle shorter than threshold)' }); continue; }
    const ts = times(r.session);
    if (!ts.length) { res.push({ ...r, verdict: 'unknown (no transcript)' }); continue; }
    const act = ts.filter((t) => t > idleStart + 1000 && t <= rel);
    res.push({ ...r, idleStart: new Date(idleStart).toISOString(), wouldRelease: new Date(rel).toISOString(), verdict: act.length ? `WRONG (${act.length} transcript entries in the window, first ${new Date(act[0]).toISOString()})` : 'right (silent from idle start to release)' });
  }
  return res;
}

if (process.argv[1]?.endsWith('lease-idle-replay.js')) {
  const f = join(state, 'lease-nudges.jsonl');
  const rows = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && String(r.at).startsWith(day)) : [];
  const out = replay(rows, (s) => transcriptTimes(s));
  for (const r of out) console.log(`${r.at} ${r.session} ${r.leaseId} ${r.reasons.join(';')} -> ${r.verdict}`);
  const wrong = out.filter((r) => r.verdict.startsWith('WRONG')).length;
  console.log(`day ${day} threshold ${thr} min: ${out.length} idle events, ${wrong} wrong, ${out.filter((r) => r.verdict.startsWith('unknown')).length} unknown`);
  process.exit(wrong ? 1 : 0);
}
