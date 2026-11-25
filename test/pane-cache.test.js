import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLimiter, createCoalescer } from '../pane-cache.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('limiter: never more than max at once, FIFO, everything finishes', async () => {
  const run = createLimiter(2);
  let active = 0, peak = 0; const order = [];
  const job = (i) => run(async () => { active++; peak = Math.max(peak, active); await tick(10); order.push(i); active--; return i; });
  const got = await Promise.all([0, 1, 2, 3, 4, 5].map(job));
  assert.deepEqual(got, [0, 1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.deepEqual(order.slice().sort(), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(run.stats(), { active: 0, queued: 0 });
});

test('limiter: a failing job frees its slot and rejects only its caller', async () => {
  const run = createLimiter(1);
  const bad = run(async () => { throw new Error('boom'); });
  const good = run(async () => 'ok');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
});

test('coalescer: ten callers while one is running make one call; a call inside the ttl is shared; after the ttl it runs again', async () => {
  let t = 1000, calls = 0;
  const c = createCoalescer({ ttlMs: 1500, now: () => t });
  const fn = async () => { calls++; await tick(10); return `v${calls}`; };
  const ten = await Promise.all(Array.from({ length: 10 }, () => c.get('s|1000', fn)));
  assert.equal(calls, 1); assert.ok(ten.every((v) => v === 'v1'));
  t += 1000; assert.equal(await c.get('s|1000', fn), 'v1'); assert.equal(calls, 1);
  t += 600; assert.equal(await c.get('s|1000', fn), 'v2'); assert.equal(calls, 2);
});

test('coalescer: a failure is not kept, a send (invalidate) forgets the session but not another', async () => {
  let t = 0, n = 0;
  const c = createCoalescer({ ttlMs: 1500, now: () => t });
  await assert.rejects(c.get('a|1', async () => { throw new Error('x'); }));
  assert.equal(await c.get('a|1', async () => 'fresh'), 'fresh');
  await c.get('b|1', async () => `b${++n}`); await c.get('a|2', async () => `a${++n}`);
  c.invalidate('a');
  assert.equal(await c.get('a|1', async () => 'after'), 'after');
  assert.equal(await c.get('a|2', async () => 'after2'), 'after2');
  assert.equal(await c.get('b|1', async () => 'bnew'), 'b1');
});

test('coalescer: sweeps old entries once it holds maxEntries', async () => {
  let t = 0;
  const c = createCoalescer({ ttlMs: 100, now: () => t, maxEntries: 5 });
  for (let i = 0; i < 5; i++) await c.get(`k${i}|1`, async () => i);
  t += 500; await c.get('new|1', async () => 1);
  assert.ok(c.size() <= 2);
});

test('server wiring: the reads a click makes are shared, every capture is capped, a send forgets them, the tick stays uncached', () => {
  const s = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(s, /paneLimit\(\(\) => exec\(TMUX, \[\s*'capture-pane'/);
  assert.equal((s.match(/paneShared\.invalidate\(session\)/g) || []).length, 2);
  const reply = s.slice(s.indexOf("p.startsWith('/api/reply/')"), s.indexOf("p === '/api/vpt-locks'"));
  assert.match(reply, /capturePaneShared\(session\)/);
  assert.match(s, /transcriptShared\.get\(`\$\{session\}\|\$\{max \|\| 0\}`/);
  assert.match(s, /pane = await capturePane\(s\.name, depth\)/);   // pollOnce keeps its own fresh capture
});
