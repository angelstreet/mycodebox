import test from 'node:test';
import assert from 'node:assert/strict';
import { createLagMonitor } from '../event-loop-lag.js';

function clock() { let t = 1_700_000_000_000; return { now: () => t, set: (v) => { t = v; }, adv: (ms) => { t += ms; } }; }

test('an on-time timer records nothing; a late one records its lag with a timestamp', () => {
  const c = clock(); const m = createLagMonitor({ now: c.now });
  c.adv(100); m.tick(); c.adv(103); m.tick();
  assert.deepEqual(m.snapshot().worst, []);
  c.adv(100 + 800); m.tick();
  const s = m.snapshot();
  assert.equal(s.stalls, 1); assert.equal(s.worst[0].lagMs, 800); assert.match(s.worst[0].at, /^2023-11-1\d/);
});
test('only lags of the spike threshold or more reach the journal callback; a callback error is swallowed', () => {
  const c = clock(); const seen = [];
  const m = createLagMonitor({ now: c.now, spikeMs: 500, onSpike: (r) => { seen.push(r.lagMs); throw new Error('disk full'); } });
  c.adv(100 + 200); m.tick(); c.adv(100 + 500); m.tick(); c.adv(100 + 15000); m.tick();
  assert.deepEqual(seen, [500, 15000]);
  assert.equal(m.snapshot().stalls, 3);
});
test('the list keeps only the worst N, biggest first', () => {
  const c = clock(); const m = createLagMonitor({ now: c.now, keep: 3 });
  for (const lag of [60, 900, 70, 300, 80, 1200]) { c.adv(100 + lag); m.tick(); }
  assert.deepEqual(m.snapshot().worst.map((w) => w.lagMs), [1200, 900, 300]);
});
test('start / stop drive the timer once', () => {
  let n = 0, cleared = 0; const c = clock();
  const m = createLagMonitor({ now: c.now, setTimer: () => { n++; return { unref() {} }; }, clearTimer: () => { cleared++; } });
  m.start(); m.start(); m.stop(); m.stop();
  assert.equal(n, 1); assert.equal(cleared, 1);
});
