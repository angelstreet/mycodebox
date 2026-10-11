#!/usr/bin/env node
// V2 acceptance matrix runner (docs/v2/ACCEPTANCE.md). Runs the whole test suite once with node --test in a fresh
// temp GHOSTY_STATE_DIR, maps every test whose name starts with matrix ids (`T07: ...`, `GL02/T09 ...`) to those
// rows, and writes docs/v2/acceptance-results.json (synthetic: test names, outcomes, sha, node version, timestamp).
//   node scripts/v2-acceptance.js [--out <file>] [--files <glob or file>...]
// Exit 0 only when no row is FAIL. A row is PASS when at least one mapped test ran and every mapped test passed;
// a known-defect (todo) test mapped to a row makes it FAIL; T16 additionally needs every pre-V2 test file green.
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(ROOT, opt('--out', 'docs/v2/acceptance-results.json'));

// Every row of the matrix. `pending` = owned elsewhere until its evidence lands; `manual` = needs a human.
export const ROWS = [
  ...Array.from({ length: 40 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 14 }, (_, i) => `GL${String(i + 1).padStart(2, '0')}`),
];
const DISPOSITION = {
  T20: { status: 'PENDING', reason: 'owned by the UI package (v2/06-ui-docs): browser check scripts/v2-ui-check.js; status set when that branch lands' },
};
const LEGACY_FOR = { T16: (f) => !path.basename(f).startsWith('v2-') };
// Open defects recorded by independent verifiers as `todo` tests without a matrix prefix, mapped to the rows whose
// requirement they contradict (file -> leading token -> rows). A mapped todo makes its row FAIL until fixed.
const DEFECT_ROWS = {
  'test/v2-goal-loop-verify.test.js': { V1: ['GL06'], V2: ['T13'], V3: ['T13'], V4: ['GL09'], V5: ['T14'], V6: ['GL09'], V7: ['GL09'], V7b: ['GL09'],
    V8: ['GL04', 'GL07'], V9: ['GL07'], V10: ['GL09'], V12b: ['T18', 'GL06'], V13: ['GL07'] },
  'test/v2-goal-loop-verify4.test.js': { Y3b: ['T10', 'GL12'], Y6: ['T06', 'T18'], Y7: ['T13'] },
  'test/v2-lease-authority-verify4.test.js': { 'adoptOwn:': ['T25', 'T27', 'GL10'] },
  'test/v2-goal-loop-verify5.test.js': { Z1: ['T18', 'T27', 'GL06'], Z3: ['T14'] },
  'test/v2-lease-authority-verify5.test.js': { 'D-016': ['T25', 'T27', 'GL10'] },
  'test/v2-store-d017-verify.test.js': { 'D-017:': ['T14', 'T18'] },
};
const defectRows = (r) => (r.todo && r.file ? DEFECT_ROWS[r.file]?.[String(r.name).split(/\s/)[0]] ?? [] : []);

