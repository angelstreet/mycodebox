import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFailoverState, standbyNames, standbyFlags, STANDBY_DEFAULT } from '../standby-manager.js';

test('state file: claude, minimax, missing and garbage count as claude; cached for the ttl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-autonomy-')), file = join(dir, 'st');
  let t = 0; const st = createFailoverState({ file, now: () => t, ttlMs: 5000 });
  assert.equal(st(), 'claude');                       // missing
  writeFileSync(file, 'minimax\n');
  assert.equal(st(), 'claude');                       // cached
  t = 6000; assert.equal(st(), 'minimax');
  writeFileSync(file, 'junk'); t = 12000; assert.equal(st(), 'claude');
  writeFileSync(file, 'claude'); t = 18000; assert.equal(st(), 'claude');
  rmSync(dir, { recursive: true, force: true });
});

test('config: default mm-manager; override; invalid falls back', () => {
  assert.deepEqual(standbyNames({}), STANDBY_DEFAULT);
  assert.deepEqual(standbyNames({ standbyManagerSessions: ['a', 3, ''] }), ['a']);
  assert.deepEqual(standbyNames({ standbyManagerSessions: 'x' }), STANDBY_DEFAULT);
});

test('flags: mm-manager hidden while claude, shown while minimax; manager and normal sessions never standby', () => {
  const n = ['mm-manager'];
  assert.deepEqual(standbyFlags('mm-manager', n, 'claude'), { standby: true, hidden: true });
  assert.deepEqual(standbyFlags('mm-manager', n, 'minimax'), { standby: true, hidden: false });
  assert.deepEqual(standbyFlags('manager', n, 'claude'), { standby: false, hidden: false });
  assert.deepEqual(standbyFlags('feat', n, 'claude'), { standby: false, hidden: false });
});
