import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../scripts/lease-idle-replay.js';

const at = '2026-11-11T10:30:00.000Z';
const row = { at, session: 's', leaseId: 'L', reasons: ['idle 25 min'] };
const t = (iso) => Date.parse(iso);
test('replay: silent window = right; an entry between idle start and release = wrong; no transcript = unknown; short idle = not released', () => {
  assert.match(replay([row], () => [t('2026-11-11T10:04:00Z')])[0].verdict, /^right/);          // idle start 10:05, release 10:15: last entry before it
  assert.match(replay([row], () => [t('2026-11-11T10:09:00Z')])[0].verdict, /^WRONG/);
  assert.match(replay([row], () => [])[0].verdict, /^unknown/);
  assert.match(replay([{ ...row, reasons: ['idle 5 min'] }], () => [])[0].verdict, /^not released/);
});
