import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restartBlocker } from '../routine-restart.js';

const dev = (id, agent, res) => ({ id, agent, mode: 'exclusive', resource: res, expires_at: '2030-01-01T00:00:00Z' });
const cmd = (u, h = '<lab-host>', extra = '') => `ssh ${h} 'sudo -n systemctl restart ${u}' ${extra}`;

test('vpt-host restart is refused under another session\'s device lease, naming id and expiry', () => {
  const m = restartBlocker({ text: cmd('vpt-host', 'vpt-pi3'), leases: [dev('abc1', 'codebox:kirby', 'vpt-pi3/device2')], session: 'me' });
  assert.match(m, /abc1/); assert.match(m, /2030-01-01/); assert.match(m, /--wait/); assert.match(m, /no --force/);
});
test('own lease, other host, deviceless unit and no lease are allowed', () => {
  const l = [dev('abc1', 'codebox:kirby', 'vpt-pi3/device2')];
  assert.equal(restartBlocker({ text: cmd('vpt-host', 'vpt-pi3'), leases: l, session: 'kirby' }), null);
  assert.equal(restartBlocker({ text: cmd('vpt-host', 'vpt-pi4'), leases: l, session: 'me' }), null);
  assert.equal(restartBlocker({ text: cmd('vpt-kpi', 'vpt-pi3'), leases: l, session: 'me' }), null);
  assert.equal(restartBlocker({ text: cmd('vpt-host', 'vpt-pi3'), leases: [], session: 'me' }), null);
});
test('another session\'s host lease blocks too; shared pins do not', () => {
  assert.ok(restartBlocker({ text: cmd('vpt-stream-main', 'vpt-pi3'), leases: [dev('h1', 'codebox:x', 'vpt-pi3')], session: 'me' }));
  assert.equal(restartBlocker({ text: cmd('vpt-host', 'vpt-pi3'), leases: [{ ...dev('p', 'x', 'vpt-pi3/device2'), mode: 'pin' }], session: 'me' }), null);
});
test('per-device instance is blocked only by the same device', () => {
  const t = (d) => `ssh vpt-pi3 'sudo -n systemctl restart hid-remote@hci1' # ${d}`;
  const l = [dev('d2', 'codebox:x', 'vpt-pi3/device2')];
  assert.ok(restartBlocker({ text: t('device2'), leases: l, session: 'me' }));
  assert.equal(restartBlocker({ text: t('device5'), leases: l, session: 'me' }), null);
});
test('not decidable -> null (no host, registry down, not a restart)', () => {
  assert.equal(restartBlocker({ text: 'sudo systemctl restart vpt-host', leases: [dev('a', 'x', 'vpt-pi3/device2')], session: 'me' }), null);
  assert.equal(restartBlocker({ text: cmd('vpt-host', 'vpt-pi3'), leases: null, session: 'me' }), null);
  assert.equal(restartBlocker({ text: 'ls', leases: [], session: 'me' }), null);
});
