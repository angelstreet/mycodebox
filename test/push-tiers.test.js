// TASK-58 C7: two-tier push (interrupt now, digest per 30 min while awake, nothing in quiet hours, manager never pushes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlerts, defaultTier, digestLine, isQuietHours, tierConfig, localMinutes } from '../push.js';
import { createQuotaAlerts } from '../quota.js';

const quiet = { error() {} };
const utc = (iso) => Date.parse(iso);
// 2026-10-05 is CEST (UTC+2): 12:00Z = 14:00 Zurich, 21:30Z = 23:30 Zurich, 05:30Z = 07:30 Zurich, 04:00Z = 06:00 Zurich.
const NOON = utc('2026-10-05T12:00:00Z');

function rig({ at = NOON, managers = ['manager'], cfg = {} } = {}) {
  const clock = { t: at };
  const sent = [];
  const push = { notify: async (i) => { sent.push(i); return {}; } };
  const a = createAlerts({ push, now: () => clock.t, log: quiet, tiering: { config: () => tierConfig(cfg), managerSessions: () => managers } });
  return { ...a, clock, sent };
}

test('tier routing: interrupt list vs digest', () => {
  assert.equal(defaultTier('disk:/', { priority: 'urgent' }), 'interrupt');
  assert.equal(defaultTier('deploy:d1:failed', {}), 'interrupt');
  assert.equal(defaultTier('deploy:d1:orphan', {}), 'interrupt');
  assert.equal(defaultTier('deploy:d1:approve', {}), 'interrupt');
  assert.equal(defaultTier('deploy:d1:done', {}), 'digest');
  assert.equal(defaultTier('deploy:d1:start', {}), 'digest');
  assert.equal(defaultTier('quota:claude:5h', { pct: 96 }), 'interrupt');
  assert.equal(defaultTier('quota:claude:5h', { pct: 85 }), 'digest');
  assert.equal(defaultTier('s1:asks', { body: 'which colour?' }), 'digest');
  assert.equal(defaultTier('s1:asks', { body: 'P0 blocked on prod' }), 'interrupt');
  assert.equal(defaultTier('s1:waiting', { body: 'needs the API key credentials' }), 'interrupt');
  assert.equal(defaultTier('s1:waiting', { body: 'customer Sunrise wants this' }), 'interrupt');
  assert.equal(defaultTier('s1:hold', {}), 'digest');
  assert.equal(defaultTier('s1:done', {}), 'digest');
  assert.equal(defaultTier('manager-agent:x', { priority: 'high' }), 'digest');
  assert.equal(defaultTier('s1:done', { tier: 'interrupt' }), 'interrupt');
});

test('interrupt pushes at once, digest items are held; per-key debounce still applies to interrupts', () => {
  const r = rig();
  assert.equal(r.alert('disk:/', { title: 'disk', priority: 'urgent' }), true);
  assert.equal(r.alert('disk:/', { title: 'disk', priority: 'urgent' }), false);
  assert.equal(r.sent.length, 1);
  assert.equal(r.alert('s1:asks', { title: 's1 asks you', body: 'which colour?' }), true);
  assert.equal(r.sent.length, 1);
  assert.equal(r.pendingDigest().length, 1);
});

test('digest batching: one push for all items, one line each, after the interval; then the clock restarts', () => {
  const r = rig();
  r.alert('s1:asks', { title: 'a', body: 'which colour?\nmore', meta: { session: 's1', case: 'owner_decision', question: 'which colour?', answer: 'blue' } });
  r.alert('s2:waiting', { title: 'b', body: 'ok to delete?' });
  assert.equal(r.digestTick(), true);          // first digest: nothing sent before, interval satisfied
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].title, '2 items for you');
  const lines = r.sent[0].body.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 's1 · owner_decision · which colour? · blue');
  assert.equal(lines[1], 's2 · waiting · ok to delete? · -');
  assert.equal(r.sent[0].url, '/');
  assert.equal(r.pendingDigest().length, 0);
  // new item inside 30 min: held
  r.clock.t += 10 * 60000;
  r.alert('s3:asks', { title: 'c', body: 'q' });
  assert.equal(r.digestTick(), false);
  r.clock.t += 20 * 60000;
  assert.equal(r.digestTick(), true);
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].title, '1 item for you');
  assert.equal(r.digestTick(), false);         // nothing pending: no empty push
});

