// Independent verification of scripts/v2-acceptance.js: a test file that node --test ran but that produced no test of
// its own must fail the acceptance run (its tests vanished with 0 failures). Real node --test over fixture files, both
// shapes observed on Node 23/24: a file that exits 0 before registering tests, a file with no tests, and a file whose
// process exits 0 inside a test are each reported as ONE passing entry named by the file's absolute path.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fileGaps, classify } from '../scripts/v2-acceptance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-acc-runner-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('acceptance runner guard: files whose tests vanished (early exit, no tests, exit inside a test) are reported as gaps; a healthy file is not', () => {
  const w = (name, body) => { const f = path.join(TMP, name); fs.writeFileSync(f, body); return f; };
  const files = [
    w('ok.test.js', "import test from 'node:test';\ntest('T99: ok', () => {});\n"),
    w('early.test.js', 'process.exit(0);\n'),
    w('none.test.js', 'export const x = 1;\n'),
    w('inside.test.js', "import test from 'node:test';\ntest('T98: registered then the process dies', () => { process.exit(0); });\n"),
  ];
  const out = path.join(TMP, 'r.jsonl');
  // A nested runner must not inherit NODE_TEST_CONTEXT: with it, node --test behaves as a child of the outer runner
  // (v8-serialized stdout, reporter flags ignored) and writes no destination file.
  const env = { ...process.env, GHOSTY_STATE_DIR: path.join(TMP, 'state') };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=./scripts/v2-acceptance-reporter.mjs', `--test-reporter-destination=${out}`, ...files],
    { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(run.status, 0, 'node --test itself reports success');
  const results = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(results.length, 4, 'one entry per file: three of them are synthetic file-level passes');
  assert.ok(results.every((r) => r.outcome === 'pass'), '0 failures');
  assert.deepEqual(fileGaps(files, results, ROOT), files.slice(1), 'every file that lost its tests is a gap');
  // The matrix on its own would not notice: T98 simply has no executed test; a row carried by another file stays PASS.
  assert.ok(classify([{ name: 'T07: carried elsewhere', file: 'test/x.test.js', outcome: 'pass', todo: false, skip: false }, ...results]).find((r) => r.id === 'T07').status === 'PASS');
});

test('acceptance runner guard: the real suite file list has no gap in the recorded results shape (relative file paths, absolute synthetic names)', () => {
  const files = ['test/a.test.js', 'test/b.test.js'];
  const ok = { outcome: 'pass', name: 'T01: x', file: 'test/a.test.js', todo: false, skip: false };
  const synthetic = { outcome: 'pass', name: path.resolve(ROOT, 'test/b.test.js'), file: 'test/b.test.js', todo: false, skip: false };
  assert.deepEqual(fileGaps(files, [ok, synthetic], ROOT), ['test/b.test.js']);
  assert.deepEqual(fileGaps(files, [ok, { ...synthetic, name: 'b real test' }], ROOT), []);
  assert.deepEqual(fileGaps(files, [ok], ROOT), ['test/b.test.js'], 'a file that produced nothing at all (absent at launch) is a gap too');
});
