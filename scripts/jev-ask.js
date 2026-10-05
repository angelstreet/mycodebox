#!/usr/bin/env node
// jev-ask: "Jev makes the call when in doubt". The manager agent runs this from its shell whenever it
// is unsure whether to answer a stopped coding session itself or escalate it to the owner.
//
// Usage:
//   node scripts/jev-ask.js <point> --facts '<json>' | --facts-file <path> | --facts -
//                           [--threshold 0.7] [--task <text>] [--run <id>] [--help]
//
// Env:
//   JEV_URL          VPT server base URL (the script takes its origin; the route is /server/ai/decide)
//   JEV_API_KEY      X-API-Key for the server (NEVER printed)
//   VPT_TEAM_ID      team_id for the decision log (the call is logged when set)
// When unset, values fall back to KEY=VALUE lines in <repoRoot>/.env (resolved relative to this script's
// own directory: ~/ghosty-sessions/.env when run there). No external dependency.
//
// stdout: exactly ONE JSON line: { point, pick, confidence, source, ruleDefault, allowed, decision_id }
// stderr: one-line error on bad usage (exit 2)
// Side effect: appends one line per call to <state dir>/manager-asks.jsonl
//
// Exit codes:
//   0  printed a pick (also on rule fallback, also on forced floor)
//   2  bad usage: unknown point, unparsable facts, missing --facts

import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { decide, POINTS } from '../router.js';
import { serverBase } from '../decisions.js';
import { isDisabledReply } from '../jev-switch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const STATE_DIR = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
const ASKS_LOG = join(STATE_DIR, 'manager-asks.jsonl');

// ---- tiny .env parser (KEY=VALUE lines, # comments, no deps) ----
// Looks only at <repoRoot>/.env (or GHOSTY_ENV_FILE) when an env var is missing from process.env.
async function loadDotEnv() {
  const out = {};
  try {
    const raw = await readFile(process.env.GHOSTY_ENV_FILE || join(REPO_ROOT, '.env'), 'utf8');   // GHOSTY_ENV_FILE: tests point it away from the real .env
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const m = s.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return out;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
}

// ---- usage text (with one example per point) ----
const EXAMPLES = {
  wake: { event: { kind: 'stall' }, disk_pct: 42, quota: { claude: 30, codex: 25 } },
  builder: { work: { touches: ['app'], repo_public: false, size: 'small', files_est: 2, lines_est: 80, has_tests: true } },
  reviewer: { work: { touches: ['app'], repo_public: false, size: 'small' } },
  retry: { reject: { round: 1, reason: 'tests failed' } },
  model: { work: { touches: ['app'], repo_public: false, size: 'small' } },
  stop: { session: 's1', agent: 'claude', case: 'owner_decision', priority: 'P1', forbidden_topic: false, closing_text: 'Done with step 1. Continue with step 2?', proposed_reply: 'Yes, continue with step 2.' },
};
function help() {
  const examples = Object.keys(POINTS).map((p) => {
    const def = POINTS[p];
    const opts = Object.keys(def.options).join('|');
    return `  ${p}: node scripts/jev-ask.js ${p} --facts '${JSON.stringify(EXAMPLES[p] || {})}'  # options: ${opts}`;
  }).join('\n');
  return `usage:
  node scripts/jev-ask.js <point> --facts '<json>' | --facts-file <path> | --facts -
                           [--threshold 0.7] [--task <text>] [--run <id>]

points (and example invocation):
${examples}

env (process.env or <repoRoot>/.env):
  JEV_URL         VPT server base URL (origin is taken); the route is /server/ai/decide
  JEV_API_KEY     X-API-Key for the server (never printed)
  VPT_TEAM_ID     team_id for the decision log (the call is logged when set)

stdout is exactly one JSON line:
  { point, pick, confidence, source, ruleDefault, allowed, decision_id }
  source = "forced" | "jev" | "rule"

exit codes:
  0  printed a pick (also on rule fallback, also on forced floor)
  2  bad usage: unknown point, unparsable facts, missing --facts

side effect: appends one line per call to <state dir>/manager-asks.jsonl
  state dir = $GHOSTY_STATE_DIR or ~/.local/state/ghosty
`;
}

// ---- arg parsing (accepts --key value pairs and one positional point) ----
function parseArgs(argv) {
  const out = { _: [], flags: {}, _unknown: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out.flags[k] = 'true'; }
      else { out.flags[k] = next; i++; }
    }
    else out._.push(a);
  }
  return out;
}

