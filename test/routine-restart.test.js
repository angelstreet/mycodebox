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
