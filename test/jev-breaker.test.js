// Jev circuit breaker (jev-breaker.js): 3 errors in a row open it, a probe every 10 min, a success closes it, one announcement per transition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJevBreaker, PROBE_MS } from '../jev-breaker.js';
import { decide } from '../router.js';
import { classifyKey, createManagerEvents } from '../manager-events.js';

const setup = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ghosty-jevb-')), 'jev-budget.json');
  let t = Date.parse('2026-10-05T10:00:00Z');
  const b = createJevBreaker({ file, now: () => t });
  return { b, file, tick: (ms) => { t += ms; }, read: () => JSON.parse(readFileSync(file, 'utf8')) };
};

test('2 errors keep it closed, the 3rd opens it; counters land in jev-budget.json', () => {
  const { b, read } = setup();
  b.failure('http 403 key limit'); b.failure('http 403 key limit');
  assert.equal(b.isOpen(), false); assert.equal(b.allow(), true);
  b.failure('http 403 key limit');
  assert.equal(b.isOpen(), true);
  const s = read();
  assert.equal(s.errors, 3); assert.equal(s.consecutiveErrors, 3); assert.equal(s.lastError, 'http 403 key limit'); assert.equal(s.breaker, 'open');
});

test('a success in between resets the streak', () => {
  const { b } = setup();
  b.failure('x'); b.failure('x'); b.success(); b.failure('x'); b.failure('x');
  assert.equal(b.isOpen(), false);
});

test('open: no calls except one half-open probe per 10 min; a failed probe stays open; a good probe closes', () => {
  const { b, tick, read } = setup();
  for (let i = 0; i < 3; i++) b.failure('boom');
  assert.equal(b.allow(), false);
  tick(PROBE_MS - 1000); assert.equal(b.allow(), false);
  tick(1000); assert.equal(b.allow(), true, 'probe');
  assert.equal(b.allow(), false, 'only one probe per window');
  b.failure('boom'); assert.equal(b.isOpen(), true); assert.equal(read().errors, 4);
  tick(PROBE_MS); assert.equal(b.allow(), true, 'next probe');
  b.success();
  assert.equal(b.isOpen(), false); assert.equal(read().consecutiveErrors, 0);
  assert.equal(b.allow(), true);
});

test('announce: exactly one down while open (repeated ticks, failed probes), one up after it closes', () => {
  const { b, tick } = setup();
  const seen = [];
  const emit = (e) => seen.push(e.kind);
  assert.equal(b.announce(emit), null);
  for (let i = 0; i < 3; i++) b.failure('boom');
  b.announce(emit); b.announce(emit);
  tick(PROBE_MS); b.allow(); b.failure('boom'); b.announce(emit);
  assert.deepEqual(seen, ['down']);
  tick(PROBE_MS); b.allow(); b.success();
  b.announce(emit); b.announce(emit);
  assert.deepEqual(seen, ['down', 'up']);
});

test('two breaker instances (server + jev-ask process) share the state through the file', () => {
  const { b, file } = setup();
  const other = createJevBreaker({ file });
  for (let i = 0; i < 3; i++) other.failure('cli error');
  assert.equal(b.isOpen(), true);
});

test('saveCounters keeps the breaker fields and resets errors on a new day', () => {
  const { b, file, read } = setup();
  b.failure('e'); b.saveCounters({ day: '2026-10-05', calls: 5, cost: 0.1 });
  assert.equal(read().errors, 1); assert.equal(read().calls, 5); assert.equal(read().lastError, 'e');
  b.saveCounters({ day: '2026-10-06', calls: 1, cost: 0 });
  assert.equal(read().errors, 0); assert.equal(read().consecutiveErrors, 1);
});

test('router decide: an API failure is source "error", an unsure answer stays "rule"', async () => {
  const facts = { case: 'owner_decision' };
  const err = await decide('stop', facts, { post: async () => ({ success: false, error: 'http 403: key limit exceeded' }) });
  assert.equal(err.source, 'error'); assert.match(err.error, /403/); assert.equal(err.choice, err.ruleDefault);
  const unsure = await decide('stop', facts, { post: async () => ({ success: true, answers: { choice: { choice: 'escalate', probabilities: { escalate: 0.3 } } } }) });
  assert.equal(unsure.source, 'rule');
  const none = await decide('stop', facts, {});
  assert.equal(none.source, 'rule');
});

test('jev:down / jev:up are manager events of kind jev', async () => {
  assert.deepEqual(classifyKey('jev:down'), { kind: 'jev', state: 'down' });
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-jevb-ev-'));
  const me = createManagerEvents({ stateDir: dir });
  assert.equal(await me.record({ key: 'jev:down', title: 'Jev is down', body: 'x' }), true);
  const l = JSON.parse(readFileSync(me.file, 'utf8').trim());
  assert.equal(l.kind, 'jev'); assert.equal(l.state, 'down');
});

test('jev-ask CLI: 403s give source "error"; after 3 the breaker is open and the 4th call does not reach the API', async () => {
  const { createServer } = await import('node:http');
  const { fileURLToPath } = await import('node:url');
  let hits = 0;
  const srv = createServer((req, res) => { hits++; res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'key limit exceeded' })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-jevb-cli-'));
  const cli = fileURLToPath(new URL('../scripts/jev-ask.js', import.meta.url));
  const env = { ...process.env, GHOSTY_STATE_DIR: dir, GHOSTY_ENV_FILE: join(dir, 'none.env'), JEV_URL: `http://127.0.0.1:${srv.address().port}/server/ai/decide`, JEV_API_KEY: 'k' };
  const ask = () => new Promise((res) => { import('node:child_process').then(({ spawn }) => { const p = spawn('node', [cli, 'stop', '--facts', JSON.stringify({ case: 'owner_decision' })], { env }); let o = ''; p.stdout.on('data', (d) => { o += d; }); p.on('close', () => res(JSON.parse(o))); }); });
  const outs = [await ask(), await ask(), await ask(), await ask()];
  srv.close();
  assert.deepEqual(outs.slice(0, 3).map((o) => o.source), ['error', 'error', 'error']);
  assert.match(outs[0].error, /key limit/);
  assert.equal(hits, 3, 'the 4th call is served by the rules without the API');
  assert.equal(outs[3].source, 'rule'); assert.equal(outs[3].jev, 'down');
});
