import test from 'node:test';
import assert from 'node:assert/strict';
import { viewHtml, leaseRowHtml, ticketRowHtml, groupByEnv, pinsOverridden, tap, actionRequest, fmtMin, fmtEta, shadowHtml, esc } from '../public/leases-view.js';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const ex = { id: 'L1', env: 'env-a', resources: ['frontend'], mode: 'exclusive', agent: 'codebox:dev1', holderSession: 'dev1', purpose: 'ui <b>', sinceMs: NOW - 22 * 60000, ttlLeftMin: 98, lastHeartbeatMs: NOW - 120000, idleMin: 12 };
const pin = { id: 'L2', env: 'env-a', resources: ['frontend'], mode: 'pin', agent: 'mac:x', ttlLeftMin: 30 };
const data = (o = {}) => ({ ok: true, authority: 'central', leases: [ex, pin], tickets: [{ id: 'T1', env: 'env-a', resources: ['frontend'], agent: 'codebox:dev2', position: 1, etaMs: NOW + 120000, holders: ['codebox:dev1'] }], deploys: [{ id: 'd1', env: 'env-a', scope: 'frontend', ref: 'main', state: 'queued', agent: 'a' }, { id: 'd0', env: 'env-a', state: 'done' }], shadow: [{ machine: 'host-1', command: 'claim', legacy: { code: 0 }, central: { code: 3 } }], ...o });

test('formatting helpers', () => {
  assert.equal(fmtMin(0.2), '<1m'); assert.equal(fmtMin(75), '1h15'); assert.equal(fmtMin(null), '—');
  assert.equal(fmtEta(NOW + 120000, NOW), 'in 2m'); assert.equal(fmtEta(NOW - 1, NOW), 'now'); assert.equal(fmtEta(null, NOW), 'unknown');
  assert.equal(esc('<a "x">'), '&lt;a &quot;x&quot;&gt;');
});
test('a held lease row: resource, mode, holder link, purpose (escaped), since, ttl, heartbeat, idle', () => {
  const h = leaseRowHtml(ex, { now: NOW, central: true });
  assert.match(h, /env-a|frontend/); assert.match(h, /exclusive/); assert.match(h, /href="\/\?s=dev1"/); assert.match(h, /ui &lt;b&gt;/);
  assert.match(h, /22m ago/); assert.match(h, /1h38/); assert.match(h, /2m ago/); assert.match(h, /lv-amber/);   // idle 12 min
  assert.doesNotMatch(h, /<b>ui/);
  assert.match(leaseRowHtml({ ...ex, holderSession: null }, { now: NOW }), /codebox:dev1/);
  assert.match(leaseRowHtml({ ...ex, ttlLeftMin: 400 }, { now: NOW }), /lv-amber/);   // long TTL in amber
});
test('owner actions only for an exclusive lease under the central authority; the first tap arms', () => {
  assert.match(leaseRowHtml(ex, { now: NOW, central: true }), /data-lv-act="pin:L1"[\s\S]*data-lv-act="release:L1"/);
  assert.doesNotMatch(leaseRowHtml(ex, { now: NOW, central: false }), /data-lv-act/);
  assert.doesNotMatch(leaseRowHtml(pin, { now: NOW, central: true }), /data-lv-act/);
  assert.match(leaseRowHtml(ex, { now: NOW, central: true, armed: 'release:L1' }), /tap again to confirm/);
  assert.doesNotMatch(leaseRowHtml(ex, { now: NOW, central: true, armed: 'pin:L1' }).split('data-lv-act="release')[1], /tap again/);
});
test('two-tap rule and request building (second tap is client side)', () => {
  assert.deepEqual(tap(null, 'release:L1'), { arm: 'release:L1', fire: null });
  assert.deepEqual(tap('release:L1', 'release:L1'), { arm: null, fire: 'release:L1' });
  assert.deepEqual(tap('release:L1', 'pin:L1'), { arm: 'pin:L1', fire: null });
  assert.deepEqual(actionRequest('release:L1'), { url: '/api/leases/owner/release', body: { id: 'L1' } });
  assert.deepEqual(actionRequest('pin:L1'), { url: '/api/leases/owner/mode', body: { id: 'L1', mode: 'pin' } });
  assert.equal(actionRequest('nope:'), null);
});
test('the view: per env held leases, pins overridden, queue with position and ETA, active deploys only, shadow list', () => {
  const h = viewHtml(data(), { now: NOW });
  assert.match(h, /central lease service/); assert.match(h, /<h3[^>]*>[\s\S]*env-a/);
  assert.match(h, /#1 frontend/); assert.match(h, /in 2m/); assert.match(h, /behind/);
  assert.match(h, /overridden by codebox:dev1/);
  assert.match(h, /deploy queue \(1\)/); assert.match(h, /queued/); assert.doesNotMatch(h, /done/);
  assert.match(h, /shadow disagreements \(1\)/); assert.match(h, /exit 0/); assert.match(h, /exit 3/);
  assert.deepEqual(Object.keys(pinsOverridden(data().leases)), ['L2']);
  assert.equal(groupByEnv(data()).length, 1);
});
test('legacy view is read-only with a pointer to the registry host; errors say busy; empty says so', () => {
  const h = viewHtml(data({ authority: 'legacy', shadow: [] }), { now: NOW });
  assert.match(h, /legacy registry/); assert.match(h, /release a lease on the registry host/); assert.doesNotMatch(h, /data-lv-act/);
  assert.match(viewHtml({ ok: false, error: 'lease service not available', authority: 'central' }), /treated as busy/);
  assert.match(viewHtml({ ok: true, authority: 'central', leases: [], tickets: [] }), /No leases held/);
  assert.equal(shadowHtml([]), '');
  assert.match(ticketRowHtml({ id: 't', position: 3, resources: ['host-1'], agent: 'a' }, NOW), /#3 host-1/);
});
