// The UI review gate of the integration lane (owner / manager, 2026-11-25): sessions deliver graphical work nobody opened, and the
// owner finds the problems. So the lane reviews it itself. Before the merge, a request whose diff touches a visual path is previewed
// from the merged tree and reviewed; a fail returns the request (nothing merges, deploys or asks anybody). After a frontend deploy the
// live pages are reviewed again, and once a night the key pages. The reviewer lives in the product repo (scripts/review/ui_review_gate.py)
// and is exported from ITS target branch, never from the branch under review: a session cannot skip, edit or grade it.
// A repo opts in with, in <state>/integration.json:
//   "uiReview": { "paths": ["^frontend/src/"], "from": "/abs/lane/clone/of/the/product", "ref": "origin/main", "repo": "virtualpytest",
//                 "liveScopes": ["frontend", "full"], "timeoutMin": 15 }
import fs from 'node:fs';
import path from 'node:path';

export const EXPORT = ['scripts/review', 'scripts/agent', 'docs', 'frontend/src/i18n', 'scripts/promo/concepts', 'README.md'];
export const GATE = 'scripts/review/ui_review_gate.py';
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// -> the validated block, null when absent, or { error }.
export function parseUiReview(raw) {
  if (raw == null) return null;
  const bad = (m) => ({ error: `uiReview: ${m}` });
  if (!Array.isArray(raw.paths) || !raw.paths.length) return bad('paths must be a list of regular expressions');
  try { raw.paths.forEach((p) => new RegExp(p)); } catch (e) { return bad(`invalid path pattern (${e.message})`); }
  if (typeof raw.from !== 'string' || !path.isAbsolute(raw.from)) return bad('from must be the absolute path of a clone that holds the reviewer');
  const ref = raw.ref ?? 'origin/main';
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(ref)) return bad('invalid ref');
  const repo = raw.repo ?? 'virtualpytest';
  if (!/^[a-z0-9_-]{1,40}$/.test(repo)) return bad('invalid repo name');
  const liveScopes = Array.isArray(raw.liveScopes) ? raw.liveScopes.filter((s) => typeof s === 'string') : [];
  const timeoutMin = Number(raw.timeoutMin) > 0 ? Number(raw.timeoutMin) : 15;
  return { paths: raw.paths, from: raw.from, ref, repo, liveScopes, timeoutMin };
}

export const touchesVisual = (cfg, files) => files.some((f) => cfg.paths.some((p) => new RegExp(p).test(f)) && !/\.(test|spec)\.[jt]sx?$|\.md$/.test(f));

