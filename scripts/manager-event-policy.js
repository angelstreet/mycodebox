#!/usr/bin/env node
// Manager event policy (owner, 2026-11-02; DeepSeek review P1). The wake filter (scripts/manager-event-filter.sh) reads
// scripts/manager-event-policy.json (defaults) merged with <state dir>/manager-event-policy.json (the owner's copy wins per key):
// '<kind>' or '<kind>:<state>' -> pass | ignore | urgent.
//   node scripts/manager-event-policy.js show                 the effective policy and where each key comes from
//   node scripts/manager-event-policy.js suggest [--days 7] [--min 20]
//       kinds that woke the manager in the window and were never labelled `needed` by the wake shadow (stalls.jsonl
//       `wake_outcome`, manager.js): candidates for `ignore`. Prints only; the owner (or the manager, journaled) edits the file.
// Pure parts (mergePolicy, policyOf, suggest) are exported for tests; nothing here writes any file.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), 'manager-event-policy.json');
export const VALUES = ['pass', 'ignore', 'urgent'];
const ownerFile = (stateDir) => join(stateDir || process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty'), 'manager-event-policy.json');

const readJson = (file) => { try { const j = JSON.parse(readFileSync(file, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; } };

// Pure. defaults + owner -> { policy: {key: value}, source: {key: 'default'|'owner'}, invalid: [key] }. Unknown values are kept out.
export function mergePolicy(defaults = {}, owner = {}) {
  const policy = {}, source = {}, invalid = [];
  for (const [who, obj] of [['default', defaults], ['owner', owner]]) {
    for (const [k, v] of Object.entries(obj || {})) {
      if (k.startsWith('_')) continue;
      if (!VALUES.includes(v)) { invalid.push(`${who}:${k}=${String(v)}`); continue; }
      policy[k] = v; source[k] = who;
    }
  }
  return { policy, source, invalid };
}

// Pure. The policy value for an event line (kind, state), same lookup as the jq filter: '<kind>:<state>' first, then '<kind>'.
export function policyOf(policy, ev) {
  const kind = String(ev?.kind ?? ''), state = String(ev?.state ?? '');
  return policy[`${kind}:${state}`] ?? policy[kind] ?? 'default';
}

const keyOf = (ev) => (ev?.state != null && ev.state !== '' ? `${ev.kind}:${ev.state}` : String(ev?.kind ?? ''));

// Pure. events: manager-events lines in the window; outcomes: `wake_outcome` records of the window ({event_key, kind, label});
// -> rows [{ key, events, needed, notNeeded, policy, suggest }], most events first. `suggest` is 'ignore' when the kind woke the
// manager at least `min` times, has at least `min` labels, none of them `needed`, and the policy does not already say ignore / pass / urgent.
export function suggest({ events = [], outcomes = [], policy = {}, min = 20 } = {}) {
  const rows = new Map();
  const row = (k) => { if (!rows.has(k)) rows.set(k, { key: k, events: 0, needed: 0, notNeeded: 0 }); return rows.get(k); };
  const byEventKey = new Map(events.map((e) => [e.key, e]));
  for (const e of events) if (e && e.kind) row(keyOf(e)).events++;
  for (const o of outcomes) {
    if (!o || o.type !== 'wake_outcome') continue;
    const e = byEventKey.get(o.event_key) || { kind: o.kind, state: null };
    if (!e.kind) continue;
    const r = row(keyOf(e));
    if (o.label === 'needed') r.needed++; else if (o.label === 'not_needed') r.notNeeded++;
  }
  return [...rows.values()].map((r) => {
    const [kind, state] = r.key.includes(':') ? [r.key.slice(0, r.key.indexOf(':')), r.key.slice(r.key.indexOf(':') + 1)] : [r.key, ''];
    const pol = policyOf(policy, { kind, state });
    const suggestIgnore = pol === 'default' && r.events >= min && r.needed === 0 && r.notNeeded >= min;
    return { ...r, policy: pol, suggest: suggestIgnore ? 'ignore' : null };
  }).sort((a, b) => b.events - a.events);
}

function readJsonl(file, sinceIso) {
  const out = [];
  if (!existsSync(file)) return out;
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue;
    try { const o = JSON.parse(l); if (!sinceIso || String(o.at || '') >= sinceIso) out.push(o); } catch { /* bad line */ }
  }
  return out;
}

export function loadPolicy(stateDir) {
  const own = ownerFile(stateDir);
  return { ...mergePolicy(readJson(DEFAULT_FILE), existsSync(own) ? readJson(own) : {}), ownerFile: own };
}

function main(argv) {
  const cmd = argv[0] || 'show';
  const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : def; };
  const stateDir = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
  const { policy, source, invalid, ownerFile: own } = loadPolicy(stateDir);
  if (cmd === 'show') {
    console.log(`defaults: ${DEFAULT_FILE}\nowner:    ${own}${existsSync(own) ? '' : ' (none)'}`);
    for (const k of Object.keys(policy).sort()) console.log(`${k.padEnd(28)} ${policy[k].padEnd(7)} (${source[k]})`);
    for (const i of invalid) console.log(`invalid: ${i} (allowed: ${VALUES.join(' | ')})`);
    return 0;
  }
  if (cmd === 'suggest') {
    const days = opt('--days', 7), min = opt('--min', 20);
    const since = new Date(Date.now() - days * 86400e3).toISOString();
    const events = [...readJsonl(join(stateDir, 'manager-events.jsonl.1'), since), ...readJsonl(join(stateDir, 'manager-events.jsonl'), since)];
    const outcomes = readJsonl(join(stateDir, 'stalls.jsonl'), since).filter((o) => o.type === 'wake_outcome');
    const rows = suggest({ events, outcomes, policy, min });
    console.log(`last ${days} d: ${events.length} events, ${outcomes.length} wake labels (min ${min} per kind)`);
    console.log('kind'.padEnd(36) + 'events needed not_needed policy  suggest');
    for (const r of rows.slice(0, 40)) console.log(r.key.slice(0, 35).padEnd(36) + String(r.events).padEnd(7) + String(r.needed).padEnd(7) + String(r.notNeeded).padEnd(11) + r.policy.padEnd(8) + (r.suggest || '-'));
    const ig = rows.filter((r) => r.suggest);
    if (ig.length) console.log(`\nto ignore them, add to ${own}: ${JSON.stringify(Object.fromEntries(ig.map((r) => [r.key, 'ignore'])))}`);
    return 0;
  }
  console.error('usage: manager-event-policy.js show | suggest [--days N] [--min N]');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
