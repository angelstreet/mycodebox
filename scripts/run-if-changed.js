#!/usr/bin/env node
// V2 check wrapper (round 5): run a command only when the change touches paths outside the given patterns.
//   node scripts/run-if-changed.js --except '*.md' --except 'docs/**' -- npm test
// Changed paths are taken against V2_BASE_SHA (set by the V2 verifier). Without it, or when the list cannot be read,
// the command always runs: a missing base never skips a check. Exit: the command's exit, 0 when skipped.
import { execFileSync, spawnSync } from 'node:child_process';

// Glob subset: `**` any path, `*` within one segment, `?` one char. A pattern without `/` matches the basename.
export function globRe(glob) {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?|\*|\?/g, (m) => (m === '**/' ? '(?:.*/)?' : m === '**' ? '.*' : m === '*' ? '[^/]*' : '[^/]'));
  return new RegExp(glob.includes('/') ? `^${body}$` : `(?:^|/)${body}$`);
}

// -> { run: boolean, reason, outside[] }
export function decide(changed, except) {
  if (!changed) return { run: true, reason: 'changed paths unknown', outside: [] };
  if (!changed.length) return { run: true, reason: 'no changed paths', outside: [] };
  const res = except.map(globRe);
  const outside = changed.filter((f) => !res.some((re) => re.test(f)));
  return outside.length ? { run: true, reason: `${outside.length} changed path(s) outside ${except.join(', ')}`, outside }
    : { run: false, reason: `all ${changed.length} changed path(s) match ${except.join(', ')}`, outside };
}

function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  const cmd = sep >= 0 ? argv.slice(sep + 1) : [];
  const except = [];
  for (let i = 0; i < (sep >= 0 ? sep : argv.length); i++) if (argv[i] === '--except' && argv[i + 1]) except.push(argv[++i]);
  if (!cmd.length || !except.length) {
    console.error('usage: run-if-changed.js --except <glob> [--except <glob>...] -- <command...>');
    process.exit(2);
  }
  let changed = null;
  const base = process.env.V2_BASE_SHA;
  if (base) {
    try { changed = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean); } catch { changed = null; }
  }
  const d = decide(changed, except);
  if (!d.run) {
    console.log(`run-if-changed: skipped ${cmd.join(' ')}: ${d.reason}`);
    process.exit(0);
  }
  console.log(`run-if-changed: running ${cmd.join(' ')}: ${d.reason}`);
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  if (r.error) { console.error(`run-if-changed: ${r.error.message}`); process.exit(2); }
  process.exit(r.status ?? 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
