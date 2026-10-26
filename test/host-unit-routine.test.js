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

// ---- owner, 2026-10-26: units on codebox / database hosts, safer changes, permission fixes ----
import { routineChange } from '../host-unit-routine.js';

const UNIT_CODEBOX = 'Install the merged and reviewed game-lane timers on codebox with sudo install and systemctl daemon-reload; the old unit files are backed up first. Rollback: copy the backups back.';
const SAFER_TXT = 'Make the two migration files re-runnable (CREATE OR REPLACE for the functions, a guard on the check constraint); nothing is applied to a database. Rollback: revert the commit.';
const PERM_TXT = 'Fix the ownership and permissions of the settings file so the database host service can read it, without reading or printing its contents. Rollback: restore the old mode and owner (recorded first).';

test('unit class: codebox and database / helper hosts are routine; the ghosty-sessions service itself is not', () => {
  assert.equal(routineChange(UNIT_CODEBOX, textVariants).kind, 'unit');
  assert.equal(hardMatch(UNIT_CODEBOX, {}), null);
  assert.equal(routineChange(UNIT_CODEBOX.replace('codebox', 'the database host'), textVariants).kind, 'unit');
  assert.equal(routineChange(UNIT_CODEBOX.replace('codebox', 'the helper host'), textVariants).kind, 'unit');
  assert.equal(routineChange(UNIT_CODEBOX + ' It changes the ghosty-sessions service.', textVariants).routine, false);
  assert.equal(routineChange(UNIT_CODEBOX.replace('codebox', 'the production customer-facing app host'), textVariants).routine, false);
});

test('safer class: re-runnable / guarded / tightened passes, anything destructive or unsafe does not', () => {
  const r = routineChange(SAFER_TXT, textVariants);
  assert.equal(r.kind, 'safer');
  assert.equal(hardMatch(SAFER_TXT, {}), null);
  assert.equal(routineChange('Tighten the permissions of the backup directory to 700. Rollback: chmod back to 755.', textVariants).kind, 'safer');
  for (const extra of [' It also drops the old table.', ' It also deletes old rows.', ' It truncates the log.', ' Add a sudoers line.', ' It rotates the token.', ' On the production app host.']) {
    assert.equal(routineChange(SAFER_TXT + extra, textVariants).routine, false, extra);
  }
  assert.equal(routineChange(SAFER_TXT.replace(' Rollback: revert the commit.', ''), textVariants).routine, false, 'no rollback line');
  assert.equal(routineChange('Add a new column to the customers table; guard it with IF NOT EXISTS. Revert: drop it.', textVariants).routine, false);
});

test('permission class: a settings-file permission fix with contents untouched passes; credential handling does not', () => {
  const r = routineChange(PERM_TXT, textVariants);
  assert.equal(r.kind, 'perm', r.why);
  assert.equal(hardMatch(PERM_TXT, {}), null);
  for (const [t, why] of [
    [PERM_TXT.replace(', without reading or printing its contents', ''), 'contents not promised unread'],
    [PERM_TXT.replace(' Rollback: restore the old mode and owner (recorded first).', ''), 'no rollback'],
    [PERM_TXT.replace('settings file', 'directory'), 'no settings file'],
    [PERM_TXT + ' Also print the file to check the key.', 'prints'],
    [PERM_TXT + ' Also set a new password.', 'password'],
    [PERM_TXT + ' Also rotate the key.', 'rotate'],
    [PERM_TXT + ' Add a sudoers line.', 'sudoers'],
    [PERM_TXT.replace('database host', 'production app host'), 'production'],
  ]) assert.equal(routineChange(t, textVariants).routine, false, why);
});

test('the remaining floors still block: money, customers, deleting data, destructive migration, history rewrite', () => {
  for (const t of [
    SAFER_TXT + ' Also pay the invoice.', SAFER_TXT + ' Also email the customers.', SAFER_TXT + ' Also delete the shared data.',
    SAFER_TXT + ' Also run the destructive migration.', SAFER_TXT + ' Also force-push main.',
    PERM_TXT + ' Also pay the invoice.', UNIT_CODEBOX + ' Also delete the shared data.',
  ]) assert.ok(hardMatch(t, {}) || !routineChange(t, textVariants).routine, t);
});

test('the ask gate refuses routine classes under any floor they might be filed as, and keeps real floor asks', () => {
  const base = { options: ['1 yes', '2 no'], recommend: 1, question: 'May I do this?' };
  for (const [floor, what, why] of [
    ['host_units', UNIT_CODEBOX, 'It installs units on the host.'],
    ['production_migration', SAFER_TXT, 'A migration could break the database.'],
    ['credentials', PERM_TXT, 'The settings file holds a key that could leak.'],
  ]) {
    const r = checkAsk({ ...base, floor, what, why });
    assert.equal(r.ok, false, floor);
    assert.match(r.why, /routine .* change/, floor);
  }
  // real floor items go through
  assert.equal(checkAsk({ ...base, floor: 'credentials', what: 'Rotate the deploy token for the service.', why: 'A rotated token could lock the service out.' }).ok, true);
  assert.equal(checkAsk({ ...base, floor: 'production_migration', what: 'Drop the old column in the production database.', why: 'A dropped column is lost, the migration is unrecoverable.' }).ok, true);
  assert.equal(checkAsk({ ...base, floor: 'host_units', what: 'Add a sudoers line on codebox.', why: 'sudoers gives root to a service.' }).ok, true);
  assert.equal(checkAsk({ ...base, floor: 'money', what: 'Pay the hosting invoice.', why: 'It spends the owner money.' }).ok, true);
});
