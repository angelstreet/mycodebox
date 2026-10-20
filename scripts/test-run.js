#!/usr/bin/env node
// `npm test`. Owner 2026-10-20: every run tests only what its change touches, the integration lane included (it sets
// V2_BASE_SHA to the target before the merge); the full suite runs once a day on main (scripts/full-suite-check.js,
// a daily check). At most TEST_SLOTS (default 2) big runs share the host at once. Five full suites at once
// on 6 cores made each 3-5x slower and timed tests out, so the extra runs bought nothing.
//   npm test                         changed-only vs V2_BASE_SHA, else merge-base with origin/main (falls back to full)
//   TEST_SCOPE=full npm test         the whole suite (npm run test:full)
//   npm test -- test/a.test.js ...   exactly these files
// A run of BIG_RUN files or more waits for a ticket: a slot file in TEST_SLOT_DIR holding the owner's pid, freed on
// exit, taken over when that pid is dead.
// Each run gets its own TMPDIR, removed on exit: the tests' mkdtemp dirs were never cleaned and ~99k piled up in /tmp.
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BIG_RUN = 40;
// A change to these can break any test: run everything.
const FULL_IF = [/^package(?:-lock)?\.json$/, /^test\/(?!.*\.test\.js$)/];

const tests = (root) => readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).sort().map((f) => `test/${f}`);

// changed: repo-relative paths; read(file) -> test source. -> { full: reason } | { files: [...] }
export function select(changed, all, read) {
  if (!changed) return { full: 'changed paths unknown' };
  const hit = changed.find((f) => FULL_IF.some((re) => re.test(f)));
  if (hit) return { full: `${hit} changed` };
  const picked = new Set(changed.filter((f) => all.includes(f)));
  // A test covers a file when it names it: ESM imports carry the extension, so `name.js` is precise enough.
  const needles = changed.filter((f) => !all.includes(f)).map((f) => path.basename(f)).filter((b) => b.length > 3);
  if (needles.length) for (const t of all) if (!picked.has(t)) { const s = read(t); if (needles.some((n) => s.includes(n))) picked.add(t); }
  return { files: all.filter((t) => picked.has(t)) };
}

function changedPaths(root) {
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const base = process.env.V2_BASE_SHA || g('merge-base', 'HEAD', 'origin/main');
    const out = [g('diff', '--name-only', '--no-renames', base), g('ls-files', '--others', '--exclude-standard')].join('\n');
    return { base: base.slice(0, 8), changed: [...new Set(out.split('\n').filter(Boolean))] };
  } catch { return { base: null, changed: null }; }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// -> release(). Polls every 2 s; prints once who holds the tickets.
export async function ticket({ dir = process.env.TEST_SLOT_DIR || path.join(os.tmpdir(), 'mycodebox-test-slots'),
  slots = Number(process.env.TEST_SLOTS) || 2, pid = process.pid, log = console.log, pollMs = 2000 } = {}) {
  mkdirSync(dir, { recursive: true });
  let told = false;
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const f = path.join(dir, `slot-${i}`);
      try { closeSync(openSync(f, 'wx')); writeFileSync(f, String(pid)); return () => { try { if (readFileSync(f, 'utf8') === String(pid)) unlinkSync(f); } catch {} }; }
      catch {}
      const owner = Number(readFileSync(f, 'utf8')) || 0;
      if (owner && !alive(owner)) { try { unlinkSync(f); } catch {} i--; }   // dead holder: take the slot over
    }
    if (!told) { log(`test-run: ${slots} big test runs already on this host, waiting for a ticket`); told = true; }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function main() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const all = tests(root);
  const args = process.argv.slice(2).filter((a) => a !== '--');
  let files, why;
  if (args.length) { files = args; why = 'files given'; }
  else if (process.env.TEST_SCOPE === 'full') { files = all; why = 'TEST_SCOPE=full'; }
  else {
    const { base, changed } = changedPaths(root);
    const s = select(changed, all, (t) => readFileSync(path.join(root, t), 'utf8'));
    if (s.full) { files = all; why = `full: ${s.full}`; }
    else { files = s.files; why = `changed-only vs ${base}; the full suite runs daily on main`; }
  }
  console.log(`test-run: ${files.length} of ${all.length} test files (${why})`);
  if (!files.length) return 0;
  const release = files.length >= BIG_RUN ? await ticket() : () => {};
  const tmp = mkdtempSync(path.join(os.tmpdir(), 't-'));   // short: unix socket paths under it must stay < 104 chars
  const child = spawn(process.execPath, ['--test', '--test-timeout=300000', '--test-force-exit', ...files],
    { cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: tmp } });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  const code = await new Promise((r) => child.on('exit', (c, s) => r(c ?? (s ? 1 : 0))));
  release();
  rmSync(tmp, { recursive: true, force: true });
  return code;
}
if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
