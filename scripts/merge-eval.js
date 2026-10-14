#!/usr/bin/env node
// merge-eval: the interactive manager's merge / push / deploy check (OWNER_DECISIONS §14, §15). Same evaluation the server runs
// for a session's "merge <branch>?", "push it?" or "deploy it?" stop (merge-policy.js, decide-policy.js): read-only git facts,
// the floor, Jev (or the manager's own reasoning).
//
// Usage:
//   node scripts/merge-eval.js --repo <path> [--kind merge|push|deploy] [--branch b] [--target t | --dest d]
//                              [--text "<closing text>" | --tests green|red|unknown] [--session s] [--journal] [--help]
//   deploy: --env <name> [--scope full|frontend|server|host] [--ref r]; the deploy queue and the leases are read from the
//           registry (DEPLOY_REGISTRY or ssh proxmox, like the server), else from GET <--server|GHOSTY_URL|http://127.0.0.1:7777>
//           /api/deploys and /api/leases (read-only, 5 s timeout); when neither answers: escalate "deploy queue state unavailable".
//           --source registry|api limits where the state is read from (default: registry, then api).
//
// Env (process.env or <repoRoot>/.env, like jev-ask.js): JEV_URL, JEV_API_KEY (never printed), VPT_TEAM_ID
// stdout: ONE JSON line { verdict, reasons, rationale, branch, target, branch_sha, target_sha, conflicts, docsOnly, tests, decision }
//   (push: branch, dest, branch_sha, ahead; deploy: env, scope, ref, sha, rollback; verdict is merge|push|deploy|escalate)
// --journal appends the decision record to <state dir>/manager-decisions.jsonl
// Exit codes: 0 printed a verdict (also an escalate), 2 bad usage

import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { evaluateMerge, journalRecord, MERGE_DEFAULTS } from '../merge-policy.js';
import { evaluatePush, evaluateDeploy, decisionRecord, DECIDE_DEFAULTS } from '../decide-policy.js';
import { DEFAULT_ENVS } from '../deploy-runner.js';
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
  node scripts/merge-eval.js --repo <path> [--kind merge|push|deploy] [--branch b] [--target t | --dest d] [--text "<closing text>" | --tests green|red|unknown] [--session s] [--journal]
  node scripts/merge-eval.js --repo <path> --kind deploy --env <name> [--scope full|frontend|server|host] [--ref r] [--source registry|api] [--server <url>]

