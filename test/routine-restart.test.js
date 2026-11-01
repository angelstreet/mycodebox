import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenMatch, hardMatch, ownerFloorMatch, forbiddenTopics } from '../stall.js';
import { routineRestart, answerRoutineRestart, setRoutineRestartUnits, DEFAULT_RESTART_UNITS } from '../routine-restart.js';

const CMD = `ssh <lab-proxy> "ssh <lab-host> 'sudo -n systemctl restart vpt-monitor-img && systemctl is-active vpt-monitor-img'"`;

test('the owner example is not forbidden anywhere', () => {
  assert.equal(forbiddenMatch(CMD), null);
  assert.equal(hardMatch(CMD, {}), null);
  assert.equal(ownerFloorMatch(CMD), null);
  assert.deepEqual(forbiddenTopics(CMD), []);
  assert.equal(forbiddenMatch('I will restart vpt-monitor-img on <lab-host>, then check it.'), null);
  assert.equal(forbiddenMatch('Shall I run `sudo -n systemctl restart vpt-host` on <lab-host>?'), null);
  assert.equal(forbiddenMatch('sudo systemctl restart vpt-stream-main.service'), null);
});

test('everything else about services stays forbidden', () => {
  for (const t of [
    'sudo -n systemctl restart ghosty-sessions',
    'ssh <lab-host> sudo -n systemctl stop vpt-monitor-img',
    'sudo -n systemctl start vpt-monitor-img',
    'sudo -n systemctl disable vpt-monitor-img',
    'sudo -n systemctl enable vpt-monitor-img',
    'sudo -n systemctl mask vpt-monitor-img',
    'sudo -n systemctl daemon-reload',
    'edit the sudoers entry for vpt-monitor-img',
    'install the unit file /etc/systemd/system/vpt-monitor-img.service',
    'sudo -n systemctl restart nginx',
    'sudo -n systemctl restart vpt-host and nginx',
    'sudo -n systemctl restart vpt-host ghosty-sessions',
    'sudo -n systemctl restart vpt-host, ghosty-sessions',
    'restart vpt-host and the ghosty service',
    'restart vpt-host on the production host',
    'sudo -n systemctl restart vpt-host; sudo -n systemctl stop vpt-stream',
    'sudo -n systemctl restart vpt-hostile',
  ]) assert.ok(forbiddenMatch(t), t);
});

test('allowlist: defaults and override', () => {
  assert.ok(DEFAULT_RESTART_UNITS.includes('vpt-host'));
  assert.equal(routineRestart('systemctl restart vpt-grabber2').routine, true);
  setRoutineRestartUnits(['vpt-only-this']);
  try {
    assert.equal(routineRestart('systemctl restart vpt-host').routine, false);
    assert.equal(routineRestart('systemctl restart vpt-only-this').routine, true);
  } finally { setRoutineRestartUnits(null); }
});

test('restart without a covering lease: claim the host lease first', () => {
  const t = 'sudo -n systemctl restart vpt-monitor-img on <lab-host>';
  const none = answerRoutineRestart({ text: t, view: { ok: true, leases: [] }, session: 's1' });
  assert.equal(none.covered, false);
  assert.match(none.text, /Claim the host lease first/);
  assert.match(none.text, /--wait/);
  const other = answerRoutineRestart({ text: t, view: { ok: true, leases: [{ mode: 'exclusive', agent: 'codebox:s2', resources: ['<lab-host>'] }] }, session: 's1' });
  assert.equal(other.covered, false);
  const own = answerRoutineRestart({ text: t, view: { ok: true, leases: [{ mode: 'exclusive', agent: 'codebox:s1', resources: ['<lab-host>'], kind: 'host' }] }, session: 's1' });
  assert.equal(own.covered, true);
  assert.match(own.text, /^Yes, go ahead/);
  assert.equal(answerRoutineRestart({ text: t, view: { ok: false }, session: 's1' }).covered, false);
  assert.equal(answerRoutineRestart({ text: 'systemctl restart ghosty-sessions', view: { ok: true, leases: [] }, session: 's1' }), null);
});

