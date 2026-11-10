#!/usr/bin/env node
// Merged-worktree prune (manager, 2026-11-10; idea bug-37d626f1). Dry run by default, apply only a reviewed plan.
//   node scripts/worktree-prune.js [--repo DIR ...] [--plan-out FILE] [--min-age-h 12]   dry run: per-worktree table + plan file + sha
//   node scripts/worktree-prune.js --apply --plan FILE --sha SHA                          removes exactly the reviewed REMOVE list
// REMOVE = clean + nothing ahead of origin/main (merged or empty) + not used by a pane/process/live session/lease/open integration
// + last change older than 12 h. Everything else is KEEP with the reason. Removal is `git worktree remove` WITHOUT --force, then
// `git branch -d` (merged only), then `git worktree prune`; each removal is logged (path, branch, tip sha) to worktree-prune.jsonl.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLAN_MAX_AGE_MS = 24 * 36e5;
const CACHE = /^(node_modules|dist|build|\.cache|\.next|\.vite|coverage|\.turbo|__pycache__|\.pytest_cache|\.venv|venv)(\/|$)/;
const OWNER_RE = /(^|[-_/])(demo|promo|customer|overlay)([-_/]|$)/i;
const MB = (b) => `${(b / 2 ** 20).toFixed(0)}M`;
const GB = (b) => `${(b / 2 ** 30).toFixed(2)}G`;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };

export function listWorktrees(repo) {
  const out = git(repo, 'worktree', 'list', '--porcelain'), wts = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null, head: null, detached: false, prunable: false }; wts.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return wts;
}

