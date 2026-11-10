import test from 'node:test';
import assert from 'node:assert/strict';
import { audit } from '../scripts/deploy-catchup-audit.js';

const contains = (n, o) => (n === o ? true : n === 'b' && o === 'a' ? true : n === 'a' && o === 'b' ? false : null);
const d = (id, o) => ({ id, env: 'e', scope: 'host', state: 'done', created: 1, finished: 1, ...o });

test('audit: a host skipped at a ref whose catch-up was cancelled and never redone is behind', () => {
  const rows = audit([
    d('D1', { ref: 'a', finished: 10, skippedHosts: ['pi1'] }),
    d('C1', { ref: 'a', state: 'cancelled', purpose: 'catch-up for D1: skipped pi1', hosts: ['pi1'], reason: 'superseded by a catch-up at a', finished: 20 }),
  ], contains);
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'behind'); assert.equal(rows[0].host, 'pi1'); assert.match(rows[0].via, /C1 cancelled/);
});
test('audit: covered by a later deploy of a containing ref, or pending in a queued catch-up, is not behind', () => {
  assert.deepEqual(audit([d('D1', { ref: 'a', finished: 10, skippedHosts: ['pi1'] }), d('D2', { ref: 'b', finished: 30, scope: 'full' })], contains), []);
  const p = audit([d('D1', { ref: 'a', finished: 10, skippedHosts: ['pi1'] }), d('C2', { ref: 'b', state: 'queued', purpose: 'catch-up: x', hosts: ['pi1'] })], contains);
  assert.equal(p[0].state, 'pending');
  // an OLDER later deploy does not cover it
  assert.equal(audit([d('D1', { ref: 'b', finished: 10, skippedHosts: ['pi1'] }), d('D2', { ref: 'a', finished: 30 , hosts: ['pi1'] })], contains)[0].state, 'behind');
  // unknown containment is flagged, not hidden
  assert.equal(audit([d('D1', { ref: 'a', finished: 10, skippedHosts: ['pi1'] }), d('D2', { ref: 'zz', finished: 30, scope: 'full' })], contains)[0].state, 'unverified');
});

import { auditLedger } from '../scripts/deploy-catchup-audit.js';
test('ledger audit: a host whose last ref does not contain the newest done ref is behind; a queued catch-up makes it pending', () => {
  const envs = { e: { h1: { ref: 'b', at: 20, status: 'done' }, pi1: { ref: 'a', at: 10, status: 'done' }, pi2: { ref: 'a', at: 5, status: 'done' } } };
  const q = [{ id: 'Q', env: 'e', state: 'queued', purpose: 'catch-up: x', hosts: ['pi2'], ref: 'b' }];
  const rows = auditLedger(envs, q, (n, o) => n === o || (n === 'b' && o === 'a'));
  assert.deepEqual(rows.map((r) => [r.host, r.state]), [['pi1', 'behind'], ['pi2', 'pending']]);
});
