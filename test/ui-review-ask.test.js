// A needs-owner stop on something to look at: ghosty reviews it before the owner is woken (ui-review-ask.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAskReview, visualAskOf, kindOf, MAX_ROUNDS } from '../ui-review-ask.js';
import { tmp } from './helpers-tmp.js';

const ask = (extra = '') => `The poster is ready. ${extra}\nSTATUS: needs-owner: poster mockup; 1 = ship / 2 = change`;

test('which stops are visual asks', () => {
  assert.ok(visualAskOf(ask()));
  assert.ok(visualAskOf('Done.\nSTATUS: needs-owner: ok?', ['frontend/src/pages/X.tsx']));
  assert.equal(visualAskOf('STATUS: needs-owner: may I delete the table? [1 yes / 2 no]'), null);
  assert.equal(visualAskOf('The poster is live.\nSTATUS: done — shipped'), null);
  assert.deepEqual(visualAskOf(ask('See /tmp/a/poster.html and claude.ai/artifact/x')).files, ['/tmp/a/poster.html']);
  assert.equal(kindOf('/tmp/a/poster.html', ''), 'poster');
  assert.equal(kindOf('/tmp/a/page.html', 'mockup'), 'mockup');
});

const rig = (verdicts, o = {}) => {
  const dir = tmp('ask-'), sent = [], reviewed = [];
  const file = join(dir, 'poster.html'); writeFileSync(file, '<html></html>');
  const a = createAskReview({ stateDir: dir, branchOf: async () => ({ cwd: dir, base: 'x', files: [] }), send: async (s, t) => sent.push(t),
    review: async (x) => { reviewed.push(x); return { verdict: verdicts.shift() || 'fail', summary: 'sum', table: '| text.words_per_line | FAIL | 20 words |' }; }, ...o });
  return { a, sent, reviewed, file };
};

test('a fail is held and sent back; the owner is pushed after two rounds, with the table said to be failing', async () => {
  const { a, sent, file } = rig(['fail', 'fail', 'fail']);
  for (let i = 1; i <= MAX_ROUNDS; i++) assert.deepEqual(await a.handle('s1', ask(`${file} try ${i}`)), { push: false });
  assert.equal(sent.length, 2);
  assert.match(sent[0], /round 1 of 2[\s\S]*owner has not been woken[\s\S]*20 words/);
  const third = await a.handle('s1', ask(`${file} try 3`));
  assert.equal(third.push, true);
  assert.match(third.note, /^UI review: STILL FAILING after 2 send-backs[\s\S]*20 words/);
  assert.equal(a.cardOf('s1').verdict, 'fail');
});

test('a pass pushes at once with the verdict, and the same stop is not reviewed twice', async () => {
  const { a, sent, reviewed, file } = rig(['pass']);
  const r = await a.handle('s1', ask(file));
  assert.equal(r.push, true); assert.match(r.note, /^UI review: pass/);
  await a.handle('s1', ask(file));
  assert.equal(reviewed.length, 1); assert.equal(sent.length, 0);
});

test('a claude.ai artifact with no file behind it is sent back for the file', async () => {
  const { a, sent, reviewed } = rig([]);
  assert.equal((await a.handle('s1', ask('https://claude.ai/artifact/abc'))).push, false);
  assert.match(sent[0], /absolute path of the HTML file/); assert.equal(reviewed.length, 0);
});

test('a review that breaks or finds nothing to look at never swallows the ask', async () => {
  const broken = rig([], { review: async () => { throw new Error('no browser'); } });
  const r = await broken.a.handle('s1', ask(broken.file));
  assert.equal(r.push, true); assert.match(r.note, /could not run/);
  const words = rig([]);
  assert.deepEqual(await words.a.handle('s1', 'The layout of the config.\nSTATUS: needs-owner: which key?'), { push: true, note: '' });
});

test('the alert path: only needs-owner is taken over, and a second poll while reviewing does not push', async () => {
  const { a, file } = rig(['pass']);
  assert.equal(a.take('s1', 'STATUS: done — ok', () => assert.fail('not ours')), false);
  await new Promise((resolve) => {
    assert.equal(a.take('s1', ask(file), (note) => { assert.match(note, /pass/); resolve(); }), true);
    assert.equal(a.take('s1', ask(file), () => assert.fail('pushed twice')), true);
  });
});

test('a screenshot cited as evidence is not reviewed as the deliverable; a mockup shown only as a picture needs its source', async () => {
  const seen = [], dir = tmp('ask-');
  writeFileSync(join(dir, 'frame.png'), 'x');
  const a = createAskReview({ stateDir: dir, send: async () => {}, branchOf: async () => ({ cwd: dir, base: 'x', files: ['frontend/src/pages/X.tsx'] }),
    review: async (x) => { seen.push(x); return { verdict: 'pass', summary: 's', table: '' }; } });
  await a.handle('s1', `Evidence ${join(dir, 'frame.png')}\nSTATUS: needs-owner: look at the page?`);
  assert.equal(seen[0].tree, dir); assert.equal(seen[0].files, undefined);
  const sent = [];
  const b = createAskReview({ stateDir: tmp('ask-'), send: async (s, t) => sent.push(t), branchOf: async () => null, review: async () => assert.fail('nothing to run') });
  await b.handle('s2', `Mockup: ${join(dir, 'frame.png')}\nSTATUS: needs-owner: mockup ok?`);
  assert.match(sent[0], /HTML file behind it/);
});

test('only the alert of a finished needs-owner turn is taken: never one over a prompt on screen', () => {
  const { a } = rig(['pass']);
  for (const alert of [{ kind: 'waiting', state: null }, { kind: 'asks', state: 'waiting' }, { kind: 'done', state: null }, { kind: 'asks', state: 'done', status: 'blocked' }]) {
    assert.equal(a.takeAlert('s1', { ...alert, text: ask() }, () => assert.fail('not taken')), false, JSON.stringify(alert));
  }
});
