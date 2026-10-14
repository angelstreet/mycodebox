// Hands-free loop, server side (voice.js): queue, spoken script, spoken-answer matching, the answer endpoint with a fake send,
// the digest, and the notification actions. No tmux, no network, no live state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceQueue, spokenScript, matchSpokenAnswer, needsConfirm, createVoice, digestText, feedActions, plainSpeech, normalizeSpeech, VOICE_BY } from '../voice.js';
import { createAlerts, tierConfig, createPush } from '../push.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const menuStop = (over = {}) => ({ state: 'waiting', lastActivitySec: 60, stall: { id: 'st1', case: 'menu_recommended', question: 'Which approach should I take for the parser?', options: [
  { n: 1, text: 'Keep the old parser', recommended: false, forbidden: null },
  { n: 2, text: 'Rewrite it with a state machine', recommended: true, forbidden: null },
  { n: 3, text: 'Drop the feature', recommended: false, forbidden: null }] }, ...over });
const yesnoStop = () => ({ state: 'done', lastActivitySec: 30, stall: { id: 'st2', case: 'owner_decision', escalated: true, question: 'Shall I continue with the refactor?' } });
const queueOf = (status, extra = {}) => voiceQueue({ status, managerSessions: ['manager'], ...extra });
const item = (s = menuStop()) => queueOf({ alpha: s })[0];
const yn = () => queueOf({ beta: yesnoStop() })[0];

test('voiceQueue: stops that need the owner, with buttons-derived answers', () => {
  const q = queueOf({ alpha: menuStop(), beta: yesnoStop() });
  assert.equal(q.length, 2);
  const a = q.find((i) => i.session === 'alpha');
  assert.equal(a.id, 'stop:alpha:st1');
  assert.deepEqual(a.options.map((o) => [o.n, o.recommended, o.answer]), [[1, false, { key: '1' }], [2, true, { key: '2' }], [3, false, { key: '3' }]]);
  const b = q.find((i) => i.session === 'beta');
  assert.deepEqual(b.options.map((o) => o.answer), [{ text: 'yes' }, { text: 'no' }]);
});

test('voiceQueue: skips the manager session, paused sessions, pending auto answers, working sessions and plain done', () => {
  const status = {
    manager: menuStop(), paused: menuStop({ stall: { ...menuStop().stall, id: 'p' } }), auto: menuStop({ auto: { id: 'x', sendAt: 1 } }),
    busy: menuStop({ state: 'working' }), plain: { state: 'done', stall: { id: 'd', case: 'done', question: 'All done. Tests pass.' } },
    bg: { state: 'idle', stall: { id: 'b', case: 'background_wait', question: 'waiting?' } }, ok: menuStop(),
  };
  const q = queueOf(status, { isPaused: (n) => n === 'paused' });
  assert.deepEqual(q.map((i) => i.session), ['ok']);
});

test('voiceQueue: P0 first, then oldest; ledger asks are items with the manager as target', () => {
  const status = { newer: menuStop({ lastActivitySec: 5, stall: { ...menuStop().stall, id: 'n' } }), older: menuStop({ lastActivitySec: 500, stall: { ...menuStop().stall, id: 'o' } }), urgent: menuStop({ lastActivitySec: 1, stall: { ...menuStop().stall, id: 'u' } }) };
  const q = queueOf(status, { priority: (s) => (s === 'urgent' ? 'P0' : 'P2'), ownerAsks: [{ id: 'Q12', session: 'alpha', question: 'Pick a colour', options: ['red', 'blue'], recommendation: '2', at: '2026-01-14T10:00:00Z' }] });
  assert.equal(q[0].session, 'urgent');
  assert.deepEqual(q.slice(1).map((i) => i.id), ['ask:Q12', 'stop:older:o', 'stop:newer:n']);   // the ledger ask dates from earlier today
  const ask = q.find((i) => i.kind === 'ask');
  assert.deepEqual(ask.options[1].answer, { text: 'Answer: Q12 2', to: 'manager' });
  assert.equal(ask.options[1].recommended, true);
});

