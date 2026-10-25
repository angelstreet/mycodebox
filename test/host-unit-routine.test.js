// The narrow host_units exception (owner 2026-10-25): a reviewed + merged unit / timer / script install on a CI runner VM
// is routine; sudoers, production, codebox's own service, reboots, removals and credentials stay with the owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { routineHostUnit } from '../host-unit-routine.js';
import { hardMatch, textVariants } from '../stall.js';
import { checkAsk } from '../owner-asks.js';

const ROUTINE = 'Install the merged and reviewed ci-runner-retention.service and its timer on the CI runner VMs with sudo install and systemctl enable --now; the previous script is kept as backup. Rollback: copy the saved file back.';

test('routine: a reviewed, merged install on a CI runner VM with backup and rollback passes the hard floor', () => {
  assert.equal(routineHostUnit(ROUTINE, textVariants).routine, true);
  assert.equal(hardMatch(ROUTINE, {}), null);
  assert.equal(hardMatch(ROUTINE.replace('CI runner VMs', 'non-production helper VM'), {}), null);
});

test('still floor: sudoers, production, codebox service, reboot, removal, credentials', () => {
  for (const extra of [
    ' Also add a sudoers line.', ' Then reboot the VM.', ' Remove the old timer.', ' Also rotate the deploy token.',
    ' It also changes the ghosty-sessions service.',
  ]) {
    assert.equal(routineHostUnit(ROUTINE + extra, textVariants).routine, false, extra);
    assert.ok(hardMatch(ROUTINE + extra, {}), extra);
  }
  assert.ok(hardMatch(ROUTINE.replace('CI runner VMs', 'production hosts'), {}));
  assert.ok(hardMatch(ROUTINE.replace('CI runner VMs', 'customer-facing hosts'), {}));
  assert.ok(hardMatch(ROUTINE + ' s u d o e r s', {}));
});

test('a removal that says what replaces it is still checked by the rest of the floor', () => {
  const t = ROUTINE + ' It replaces the old timer and removes the old unit file.';
  assert.equal(routineHostUnit(t, textVariants).routine, true);
  assert.equal(hardMatch(t, {}) !== null, true, 'the word "removes" is still floor');
  assert.ok(hardMatch(ROUTINE + ' It replaces the old timer. Delete the shared data.', {}));
});

test('not routine when the text leaves out a piece', () => {
  for (const [drop, why] of [['merged and ', 'merged'], [' Rollback: copy the saved file back.', 'rollback'], ['; the previous script is kept as backup', 'backup'], ['CI runner VMs', 'target']]) {
    const t = ROUTINE.replace(drop, drop === 'CI runner VMs' ? 'the hosts' : '');
    assert.equal(routineHostUnit(t, textVariants).routine, false, why);
    assert.ok(hardMatch(t, {}), why);
  }
});

test('owner-ask gate refuses a routine host_units ask and still accepts a real one', () => {
  const base = { options: ['1 yes', '2 no'], recommend: 1, floor: 'host_units' };
  const routine = checkAsk({ ...base, question: 'May I do this?', what: ROUTINE, why: 'It installs a systemd unit on a host.' });
  assert.equal(routine.ok, false);
  assert.match(routine.why, /routine/);
  const real = checkAsk({ ...base, question: 'May I edit sudoers on the CI runner VMs?', what: 'It adds a sudoers line on the runner VMs.', why: 'sudoers is a host unit floor item.' });
  assert.equal(real.ok, true);
});
