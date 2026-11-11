#!/usr/bin/env node
// Daily disk cleanup (owner task 2026-11-11; the disk froze the host on 10-18, 10-20, 11-01 and 11-07).
//   node scripts/disk-cleanup.js [--dry-run] [--no-fetch] [--policy FILE]
// DRY RUN unless $GHOSTY_STATE_DIR/disk-cleanup.json says {"live": true} (the owner's switch); --dry-run always wins.
// Reuses scripts/worktree-prune.js (plan + apply, no --force) and the lane's merge-worktree layout. Steps:
//   a) worktrees merged to origin/main, clean, unused, idle > 24 h: git worktree remove + git branch -d
//   b) node_modules / .vite / .playwright of worktrees idle > 3 days (gitignored dirs only; `npm ci` brings them back)
//   c) own logs over a size cap: keep the tail
//   d) lane merge worktrees (<state>/integration/wt/<id>) of finished requests, idle > 24 h
// Never touched: the policy's `never` paths (live checkouts, vpt-private, vpt-backups ...), anything named in the parked-worktree
// files, a worktree holding non-cache ignored files (.env, keystores) or unpushed commits, state files other than the listed logs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, apply, writePlan, listWorktrees, inUse, usedCwds, liveRefs, lastChangeMs, fetchOrigin } from './worktree-prune.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GB = (b) => `${(b / 2 ** 30).toFixed(2)}G`, MB = (b) => `${(b / 2 ** 20).toFixed(0)}M`;
const SAFE_IGNORED = /(^|\/)(node_modules|\.cache|\.vite|\.playwright|coverage|dist|build|__pycache__|\.pytest_cache|\.ruff_cache|\.mypy_cache|\.turbo|\.next)(\/|$)/;
const stateDir = () => process.env.GHOSTY_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'ghosty');
const expand = (p) => path.resolve(String(p).replace(/^~(?=\/|$)/, os.homedir()));
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const git = (cwd, ...a) => { try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).trim(); } catch { return null; } };
const du = (p) => { try { return Number(execFileSync('du', ['-sb', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\t')[0]); } catch { return 0; } };

export function loadPolicy(file = path.join(HERE, 'disk-cleanup-policy.json')) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// The owner's switch. Anything but an explicit true is a dry run.
export function isLive(state = stateDir()) {
  try { return JSON.parse(fs.readFileSync(path.join(state, 'disk-cleanup.json'), 'utf8')).live === true; } catch { return false; }
}

// Absolute paths named in the parked-worktree review files: never touched.
export function parkedPaths(policy, state = stateDir()) {
  const out = new Set();
  for (const f of policy.parkedFiles || []) {
    let t = ''; try { t = fs.readFileSync(path.join(state, f), 'utf8'); } catch { continue; }
    for (const m of t.matchAll(/(\/[\w.@-]+\/[\w.@-]+\/[\w./@-]+)/g)) out.add(m[1].replace(/[.,/]+$/, ''));
  }
  return out;
}

export function protector(policy, state = stateDir()) {
  const never = (policy.never || []).map((p) => real(expand(p)));
  const parked = [...parkedPaths(policy, state)].map((p) => real(p));
  return (p) => {
    const r = real(p);
    if (never.some((n) => r === n)) return 'protected: live checkout or owner data';
    if (never.some((n) => within(n, r) && n !== r)) return 'protected: contains an owner-only path';
    if (never.some((n) => within(r, n) && !/^(~|\/home\/[^/]+)$/.test(n) && fs.existsSync(path.join(n, '.git')) === false)) return 'protected: inside an owner-only path';
    if (parked.some((q) => r === q || within(r, q) || within(q, r))) return 'protected: named in the parked-worktrees review';
    return null;
  };
}

// Why a worktree is busy right now (null = free): pane/process cwd, open request, lease, live session.
export function busy(wt, { cwds, refs }) {
  const name = path.basename(wt.path);
  const c = inUse(wt.path, cwds); if (c) return `in use: cwd ${c}`;
  if (refs.worktrees.has(wt.path) || (wt.branch && refs.branches.has(wt.branch))) return 'named by an open integration request';
  if (wt.branch && refs.leaseText.includes(`"${wt.branch}"`)) return 'named in the lease registry';
  const s = [...refs.sessions].find((x) => x.length > 2 && (name === x || name.endsWith(`-${x}`) || wt.branch === x));
  return s ? `live session ${s}` : null;
}

// Ignored entries that are not regenerable caches (.env, keystores, notes): git worktree remove would delete them silently.
export function precious(wtPath) {
  const out = git(wtPath, 'status', '--porcelain', '--ignored', '--untracked-files=all');
  if (out == null) return '<git status failed>';
  return out.split('\n').find((l) => l.startsWith('!! ') && !SAFE_IGNORED.test(l.slice(3))) ?.slice(3) || null;
}

function findCaches(root, names, maxDepth) {
  const hits = [];
  (function walk(dir, d) {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (names.includes(e.name)) { hits.push(p); continue; }   // never descend into a cache
      if (d < maxDepth) walk(p, d + 1);
    }
  })(root, 1);
  return hits;
}

export async function planCleanup({ policy = loadPolicy(), state = stateDir(), now = Date.now(), noFetch = false, cwds, refs, url } = {}) {
  const repos = (policy.repos || []).map(expand).filter((r) => fs.existsSync(path.join(r, '.git')));
  const fetchFailed = noFetch ? [] : fetchOrigin(repos);
  cwds ||= usedCwds(); refs ||= await liveRefs({ state, url });
  const prot = protector(policy, state);
  const items = [];   // { step, path, bytes, action, why }
  const skipped = [];
  // a) merged worktrees
  const p = await plan(repos, { cwds, refs, state, now, minAgeH: policy.worktrees?.minAgeH ?? 24 });
  const planned = [];
  for (const i of p.items) {
    if (i.verdict !== 'remove') continue;
    const why = prot(i.path) || (!i.missing && precious(i.path) && `ignored non-cache file: ${precious(i.path)}`);
    if (why) { skipped.push({ step: 'worktree', path: i.path, why }); continue; }
    planned.push(i);
    items.push({ step: 'worktree', path: i.path, branch: i.branch, bytes: i.bytes, why: i.why });
  }
  // b) caches of idle worktrees (also of worktrees that stay: only the regenerable dirs go)
  const removing = new Set(planned.map((i) => i.path));
  const idleMs = (policy.caches?.idleDays ?? 3) * 864e5;
  for (const repo of repos) {
    for (const wt of listWorktrees(repo)) {
      if (removing.has(wt.path) || path.resolve(wt.path) === path.resolve(repo) || !fs.existsSync(wt.path)) continue;
      if (prot(wt.path) || busy(wt, { cwds, refs })) continue;
      const found = findCaches(wt.path, policy.caches?.names || [], policy.caches?.maxDepth ?? 3);
      if (!found.length) continue;
      if (now - lastChangeMs(wt.path) < idleMs) continue;
      for (const c of found) {
        if (git(wt.path, 'check-ignore', '-q', c) === null || git(wt.path, 'ls-files', '--', c)) { skipped.push({ step: 'cache', path: c, why: 'tracked or not gitignored' }); continue; }
        items.push({ step: 'cache', path: c, bytes: du(c), why: `worktree idle > ${policy.caches?.idleDays ?? 3} d` });
      }
    }
  }
  // c) logs over the cap
  for (const l of policy.logs || []) {
    const f = path.join(state, l.file);
    if (path.dirname(path.resolve(f)) !== path.resolve(state)) continue;   // a policy entry can only name a file directly in the state dir
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.size > l.maxMB * 2 ** 20) items.push({ step: 'log', path: f, bytes: Math.max(0, st.size - l.keepMB * 2 ** 20), keepBytes: Math.floor(l.keepMB * 2 ** 20), why: `${MB(st.size)} > ${l.maxMB}M cap` });
  }
  // d) lane merge worktrees of finished requests
  const wtDir = path.join(state, 'integration', 'wt');
  let ids = []; try { ids = fs.readdirSync(wtDir); } catch { /* none */ }
  const last = new Map();
  try { for (const l of fs.readFileSync(path.join(state, 'integration', 'requests.jsonl'), 'utf8').split('\n')) { try { const j = JSON.parse(l); last.set(j.id, j); } catch { /* skip */ } } } catch { /* none */ }
  for (const id of ids) {
    const d = path.join(wtDir, id), st = last.get(id)?.state;
    if (!['deployed', 'merged', 'failed', 'returned', 'cancelled', 'done', 'rejected'].includes(st)) { skipped.push({ step: 'lane', path: d, why: `request state ${st || 'unknown'}` }); continue; }
    if (inUse(d, cwds)) { skipped.push({ step: 'lane', path: d, why: 'in use' }); continue; }
    let age = 0; try { age = (now - fs.statSync(d).mtimeMs) / 36e5; } catch { continue; }
    if (age < (policy.laneWorktrees?.minAgeH ?? 24)) { skipped.push({ step: 'lane', path: d, why: `changed ${age.toFixed(1)} h ago` }); continue; }
    items.push({ step: 'lane', path: d, bytes: du(d), why: `request ${st}, idle ${age.toFixed(0)} h` });
  }
  return { items, skipped, repos, fetchFailed, planned, sessionsOk: p.sessionsOk, cwds, refs };
}

// Keep the last keepBytes of a log, cut at a line boundary; atomic rename (appenders open per write).
export function truncateLog(file, keepBytes) {
  keepBytes = Math.floor(keepBytes);
  const size = fs.statSync(file).size; if (size <= keepBytes) return 0;
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(keepBytes);
  fs.readSync(fd, buf, 0, keepBytes, size - keepBytes); fs.closeSync(fd);
  const nl = buf.indexOf(10), tail = nl >= 0 ? buf.subarray(nl + 1) : buf;
  const tmp = `${file}.trim-${process.pid}`;
  fs.writeFileSync(tmp, tail, { mode: fs.statSync(file).mode & 0o777 }); fs.renameSync(tmp, file);
  return size - tail.length;
}

export async function runCleanup({ live = false, ...opts } = {}) {
  const state = opts.state || stateDir();
  const P = await planCleanup({ ...opts, state });
  const res = { live, freed: 0, done: [], refused: [] };
  const logFile = path.join(state, 'disk-cleanup.jsonl');
  const log = (e) => { try { fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`); } catch { /* best effort */ } };
  if (live) {
    // a) through the reviewed-plan path of worktree-prune: it re-checks every item and never forces
    const wts = P.items.filter((i) => i.step === 'worktree');
    if (wts.length) {
      const sub = { items: P.planned, sessionsOk: P.sessionsOk };
      const file = path.join(state, 'worktree-prune', `plan-cleanup-${Date.now()}.json`);
      const sha = writePlan(P.repos, sub, file);
      try {
        const r = await apply(file, sha, { state, cwds: P.cwds, refs: P.refs, minAgeH: opts.policy?.worktrees?.minAgeH ?? loadPolicy().worktrees?.minAgeH ?? 24 });
        for (const x of r.removed) res.done.push({ step: 'worktree', path: x });
        res.freed += r.bytes; res.refused.push(...r.refused.map((x) => ({ step: 'worktree', ...x })));
      } catch (e) { res.refused.push({ step: 'worktree', error: e.message }); }
    }
    for (const i of P.items.filter((x) => x.step !== 'worktree')) {
      try {
        if (!fs.existsSync(i.path)) continue;   // already gone (removed by an earlier step)
        if (i.step === 'cache') fs.rmSync(i.path, { recursive: true, force: true });
        else if (i.step === 'log') i.bytes = truncateLog(i.path, i.keepBytes);
        else if (i.step === 'lane') {
          const c = git(i.path, 'rev-parse', '--git-common-dir');
          if (!c) throw new Error('not a git worktree');
          const common = path.resolve(i.path, c);
          execFileSync('git', ['--git-dir', common, 'worktree', 'remove', i.path], { stdio: 'pipe' });   // no --force
        }
        res.done.push({ step: i.step, path: i.path }); res.freed += i.bytes; log({ ...i, removed: true });
      } catch (e) { res.refused.push({ step: i.step, path: i.path, error: String(e.stderr || e.message).trim().split('\n')[0] }); }
    }
  }
  return { ...res, plan: P };
}

export function report(P, res) {
  const short = (p) => p.replace(os.homedir(), '~');
  const L = [`# disk cleanup ${res.live ? 'LIVE' : 'DRY RUN (nothing is deleted)'}`];
  let total = 0;
  for (const step of ['worktree', 'cache', 'lane', 'log']) {
    const it = P.items.filter((i) => i.step === step).sort((a, b) => b.bytes - a.bytes);
    const sum = it.reduce((n, i) => n + i.bytes, 0); total += sum;
    L.push(`${step}: ${it.length} item(s), ${GB(sum)}`);
    for (const i of it) L.push(`  ${short(i.path).padEnd(70)} ${MB(i.bytes).padStart(6)}  ${i.why}`);
  }
  L.push(`skipped (protected or busy): ${P.skipped.length}`);
  for (const s of P.skipped.slice(0, 15)) L.push(`  [${s.step}] ${short(s.path)}: ${s.why}`);
  if (P.fetchFailed.length) L.push(`WARNING: git fetch failed in ${P.fetchFailed.join(' ')}; origin/main may be stale (safe: fewer removals)`);
  if (!P.sessionsOk) L.push('WARNING: dashboard sessions API unreachable; pane/process cwd checks still ran');
  L.push(res.live ? `=> freed ${GB(res.freed)}, refused ${res.refused.length}` : `=> WOULD free ${GB(total)}`);
  for (const r of res.refused) L.push(`  refused ${short(r.path || '')}: ${r.error}`);
  return L.join('\n');
}

async function main() {
  const argv = process.argv, arg = (k) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : undefined; };
  const live = isLive() && !argv.includes('--dry-run');
  const policy = loadPolicy(arg('--policy') && expand(arg('--policy')));
  const res = await runCleanup({ live, policy, noFetch: argv.includes('--no-fetch') });
  const text = report(res.plan, res);
  console.log(text);
  try { const d = path.join(stateDir(), 'disk-cleanup'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'last.txt'), `${text}\n`); } catch { /* report only */ }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
