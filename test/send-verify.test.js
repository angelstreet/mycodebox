// A send whose Enter was swallowed (Claude Code still turning an image path into an attachment) leaves the text in the prompt:
// verifyDelivered notices and presses Enter again, a bounded number of times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isOurDraft, verifyDelivered } from '../send-verify.js';

const TEXT = 'explain to me the difference between reader and terminal /home/jndoye/.ghosty/uploads/1792683836883-e3d3fe.png and more';

test('isOurDraft: the start of our text, or an agent paste placeholder, is ours; an empty prompt or other text is not', () => {
  assert.equal(isOurDraft('explain to me the difference between reader', TEXT), true);
  assert.equal(isOurDraft('[Image #3]explain to me the difference', TEXT), true, 'the image attachment placeholder');
  assert.equal(isOurDraft('[Pasted text +12 lines]', 'whatever'), true);
  assert.equal(isOurDraft('', TEXT), false);
  assert.equal(isOurDraft(null, TEXT), false);
  assert.equal(isOurDraft('something the owner was typing', TEXT), false, 'not ours: never press Enter on it');
  assert.equal(isOurDraft('anything', ''), false);
});

const run = async ({ drafts, retries }) => {
  let i = 0, enters = 0, waited = 0; const retried = [];
  const pressed = await verifyDelivered({ text: TEXT, retries, draftNow: async () => drafts[Math.min(i++, drafts.length - 1)], pressEnter: async () => { enters++; },
    sleep: async (ms) => { waited += ms; }, onRetry: (n) => retried.push(n) });
  return { pressed, enters, waited, retried };
};

test('verifyDelivered: delivered at once -> no extra Enter', async () => {
  assert.deepEqual(await run({ drafts: [null] }), { pressed: 0, enters: 0, waited: 650, retried: [] });
});

test('verifyDelivered: the first Enter was swallowed -> one more Enter, then it is gone', async () => {
  const r = await run({ drafts: ['[Image #1]explain to me the difference', null] });
  assert.equal(r.pressed, 1); assert.equal(r.enters, 1); assert.deepEqual(r.retried, [1]);
});

test('verifyDelivered: bounded, a draft that never clears gets at most 3 extra Enters', async () => {
  const r = await run({ drafts: ['[Image #1]explain to me'], retries: 3 });
  assert.equal(r.pressed, 3); assert.equal(r.enters, 3);
});

test('verifyDelivered: the owner\'s own unrelated draft is left alone', async () => {
  const r = await run({ drafts: ['half a sentence the owner is typing'] });
  assert.equal(r.pressed, 0); assert.equal(r.enters, 0);
});