// owner 2026-10-31: the lab-host service families that proved routine are answered by the manager (Q256-Q258 were avoidable)
test('2026-10-31 allowlist: kpi, BLE daemons, avq, archiver, timeline, audio, mediamtx are routine', () => {
  for (const t of [
    'May I restart vpt-kpi on <lab-host>?',
    'sudo -n systemctl restart hid-remote@hci1',
    'sudo -n systemctl restart hid-remote@hci2.service && systemctl is-active hid-remote@hci2',
    'systemctl restart vpt-ble-remote@hci0',
    'systemctl restart vpt-avq', 'systemctl restart vpt-archiver', 'systemctl restart vpt-timeline',
    'systemctl restart vpt-audio-main', 'systemctl restart vpt-monitor-audio', 'systemctl restart vpt-mediamtx',
  ]) { assert.equal(forbiddenMatch(t), null, t); assert.equal(hardMatch(t, {}), null, t); assert.equal(routineRestart(t).routine, true, t); }
  for (const t of ['systemctl restart vpt-vnc', 'systemctl restart vpt-websockify', 'systemctl restart lircd', 'systemctl restart bluetooth',
    'systemctl restart bluetooth.service', 'systemctl restart vpt-server', 'systemctl restart postgresql', 'systemctl restart nginx',
    'systemctl restart hid-remote@hci1 on the production host', 'systemctl stop hid-remote@hci1', 'systemctl disable vpt-kpi'])
    assert.ok(forbiddenMatch(t), t);
});

test('a run holding a device lease on the host blocks a restart of a device unit, not of a deviceless one', () => {
  const view = { ok: true, leases: [
    { id: 'L1', mode: 'exclusive', kind: 'host', agent: 'codebox:s1', resources: ['<lab-host>'] },
    { id: 'L2', mode: 'exclusive', kind: 'device', agent: 'codebox:run7', resources: ['<lab-host>/device1'] },
  ] };
  const ble = answerRoutineRestart({ text: 'restart hid-remote@hci1 on <lab-host>', view, session: 's1' });
  assert.equal(ble.covered, false);
  assert.match(ble.text, /device lease/);
  assert.match(ble.text, /--wait/);
  const kpi = answerRoutineRestart({ text: 'restart vpt-kpi on <lab-host>', view, session: 's1' });
  assert.equal(kpi.covered, true);
});

test('per-device unit instance: own device lease suffices, only the same device blocks', () => {
  const L = (id, agent, res, kind = 'host') => ({ id, mode: 'exclusive', kind, agent, resources: [res] });
  const ask = 'restart hid-remote@hci1 (device5) on <lab-host>';
  const other4 = [L('A', 'codebox:s1', '<env>/<lab-host>/device5'), L('B', 'codebox:run7', '<env>/<lab-host>/device4')];
  assert.equal(answerRoutineRestart({ text: ask, view: { ok: true, leases: other4 }, session: 's1' }).covered, true);
  const same = [L('A', 'codebox:s1', '<env>/<lab-host>/device5'), L('B', 'codebox:run7', '<env>/<lab-host>/device5')];
  const blocked = answerRoutineRestart({ text: ask, view: { ok: true, leases: same }, session: 's1' });
  assert.equal(blocked.covered, false); assert.match(blocked.text, /device5/);
  // own host lease also fine, another device's lease does not block
  const hostL = [L('H', 'codebox:s1', '<env>/<lab-host>'), L('B', 'codebox:run7', '<env>/<lab-host>/device4', 'device')];
  assert.equal(answerRoutineRestart({ text: ask, view: { ok: true, leases: hostL }, session: 's1' }).covered, true);
  // no lease at all: claim the device, not the host
  const none = answerRoutineRestart({ text: ask, view: { ok: true, leases: [] }, session: 's1' });
  assert.equal(none.covered, false); assert.match(none.text, /Claim <lab-host>\/device5 first/);
  // device in the unit suffix
  assert.equal(answerRoutineRestart({ text: 'restart vpt-stream@device5 on <lab-host>', view: { ok: true, leases: other4 }, session: 's1' }).covered, true);
});

test('no derivable device or host-wide unit keeps the host rule', () => {
  const view = { ok: true, leases: [
    { id: 'L1', mode: 'exclusive', kind: 'host', agent: 'codebox:s1', resources: ['<lab-host>'] },
    { id: 'L2', mode: 'exclusive', kind: 'device', agent: 'codebox:run7', resources: ['<lab-host>/device4'] } ] };
  assert.equal(answerRoutineRestart({ text: 'restart hid-remote@hci1 on <lab-host>', view, session: 's1' }).covered, false);
  assert.equal(answerRoutineRestart({ text: 'restart vpt-host (device5) on <lab-host>', view, session: 's1' }).covered, false);
});
