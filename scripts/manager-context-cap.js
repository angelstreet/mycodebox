#!/usr/bin/env node
// Context cap of the AI manager: when its context passes the cap, restart it fresh, through the SAME path as the nightly
// restart (scripts/manager-fresh.sh: idle with no draft, /exit, relaunch, kickoff that reads the open items from files).
// Token-free, no AI call. Run by scripts/manager-watch.sh every 5 min, after its own checks.
//
// Why: a wake re-reads the whole conversation. The week of 2026-11-25 the manager's context reached 887k between two
// nightly restarts and calls over 400k were half of its cost.
//
// Rules (manager's conditions, 2026-11-25):
//   - never in the middle of a stop the manager is answering: it fires only when the session is done / idle / waiting with
//     no draft, and manager-fresh.sh checks that again itself (one try, no 60 min wait);
//   - at most 2 restarts per UTC day (a failed attempt counts: /exit may already have happened);
//   - every firing writes one decision line to manager-actions.jsonl.
//
// Settings in manager.json: "contextCap" tokens (default 300000; 0 or false = off), "contextCapMaxPerDay" (default 2, never
// more than 2). Flags, for verifying on a throw-away session: --session <tmux name> --cap <tokens> --dry-run.
//
// Context = the last model call of the session's current Claude transcript (input + cache read + cache written), the
// transcript being ~/.claude/projects/*/<claudeSessionId>.jsonl with the id the dashboard reports for the session.

import { openSync, readSync, closeSync, statSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendJsonLine } from '../jsonl-append.js';

export const DEFAULT_CAP = 300000;
export const HARD_MAX_PER_DAY = 2;
export const NOT_IDLE_EXIT = 3;                    // manager-fresh.sh: never idle, nothing touched
const RESTARTABLE = new Set(['done', 'idle', 'waiting']);
const TAIL_BYTES = 2 * 1024 * 1024;

const k = (n) => `${Math.round(n / 1000)}k`;
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

// { cap, maxPerDay } from manager.json (already parsed, or null). cap 0 = off.
export function capConfig(cfg) {
  const raw = cfg?.contextCap;
  const cap = raw === undefined || raw === null || raw === true ? DEFAULT_CAP : raw === false ? 0 : Math.floor(num(raw));
  const m = Number.isInteger(cfg?.contextCapMaxPerDay) && cfg.contextCapMaxPerDay >= 0 ? cfg.contextCapMaxPerDay : HARD_MAX_PER_DAY;
  return { cap, maxPerDay: Math.min(HARD_MAX_PER_DAY, m) };
}

// Last real model call in transcript text: { ctx, at } or null. Sidechain (subagent) and synthetic records are not the
// manager's own context. A torn first line (the text is a tail of the file) is skipped like any bad line.
export function lastContext(text) {
  let last = null;
  for (const l of String(text || '').split('\n')) {
    if (!l.includes('"usage"')) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const m = o?.message, u = m?.usage;
    if (o.type !== 'assistant' || o.isSidechain || !u || !m.model || m.model === '<synthetic>') continue;
    const at = Date.parse(o.timestamp);
    const ctx = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    if (ctx > 0 && Number.isFinite(at)) last = { ctx, at };
  }
  return last;
}

export function readTail(file, bytes = TAIL_BYTES) {
  const size = statSync(file).size, start = Math.max(0, size - bytes);
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(size - start); readSync(fd, b, 0, b.length, start); return b.toString('utf8'); } finally { closeSync(fd); }
}

