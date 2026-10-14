import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionHistory, validateRecord, sanitizePromptRef, fold } from '../session-history.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sh-')), 'session-history.jsonl');
const start = (name, ts, over = {}) => ({ kind: 'session.started', name, provider: 'claude', model: null, cwd: '/w/a', started_by: 'dashboard', prompt_ref: null, handover_ref: null, ts, ...over });
const end = (name, ts, reason = 'killed') => ({ kind: 'session.ended', name, ts, reason });

test('validation rejects unknown kinds, started_by, reasons and bad names', () => {
  assert.throws(() => validateRecord({ kind: 'x', name: 'a' }), /kind/);
  assert.throws(() => validateRecord(start('a', 1, { started_by: 'bob' })), /started_by/);
  assert.throws(() => validateRecord(start('bad name', 1)), /name/);
  assert.throws(() => validateRecord(end('a', 1, 'because')), /reason/);
  assert.equal(validateRecord(start('a', 5)).schema_version, 1);
});

test('prompt_ref: path kept, text sanitized and capped at 200 chars', () => {
  
  const t = sanitizePromptRef('\x1b[31mhello\x1b[0m\n\n  world\x07' + 'x'.repeat(500));
  assert.ok(t.length <= 200); assert.ok(t.startsWith('hello world')); assert.ok(!/[\x00-\x1f]/.test(t));
  assert.equal(sanitizePromptRef('  \n '), null);
});

test('append is one line per record; reader skips a torn last line; instances fold with name reuse', async () => {
  const f = tmp(); const h = createSessionHistory({ file: f });
  await h.append(start('s1', 1000)); await h.append(end('s1', 2000)); await h.append(start('s1', 3000, { cwd: '/w/b' }));
  fs.appendFileSync(f, '{"schema_version":1,"kind":"session.sta');   // crash mid-write
  const l = createSessionHistory({ file: f }).instances();   // boot read skips the torn line
  assert.equal(h.instances().length, 2);
  assert.equal(l.length, 2);
  assert.deepEqual([l[0].end, l[0].end_reason, l[1].end], [2000, 'killed', null]);
  assert.equal(h.instanceAt('s1', 1500).cwd, '/w/a');
  assert.equal(h.instanceAt('s1', 2500), null);
  assert.equal(h.instanceAt('s1', 9999).cwd, '/w/b');
  assert.equal(h.byCwd('/w/b', 3500).name, 's1');
  assert.equal(h.byCwd('/w/b', 1500), null);
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 4); assert.equal(lines.filter((x) => { try { JSON.parse(x); return true; } catch { return false; } }).length, 3);
});

test('byCwd is null when two instances overlap in one directory', () => {
  const f = tmp();
  fs.writeFileSync(f, [start('a', 1), start('b', 2)].map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(createSessionHistory({ file: f }).byCwd('/w/a', 5), null);
});

test('an unknown instance is enriched by the real start, keeping the earlier start time', () => {
  const l = fold([start('a', 100, { started_by: 'unknown' }), start('a', 160, { started_by: 'cbsession', model: 'haiku', prompt_ref: '/p.md' })]);
  assert.equal(l.length, 1);
  assert.deepEqual([l[0].start, l[0].started_by, l[0].model, l[0].prompt_ref], [100, 'cbsession', 'haiku', '/p.md']);
});

test('sync: starts unseen live sessions as unknown; ends after >= missMs of wall clock; idempotent across restarts', async () => {
  const f = tmp(); let t = 5000; let h = createSessionHistory({ file: f, now: () => t, missMs: 2000 });
  const live = new Map([['a', { provider: 'claude', model: 'm', cwd: '/w', created: 100 }]]);
  await h.sync(live); await h.sync(live);
  assert.equal(h.instances().length, 1);
  assert.equal(h.instances()[0].started_by, 'unknown');
  h = createSessionHistory({ file: f, now: () => t, missMs: 2000 });   // restart: rebuilt from the file
  await h.sync(live);
  assert.equal(h.instances().length, 1);
  await h.sync(new Map()); t += 1500; await h.sync(new Map());   // quick successive polls do not end it
  assert.equal(h.instances()[0].end, null);
  await h.sync(live); t += 5000; await h.sync(new Map());           // reappearing reset the clock
  assert.equal(h.instances()[0].end, null);
  t += 2000; await h.sync(new Map());
  assert.equal(h.instances()[0].end_reason, 'vanished');
  await h.append(start('run1', 1, { started_by: 'v2' }));
  t += 9000; await h.sync(new Map()); t += 9000; await h.sync(new Map());
  assert.equal(h.openOf('run1').name, 'run1', 'v2 runs are not tmux sessions');
});

test('sync: a reused name (different tmux session_created) starts a new instance', async () => {
  const h = createSessionHistory({ file: tmp() });
  await h.sync(new Map([['a', { created: 100 }]])); await h.sync(new Map([['a', { created: 100 }]]));
  assert.equal(h.instances().length, 1);
  await h.sync(new Map([['a', { created: 200 }]]));
  assert.deepEqual(h.instances().map((i) => [i.end_reason, i.tmux_created]), [['vanished', 100], [null, 200]]);
});

test('sync: overlapping calls never double-append', async () => {
  const f = tmp(); const h = createSessionHistory({ file: f });
  const live = new Map([['a', {}], ['b', {}]]);
  await Promise.all([h.sync(live), h.sync(live), h.sync(live)]);
  assert.equal(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length, 2);
});

test('sync skips names being created', async () => {
  const h = createSessionHistory({ file: tmp() });
  await h.sync(new Map([['new', {}]]), { skip: new Set(['new']) });
  assert.equal(h.instances().length, 0);
});

test('a slash-command prompt is text capped at 200 chars, an existing path stays a path', () => {
  const t = sanitizePromptRef('/review ' + 'y'.repeat(900));
  assert.ok(t.length <= 200 && t.startsWith('/review y'));
  assert.equal(sanitizePromptRef('/no/such/file.md'.padEnd(300, 'x')).length <= 200, true);
  const f = path.join(os.tmpdir(), `sh-path-${process.pid}.md`); fs.writeFileSync(f, 'x');
  assert.equal(sanitizePromptRef(f), f); fs.rmSync(f);
});

test('tmux_created is validated and kept', () => {
  assert.equal(validateRecord(start('a', 1, { tmux_created: 123 })).tmux_created, 123);
  assert.equal('tmux_created' in validateRecord(start('a', 1, { tmux_created: 'x' })), false);
});