prints one JSON line: { verdict: merge|push|deploy|escalate, reasons, rationale, ..., tests, decision } (deploy also: rollback)
exit 0 when a verdict was printed, 2 on bad usage. --journal appends the record to <state dir>/manager-decisions.jsonl
`;
const KINDS = ['merge', 'push', 'deploy'];

// ---- deploy state: the registry like the server (DEPLOY_REGISTRY argv prefix, else ssh proxmox), else the server's read-only API ----
const SAFE = /^[A-Za-z0-9_.\/:@=+-]+$/;
const shq = (x) => (SAFE.test(x) ? x : `'${String(x).replace(/'/g, `'\\''`)}'`);
function registryRun(args) {
  const custom = process.env.DEPLOY_REGISTRY;
  const [cmd, ...pre] = custom ? JSON.parse(custom) : ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'proxmox'];
  const argv = custom ? [...pre, ...args] : [...pre, `~/bin/vpt-lease ${args.map(shq).join(' ')}`];
  return new Promise((done) => execFile(cmd, argv, { timeout: 15000, maxBuffer: 4 << 20 }, (err, stdout) => done({ code: err ? (typeof err.code === 'number' ? err.code : 255) : 0, stdout: String(stdout || '') })));
}
async function readEnvNames() {
  try { return Object.keys(JSON.parse(await readFile(join(STATE_DIR, 'deploy-envs.json'), 'utf8'))); } catch { return Object.keys(DEFAULT_ENVS); }
}
async function stateFromRegistry() {
  const l = await registryRun(['deploy', 'list', '--json']);
  if (l.code !== 0) return null;
  const j = JSON.parse(l.stdout);
  let deployed = {};
  try { const r = await registryRun(['deploy', 'last', '--json']); if (r.code === 0) deployed = JSON.parse(r.stdout).envs || {}; } catch {}
  const leases = (j.leases || []).map((x) => ({ id: x.id, env: x.env, resource: x.resource || '*', agent: x.agent || '', purpose: x.purpose || '', kind: x.kind || 'run', ttlLeftMin: x.ttlLeftMin }));
  const envs = await readEnvNames();
  return { deploys: { ok: true, deploys: j.deploys || [], deployed, envs }, leases: { ok: true, leases, waiters: j.waiters || [] }, envs };
}
async function stateFromApi(base) {
  const get = async (path) => { const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(`http ${r.status}`); return r.json(); };
  const [d, l] = await Promise.all([get('/api/deploys'), get('/api/leases')]);
  if (d.ok === false || l.ok === false) return null;
  return { deploys: d, leases: l, envs: d.envs || (await readEnvNames()) };
}
async function loadDeployState({ source, server }) {
  const tryIt = async (fn) => { try { return await fn(); } catch { return null; } };
  let st = null;
  if (source !== 'api') st = await tryIt(stateFromRegistry);
  if (!st && source !== 'registry') st = await tryIt(() => stateFromApi(server));
  return st || { deploys: null, leases: null, envs: await readEnvNames() };
}
async function managerJson() { try { return JSON.parse(await readFile(join(STATE_DIR, 'manager.json'), 'utf8')); } catch { return {}; } }
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
  const kind = f.kind || 'merge';
  if (!f.repo || f.repo === 'true' || f._bad || (f.tests && !(f.tests in TESTS)) || !KINDS.includes(kind)) { process.stderr.write(HELP); process.exit(2); }
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
  const tests = f.tests ? TESTS[f.tests] : null;
  const cwd = resolve(f.repo);
  let ev, out;
  if (kind === 'push') {
    ev = await evaluatePush({ cwd, text, session, config: { ...MERGE_DEFAULTS, ...DECIDE_DEFAULTS, ...await managerJson() }, jev, branch: named(f.branch), dest: named(f.dest) || named(f.target), tests });
    const x = ev.facts;
    out = { verdict: ev.verdict, reasons: ev.reasons, rationale: ev.rationale, branch: x.branch, dest: x.dest, branch_sha: x.branchSha, remote_sha: x.remoteSha, ahead: x.ahead, docsOnly: x.docsOnly, tests: ev.tests, decision: ev.decision };
  } else if (kind === 'deploy') {
    const st = await loadDeployState({ source: named(f.source), server: named(f.server) || process.env.GHOSTY_URL || 'http://127.0.0.1:7777' });
    const mj = await managerJson();
    ev = await evaluateDeploy({ session, text, cwd, config: { ...MERGE_DEFAULTS, ...DECIDE_DEFAULTS, ...mj, deployRunner: mj.deployRunner === true }, deploys: st.deploys, leases: st.leases, envs: st.envs, jev, tests, env: named(f.env), scope: named(f.scope), ref: named(f.ref), branch: named(f.branch) });
    const x = ev.facts;
    out = { verdict: ev.verdict, reasons: ev.reasons, rationale: ev.rationale, env: x.env, scope: x.scope, ref: x.ref, sha: x.sha, branch: x.branch, tests: ev.tests, decision: ev.decision, rollback: ev.rollback };
  } else {
    ev = await evaluateMerge({ cwd, text, session, config: MERGE_DEFAULTS, jev, branch: named(f.branch), target: named(f.target), tests });
    const f2 = ev.facts;
    out = { verdict: ev.verdict, reasons: ev.reasons, rationale: ev.rationale, branch: f2.branch, target: f2.target, branch_sha: f2.branchSha, target_sha: f2.targetSha,
      conflicts: f2.conflicts, docsOnly: f2.docsOnly, tests: ev.tests, decision: ev.decision };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  if (f.journal) {
    try {
      const id = randomUUID().slice(0, 8), at = new Date();
      const rec = kind === 'merge' ? journalRecord(ev, { id, session, at }) : decisionRecord(kind, ev, { id, session, at });
      await mkdir(STATE_DIR, { recursive: true }); await appendFile(join(STATE_DIR, 'manager-decisions.jsonl'), JSON.stringify(rec) + '\n');
    } catch (e) { process.stderr.write(`journal failed: ${e.message}\n`); }
  }
}
main().catch((e) => { process.stderr.write(`${e.message || e}\n`); process.exit(1); });