async function readFacts(arg) {
  if (arg === undefined || arg === null) return null;
  if (arg === '-') return JSON.parse((await readStdin()).trim() || '{}');
  if (arg.startsWith('@')) return JSON.parse(await readFile(arg.slice(1), 'utf8'));
  return JSON.parse(arg);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args._.length === 0) { process.stdout.write(help()); return; }
  const point = args._[0];
  if (!POINTS[point]) { process.stderr.write(`unknown point: ${point} (known: ${Object.keys(POINTS).join(', ')})\n`); process.exit(2); }
  const factsInline = args.flags.facts;
  const factsPath = args.flags['facts-file'];
  if (factsInline === undefined && factsPath === undefined) {
    process.stderr.write('--facts <json> (or --facts-file <path> or --facts -) is required\n');
    process.exit(2);
  }
  let facts;
  try {
    if (factsPath !== undefined) facts = JSON.parse(await readFile(factsPath, 'utf8'));
    else facts = await readFacts(factsInline);
  } catch (e) {
    process.stderr.write(`could not parse facts: ${e.message}\n`);
    process.exit(2);
  }
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) {
    process.stderr.write('facts must be a JSON object\n');
    process.exit(2);
  }

  const dot = await loadDotEnv();
  const JEV_URL = process.env.JEV_URL || dot.JEV_URL || '';
  const JEV_API_KEY = process.env.JEV_API_KEY || dot.JEV_API_KEY || '';
  const VPT_TEAM_ID = process.env.VPT_TEAM_ID || dot.VPT_TEAM_ID || '';

  const origin = serverBase(JEV_URL);
  // post(): returns the JSON or null on any error. Never throws.
  let jevDisabled = false;   // the server's JEV_ENABLED=false: print the rule default, flagged
  const post = origin && JEV_API_KEY
    ? async (body) => {
        try {
          const r = await fetch(`${origin}/server/ai/decide`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-API-Key': JEV_API_KEY },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
          });
          const j = await r.json().catch(() => null);
          if (isDisabledReply(j)) jevDisabled = true;
          return (j && j.success !== false) ? j : null;
        } catch { return null; }
      }
    : null;

  const refs = { source: 'ghosty-manager-cli' };
  if (args.flags.task) refs.task = String(args.flags.task).slice(0, 500);
  if (args.flags.run) refs.run = String(args.flags.run).slice(0, 200);
  const threshold = args.flags.threshold != null ? Number(args.flags.threshold) : 0.7;

  const out = await decide(point, facts, { post, teamId: VPT_TEAM_ID || undefined, refs, threshold });

  const record = {
    point,
    pick: out.choice,
    confidence: out.confidence,
    source: out.source,
    ruleDefault: out.ruleDefault,
    allowed: out.allowed,
    decision_id: out.decision_id || null,
    ...(jevDisabled && out.source !== 'forced' ? { jev: 'disabled' } : {}),
  };

  // Exactly ONE JSON line on stdout.
  process.stdout.write(JSON.stringify(record) + '\n');

  // Append one line per call to <state dir>/manager-asks.jsonl
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await appendFile(ASKS_LOG, JSON.stringify({
      at: new Date().toISOString(),
      point,
      pick: out.choice,
      confidence: out.confidence,
      source: out.source,
      ruleDefault: out.ruleDefault,
      decision_id: out.decision_id || null,
      ...(jevDisabled && out.source !== 'forced' ? { skipped: 'jev_disabled' } : {}),
      ...(args.flags.task ? { task: String(args.flags.task).slice(0, 500) } : {}),
    }) + '\n');
  } catch { /* logging is best-effort; never block the answer */ }
}

main().catch((e) => { process.stderr.write(`${e.message || e}\n`); process.exit(1); });