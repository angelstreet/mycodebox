import test from 'node:test';
import assert from 'node:assert/strict';
import { findUnanswered, stopSession, reminderText } from '../stop-answer.js';

const NOW = Date.parse('2026-11-13T09:00:00Z');
const ev = (o) => ({ at: '2026-11-13T08:00:00.000Z', ...o });
const stop = ev({ key: 'campaign-x:asks', kind: 'asks', session: 'campaign-x', title: 'campaign-x asks you' });
const mac = ev({ key: 'mac:TASK-208-foo:asks', kind: 'TASK-208-foo:asks', session: 'mac', title: 'mac:TASK-208-foo asks you' });

test('stopSession reads asks, needs-manager, mac keys and manager-item asks; not other events or handled ones', () => {
  assert.equal(stopSession(stop), 'campaign-x');
  assert.equal(stopSession(mac), 'mac:TASK-208-foo');
  assert.equal(stopSession(ev({ key: 'lease:1:manager-item', body: 'sess-y asks: lease ticket' })), 'sess-y');
  assert.equal(stopSession(ev({ key: 'disk', kind: 'disk' })), null);
  assert.equal(stopSession({ ...stop, handled: 'session' }), null);
});

test('an old stop with no send and no decision line is unanswered; a send or a decision line answers it', () => {
  assert.equal(findUnanswered({ events: [stop, mac], now: NOW }).length, 2);
  const sends = [{ type: 'send', by: 'manager-agent', session: 'campaign-x', at: '2026-11-13T08:05:00Z' }];
  const actions = [{ at: '2026-11-13T08:20:00Z', kind: 'decision', session: 'mac:TASK-208-foo', decision: 'x' }];
  assert.deepEqual(findUnanswered({ events: [stop, mac], sends, actions, now: NOW }), []);
});

test('a send by the owner, or before the stop, does not answer it', () => {
  const sends = [{ type: 'send', by: 'owner', session: 'campaign-x', at: '2026-11-13T08:05:00Z' }, { type: 'send', by: 'manager-agent', session: 'campaign-x', at: '2026-11-13T07:00:00Z' }];
  assert.equal(findUnanswered({ events: [stop], sends, now: NOW }).length, 1);
});

test('a stop inside the grace, one that is too old and an already reminded one are left alone', () => {
  assert.equal(findUnanswered({ events: [stop], now: Date.parse('2026-11-13T08:05:00Z') }).length, 0);
  assert.equal(findUnanswered({ events: [stop], now: Date.parse('2026-11-13T20:00:00Z') }).length, 0);
  const [u] = findUnanswered({ events: [stop], now: NOW });
  assert.equal(findUnanswered({ events: [stop], now: NOW, done: new Set([u.key]) }).length, 0);
});

test('the reminder names the sessions', () => {
  assert.match(reminderText(findUnanswered({ events: [stop], now: NOW })), /campaign-x/);
});
