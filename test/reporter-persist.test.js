// The reporter's facts survive a ghosty restart, and the background count its readers get never overrules a closing hand-over line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { createReporter } from '../reporter.js';
import { computeStopState } from '../stop-state.js';

let clock = 1_000_000_000;
const make = async (dir) => { const r = createReporter({ stateDir: dir, now: () => clock }); await r.init(); return r; };
const shell = { type: 'shell', status: 'running', description: 'npm test' };
function turn(r, session, text, { background = [shell], crons = 0 } = {}) {
  const ev = (event, extra) => r.ingest({ v: 1, session, sessionId: 'sid', cwd: '/w', event, ...extra });
  ev('prompt', { text: 'go' }); clock += 1000;
  ev('turn.end', { text, usage: { input_tokens: 5, output_tokens: 7 } });
  ev('stop', { text, backgroundWork: background.length, background, crons });
}

test('activityOf carries the background count for running, waiting and unmarked turns', async () => {
  const r = await make(tmp('rp-a-'));
  for (const [n, line] of [['run', 'STATUS: running: the suite'], ['wait', 'STATUS: waiting: my test run'], ['none', 'Started it in the background.']]) {
    turn(r, n, `Work.\n\n${line}`);
    assert.equal(r.activityOf(n).backgroundWork, 1, n);
  }
});

test('a hand-over line gives readers no background work, so stop facts cannot overrule it; summary keeps the raw count', async () => {
  const r = await make(tmp('rp-b-'));
  for (const [n, line] of [['done', 'STATUS: done — shipped'], ['blocked', 'STATUS: blocked: dead device'], ['failed', 'STATUS: failed — no frames'],
    ['owner', 'STATUS: needs-owner: which one?'], ['mgr', 'STATUS: needs-manager: pick'], ['hand', 'STATUS: handoff: see doc']]) {
    turn(r, n, `Work.\n\n${line}`);
    const count = r.activityOf(n).backgroundWork;
    assert.equal(count, 0, n);
    assert.equal(computeStopState({ said: n === 'done' ? 'done' : 'blocked', facts: { bgJobs: count } }).mismatch, false, n);
    assert.equal(r.summary(n).backgroundWork, 1, n);
  }
});

test('a restart restores the last report: background tasks, wakeups, prompt, meter and texts', async () => {
  const dir = tmp('rp-c-'), a = await make(dir);
  turn(a, 's', 'STATUS: running: the suite', { crons: 2 });
  a.ingest({ v: 1, session: 's', sessionId: 'sid', event: 'waiting', message: 'permission?' });
  a.ingest({ v: 1, session: 's', sessionId: 'sid', event: 'agents', agents: [{ id: '1', type: 'Explore', status: 'running' }] });
  await a.flush();
  assert.equal(statSync(join(dir, 'reporter-sessions.json')).mode & 0o777, 0o600);
  clock += 3600e3;   // past the live window: the pending work alone keeps it reported
  const b = await make(dir);
  assert.equal(b.summary('s').backgroundWork, 1);
  assert.equal(b.summary('s').crons, 2);
  assert.equal(b.activityOf('s').backgroundWork, 1);
  assert.equal(b.detail('s').lastTurn.text, 'STATUS: running: the suite');
  assert.equal(b.detail('s').lastPrompt.text, 'go');
  assert.equal(b.detail('s').waiting, null);
  assert.deepEqual(b.detail('s').agents, []);
  // the first events after the restart continue the same conversation
  b.ingest({ v: 1, session: 's', sessionId: 'sid', event: 'session.start' });
  assert.equal(b.summary('s').backgroundWork, 0, 'a fresh start still clears old tasks');
});

test('a pruned session stays gone, a day-old one is dropped, and a damaged or odd file starts empty', async () => {
  const dir = tmp('rp-d-'), a = await make(dir);
  turn(a, 'keep', 'STATUS: running: x'); turn(a, 'gone', 'STATUS: running: x');
  await a.flush();
  a.prune(new Set(['keep'])); await a.flush();
  assert.equal((await make(dir)).detail('gone'), null);
  clock += 25 * 3600e3;
  assert.equal((await make(dir)).detail('keep'), null);
  for (const bad of ['{not json', 'null', '{"sessions":[1]}', '{"sessions":{"x":null,"y":{"reporterSeenAt":"soon"}}}']) {
    writeFileSync(join(dir, 'reporter-sessions.json'), bad);
    const r = await make(dir);
    assert.equal(r.detail('x'), null); assert.equal(r.detail('y'), null);
    turn(r, 'new', 'STATUS: done — ok'); await r.flush();
    assert.ok(JSON.parse(readFileSync(join(dir, 'reporter-sessions.json'), 'utf8')).sessions.new);
  }
});

test('the write happens by itself after an event, and shutdown flushes', async () => {
  const dir = tmp('rp-e-'), r = createReporter({ stateDir: dir, now: () => clock, saveMs: 20 });
  await r.init();
  turn(r, 's', 'STATUS: running: x');
  await new Promise((x) => setTimeout(x, 200));
  assert.ok(JSON.parse(readFileSync(join(dir, 'reporter-sessions.json'), 'utf8')).sessions.s);
  assert.match(readFileSync(new URL('../server.js', import.meta.url), 'utf8'), /await reporter\.flush\(\);/);
});