// Leading ids: "T07: x", "GL02/T09 x", "T27 (file): x", "T12/GL06 x".
export function idsOf(name) {
  const m = /^((?:T|GL)\d{2}(?:\s*[/,+]\s*(?:T|GL)\d{2})*)(?=[\s:(]|$)/.exec(String(name));
  return m ? m[1].split(/[/,+]/).map((s) => s.trim()) : [];
}

export function classify(results) {
  const rows = [];
  for (const id of ROWS) {
    const tests = results.filter((r) => idsOf(r.name).includes(id) || defectRows(r).includes(id));
    const ran = tests.filter((r) => !r.skip);
    const failed = ran.filter((r) => r.outcome === 'fail' && !r.todo);
    const todo = tests.filter((r) => r.todo && r.outcome === 'fail');   // a passing todo no longer shows the defect
    const legacy = LEGACY_FOR[id] ? results.filter((r) => r.file && LEGACY_FOR[id](r.file)) : null;
    const legacyFailed = legacy ? legacy.filter((r) => r.outcome === 'fail' && !r.todo) : [];
    let status, reason;
    if (!tests.length && DISPOSITION[id]) ({ status, reason } = DISPOSITION[id]);
    else if (!ran.some((r) => !r.todo)) { status = 'FAIL'; reason = 'no executed test carries this id'; }
    else if (failed.length) { status = 'FAIL'; reason = `${failed.length} mapped test(s) failed`; }
    else if (todo.length) { status = 'FAIL'; reason = `open defect(s) recorded as todo: ${todo.map((r) => `${r.file}: ${r.name.slice(0, 80)}`).join(' | ')}`; }
    else if (legacy && (!legacy.length || legacyFailed.length)) { status = 'FAIL'; reason = `${legacyFailed.length} pre-V2 regression test(s) failed`; }
    else { status = 'PASS'; reason = `${ran.length} test(s) passed${legacy ? `; ${legacy.length} pre-V2 regression tests passed` : ''}`; }
    rows.push({ id, status, reason, tests: tests.map((r) => ({ name: r.name, file: r.file, outcome: r.todo ? 'todo' : r.skip ? 'skip' : r.outcome })),
      ...(legacy ? { regression: { files: [...new Set(legacy.map((r) => r.file))].length, tests: legacy.length, failed: legacyFailed.map((r) => `${r.file}: ${r.name}`) } } : {}) });
  }
  return rows;
}

function main() {
  const files = args.includes('--files') ? args.slice(args.indexOf('--files') + 1) : fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-acceptance-'));
  const jsonl = path.join(tmp, 'results.jsonl');
  const state = path.join(tmp, 'state');
  fs.mkdirSync(state);
  const t0 = Date.now();
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=./scripts/v2-acceptance-reporter.mjs', `--test-reporter-destination=${jsonl}`,
    '--test-reporter=dot', '--test-reporter-destination=stderr', ...files],
  { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, GHOSTY_STATE_DIR: state }, timeout: 30 * 60_000 });
  const results = fs.existsSync(jsonl) ? fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  fs.rmSync(tmp, { recursive: true, force: true });
  const git = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } };
  const rows = classify(results);
  const count = (s) => rows.filter((r) => r.status === s).length;
  const out = {
    schema: 'mycodebox.v2.acceptance-results/1', synthetic: true,
    generated_at: new Date().toISOString(), sha: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', '.', `:!${path.relative(ROOT, OUT)}`, ':!docs/v2/ACCEPTANCE.md') ? true : false,   // its own outputs do not count
    node: process.version, command: `node scripts/v2-acceptance.js${args.length ? ` ${args.join(' ')}` : ''}`, duration_ms: Date.now() - t0,
    runner_exit: run.status, files: files.length,
    totals: { tests: results.length, pass: results.filter((r) => r.outcome === 'pass' && !r.todo).length, fail: results.filter((r) => r.outcome === 'fail' && !r.todo).length,
      todo: results.filter((r) => r.todo).length, todo_failing: results.filter((r) => r.todo && r.outcome === 'fail').length, skip: results.filter((r) => r.skip).length },
    matrix: { rows: rows.length, PASS: count('PASS'), FAIL: count('FAIL'), PENDING: count('PENDING'), BLOCKED: count('BLOCKED'), MANUAL: count('MANUAL') },
    rows,
    open_defects: results.filter((r) => r.todo && r.outcome === 'fail').map((r) => ({ name: r.name, file: r.file, rows: [...new Set([...idsOf(r.name), ...defectRows(r)])] })),
    unmapped_failures: results.filter((r) => r.outcome === 'fail' && !r.todo && !idsOf(r.name).length).map((r) => ({ name: r.name, file: r.file, error: r.error })),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  const line = (r) => `${r.id.padEnd(5)} ${r.status.padEnd(8)} ${r.reason}`;
  process.stdout.write(`\n${rows.map(line).join('\n')}\n\nmatrix: ${JSON.stringify(out.matrix)}  tests: ${JSON.stringify(out.totals)}\nwrote ${path.relative(ROOT, OUT)}\n`);
  process.exitCode = count('FAIL') || out.unmapped_failures.length || run.status !== 0 ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
