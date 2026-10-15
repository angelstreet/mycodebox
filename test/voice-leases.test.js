import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSpokenAnswer, leaseSpeech, digestText, createVoice } from '../voice.js';
import { summarize } from '../lease-source.js';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const view = (o = {}) => ({ ok: true, leases: [
  { mode: 'exclusive', idleMin: 2 }, { mode: 'exclusive', idleMin: 3 }, { mode: 'exclusive', idleMin: 1 },
], tickets: [{ env: 'env-a', resources: ['frontend'], position: 1, etaMs: NOW + 120000 }], ...o });

test('leaseSpeech: counts, queue head with ETA, idle holds, one sentence', () => {
  assert.equal(leaseSpeech(summarize(view(), NOW)), '3 leases held; the frontend queue has 1 waiting, ETA 2 minutes; no lease is idle.');
  assert.equal(leaseSpeech(summarize(view({ leases: [{ mode: 'exclusive', idleMin: 15 }], tickets: [] }), NOW)), '1 lease held; 1 lease looks idle.');
  assert.equal(leaseSpeech(summarize({ ok: true, leases: [], tickets: [] }, NOW)), 'No leases are held and nobody is waiting.');
  assert.equal(leaseSpeech(summarize({ ok: false }, NOW)), 'I cannot read the leases right now.');
  assert.match(leaseSpeech(summarize(view({ tickets: [{ env: 'e', resources: ['host-1/device2'], etaMs: NOW + 10000 }, { env: 'e', resources: ['frontend'], etaMs: null }] }), NOW)), /device2 queue has 1 waiting, ETA under a minute, 1 more elsewhere/);
});
test('the digest carries the lease line only when something is held or queued', () => {
  const d = digestText({ now: NOW, leases: summarize(view(), NOW) });
  assert.match(d.text, /3 leases held; the frontend queue has 1 waiting/);
  assert.doesNotMatch(digestText({ now: NOW, leases: summarize({ ok: true, leases: [], tickets: [] }, NOW) }).text, /lease/i);
  assert.doesNotMatch(digestText({ now: NOW }).text, /lease/i);
});
test('spoken intents: leases / who holds', () => {
  for (const t of ['leases', 'The leases.', 'Who holds?', 'who holds it', 'Who holds the lease', 'any leases', 'lease status', 'what leases are held', 'Are there any leases?', 'who holds what']) {
    assert.deepEqual(matchSpokenAnswer(t, { options: [] }), { type: 'intent', intent: 'leases' }, t);
  }
  assert.notEqual(matchSpokenAnswer('release the lease', { options: [] }).intent, 'leases');
  assert.notEqual(matchSpokenAnswer('yes', { options: [] }).intent, 'leases');
});
test('voice answer with the leases intent speaks the lease sentence from the lease source', async () => {
  const v = createVoice({
    now: () => NOW, status: async () => ({ s1: { state: 'waiting', lastActivitySec: 60, stall: { id: 'st1', case: 'menu_recommended', question: 'Which approach should I take for the parser?', options: [{ n: 1, text: 'A' }, { n: 2, text: 'B' }] } } }),
    ownerAsks: async () => [], managerSessions: () => [], send: async () => {}, digestSources: async () => ({}), leaseView: async () => view(),
  });
  const q = await v.queue();
  const r = await v.answer({ id: q[0].id, transcript: 'who holds' });
  assert.equal(r.body.status, 'intent'); assert.equal(r.body.intent, 'leases'); assert.match(r.body.say, /3 leases held/);
  const off = createVoice({ now: () => NOW, status: async () => ({}), ownerAsks: async () => [], managerSessions: () => [], send: async () => {}, digestSources: async () => ({}) });
  assert.match((await off.digest()).text, /./);
});
