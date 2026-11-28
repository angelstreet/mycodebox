import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDoneCheck, summaryGapOf, summaryMessage } from '../done-check.js';

const WITH = 'answer\n\nSummary:\n- It works now.\n\nVerification:\n1. pass\n\nSTATUS: done — fixed';
const done = (x) => `answer\n\nSTATUS: done — ${x}`;

function harness(t, { sessions, summary = 'live', listDone = async () => [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'done-check-summary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent = [];
  const w = createDoneCheck({ stateDir: dir, git: async () => { throw new Error('no git'); }, listDone, listSessions: async () => sessions(), summaryMode: () => summary,
    mode: () => 'live', log: { error() {} }, pressure: () => ({ loadPerCore: 0.2, ramAvailPct: 60 }), send: async (n, text) => { sent.push([n, text]); } });
  return { w, dir, sent };
}

test('summaryGapOf: only closing kinds are asked; a good summary is none', () => {
  assert.equal(summaryGapOf(WITH), null);
  assert.deepEqual(summaryGapOf(done('x')), { kind: 'done', missing: true, tooLong: false, lineCount: 0 });
  assert.equal(summaryGapOf('STATUS: waiting: integration int-1'), null);
  assert.equal(summaryGapOf('STATUS: running — tests'), null);
  assert.equal(summaryGapOf('no status at all'), null);
  for (const k of ['failed', 'blocked', 'needs-manager', 'needs-owner']) assert.equal(summaryGapOf(`STATUS: ${k} — x`)?.kind, k);
  assert.equal(summaryGapOf('Summary:\n' + '- a\n'.repeat(11) + 'STATUS: done — x').tooLong, true);
  assert.match(summaryMessage(), /no `Summary:` block.*1 to 10 short plain-language lines.*repeat the STATUS line unchanged/);
});

test('tick (R): the first run only records the lines it finds; a new line without summary is pushed once', async (t) => {
  let s = [{ name: 'a', text: done('one') }, { name: 'b', text: WITH }, { name: 'c', text: 'STATUS: waiting: integration int-1' }];
  const h = harness(t, { sessions: () => s });
  const r1 = await h.w.tick();
  assert.equal(h.sent.length, 0, 'the rollout never reopens an old turn');
  assert.deepEqual(r1.missingSummary, []);
  s = [{ name: 'a', text: done('two') }, { name: 'b', text: WITH }, { name: 'c', text: done('three') }];
  const r2 = await h.w.tick();
  assert.deepEqual(h.sent.map((x) => x[0]).sort(), ['a', 'c']);
  assert.equal(h.sent[0][1], summaryMessage());
  assert.deepEqual(r2.missingSummary.sort(), ['a', 'c']);
  await h.w.tick();
  assert.equal(h.sent.length, 2, 'once per STATUS line');
});

test('tick (R): never a working or drafting session, at most 2 a day, dry journals only, off does nothing', async (t) => {
  let s = [];
  const h = harness(t, { sessions: () => s });
  await h.w.tick();   // baseline
  s = [{ name: 'w', text: done('w'), working: true }, { name: 'd', text: done('d'), draft: true }];
  await h.w.tick();
  assert.equal(h.sent.length, 0);
  for (const x of ['1', '2', '3']) { s = [{ name: 'k', text: done(x) }]; await h.w.tick(); }
  assert.equal(h.sent.filter((x) => x[0] === 'k').length, 2, 'two pushes a day');

  let ds = [];
  const dry = harness(t, { sessions: () => ds, summary: 'dry' });
  await dry.w.tick(); ds = [{ name: 'k', text: done('x') }]; await dry.w.tick(); await dry.w.tick();
  assert.equal(dry.sent.length, 0);
  const lines = readFileSync(join(dry.dir, 'done-check.jsonl'), 'utf8').trim().split('\n').filter((l) => l.includes('"summary"'));
  assert.equal(lines.length, 1, 'dry journals once per line');

  const off = harness(t, { sessions: () => [{ name: 'k', text: done('x') }], summary: 'off' });
  await off.w.tick(); await off.w.tick();
  assert.equal(off.sent.length, 0);
  assert.equal(existsSync(join(off.dir, 'done-check.jsonl')), false);
});

test('tick (R): a closing-review push carries the summary ask, so the session gets one message', async (t) => {
  let s = [];
  const row = () => ({ name: 'k', cwd: '/nowhere', text: done('fixed · bugs: none') });
  const h = harness(t, { sessions: () => s, listDone: async () => s.map(() => row()) });
  await h.w.tick();   // baseline (nothing listed)
  s = [row()];
  await h.w.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0][1], /no closing review/);
  assert.match(h.sent[0][1], /Also: your last message has no `Summary:` block/);
  await h.w.tick();
  assert.equal(h.sent.length, 1, 'the summary ask is not sent again for the same line');
});
