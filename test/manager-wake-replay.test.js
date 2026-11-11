import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../scripts/manager-wake-replay.js';
import { pickCases, blindPairs, sheetMarkdown, scrub } from '../scripts/manager-model-replay.js';

const wk = (start, nothing) => ({ start, nothing, trigger: 'task_done' });
test('replay: a wake whose events are all dropped is removed; one that acted is reported lost', () => {
  const wakes = [wk('2026-01-01T00:10:00Z', true), wk('2026-01-01T00:20:00Z', false), wk('2026-01-01T00:30:00Z', true)];
  const events = [{ at: '2026-01-01T00:09:00Z', id: 'a' }, { at: '2026-01-01T00:19:00Z', id: 'b' }, { at: '2026-01-01T00:29:00Z', id: 'c' }];
  const r = replay({ wakes, events, baseKeys: new Set(['a', 'b', 'c']), candKeys: new Set(['c']) });
  assert.equal(r.removed.length, 2); assert.equal(r.lost.length, 1);
  assert.equal(r.noopBefore, 2); assert.equal(r.noopAfter, 1); assert.equal(r.after, 1);
});
test('replay: batching merges non-urgent wakes inside the window, never an urgent one', () => {
  const wakes = [wk('2026-01-01T00:10:00Z', true), wk('2026-01-01T00:12:00Z', true), wk('2026-01-01T00:13:00Z', true)];
  const events = [{ at: '2026-01-01T00:09:00Z', id: 'a' }, { at: '2026-01-01T00:11:00Z', id: 'b' }, { at: '2026-01-01T00:12:30Z', id: 'c' }];
  const k = new Set(['a', 'b', 'c']);
  assert.equal(replay({ wakes, events, baseKeys: k, candKeys: k, windowSec: 600 }).after, 1);
  assert.equal(replay({ wakes, events, baseKeys: k, candKeys: k, urgentKeys: new Set(['b']), windowSec: 600 }).after, 3);
});
test('model replay: cases need an acted wake with an event; blind pairs hide the model and keep a key; scrub masks ips', () => {
  const wakes = [{ start: '2026-01-01T00:10:00Z', nothing: false, trigger: 'task_done', decision: 'I told the session to rebase and filed the item.', triggerSummary: 'x' }, { start: '2026-01-01T00:20:00Z', nothing: true, trigger: 'task_done', decision: 'nothing happened at all here' }];
  const events = [{ at: '2026-01-01T00:09:00Z', kind: 'bug', title: 'a at 10.1.2.3', body: 'b' }];
  const cases = pickCases({ wakes, events });
  assert.equal(cases.length, 1); assert.ok(!/10\.1\.2\.3/.test(cases[0].input));
  const p = blindPairs([{ id: 'c1', input: 'i', sonnet: 'S', opus: 'O' }], 1);
  const md = sheetMarkdown(p);
  assert.ok(!/sonnet|opus/i.test(md.replace(/Sonnet vs Opus/, '')));
  assert.ok(['sonnet', 'opus'].includes(p[0].aIs)); assert.equal(scrub('ip 1.2.3.4'), 'ip <ip>');
});