export function createUiReview({ stateDir, git, run, log = () => {} }) {
  const root = path.join(stateDir, 'integration', 'ui-review');

  // The reviewer as it is on the product's target branch, in its own folder. -> { home } | { missing } (not on that branch yet)
  async function exportReviewer(cfg, id) {
    const home = path.join(root, 'reviewer', id);
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    await git(['fetch', '--quiet', 'origin'], { cwd: cfg.from, timeoutMs: 120_000 });
    // one question per path: `ls-tree` given a folder and a file inside it lists the file only, and the folder was left out
    const has = async (p) => (await git(['cat-file', '-e', `${cfg.ref}:${p}`], { cwd: cfg.from })).code === 0;
    if ((await git(['rev-parse', '--verify', '--quiet', `${cfg.ref}^{commit}`], { cwd: cfg.from })).code !== 0) throw new Error(`no ${cfg.ref} in ${cfg.from}`);
    if (!(await has(GATE))) return { home, missing: true };
    const names = [];
    for (const p of EXPORT) if (await has(p)) names.push(p);
    const tar = path.join(home, '.export.tar');
    const a = await git(['archive', '-o', tar, cfg.ref, '--', ...names], { cwd: cfg.from, timeoutMs: 120_000 });
    if (a.code !== 0) throw new Error(`could not export the reviewer: ${a.err}`);
    const x = await run(`tar -x -f ${sq(tar)} -C ${sq(home)} && rm -f ${sq(tar)}`, { cwd: home, timeoutMs: 120_000 });
    if (x.code !== 0 || !fs.existsSync(path.join(home, GATE))) throw new Error(`could not unpack the reviewer: ${x.out.slice(-300)}`);
    return { home };
  }

  const readText = (f, max) => { try { return fs.readFileSync(f, 'utf8').slice(0, max); } catch { return ''; } };

  // mode 'pre-merge' | 'live' | 'nightly'. -> { verdict: pass|fail|skip|cannot|absent, summary, table, dir }
  async function review(cfg, { id, mode, tree = null, base = null, head = null, onData }) {
    const dir = path.join(root, id, mode);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let home = null;
    try {
      const e = await exportReviewer(cfg, `${id}-${mode}`);
      home = e.home;
      if (e.missing) return { verdict: 'absent', summary: `the reviewer is not on ${cfg.ref} yet`, table: '', dir };
      const args = [mode, '--out', sq(dir), ...(mode === 'nightly' ? [] : ['--repo', cfg.repo, '--tree', sq(tree), '--base', sq(base), '--head', sq(head || 'HEAD')])];
      const x = await run(`python3 ${sq(path.join(home, GATE))} ${args.join(' ')}`, { cwd: dir, timeoutMs: cfg.timeoutMin * 60_000, onData });
      const last = /^ui-review-gate: (\w+) (?:uir-\S+ )?(.*)$/m.exec(x.out.split('\n').reverse().join('\n'));
      // the exit code alone proves nothing (python exits 2 when it cannot open the script): the reviewer's own last line must agree
      const said = { 0: 'pass', 1: 'fail', 2: 'skip' }[x.code];
      const verdict = !x.timedOut && said && last?.[1] === said ? said : 'cannot';
      const summary = x.timedOut ? `no answer in ${cfg.timeoutMin} min` : (last?.[2] || x.out.trim().split('\n').at(-1) || `exit ${x.code}`).slice(0, 400);
      return { verdict, summary, table: readText(path.join(dir, 'table.md'), 6000), dir };
    } catch (e) {
      log('ui review', id, e.message);
      return { verdict: 'cannot', summary: e.message.slice(0, 300), table: '', dir };
    } finally { if (home) fs.rmSync(home, { recursive: true, force: true }); }
  }
  return { review, exportReviewer };
}

// What the session reads: the verdict, where the full table and frames are, and the failing rows.
export function uiReviewLines(u, lines = 14) {
  if (!u) return '';
  const rows = String(u.table || '').split('\n').filter((l) => /^### |\| FAIL \||^Model advice|^NOT REVIEWED/.test(l)).slice(0, lines).map((l) => l.slice(0, 420));
  return [`UI review: ${u.verdict}. ${u.summary}`, ...rows, u.dir ? `Full table and frames: ${u.dir}` : ''].filter(Boolean).join('\n');
}

// Once a night, after `hourUtc`, review the key pages; only a change versus the night before reaches anybody (the manager).
export function createNightlyUiReview({ stateDir, config, review, event, now = () => Date.now(), hourUtc = 3, everyMs = 15 * 60_000, log = () => {} }) {
  const stamp = path.join(stateDir, 'integration', 'ui-review', 'nightly.day');
  let busy = false, timer = null;
  async function tick() {
    const d = new Date(now());
    const day = d.toISOString().slice(0, 10);
    const cfg = Object.values(config().repos || {}).find((r) => r.uiReview?.repo === 'virtualpytest')?.uiReview;
    if (busy || !cfg || d.getUTCHours() < hourUtc) return null;
    try { if (fs.readFileSync(stamp, 'utf8').trim() === day) return null; } catch { /* never ran */ }
    busy = true;
    try {
      fs.mkdirSync(path.dirname(stamp), { recursive: true, mode: 0o700 });
      fs.writeFileSync(stamp, day);   // one try a day, whatever happens
      const u = await review(cfg, { id: `nightly-${day}`, mode: 'nightly' });
      if (u.verdict === 'fail' || u.verdict === 'cannot') {
        await event({ key: `ui-review:nightly:${day}`, title: u.verdict === 'fail' ? `Nightly UI review: new problems on key pages` : 'Nightly UI review could not run',
          body: uiReviewLines(u).slice(0, 1500), url: '/?integration=1', priority: 'default' });
      }
      return u;
    } catch (e) { log('nightly ui review', e.message); return null; } finally { busy = false; }
  }
  return { tick, start() { timer = setInterval(() => { tick().catch((e) => log('nightly ui review', e.message)); }, everyMs); timer.unref?.(); }, stop() { clearInterval(timer); } };
}