test('spokenScript: the documented wording, options in order, at most 6, trimmed', () => {
  const s = spokenScript(item());
  assert.match(s, /^alpha needs you\. Which approach should I take for the parser\? Option 1: Keep the old parser\. Option 2: Rewrite it with a state machine, recommended\. Option 3: Drop the feature\. Say a number, recommended, yes, no, wait, skip, or repeat\.$/);
  const many = { session: 's', question: 'q?', options: Array.from({ length: 9 }, (_, i) => ({ n: i + 1, label: `opt ${i + 1}` })) };
  assert.equal((spokenScript(many).match(/Option \d/g) || []).length, 6);
  const long = spokenScript({ session: 's', question: `${'word '.repeat(200)}?`, options: [{ n: 1, label: 'x'.repeat(200) }] });
  assert.ok(long.length < 520, `trimmed (${long.length})`);
  assert.match(long, /…/);
});

test('plainSpeech: no markdown, urls or path noise', () => {
  assert.equal(plainSpeech('Edit `/home/x/src/foo.js` **now**, see https://example.test/a?b=1 and yes/no'), 'Edit foo.js now, see a link and yes/no');
  assert.equal(normalizeSpeech('  Option 2!! '), 'option 2');
});

// ---- the matching table ----
const label = (m) => (m.type === 'choice' ? `choice:${m.option.n}` : m.type === 'intent' ? `intent:${m.intent}` : 'none');
const TABLE = [
  // digits and words
  ['2', 'choice:2'], ['Two.', 'choice:2'], ['option two', 'choice:2'], ['Option 2.', 'choice:2'], ['number 2', 'choice:2'], ['Number two, please.', 'choice:2'],
  ['the second', 'choice:2'], ['the second one', 'choice:2'], ['second one.', 'choice:2'], ['The first.', 'choice:1'], ['first one', 'choice:1'], ['one', 'choice:1'],
  ['Option one.', 'choice:1'], ['three', 'choice:3'], ['the third one', 'choice:3'], ['I pick number three', 'choice:3'], ['Go with option 3', 'choice:3'], ['2nd', 'choice:2'],
  // recommended
  ['recommended', 'choice:2'], ['Recommended.', 'choice:2'], ['go with the recommendation', 'choice:2'], ['Your recommendation.', 'choice:2'], ['the recommended one, please', 'choice:2'], ['Do the recommended option', 'choice:2'],
  ['not the recommended one', 'none'],
  // ambiguous / out of range / noise
  ['one or two', 'none'], ['one two', 'none'], ['the first or the second', 'none'], ['five', 'none'], ['banana', 'none'], ['', 'none'], ['...', 'none'], ['Thank you.', 'none'], ['you', 'none'],
  // intents
  ['skip', 'intent:skip'], ['Skip it.', 'intent:skip'], ['next', 'intent:next'], ['Next one.', 'intent:next'], ['repeat', 'intent:repeat'], ['Repeat that.', 'intent:repeat'], ['say that again', 'intent:repeat'],
  ['wait', 'intent:wait'], ['Wait.', 'intent:wait'], ['hold on', 'intent:wait'], ['stop', 'intent:stop'], ['Stop listening.', 'intent:stop'],
  ['what happened', 'intent:digest'], ['What happened?', 'intent:digest'], ['digest', 'intent:digest'], ['give me a summary', 'intent:digest'], ['catch me up', 'intent:digest'],
  ['confirm', 'intent:confirm'], ['Confirm.', 'intent:confirm'], ['cancel', 'intent:cancel'], ['Never mind.', 'intent:cancel'],
  // yes / no on a menu: not an option
  ['yes', 'none'], ['no', 'none'],
];
test(`matchSpokenAnswer on a menu with a recommended option (${TABLE.length} phrasings)`, () => {
  assert.ok(TABLE.length >= 30);
  const it = item();
  for (const [said, want] of TABLE) assert.equal(label(matchSpokenAnswer(said, it)), want, JSON.stringify(said));
});

test('matchSpokenAnswer: yes / no on a yes-no item, with whisper punctuation', () => {
  const it = yn();
  const yes = ['yes', 'Yes.', 'Yeah!', 'yep', 'Sure.', 'okay', 'go ahead', 'Yes, please.', 'do it'], no = ['no', 'No.', 'Nope.', 'nah', 'no thanks'];
  for (const s of yes) assert.equal(label(matchSpokenAnswer(s, it)), 'choice:1', s);
  for (const s of no) assert.equal(label(matchSpokenAnswer(s, it)), 'choice:2', s);
  assert.equal(label(matchSpokenAnswer('yes no', it)), 'none');
  assert.equal(label(matchSpokenAnswer('one', it)), 'choice:1');
  assert.equal(label(matchSpokenAnswer('recommended', it)), 'none', 'no recommended option here');
  assert.equal(label(matchSpokenAnswer('wait', it)), 'intent:wait', 'no wait option on a yes-no stop: an intent');
});