// Dirty = tracked changes or untracked files other than build/dependency caches.
export function dirtyFiles(wt) {
  let out = null;
  try { out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: wt, encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { /* reported below */ }
  if (out == null) return ['<git status failed>'];
  return out.split('\n').filter(Boolean).filter((l) => !(l.startsWith('?? ') && CACHE.test(l.slice(3)))
    && !(l.startsWith('!! '))).map((l) => l.slice(3));
}

function dirSize(p) {
  try { return Number(execFileSync('du', ['-sb', p], { encoding: 'utf8' }).split('\t')[0]); } catch { return 0; }
}

// Newest of: HEAD commit time, mtime of modified/untracked non-ignored files (first 500), the worktree dir itself.
export function lastChangeMs(wt) {
  let t = 0;
  const ct = tryGit(wt, 'log', '-1', '--format=%ct');
  if (ct) t = Number(ct) * 1000;
  const files = tryGit(wt, 'ls-files', '-m', '-o', '--exclude-standard');
  for (const f of (files || '').split('\n').filter((x) => x && !CACHE.test(x)).slice(0, 500)) { try { t = Math.max(t, fs.statSync(path.join(wt, f)).mtimeMs); } catch { /* gone */ } }
  try { t = Math.max(t, fs.statSync(wt).mtimeMs); } catch { /* none */ }
  return t;
}

// Working directories in use: tmux panes and /proc/*/cwd (symlink targets), as absolute paths.
export function usedCwds({ procDir = '/proc', tmux } = {}) {
  const cwds = new Set();
  let panes = tmux;
  if (panes == null) { try { panes = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_current_path}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { panes = ''; } }
  for (const l of panes.split('\n').filter(Boolean)) cwds.add(l);
  let pids = [];
  try { pids = fs.readdirSync(procDir).filter((n) => /^\d+$/.test(n)); } catch { /* none */ }
  for (const pid of pids) { try { cwds.add(fs.readlinkSync(path.join(procDir, pid, 'cwd'))); } catch { /* gone / not ours */ } }
  return cwds;
}
export const inUse = (wt, cwds) => [...cwds].find((c) => c === wt || c.startsWith(wt + path.sep)) || null;

// Names that hold a worktree or branch: live session names (dashboard API) and integration requests not in a final state.
export async function liveRefs({ state, url = process.env.GHOSTY_URL || 'http://127.0.0.1:7777', fetchImpl = fetch } = {}) {
  const refs = { sessions: new Set(), sessionsOk: false, branches: new Set(), worktrees: new Set(), leaseText: '' };
  try {
    const r = await fetchImpl(`${url}/api/sessions`, { signal: AbortSignal.timeout(5000) });
    for (const s of (await r.json()).sessions || []) refs.sessions.add(s.name);
    refs.sessionsOk = true;
  } catch { /* reported as an unverified item */ }
  try {
    const last = new Map();
    for (const l of fs.readFileSync(path.join(state, 'integration', 'requests.jsonl'), 'utf8').split('\n')) { try { const j = JSON.parse(l); last.set(j.id, j); } catch { /* skip */ } }
    for (const j of last.values()) if (!['deployed', 'merged', 'failed', 'returned', 'cancelled', 'done', 'rejected'].includes(j.state)) { if (j.branch) refs.branches.add(j.branch); if (j.worktree) refs.worktrees.add(j.worktree); }
  } catch { /* none */ }
  try { refs.leaseText = fs.readFileSync(path.join(state, 'leases', 'snapshot.json'), 'utf8'); } catch { /* none */ }
  return refs;
}

export function inspect(repo, wt, { cwds, refs, now = Date.now(), minAgeH = 12, size = true } = {}) {
  const r = { repo, path: wt.path, branch: wt.branch, head: wt.head, verdict: 'keep', why: '', bytes: size ? dirSize(wt.path) : 0 };
  const name = path.basename(wt.path);
  const reasons = [];
  r.shared = path.resolve(wt.path) === path.resolve(repo);
  if (r.shared) { r.why = 'shared checkout'; return r; }
  if (OWNER_RE.test(name) || OWNER_RE.test(wt.branch || '')) { r.why = 'owner: customer/demo/promo worktree'; return r; }
  if (wt.prunable || !fs.existsSync(wt.path)) { r.verdict = 'remove'; r.why = 'directory missing (git worktree prune)'; r.missing = true; return r; }
  const dirty = dirtyFiles(wt.path);
  r.dirty = dirty.length;
  if (dirty.length) reasons.push(`uncommitted: ${dirty.length} file(s), e.g. ${dirty[0]}`);
  const base = tryGit(repo, 'rev-parse', '--verify', '-q', 'origin/main');
  if (!base) reasons.push('no origin/main to compare');
  r.ahead = base ? Number(tryGit(wt.path, 'rev-list', '--count', `origin/main..${wt.head}`) ?? NaN) : null;
  if (r.ahead == null || Number.isNaN(r.ahead)) reasons.push('cannot count commits ahead');
  else if (r.ahead > 0) {
    // squash/rebase merges leave commits "ahead": patch-equivalent ones (git cherry '-') count as merged.
    const cherry = tryGit(wt.path, 'cherry', 'origin/main', wt.head);
    const unmerged = (cherry || '').split('\n').filter((l) => l.startsWith('+')).length;
    r.unmerged = unmerged;
    if (unmerged > 0) reasons.push(`${unmerged} commit(s) ahead of origin/main`);
  }
  if (wt.branch) {
    const rem = tryGit(repo, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${wt.branch}`);
    r.onOrigin = !!rem; r.tipOnOrigin = rem === wt.head;
    if (rem && !r.tipOnOrigin && r.ahead > 0 && !reasons.some((x) => /ahead/.test(x))) { /* merged equivalent: fine */ }
    if (rem && !r.tipOnOrigin && (r.unmerged ?? r.ahead) > 0) reasons.push('local tip differs from origin branch (unpushed)');
    if (!rem && (r.unmerged ?? r.ahead) > 0) reasons.push('branch not on origin');
  } else if ((r.unmerged ?? r.ahead) > 0) reasons.push('detached HEAD with commits');
  const used = inUse(wt.path, cwds);
  if (used) reasons.push(`in use: a pane/process has cwd ${used}`);
  const hit = refs.worktrees.has(wt.path) || (wt.branch && refs.branches.has(wt.branch));
  if (hit) reasons.push('named by an open integration request');
  if (wt.branch && refs.leaseText.includes(`"${wt.branch}"`)) reasons.push('named in the lease registry');
  const ses = [...refs.sessions].find((s) => s.length > 2 && (name === s || name.endsWith(`-${s}`) || wt.branch === s));
  if (ses) reasons.push(`name matches live session "${ses}"`);
  r.lastChange = lastChangeMs(wt.path);
  r.ageH = (now - r.lastChange) / 36e5;
  if (r.ageH < minAgeH) reasons.push(`changed ${r.ageH.toFixed(1)} h ago (< ${minAgeH} h)`);
  if (reasons.length) { r.why = reasons.join('; '); return r; }
  r.verdict = 'remove';
  r.why = r.ahead === 0 ? 'clean, nothing ahead of origin/main, unused, idle' : 'clean, all commits already in origin/main (patch-equivalent), unused, idle';
  return r;
}

// A stale origin/main makes merged branches look ahead (safe but noisy): refresh the remote-tracking refs first (no working-tree change).
export function fetchOrigin(repos) {
  const failed = [];
  for (const r of repos) { try { execFileSync('git', ['fetch', '-q', '--prune', 'origin'], { cwd: r, stdio: 'ignore', timeout: 120000 }); } catch { failed.push(r); } }
  return failed;
}

export async function plan(repos, opts = {}) {
  const state = opts.state || process.env.GHOSTY_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'ghosty');
  const cwds = opts.cwds || usedCwds(), refs = opts.refs || await liveRefs({ state, url: opts.url, fetchImpl: opts.fetchImpl });
  const items = [];
  for (const repo of repos) {
    for (const wt of listWorktrees(repo)) items.push(inspect(repo, wt, { cwds, refs, now: opts.now, minAgeH: opts.minAgeH, size: opts.size }));
  }
  return { items, sessionsOk: refs.sessionsOk };
}

export function report(p) {
  const out = [], rm = p.items.filter((i) => i.verdict === 'remove'), kp = p.items.filter((i) => i.verdict !== 'remove');
  const short = (i) => i.path.replace(os.homedir(), '~');
  out.push(`REMOVE (${rm.length}, ${GB(rm.reduce((n, i) => n + i.bytes, 0))})`);
  for (const i of rm) out.push(`  ${short(i).padEnd(52)} ${String(i.branch || '(detached)').padEnd(38)} ${MB(i.bytes).padStart(6)}  ${i.why}`);
  const groups = new Map();
  for (const i of kp) { const k = i.why.split(/[:;(]/)[0].replace(/\d+(\.\d+)?/g, 'N').trim(); groups.set(k, [...(groups.get(k) || []), i]); }
  out.push(`KEEP (${kp.length}), grouped by first reason`);
  for (const [k, g] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`  ${k}: ${g.length}`);
    for (const i of g) out.push(`    ${short(i).padEnd(50)} ${String(i.branch || '(detached)').padEnd(36)} ${MB(i.bytes).padStart(6)}  ${i.why}`);
  }
  if (!p.sessionsOk) out.push('WARNING: the dashboard sessions API was unreachable; pane/process cwd checks still ran');
  out.push(`=> remove ${rm.length}, keep ${kp.length}, frees ${GB(rm.reduce((n, i) => n + i.bytes, 0))}`);
  return out.join('\n');
}

export const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function writePlan(repos, p, file, { now = Date.now() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const remove = p.items.filter((i) => i.verdict === 'remove').map((i) => ({ repo: i.repo, path: i.path, branch: i.branch, head: i.head, bytes: i.bytes, missing: !!i.missing }));
  fs.writeFileSync(file, JSON.stringify({ version: 1, created: now, repos, report: report(p), remove }, null, 1), { mode: 0o600 });
  return sha256(file);
}

// Removes exactly the reviewed list. Refuses unless sha matches, plan < 24 h, and each item is still a REMOVE with the same head sha.
export async function apply(planFile, sha, { now = Date.now(), logFile, ...opts } = {}) {
  if (!planFile || !sha) throw new Error('--apply needs --plan <file> --sha <sha256> from a reviewed dry run');
  if (sha256(planFile) !== sha) throw new Error('plan file sha does not match --sha: re-run the dry run and review it');
  const reviewed = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (reviewed.version !== 1) throw new Error('unknown plan version');
  if (now - reviewed.created > PLAN_MAX_AGE_MS) throw new Error('plan is older than 24 h: re-run the dry run and review it');
  const fresh = new Map((await plan(reviewed.repos, { ...opts, now, size: false })).items.filter((i) => i.verdict === 'remove').map((i) => [i.path, i]));
  const stale = reviewed.remove.filter((r) => !fresh.has(r.path) || fresh.get(r.path).head !== r.head);
  if (stale.length) throw new Error(`${stale.length} planned removals changed since the dry run (first: ${stale[0].path}): re-run the dry run`);
  const state = opts.state || process.env.GHOSTY_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'ghosty');
  logFile ||= path.join(state, 'worktree-prune.jsonl');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const res = { removed: [], refused: [], branchesDeleted: [], bytes: 0 };
  for (const r of reviewed.remove) {
    const entry = { at: new Date(now).toISOString(), repo: r.repo, path: r.path, branch: r.branch, sha: r.head, bytes: r.bytes };
    if (r.missing) { entry.note = 'missing directory'; fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`); continue; }
    try { git(r.repo, 'worktree', 'remove', r.path); } catch (e) { res.refused.push({ path: r.path, error: String(e.stderr || e.message).trim().split('\n')[0] }); continue; }
    entry.removed = true;
    if (r.branch) { try { git(r.repo, 'branch', '-d', r.branch); entry.branchDeleted = true; res.branchesDeleted.push(r.branch); } catch (e) { entry.branchDeleted = false; entry.branchNote = String(e.stderr || e.message).trim().split('\n')[0]; } }
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    res.removed.push(r.path); res.bytes += r.bytes;
  }
  for (const repo of reviewed.repos) tryGit(repo, 'worktree', 'prune');
  return res;
}

