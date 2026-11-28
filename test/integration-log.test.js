import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRequests, createRequestWriter } from '../integration-log.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'intlog-')), 'integration', 'requests.jsonl');
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
const rebuilt = (f, id = 'int-a') => readRequests(lines(f)).get(id);
const plain = (x) => JSON.parse(JSON.stringify(x));

test('after the first line a save writes only the changes, and reading gives the same request back', () => {
  const f = tmp(), save = createRequestWriter(f);
  const r = { id: 'int-a', state: 'queued', branch: 'b', note: 'n'.repeat(500), steps: [] };
  const check = () => { save(r); assert.deepEqual(rebuilt(f), plain(r)); };
  check();
  r.state = 'running'; check();
  r.steps.push({ name: 'fetch', ok: null }); r.step = 'fetch'; check();
  Object.assign(r.steps[0], { ok: true, tail: 'F'.repeat(2000) }); check();          // mutated in place
  r.steps.push({ name: 'test', ok: null }); r.step = 'test'; check();
  const last = lines(f).at(-1);
  assert.ok(!last.includes('FFFF') && !last.includes('nnnn') && last.length < 200, last);
  assert.deepEqual(Object.keys(JSON.parse(last)).sort(), ['of', 'set', 'steps']);
  r.times = { mergedAt: 'x' }; r.step = undefined; r.reason = null; check();          // new key, removed key, null kept
  assert.deepEqual(JSON.parse(lines(f).at(-1)).del, ['step']);
  r.steps = r.steps.slice(0, 1); check();                                             // steps shortened
  const n = lines(f).length; save(r); assert.equal(lines(f).length, n, 'nothing changed: no line');
  r.state = 'merged'; check();
  assert.equal(JSON.parse(lines(f).at(-1)).id, 'int-a', 'a change of state is a full line');
});

test('code from before the change lines (keeps lines with an id) sees the last full line, never a fragment', () => {
  const f = tmp(), save = createRequestWriter(f);
  const r = { id: 'int-a', state: 'running', branch: 'b', steps: [] };
  save(r); r.steps.push({ name: 'fetch' }); save(r);
  const old = new Map(); for (const l of lines(f)) { const x = JSON.parse(l); if (x?.id) old.set(x.id, x); }
  assert.deepEqual([...old.values()], [{ id: 'int-a', state: 'running', branch: 'b', steps: [] }]);
});

test('an old file keeps its lines; after a restart the writer starts with a full line, also behind a torn one', () => {
  const f = tmp();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const before = `${JSON.stringify({ id: 'int-a', state: 'running', steps: [{ name: 'fetch' }] })}\n${JSON.stringify({ id: 'int-b', state: 'merged' })}\n{"id":"int-a","sta`;
  fs.writeFileSync(f, before);
  const save = createRequestWriter(f), r = { id: 'int-a', state: 'running', steps: [{ name: 'fetch' }, { name: 'test' }] };
  save(r); r.step = 'test'; save(r);
  assert.ok(fs.readFileSync(f, 'utf8').startsWith(`${before}\n`), 'appended only');
  assert.deepEqual(rebuilt(f), r);
  assert.deepEqual(rebuilt(f, 'int-b'), { id: 'int-b', state: 'merged' });
});

test('a failed write loses nothing: the next save is a full line', () => {
  const f = tmp(); let fail = false;
  const save = createRequestWriter(f, { append: (file, text, o) => { if (fail) { fs.appendFileSync(file, text.slice(0, 5), o); throw new Error('ENOSPC'); } fs.appendFileSync(file, text, o); } });
  const r = { id: 'int-a', state: 'running', steps: [] };
  save(r); fail = true; r.sha = 'abc'; assert.throws(() => save(r), /ENOSPC/);
  fail = false; r.step = 'push'; save(r);
  assert.deepEqual(rebuilt(f), r);
});

test('a change line without its full line is ignored', () => {
  assert.equal(readRequests(['{"of":"int-x","set":{"state":"merged"}}', 'junk', '']).size, 0);
});
