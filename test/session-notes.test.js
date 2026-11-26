import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionNotes, carriesNotes, withNotes, carryNotes, hookDelivers } from '../session-notes.js';
import { createReporter } from '../reporter.js';
import { informsOnly } from '../lease-source.js';
import { aiSenderOf, promptSig } from '../public/prompt-sig.js';

function tmp(t) { const d = mkdtempSync(join(tmpdir(), 'session-notes-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }

test('notes: kept over a restart, one per key, delivered once; ack never removes the newer note that replaced the one taken', (t) => {
  const dir = tmp(t);
  const a = createSessionNotes({ stateDir: dir });
  a.put('s', 'rules-watch', 'v1');
  const taken = a.peek('s');
  a.put('s', 'rules-watch', 'v2'); a.put('s', 'overlap:a+s', 'o');
  const b = createSessionNotes({ stateDir: dir });
  assert.deepEqual(b.peek('s').map((n) => n.text), ['v2', 'o']);
  b.ack('s', taken.map((n) => n.id));
  assert.equal(b.peek('s').length, 2);
  b.ack('s', b.peek('s').map((n) => n.id));
  assert.deepEqual(b.peek('s'), []);
  assert.deepEqual(createSessionNotes({ stateDir: dir }).peek('s'), []);
});

test('notes: drop, dropKey, prune; a session named like an Object member has no notes', (t) => {
  const n = createSessionNotes({ stateDir: tmp(t) });
  n.put('a', 'k', '1'); n.put('b', 'k', '2'); n.put('b', 'j', '3'); n.put('c', 'j', '4');
  n.drop('a', 'k'); assert.deepEqual(n.peek('a'), []);
  n.dropKey('j'); assert.deepEqual([n.peek('b').length, n.peek('c').length], [1, 0]);
  n.prune(new Set(['a'])); assert.deepEqual(n.peek('b'), []);
  assert.deepEqual(n.peek('constructor'), []);
});

test('notes go along only with a real message, appended so the sender is still recognised', () => {
  for (const t of ['continue', '2', 'y', '/exit', '!ls -la /tmp/somewhere', '']) assert.equal(carriesNotes(t), false, t);
  assert.equal(carriesNotes('Integration int-1a2b3c: merged and deployed.'), true);
  const out = withNotes('Go on with part two.', [{ text: 'N1' }, { text: 'N2' }]);
  assert.equal(out, 'Go on with part two.\n\nN1\n\nN2');
  assert.equal(aiSenderOf(out, [{ sig: promptSig('Go on with part two.'), by: 'manager-agent' }]), 'manager-agent');
});

test('carried notes are claimed while typing, and come back when the send fails or stays unsubmitted', async (t) => {
  const n = createSessionNotes({ stateDir: tmp(t) });
  const msg = 'please carry on with part two';
  n.put('s', 'k', 'N');
  const during = [];
  await carryNotes(n, 's', msg, true, async (text) => { during.push(text, n.peek('s').length); return { submitted: false }; });
  assert.deepEqual(during, [`${msg}\n\nN`, 0]);   // a hook asking during the send gets nothing
  assert.deepEqual(n.peek('s').map((x) => x.text), ['N']);
  await assert.rejects(carryNotes(n, 's', msg, true, async () => { throw new Error('tmux gone'); }), /tmux gone/);
  assert.equal(n.peek('s').length, 1);
  await carryNotes(n, 's', msg, true, async () => { n.put('s', 'k', 'newer'); return { submitted: false }; });
  assert.deepEqual(n.peek('s').map((x) => x.text), ['newer']);
  await carryNotes(n, 's', msg, true, async () => ({ submitted: true }));
  assert.deepEqual(n.peek('s'), []);
  n.put('s', 'k', 'N');
  await carryNotes(n, 's', msg, false, async (text) => { assert.equal(text, msg); return {}; });
  assert.equal(n.peek('s').length, 1);
});

test('a hook flag left by a dead Claude process does not count once the pane runs another agent', () => {
  assert.equal(hookDelivers(true, 'claude'), true);
  assert.equal(hookDelivers(true, undefined), true);
  for (const agent of ['codex', 'minimax', 'other']) assert.equal(hookDelivers(true, agent), false, agent);
  assert.equal(hookDelivers(false, 'claude'), false);
});

test('reporter: a plugin that asked for notes is remembered (also over a restart), until its session ends', async (t) => {
  const dir = tmp(t);
  const r = createReporter({ stateDir: dir, saveMs: 1 });
  await r.init();
  assert.equal(r.takesNotes('s'), false);
  r.ingest({ v: 1, event: 'notes.take', session: 's', sessionId: 'x' });
  await r.flush();
  const again = createReporter({ stateDir: dir });
  await again.init();
  assert.equal(again.takesNotes('s'), true);
  again.ingest({ v: 1, event: 'session.end', session: 's', sessionId: 'x' });
  assert.equal(again.takesNotes('s'), false);
});

test('lease notes: pin downgrade and overlap only inform; a ticket grant and a yield need action now', () => {
  for (const kind of ['downgraded', 'pin-overlap', 'pin_overlap']) assert.equal(informsOnly({ kind }), true, kind);
  for (const kind of ['granted', 'yield', 'released']) assert.equal(informsOnly({ kind }), false, kind);
});