test('same key twice in a digest keeps one line (newest)', () => {
  const r = rig();
  r.alert('s1:asks', { title: 'a', body: 'old' }, 0);
  r.alert('s1:asks', { title: 'a', body: 'new' }, 0);
  assert.equal(r.pendingDigest().length, 1);
  assert.equal(r.pendingDigest()[0].body, 'new');
});

test('quiet hours (Europe/Zurich, not the box UTC clock): nothing sent, held until 07:00 local', () => {
  assert.equal(localMinutes(utc('2026-10-05T12:00:00Z'), 'Europe/Zurich'), 14 * 60);
  assert.equal(isQuietHours(utc('2026-10-05T21:30:00Z'), tierConfig()), true);    // 23:30 local
  assert.equal(isQuietHours(utc('2026-10-05T04:00:00Z'), tierConfig()), true);    // 06:00 local
  assert.equal(isQuietHours(utc('2026-10-05T05:00:00Z'), tierConfig()), false);   // 07:00 local
  assert.equal(isQuietHours(utc('2026-10-05T20:59:00Z'), tierConfig()), false);   // 22:59 local
  assert.equal(isQuietHours(utc('2026-10-05T21:00:00Z'), tierConfig()), true);    // 23:00 local
  const r = rig({ at: utc('2026-10-05T21:30:00Z') });
  r.alert('s1:asks', { title: 'a', body: 'q' });
  assert.equal(r.digestTick(), false);
  r.clock.t = utc('2026-10-06T02:00:00Z');                                         // 04:00 local
  assert.equal(r.digestTick(), false);
  assert.equal(r.sent.length, 0);
  r.clock.t = utc('2026-10-06T05:00:00Z');                                         // 07:00 local
  assert.equal(r.digestTick(), true);
  assert.equal(r.sent.length, 1);
});

test('interrupts are not held in quiet hours', () => {
  const r = rig({ at: utc('2026-10-05T23:00:00Z') });
  r.alert('deploy:d1:failed', { title: 'deploy failed', priority: 'high' });
  assert.equal(r.sent.length, 1);
});

test('manager session events never push, never queue, never reach onFired', () => {
  const fired = [];
  const sent = [];
  const a = createAlerts({ push: { notify: async (i) => { sent.push(i); } }, log: quiet, onFired: (e) => fired.push(e),
    tiering: { config: () => tierConfig(), managerSessions: () => ['manager'] } });
  assert.equal(a.alert('manager:asks', { title: 'x', priority: 'urgent' }), false);
  assert.equal(a.alert('manager:done', { title: 'x' }), false);
  assert.equal(a.pendingDigest().length, 0);
  assert.equal(sent.length, 0);
  assert.equal(fired.length, 0);
  assert.equal(a.alert('s1:asks', { title: 'x' }), true);
  assert.equal(fired.length, 1);   // digest items still reach the manager event feed when queued
});

test('config knobs: digest interval, awake window, timezone', () => {
  const r = rig({ cfg: { pushDigestMinutes: 5, pushAwakeFrom: '09:00', pushAwakeTo: '10:00', pushTimezone: 'UTC' }, at: utc('2026-10-05T09:30:00Z') });
  r.alert('s1:asks', { title: 'a', body: 'q' });
  assert.equal(r.digestTick(), true);
  r.clock.t = utc('2026-10-05T11:00:00Z');
  r.alert('s2:asks', { title: 'a', body: 'q' });
  assert.equal(r.digestTick(), false);
  assert.equal(tierConfig({ pushDigestMinutes: 'x' }).digestMinutes, 30);
});

test('digestLine fallbacks', () => {
  assert.equal(digestLine({ key: 's9:hold', title: 'held', body: 'quota' }), 's9 · hold · quota · -');
});

test('quota: 80 % is digest, a later crossing of 95 % is a second, interrupt-tier alert', () => {
  const calls = [];
  const q = createQuotaAlerts((key, opts) => calls.push({ key, pct: opts.pct }));
  const plan = (pct) => [{ plan: 'claude', label: 'Claude', windows: [{ name: '5h', usedPercent: pct }] }];
  q.check(plan(10));
  q.check(plan(82));
  q.check(plan(96));
  q.check(plan(97));
  assert.deepEqual(calls.map((c) => c.key), ['quota:claude:5h', 'quota:claude:5h:crit']);
  assert.equal(defaultTier(calls[0].key, { pct: calls[0].pct }), 'digest');
  assert.equal(defaultTier(calls[1].key, { pct: calls[1].pct }), 'interrupt');
});