test('matchSpokenAnswer: an open question has Yes continue / No wait; "wait" picks the wait answer', () => {
  const it = queueOf({ gamma: { state: 'done', stall: { id: 'o1', case: 'owner_decision', escalated: true, question: 'Tell me what to do next.' } } })[0];
  assert.deepEqual(it.options.map((o) => o.id), ['continue', 'wait']);
  const w = matchSpokenAnswer('Wait.', it);
  assert.equal(w.type, 'choice'); assert.equal(w.option.id, 'wait');
  assert.equal(matchSpokenAnswer('yes', it).option.id, 'continue');
  assert.equal(matchSpokenAnswer('no', it).option.id, 'wait');
});

test('needsConfirm: a sensitive option needs a spoken confirm', () => {
  const q = queueOf({ alpha: menuStop({ stall: { id: 'f', case: 'menu_recommended', question: 'What now?', options: [
    { n: 1, text: 'Deploy to production', recommended: false, forbidden: 'deploy' }, { n: 2, text: 'Keep working', recommended: true, forbidden: null }] } }) })[0];
  assert.equal(needsConfirm(q.options[0]), true);
  assert.equal(needsConfirm(q.options[1]), false);
  assert.equal(needsConfirm({ label: 'Delete the branch', answer: { text: 'x' } }), true);
  assert.equal(needsConfirm({ label: 'Keep going', answer: { text: 'yes' } }), false);
});

// ---- the answer endpoint ----
function rig({ status, asks = [], managers = ['manager'] } = {}) {
  const sent = [], chosen = [];
  const st = { status };
  const v = createVoice({
    status: async () => st.status, ownerAsks: async () => asks, managerSessions: () => managers,
    send: async (x) => { sent.push(x); return { ok: true }; }, logChoice: async (r) => { chosen.push(r); },
    digestSources: async () => ({ history: [], stalls: [], decided: null, deploys: [], quota: null }),
  });
  return { v, sent, chosen, st };
}
const post = (v, body) => v.route({ method: 'POST', path: '/api/voice/answer', readBody: async () => body });

