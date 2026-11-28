import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (log) => execFileSync('bash', [join(ROOT, 'scripts/manager-handover-line.sh')], { env: { PATH: process.env.PATH, HOME: '/nonexistent', HANDOVER_LOG: log }, encoding: 'utf8' }).trim();

test('prints the last non-empty line of the handover log, one line, 400 chars max', () => {
  const d = tmp('handover-'), f = join(d, 'manager-handover.log');
  writeFileSync(f, `2026-11-27 old line\n2026-11-28 open: s1 waits on deploy\t; promise: reply to s2\n\n   \n`);
  assert.equal(run(f), `manager handover line (${f}): 2026-11-28 open: s1 waits on deploy ; promise: reply to s2`);
  writeFileSync(f, `${'x'.repeat(900)}\n`);
  assert.equal(run(f).split(': ')[1].length, 400);
});

test('a missing or empty log says none and exits 0', () => {
  const d = tmp('handover-');
  assert.match(run(join(d, 'absent.log')), /: none \(no such file\)$/);
  writeFileSync(join(d, 'e.log'), '\n\n');
  assert.match(run(join(d, 'e.log')), /: none \(file is empty\)$/);
});

test('manager-fresh.sh calls it before the kickoff is sent', () => {
  const s = readFileSync(join(ROOT, 'scripts/manager-fresh.sh'), 'utf8');
  assert.ok(s.indexOf('manager-handover-line.sh') > 0 && s.indexOf('manager-handover-line.sh') < s.indexOf('/api/send/$S" "${H[@]}" -d @-'));
});