export function findTranscript(claudeDir, id) {
  if (!/^[0-9a-f-]{36}$/.test(id || '')) return null;
  let dirs = []; try { dirs = readdirSync(claudeDir); } catch { return null; }
  for (const d of dirs) { const f = join(claudeDir, d, `${id}.jsonl`); if (existsSync(f)) return f; }
  return null;
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// state = { day, count, lastAt, limitNoted } (count of firings on `day`, UTC). Pure.
// -> { fire, why } and, when the daily limit stops a needed restart for the first time that day, limit: true.
export function decide({ cap, maxPerDay, context, session, state = {}, now }) {
  if (!cap) return { fire: false, why: 'context cap is off' };
  if (!context) return { fire: false, why: 'no model call found in the current transcript' };
  // After a restart the dashboard can still name the old transcript for a moment: its context is the one just dropped.
  if (state.lastAt && context.at <= state.lastAt) return { fire: false, why: 'the last model call is from before the last fresh restart' };
  if (context.ctx <= cap) return { fire: false, why: `context ${k(context.ctx)} is under the ${k(cap)} cap` };
  const count = state.day === dayOf(now) ? state.count || 0 : 0;
  if (count >= maxPerDay) return { fire: false, why: `context ${k(context.ctx)} is over the ${k(cap)} cap but ${count} cap restart(s) already today (limit ${maxPerDay})`, limit: !(state.day === dayOf(now) && state.limitNoted) };
  if (!RESTARTABLE.has(session?.state) || session?.draft) return { fire: false, why: `context ${k(context.ctx)} is over the ${k(cap)} cap but the session is ${session?.draft ? 'holding a draft' : session?.state || 'unknown'}: not interrupted, checked again next run` };
  return { fire: true, why: `context ${k(context.ctx)} is over the ${k(cap)} cap`, n: count + 1 };
}

export function decisionLine({ session, text, now }) {
  return { at: new Date(now).toISOString(), kind: 'decision', session, by: 'context-cap', decision: text };
}

const arg = (argv, key) => { const i = argv.indexOf(key); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };

export async function run({
  argv = process.argv.slice(2), env = process.env, now = Date.now(), out = console.log,
  fetchStatus = async (base) => (await (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) })).json()).status,
  restart = (script, e) => spawnSync('/bin/bash', [script], { env: e, encoding: 'utf8', timeout: 8 * 60 * 1000 }),
} = {}) {
  const say = (m) => out(`manager-context-cap: ${m}`);
  const dry = argv.includes('--dry-run');
  const session = arg(argv, '--session') || 'manager';
  if (!/^[\w.-]+$/.test(session)) { say('bad session name'); return { fire: false }; }
  const stateDir = env.GHOSTY_STATE_DIR || join(env.HOME || homedir(), '.local', 'state', 'ghosty');
  const claudeDir = env.CLAUDE_PROJECTS_DIR || join(env.HOME || homedir(), '.claude', 'projects');
  const base = env.GHOSTY_URL || 'http://127.0.0.1:7777';
  let cfg = null; try { cfg = JSON.parse(readFileSync(join(stateDir, 'manager.json'), 'utf8')); } catch { /* defaults */ }
  const conf = capConfig(cfg);
  const flagCap = arg(argv, '--cap'); if (flagCap !== null) conf.cap = Math.floor(num(flagCap));
  if (!conf.cap) { say('context cap is off'); return { fire: false }; }

  let st; try { st = (await fetchStatus(base))?.[session]; } catch { st = null; }
  if (!st) { say(`dashboard unreachable or no ${session} session, nothing to do`); return { fire: false }; }
  const file = findTranscript(claudeDir, st.claudeSessionId);
  let context = null; if (file) { try { context = lastContext(readTail(file)); } catch { /* unreadable: no context */ } }

  // One state file per session, so a throw-away verification never spends the manager's two restarts.
  const stateFile = join(stateDir, session === 'manager' ? 'manager-context-cap.json' : `manager-context-cap.${session}.json`);
  let state = {}; try { state = JSON.parse(readFileSync(stateFile, 'utf8')) || {}; } catch { /* first run */ }
  // Any fresh restart (nightly, watchdog, cap) stamps its time: the dashboard may name the old transcript for a moment after.
  let freshAt = 0; try { freshAt = num(readFileSync(join(stateDir, session === 'manager' ? 'manager-fresh.last' : `manager-fresh.${session}.last`), 'utf8').trim()); } catch { /* never restarted */ }
  const d = decide({ ...conf, context, session: { state: st.state, draft: !!st.stall?.draft }, state: { ...state, lastAt: Math.max(num(state.lastAt), freshAt) }, now });
  say(d.why);
  const save = (s) => { mkdirSync(stateDir, { recursive: true }); writeFileSync(stateFile, JSON.stringify(s)); };
  const journal = (text) => appendJsonLine(join(stateDir, 'manager-actions.jsonl'), decisionLine({ session, text, now }));

  if (!d.fire) {
    if (d.limit && !dry) {   // said once a day: the cap wanted a third restart and did not take it
      journal(`context cap: ${d.why}; not restarted again today, the nightly restart is next`);
      save({ ...state, limitNoted: true });
    }
    return d;
  }
  if (dry) { say(`dry-run: would restart ${session} through manager-fresh.sh (restart ${d.n} of ${conf.maxPerDay} today)`); return d; }

  const script = join(dirname(fileURLToPath(import.meta.url)), 'manager-fresh.sh');
  const reason = `context cap restart: the context reached ${k(context.ctx)}, over the ${k(conf.cap)} cap`;
  const r = restart(script, { ...env, MANAGER_FRESH_SESSION: session, MANAGER_FRESH_WAIT_TRIES: '1', MANAGER_FRESH_REASON: reason });
  if (r.status === NOT_IDLE_EXIT) { say('the session stopped being idle before the restart: nothing touched, checked again next run'); return { ...d, fire: false }; }
  const ok = r.status === 0;
  save({ day: dayOf(now), count: d.n, lastAt: now });
  journal(ok
    ? `context cap: ${d.why}, ${session} restarted fresh through manager-fresh.sh while idle (restart ${d.n} of ${conf.maxPerDay} today)`
    : `context cap: ${d.why}, restart through manager-fresh.sh FAILED (${r.error ? r.error.code || 'spawn error' : `exit ${r.status}`}); it counts as restart ${d.n} of ${conf.maxPerDay} today, manager-watch relaunches a dead manager`);
  say(ok ? `restarted ${session} (restart ${d.n} of ${conf.maxPerDay} today)` : `restart failed: ${String(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  return { ...d, ok };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error('manager-context-cap failed:', e.message); process.exit(1); });
}