test('answer: a spoken number sends the menu key as owner-voice and logs the choice', async () => {
  const { v, sent, chosen } = rig({ status: { alpha: menuStop() } });
  const r = await post(v, { id: 'stop:alpha:st1', transcript: 'Option two.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'sent');
  assert.equal(r.body.say, 'Sent Rewrite it with a state machine to alpha.');
  assert.deepEqual(sent, [{ session: 'alpha', answer: { key: '2' }, by: VOICE_BY }]);
  assert.equal(VOICE_BY, 'owner-voice');
  assert.deepEqual(chosen.map((c) => [c.id, c.session, c.owner]), [['st1', 'alpha', 'o2']]);
});

test('answer: a yes-no stop sends the text', async () => {
  const { v, sent } = rig({ status: { beta: yesnoStop() } });
  const r = await post(v, { id: 'stop:beta:st2', transcript: 'Yes.' });
  assert.equal(r.body.status, 'sent');
  assert.deepEqual(sent[0].answer, { text: 'yes' });
});

test('answer: a sensitive option asks for "confirm" first; confirm sends, cancel does not', async () => {
  const status = { alpha: menuStop({ stall: { id: 'f', case: 'menu_recommended', question: 'What now?', options: [
    { n: 1, text: 'Deploy to production', recommended: false, forbidden: 'deploy' }, { n: 2, text: 'Keep working', recommended: true, forbidden: null }] } }) };
  const { v, sent } = rig({ status });
  const r1 = await post(v, { id: 'stop:alpha:f', transcript: 'one' });
  assert.equal(r1.body.status, 'confirm');
  assert.match(r1.body.say, /^You chose Deploy to production for alpha\. That touches .+\. Say confirm to send, or cancel\.$/);
  assert.equal(sent.length, 0);
  const r2 = await post(v, { id: 'stop:alpha:f', transcript: 'Confirm.', pending: r1.body.option });
  assert.equal(r2.body.status, 'sent');
  assert.deepEqual(sent.map((s) => s.answer), [{ key: '1' }]);
  const r3 = await post(v, { id: 'stop:alpha:f', transcript: 'cancel', pending: 1 });
  assert.equal(r3.body.intent, 'cancel');
  assert.equal(sent.length, 1);
  const r4 = await post(v, { id: 'stop:alpha:f', transcript: 'confirm' });   // nothing pending
  assert.match(r4.body.say, /nothing to confirm/i);
  assert.equal(sent.length, 1);
});

test('answer: a notification never answers a sensitive option; it opens the app', async () => {
  const status = { alpha: menuStop({ stall: { id: 'f', case: 'menu_recommended', question: 'What now?', options: [
    { n: 1, text: 'Deploy to production', recommended: true, forbidden: 'deploy' }, { n: 2, text: 'Keep working', recommended: false, forbidden: null }] } }) };
  const { v, sent } = rig({ status });
  const r = await post(v, { id: 'stop:alpha:f', option: 'recommended', via: 'notification' });
  assert.equal(r.body.status, 'open');
  assert.equal(sent.length, 0);
});

test('answer: notification actions "recommended" and a safe option are sent', async () => {
  const { v, sent } = rig({ status: { alpha: menuStop() } });
  const r = await post(v, { id: 'stop:alpha:st1', option: 'recommended', via: 'notification' });
  assert.equal(r.body.status, 'sent');
  assert.deepEqual(sent[0].answer, { key: '2' });
  const none = await post(v, { id: 'stop:alpha:st1', option: 'wait', via: 'notification' });   // no wait option on a live menu
  assert.equal(none.body.status, 'again');
  assert.equal(sent.length, 1);
});

test('answer: nothing understood -> "again" with the short options, nothing sent', async () => {
  const { v, sent } = rig({ status: { alpha: menuStop() } });
  const r = await post(v, { id: 'stop:alpha:st1', transcript: 'banana split' });
  assert.equal(r.body.status, 'again');
  assert.match(r.body.say, /^Sorry, I did not get that\. Option 1: Keep the old parser\. Option 2:/);
  assert.equal(sent.length, 0);
});

test('answer: intents come back as intents (skip, repeat, wait, stop, digest)', async () => {
  const { v, sent } = rig({ status: { alpha: menuStop() } });
  for (const [said, intent] of [['skip', 'skip'], ['repeat', 'repeat'], ['wait', 'wait'], ['stop', 'stop'], ['what happened', 'digest'], ['next', 'next']]) {
    const r = await post(v, { id: 'stop:alpha:st1', transcript: said });
    assert.equal(r.body.status, 'intent', said); assert.equal(r.body.intent, intent, said);
  }
  assert.equal(sent.length, 0);
});

test('answer: a stale item (the stop changed or went away) is a 409 and nothing is sent', async () => {
  const { v, sent, st } = rig({ status: { alpha: menuStop() } });
  st.status = { alpha: menuStop({ stall: { ...menuStop().stall, id: 'st-NEW' } }) };   // a new stop on the same session
  const r = await post(v, { id: 'stop:alpha:st1', transcript: 'two' });
  assert.equal(r.status, 409); assert.equal(r.body.status, 'stale');
  st.status = {};
  assert.equal((await post(v, { id: 'stop:alpha:st-NEW', transcript: 'two' })).status, 409);
  assert.equal(sent.length, 0);
});

test('answer: a draft in the input box is never overwritten', async () => {
  const base = menuStop();
  const { v, sent } = rig({ status: { alpha: { ...base, stall: { ...base.stall, draft: true } } } });
  const r = await post(v, { id: 'stop:alpha:st1', transcript: 'two' });
  assert.equal(r.status, 409); assert.equal(r.body.status, 'draft');
  assert.match(r.body.say, /draft/);
  assert.equal(sent.length, 0);
});

test('answer: a ledger ask goes to the manager session as "Answer: Q12 2"', async () => {
  const { v, sent, chosen } = rig({ status: {}, asks: [{ id: 'Q12', session: 'alpha', question: 'Pick a colour', options: ['red', 'blue'], recommendation: 'blue' }] });
  const r = await post(v, { id: 'ask:Q12', transcript: 'recommended' });
  assert.equal(r.body.status, 'sent');
  assert.deepEqual(sent, [{ session: 'manager', answer: { text: 'Answer: Q12 2' }, by: 'owner-voice' }]);
  assert.equal(r.body.say, 'Sent blue to alpha.');
  assert.equal(chosen[0].id, 'Q12');
});

test('answer: bad request and a failing send', async () => {
  const { v } = rig({ status: { alpha: menuStop() } });
  assert.equal((await post(v, {})).status, 400);
  const bad = createVoice({ status: async () => ({ alpha: menuStop() }), ownerAsks: async () => [], managerSessions: () => [], send: async () => { throw Object.assign(new Error('not an agent pane'), { status: 409 }); }, digestSources: async () => ({}) });
  const r = await post(bad, { id: 'stop:alpha:st1', transcript: '2' });
  assert.equal(r.status, 409); assert.equal(r.body.status, 'error');
  assert.equal((await v.route({ method: 'GET', path: '/api/voice/nope', readBody: async () => ({}) })).status, 404);
  assert.equal(await v.route({ method: 'GET', path: '/api/other', readBody: async () => ({}) }), null);
});

test('GET /api/voice/queue returns the items', async () => {
  const { v } = rig({ status: { alpha: menuStop() } });
  const r = await v.route({ method: 'GET', path: '/api/voice/queue', query: new URLSearchParams(), readBody: async () => ({}) });
  assert.equal(r.body.items.length, 1);
  assert.match(r.body.items[0].script, /^alpha needs you\./);
});

// ---- the digest ----
const NOW = Date.parse('2026-10-14T12:00:00Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();
const DATA = {
  now: NOW, minutes: 60, queue: [{ session: 'alpha' }, { session: 'beta' }],
  stalls: [{ type: 'stall', case: 'done', session: 'gamma', at: iso(10), question: 'STATUS: done - merged the parser fix, 12 tests pass' },
    { type: 'stall', case: 'done', session: 'old', at: iso(300), question: 'too old' }, { type: 'stall', case: 'menu_recommended', session: 'x', at: iso(5) },
    { type: 'answer', session: 'gamma', at: iso(8) }, { type: 'answer', session: 'gamma', at: iso(7) }, { type: 'answer', session: 'gamma', at: iso(400) }],
  history: [{ name: 'delta', start: NOW - 20 * 60000, end: null }, { name: 'eps', start: NOW - 5 * 3600000, end: NOW - 15 * 60000 }],
  deploys: [{ id: 'd1', env: 'staging', state: 'done', finished: NOW - 30 * 60000 }, { id: 'd2', env: 'prod', state: 'failed', finished: NOW - 3 * 60000 }, { id: 'd3', env: 'x', state: 'done', finished: NOW - 9 * 3600000 }],
  quota: { plans: [{ plan: 'claude', windows: [{ name: 'weekly', usedPercent: 87.4 }, { name: '5h', usedPercent: 10 }] }] },
};
test('digestText without the decided endpoint: builds "N answers typed for you" from answer records', () => {
  const d = digestText({ ...DATA, decided: null });
  assert.ok(d.text.length <= 900);
  assert.match(d.text, /2 items need you: alpha, beta\./);
  assert.match(d.text, /1 session finished a turn\. gamma: done, merged the parser fix, 12 tests pass/);
  assert.match(d.text, /1 session started: delta\./);
  assert.match(d.text, /1 session ended: eps\./);
  assert.match(d.text, /2 answers typed for you\./);
  assert.match(d.text, /1 deploy failed: prod\./);
  assert.match(d.text, /1 deploy finished: staging\./);
  assert.match(d.text, /Claude weekly quota is at 87 percent\.|claude weekly quota is at 87 percent/i);
  assert.doesNotMatch(d.text, /too old|[*#`]|\/home/);
  assert.ok(d.parts.length >= 6);
});
test('digestText with the decided endpoint: its summary text wins over the fallback', () => {
  const d = digestText({ ...DATA, decided: { items: [], summary: { count: 3, byKind: { answer: 3 }, text: '3 decisions made for you: 3 answers.' } } });
  assert.match(d.text, /3 decisions made for you: 3 answers\./);
  assert.doesNotMatch(d.text, /typed for you/);
});
test('digestText: quiet hour, and the 900 character cap', () => {
  assert.equal(digestText({ now: NOW, queue: [] }).text, 'Nothing needs you right now.');
  const hist = Array.from({ length: 40 }, (_, i) => ({ name: `session-with-a-long-name-${i}`, start: NOW - 60000 }));
  const stalls = Array.from({ length: 40 }, (_, i) => ({ type: 'stall', case: 'done', session: `s${i}`, at: iso(5), question: 'finished a very long piece of work '.repeat(5) }));
  const d = digestText({ now: NOW, queue: Array.from({ length: 30 }, (_, i) => ({ session: `needy-${i}` })), history: hist, stalls });
  assert.ok(d.text.length <= 900, `${d.text.length}`);
});
test('GET /api/voice/digest passes the window to the sources', async () => {
  let seen = null;
  const v = createVoice({ status: async () => ({}), ownerAsks: async () => [], managerSessions: () => [], send: async () => ({}), now: () => NOW,
    digestSources: async (a) => { seen = a; return { history: [], stalls: [], decided: null, deploys: [], quota: null }; } });
  const r = await v.route({ method: 'GET', path: '/api/voice/digest', query: new URLSearchParams('minutes=30'), readBody: async () => ({}) });
  assert.equal(seen.minutes, 30); assert.equal(seen.since, NOW - 30 * 60000);
  assert.equal(r.body.text, 'Nothing needs you right now.');
});

// ---- notification actions on the push feed ----
test('feedActions: only for a recommended option that is not forbidden', () => {
  assert.deepEqual(feedActions(item()), [{ action: 'recommended', title: 'Do recommended' }]);
  assert.equal(feedActions(yn()), null, 'no recommended option');
  const forb = queueOf({ a: menuStop({ stall: { id: 'f', case: 'menu_recommended', question: 'What now?', options: [{ n: 1, text: 'Push to main', recommended: true, forbidden: 'push' }, { n: 2, text: 'Wait here', recommended: false, forbidden: null }] } }) })[0];
  assert.equal(feedActions(forb), null, 'forbidden recommended option');
  const topic = queueOf({ a: menuStop({ stall: { ...menuStop().stall, id: 't', forbidden: 'money' } }) })[0];
  assert.equal(feedActions(topic), null, 'forbidden topic');
  const open = queueOf({ g: { state: 'done', stall: { id: 'o', case: 'owner_decision', escalated: true, question: 'Tell me what to do next.' } } })[0];
  assert.equal(feedActions(open), null, 'open question has no recommended option');
  const withWait = { kind: 'stop', options: [{ n: 1, id: 'ai', label: 'x', recommended: true, answer: { text: 'x' } }, { n: 2, id: 'wait', label: 'No - wait for me', answer: { text: 'w' } }] };
  assert.deepEqual(feedActions(withWait).map((a) => a.action), ['recommended', 'wait']);
});

test('push feed items carry voiceId and actions only when given (interrupt tier and a one-item digest)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-push-'));
  const push = createPush({ stateDir: dir });
  const sent = [];
  const real = push.notify;
  push.notify = async (i) => { sent.push(i); return real.call(push, i); };
  const clock = { t: Date.parse('2026-10-05T12:00:00Z') };
  const a = createAlerts({ push, now: () => clock.t, log: { error() {} }, tiering: { config: () => tierConfig({}), managerSessions: () => [] } });
  a.alert('s1:asks', { title: 's1 asks you', body: 'P0 blocked on prod', voiceId: 'stop:s1:x', actions: [{ action: 'recommended', title: 'Do recommended' }] });
  a.alert('s2:asks', { title: 's2 asks you', body: 'P0 blocked again' });
  assert.equal(sent[0].voiceId, 'stop:s1:x'); assert.equal(sent[0].actions[0].action, 'recommended');
  assert.equal('voiceId' in sent[1], false); assert.equal('actions' in sent[1], false);
  const feed = push.feedSince(0);
  assert.equal(feed[0].voiceId, 'stop:s1:x'); assert.equal(feed[0].actions.length, 1);
  assert.equal('actions' in feed[1], false);
  // digest tier: one pending stop keeps its buttons, two do not
  a.alert('s3:asks', { title: 's3 asks you', body: 'which colour?', meta: { session: 's3' }, voiceId: 'stop:s3:y', actions: [{ action: 'recommended', title: 'Do recommended' }] });
  clock.t += 31 * 60000;
  a.digestTick();
  assert.equal(sent.at(-1).voiceId, 'stop:s3:y');
});
