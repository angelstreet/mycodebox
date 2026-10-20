import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { select, ticket } from '../scripts/test-run.js';

const all = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'];
const src = { 'test/a.test.js': "import x from '../lane.js';", 'test/b.test.js': "readFileSync('docs/USAGE.md')", 'test/c.test.js': '' };
const read = (t) => src[t];

test('select: changed tests plus the tests that name a changed file', () => {
  assert.deepEqual(select(['lane.js'], all, read), { files: ['test/a.test.js'] });
  assert.deepEqual(select(['docs/USAGE.md', 'test/c.test.js'], all, read), { files: ['test/b.test.js', 'test/c.test.js'] });
  assert.deepEqual(select(['README.md'], all, read), { files: [] });
});

test('select: lockfile, package.json, helpers and fixtures, or an unknown diff mean the full suite', () => {
  for (const f of ['package.json', 'package-lock.json', 'test/helpers-git.js', 'test/fixtures/x.json']) assert.ok(select([f], all, read).full, f);
  assert.ok(select(null, all, read).full);
});

test('ticket: two slots, a third waits, a dead holder is taken over', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'slots-'));
  const quiet = () => {};
  const r1 = await ticket({ dir, slots: 2, pid: process.pid, log: quiet });
  const r2 = await ticket({ dir, slots: 2, pid: process.pid, log: quiet });
  let got = false; const logs = [];
  const p3 = ticket({ dir, slots: 2, pid: process.pid, log: (m) => logs.push(m), pollMs: 20 }).then((r) => { got = true; return r; });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(got, false); assert.equal(logs.length, 1);
  r1(); const r3 = await p3; assert.equal(got, true);
  r2(); r3();
  writeFileSync(path.join(dir, 'slot-0'), '999999999'); writeFileSync(path.join(dir, 'slot-1'), '999999998');   // dead pids
  const r4 = await ticket({ dir, slots: 2, pid: process.pid, log: quiet, pollMs: 20 });
  assert.equal(readFileSync(path.join(dir, 'slot-0'), 'utf8'), String(process.pid));
  r4(); assert.equal(existsSync(path.join(dir, 'slot-0')), false);
});