async function main() {
  const argv = process.argv;
  const arg = (k, d) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : d; };
  const all = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
  const home = (p) => path.resolve(p.replace(/^~/, os.homedir()));
  if (argv.includes('--apply')) {
    try {
      const r = await apply(arg('--plan') && home(arg('--plan')), arg('--sha'));
      console.log(`removed ${r.removed.length} worktrees (${GB(r.bytes)}), deleted ${r.branchesDeleted.length} merged branches, refused ${r.refused.length}`);
      for (const x of r.refused) console.log(`  refused ${x.path}: ${x.error}`);
    } catch (e) { console.error(`refused: ${e.message}`); process.exit(3); }
    return;
  }
  const repos = (all('--repo').length ? all('--repo') : ['~/virtualpytest', '~/ghosty-sessions']).map(home).filter((r) => fs.existsSync(r));
  const noFetch = argv.includes('--no-fetch'), fetchFailed = noFetch ? [] : fetchOrigin(repos);
  const p = await plan(repos, { minAgeH: Number(arg('--min-age-h', 12)) });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const state = process.env.GHOSTY_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'ghosty');
  const file = home(arg('--plan-out', path.join(state, 'worktree-prune', `plan-${stamp}.json`)));
  console.log(`# worktree prune dry run (nothing is changed)  repos=${repos.join(' ')}`);
  console.log(report(p));
  if (fetchFailed.length) console.log(`WARNING: git fetch failed in ${fetchFailed.join(' ')}; origin/main may be stale (safe: more KEEP)`);
  const sha = writePlan(repos, p, file);
  console.log(`plan: ${file}\nsha256: ${sha}\napply after review: node scripts/worktree-prune.js --apply --plan ${file} --sha ${sha}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
