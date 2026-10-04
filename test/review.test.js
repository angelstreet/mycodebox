import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Synthetic log only: no real stop content.
const dir = mkdtempSync(join(tmpdir(), 'ghosty-review-'));
process.env.GHOSTY_STATE_DIR = dir;
const m = await import('../manager.js');
const log = join(dir, 'stalls.jsonl');
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const stall = (id, minAgo, extra = {}) => ({ type: 'stall', id, session: `sess-${id}`, project: 'demo', agent: 'claude', state: 'done', at: iso(minAgo),
  case: 'continue', source: 'rules', why: 'safe', wouldSend: { text: 'Yes, continue.' }, no_status: false, excerpt: `synthetic closing text ${id}`, ...extra });
const write = (recs) => writeFileSync(log, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
const read = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('review deck: unlabelled only, newest first, outcome + jev + counts', async () => {
  write([
    stall('a1', 50), stall('a2', 40, { jev: { choice: 'continue', confidence: 0.9 }, deployHint: { scope: '--server' } }), stall('a3', 30), stall('a4', 20),
    { type: 'outcome', id: 'a2', session: 'sess-a2', at: iso(39), kind: 'continue', via: 'ghosty', reply: 'Yes, continue.' },
    { type: 'label', id: 'a3', label: 'legit', at: iso(10) },
    { type: 'answer', id: 'a4', session: 'sess-a4' },
  ]);
  const d = await m.reviewDeck(50);
  assert.deepEqual(d.cards.map((c) => c.id), ['a4', 'a2', 'a1']);
  assert.equal(d.unlabelled, 3);
  assert.equal(d.labelledToday, 1);
  const a2 = d.cards[1];
  assert.deepEqual(a2.jev, { choice: 'continue', confidence: 0.9 });
  assert.equal(a2.outcome.reply, 'Yes, continue.');
  assert.deepEqual(a2.deployHint, { scope: '--server' });
  assert.equal(a2.excerpt, 'synthetic closing text a2');
  assert.equal(d.cards[0].outcome, null);
  assert.equal((await m.reviewDeck(2)).cards.length, 2);
  assert.equal((await m.reviewDeck(2)).unlabelled, 3, 'the total ignores the limit');
});

test('label then undo: the stop comes back, a newer label wins, wrong case rides on a good/bad label', async () => {
  write([stall('b1', 30), stall('b2', 20)]);
  await m.labelStall({ id: 'b2', label: 'no_reason' });
  assert.deepEqual((await m.reviewDeck()).cards.map((c) => c.id), ['b1']);
  const u = await m.unlabelStall({ id: 'b2' });
  assert.equal(u.type, 'unlabel');
  const d = await m.reviewDeck();
  assert.deepEqual(d.cards.map((c) => c.id), ['b2', 'b1']);
  assert.equal(d.labelledToday, 0);
  const w = await m.labelStall({ id: 'b1', label: 'legit', note: 'fine', correctCase: 'done' });
  assert.equal(w.correctCase, 'done');
  await assert.rejects(m.unlabelStall({ id: 'nope' }), /unknown stall id/);
  await assert.rejects(m.unlabelStall({}), /id required/);
  assert.equal(m.effectiveLabels(read()).get('b1').label, 'legit');
});

test('stall-report honours unlabel (counts and --export)', () => {
  write([stall('c1', 30), stall('c2', 20), stall('c3', 10),
    { type: 'label', id: 'c1', label: 'no_reason', at: iso(9) },
    { type: 'label', id: 'c2', label: 'legit', correctCase: 'done', at: iso(8) },
    { type: 'label', id: 'c3', label: 'no_reason', at: iso(7) },
    { type: 'unlabel', id: 'c1', at: iso(6) }]);
  const out = join(dir, 'export.json');
  const r = spawnSync('node', ['scripts/stall-report.js', '--days', '1', '--log', log, '--export', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const items = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(items.map((x) => x.id).sort(), ['c2', 'c3']);
  assert.match(r.stdout, /continue\s+1\s+1\s+1/, 'continue: 1 no_reason, 1 legit, 1 wrong_case');
});

test('review deck folds repeats of the same stop into one card', async () => {
  const { appendFileSync } = await import('node:fs');
  const m = await import('../manager.js');
  const ex = 'Repeated closing text of one stop.';
  for (let i = 0; i < 5; i++) appendFileSync(m.LOG_FILE, JSON.stringify({ type: 'stall', id: `dup-${i}`, session: 'dupsess', case: 'done', at: new Date(Date.now() - (5 - i) * 1000).toISOString(), excerpt: ex }) + '\n');
  let d = await m.reviewDeck(200);
  const dups = d.cards.filter((c) => c.session === 'dupsess');
  assert.equal(dups.length, 1);
  assert.equal(dups[0].id, 'dup-4');
  await m.labelStall({ id: 'dup-2', label: 'legit' });
  d = await m.reviewDeck(200);
  assert.equal(d.cards.filter((c) => c.session === 'dupsess').length, 0);
});

test('a re-wrapped pane is the same stop (swipe deck and observe key)', async () => {
  const { appendFileSync } = await import('node:fs');
  const m = await import('../manager.js');
  assert.equal(m.stopKey('the local agent, more pre-canned\n  behavior rule configs), say the word.'),
    m.stopKey('the lo\ncal   agent, more   pre-canned behavior rule   configs),\n say the word.'));
  appendFileSync(m.LOG_FILE, JSON.stringify({ type: 'stall', id: 'wrap-1', session: 'wrapsess', case: 'done', at: new Date(Date.now() - 2000).toISOString(), excerpt: 'local agent, say the word.' }) + '\n');
  appendFileSync(m.LOG_FILE, JSON.stringify({ type: 'stall', id: 'wrap-2', session: 'wrapsess', case: 'done', at: new Date().toISOString(), excerpt: 'lo\ncal   agent,  say the\nword.' }) + '\n');
  const d = await m.reviewDeck(200);
  assert.equal(d.cards.filter((c) => c.session === 'wrapsess').length, 1);
});
