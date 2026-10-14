#!/usr/bin/env node
// merge-eval: the interactive manager's merge check (OWNER_DECISIONS §14). Same evaluation the server runs for a
// session's "merge <branch>?" stop (merge-policy.js): read-only git facts, the floor, Jev (or the manager's own reasoning).
//
// Usage:
//   node scripts/merge-eval.js --repo <path> [--branch b] [--target t] [--text "<closing text>" | --tests green|red|unknown]
//                              [--session s] [--journal] [--help]
//
// Env (process.env or <repoRoot>/.env, like jev-ask.js): JEV_URL, JEV_API_KEY (never printed), VPT_TEAM_ID
// stdout: ONE JSON line { verdict, reasons, rationale, branch, target, branch_sha, target_sha, conflicts, docsOnly, tests, decision }
// --journal appends the decision record to <state dir>/merge-decisions.jsonl
// Exit codes: 0 printed a verdict (also an escalate), 2 bad usage

import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { evaluateMerge, journalRecord, MERGE_DEFAULTS } from '../merge-policy.js';
import { serverBase } from '../decisions.js';
import { isDisabledReply } from '../jev-switch.js';
import { createJevBreaker } from '../jev-breaker.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');

async function loadDotEnv() {
  const out = {};
  try {
    for (const line of (await readFile(process.env.GHOSTY_ENV_FILE || join(REPO_ROOT, '.env'), 'utf8')).split(/\r?\n/)) {
      const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return out;
}

const HELP = `usage:
  node scripts/merge-eval.js --repo <path> [--branch b] [--target t] [--text "<closing text>" | --tests green|red|unknown] [--session s] [--journal]

prints one JSON line: { verdict: merge|escalate, reasons, rationale, branch, target, branch_sha, target_sha, conflicts, docsOnly, tests, decision }
exit 0 when a verdict was printed, 2 on bad usage. --journal appends the record to <state dir>/merge-decisions.jsonl
`;
const TESTS = { green: { state: 'green', explicit: true, quote: 'reported green by the caller' }, red: { state: 'red', explicit: true, quote: 'reported red by the caller' }, unknown: { state: 'unknown', explicit: false, quote: '' } };

function parseArgs(argv) {
  const flags = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = 'true';
    else if (a.startsWith('--')) { const next = argv[i + 1]; if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = 'true'; else { flags[a.slice(2)] = next; i++; } }
    else flags._bad = a;
  }
  return flags;
}

async function main() {
  const f = parseArgs(process.argv);
  if (f.help) { process.stdout.write(HELP); return; }
  if (!f.repo || f.repo === 'true' || f._bad || (f.tests && !(f.tests in TESTS))) { process.stderr.write(HELP); process.exit(2); }
  const dot = await loadDotEnv();
  const JEV_URL = process.env.JEV_URL || dot.JEV_URL || '', JEV_API_KEY = process.env.JEV_API_KEY || dot.JEV_API_KEY || '', TEAM = process.env.VPT_TEAM_ID || dot.VPT_TEAM_ID || '';
  const origin = serverBase(JEV_URL);
  const breaker = createJevBreaker({ file: join(STATE_DIR, 'jev-budget.json') });
  const jev = origin && JEV_API_KEY ? async (body) => {
    if (!breaker.allow()) return { skipped: 'Jev down' };
    try {
      const r = await fetch(`${origin}/server/ai/decide`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': JEV_API_KEY }, body: JSON.stringify({ ...body, ...(TEAM ? { team_id: TEAM } : {}) }), signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => null);
      if (isDisabledReply(j)) return { skipped: 'Jev disabled' };
      if (j && j.success !== false) { breaker.success(); return j; }
      const error = String(j?.error || `http ${r.status}`).slice(0, 200); breaker.failure(error); return { error };
    } catch (e) { breaker.failure(e.message); return { error: e.message }; }
  } : null;
  const text = f.text && f.text !== 'true' ? f.text : '';
  const named = (v) => (v && v !== 'true' ? v : null);
  const session = f.session && f.session !== 'true' ? f.session : null;
  const ev = await evaluateMerge({ cwd: resolve(f.repo), text, session, config: MERGE_DEFAULTS, jev, branch: named(f.branch), target: named(f.target), tests: f.tests ? TESTS[f.tests] : null });
  const f2 = ev.facts;
  process.stdout.write(JSON.stringify({ verdict: ev.verdict, reasons: ev.reasons, rationale: ev.rationale, branch: f2.branch, target: f2.target, branch_sha: f2.branchSha, target_sha: f2.targetSha,
    conflicts: f2.conflicts, docsOnly: f2.docsOnly, tests: ev.tests, decision: ev.decision }) + '\n');
  if (f.journal) {
    try { await mkdir(STATE_DIR, { recursive: true }); await appendFile(join(STATE_DIR, 'merge-decisions.jsonl'), JSON.stringify(journalRecord(ev, { id: randomUUID().slice(0, 8), session, at: new Date() })) + '\n'); }
    catch (e) { process.stderr.write(`journal failed: ${e.message}\n`); }
  }
}
main().catch((e) => { process.stderr.write(`${e.message || e}\n`); process.exit(1); });
