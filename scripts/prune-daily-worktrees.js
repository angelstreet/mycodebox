#!/usr/bin/env node
// Keep only the newest N daily worktrees per game (owner, 2026-11-10: coc daily worktrees, max last 3).
//   node scripts/prune-daily-worktrees.js <repo-or-worktree> <session-name> [--keep 3] [--dry]
// A session name like coc-daily-20261110 groups worktrees <repo>-coc-daily-<YYYYMMDD>. Older ones beyond --keep are removed only when
// clean (git refuses a dirty tree: no --force), HEAD is in origin/main (nothing unmerged) and no tmux pane uses them. Called by cbsession.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const git = (cwd, ...a) => { try { return { ok: true, out: execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message) }; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

export function prune(repo, session, { keep = 3, dry = false, cwds = null } = {}) {
  const m = /^(.*-daily)-(\d{8})$/.exec(session);
  if (!m) return [];
  const list = git(repo, 'worktree', 'list', '--porcelain');
  if (!list.ok) return [];
  const wts = list.out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  const primary = wts[0];
  const group = wts.slice(1).map((p) => ({ p, m: new RegExp(`-${m[1]}-(\\d{8})$`).exec(path.basename(p)) })).filter((x) => x.m)
    .map((x) => ({ p: x.p, date: x.m[1] })).sort((a, b) => b.date.localeCompare(a.date));
  const live = (cwds ?? tmuxCwds()).map(real);
  const out = [];
  for (const w of group.slice(keep)) {
    const wt = real(w.p), skip = (why) => out.push({ worktree: w.p, removed: false, why });
    if (live.some((c) => c === wt || c.startsWith(`${wt}/`))) { skip('a tmux pane uses it'); continue; }
    const branch = git(wt, 'symbolic-ref', '--short', '-q', 'HEAD').out.trim();
    if (!branch) { skip('detached HEAD'); continue; }
    const base = git(primary, 'rev-parse', '--verify', '-q', 'origin/main').ok ? 'origin/main' : 'main';
    if (!git(wt, 'merge-base', '--is-ancestor', 'HEAD', base).ok) { skip('has commits not in main'); continue; }
    if (dry) { out.push({ worktree: w.p, removed: false, why: 'dry run: would remove' }); continue; }
    const rm = git(primary, 'worktree', 'remove', wt);   // refuses dirty trees
    if (!rm.ok) { skip(`git refused: ${rm.out.trim().slice(0, 100)}`); continue; }
    git(primary, 'branch', '-D', branch);
    out.push({ worktree: w.p, removed: true, branch });
  }
  return out;
}
function tmuxCwds() { try { return execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_current_path}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).map((c) => c.replace(/ \(deleted\)$/, '')); } catch { return []; } }

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [repo, session] = process.argv.slice(2);
  const k = process.argv.indexOf('--keep');
  if (!repo || !session) { console.error('usage: prune-daily-worktrees.js <repo> <session-name> [--keep 3] [--dry]'); process.exit(2); }
  for (const r of prune(repo, session, { keep: k > 0 ? Number(process.argv[k + 1]) : 3, dry: process.argv.includes('--dry') })) console.log(`${r.removed ? 'removed' : 'kept'} ${r.worktree} ${r.removed ? r.branch : `(${r.why})`}`);
}
