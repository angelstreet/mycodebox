#!/usr/bin/env node
// Daily check (scripts/daily-checks.js protocol): the full test suite on the tip of origin/main, once a day.
// Owner 2026-10-20: merges test only what they touch (scripts/test-run.js), so this is where cross-file breakage shows.
// Runs in a throwaway worktree with its own state dir; red = one finding naming the failing tests.
//   node scripts/full-suite-check.js            (daily-checks.json: "command": ["/usr/local/bin/node", "<checkout>/scripts/full-suite-check.js"], "timeoutSec": 2400)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Pure: test runner output -> the daily-check result object.
export function summarize(out, code, sha) {
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out) || [])[1] || 0);
  const failing = [...new Set([...out.matchAll(/^✖ (.+?)(?: \(\d[\d.]*ms\))?$/gm)].map((m) => m[1]).filter((t) => t !== 'failing tests:'))];
  const line = `full suite on main ${sha}: ${n('pass')} of ${n('tests')} passed`;
  if (code === 0 && n('fail') === 0) return { summary: line, report: line, findings: [] };
  const list = failing.slice(0, 20).map((t) => `- ${t}`).join('\n');
  return {
    summary: `${line}, ${n('fail')} failing`,
    report: `${line}, ${n('fail')} failing (exit ${code}).\n\n${list}`,
    findings: [{ key: 'full-suite:red', title: `Full test suite red on main (${n('fail')} failing)`,
      body: `main ${sha}: ${failing.slice(0, 5).join('; ').slice(0, 260)}`, priority: 'high' }],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('fetch', '-q', 'origin', 'main');
  const sha = g('rev-parse', '--short=8', 'origin/main');
  const wt = mkdtempSync(path.join(os.tmpdir(), 'full-suite-'));
  const state = mkdtempSync(path.join(os.tmpdir(), 'full-suite-state-'));
  let res;
  try {
    g('worktree', 'add', '-q', '--detach', wt, 'origin/main');
    const sh = (cmd, env = {}) => spawnSync('sh', ['-c', cmd], { cwd: wt, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CI: '1', ...env } });
    const i = sh('npm ci --no-audit --no-fund');
    res = i.status === 0 ? sh('npm run test:full', { GHOSTY_STATE_DIR: state }) : { status: i.status, stdout: `npm ci failed\n${i.stdout}${i.stderr}` };
  } finally {
    try { g('worktree', 'remove', '--force', wt); } catch {}
    rmSync(wt, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true });
  }
  console.log(JSON.stringify(summarize(`${res.stdout || ''}${res.stderr || ''}`, res.status ?? 1, sha)));
}
