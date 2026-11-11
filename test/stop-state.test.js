// Stop state from facts (stop-state.js + manager.js): the harness decides waiting / blocked from what it knows, not from the STATUS word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { tmp } from './helpers-tmp.js';
import { computeStopState, waitingText } from '../stop-state.js';

const dir = tmp('stopstate-');
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const m = await import('../manager.js');
const pushes = [];
let facts = { bgJobs: 0, integrations: [], tickets: [], workers: [], timeMs: null };
await m.initManager({ onOwnerNeeded: (s, st) => pushes.push([s, st.case]), stopFacts: async () => facts });
await m.setManagerConfig({ aiTriage: 'off', routerShadow: false, autoSend: false });
const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now });
const records = () => (existsSync(m.LOG_FILE) ? readFileSync(m.LOG_FILE, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
const until = async (pred, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const r = records().find(pred); if (r) return r; await new Promise((x) => setTimeout(x, 20)); } throw new Error('timed out'); };
const stop = async (name, line, t0) => { const p = pane(`Working notes.\n${line}`); tick(name, 'working', ['busy'], t0); tick(name, 'done', p, t0 + 1000); tick(name, 'done', p, t0 + 2100); tick(name, 'done', p, t0 + 3000); return until((r) => r.type === 'stall' && r.session === name); };

test('dry (default): the row carries said / computed / stateWould and nothing changes for the manager', async () => {
  facts = { bgJobs: 0, integrations: ['int-1a1cc76f2cfaa4a04'], tickets: [], workers: [], timeMs: null };
  const r = await stop('sdry', 'STATUS: blocked: the merge is not in yet', 0);
  assert.equal(r.said, 'blocked'); assert.equal(r.computed, 'waiting'); assert.equal(r.stateWould, 'waiting');
  assert.deepEqual(r.stateReasons, [{ kind: 'integration', id: 'int-1a1cc76f2cfaa4a04' }]);
  assert.notEqual(r.case, 'background_wait');
});
test('live: a computed wait is background_wait, never escalated as a block; no fact keeps the block', async () => {
  await m.setManagerConfig({ stopState: 'live' });
  facts = { bgJobs: 0, integrations: [], tickets: ['t-0a1b2c3d'], workers: [], timeMs: null };
  const r = await stop('slive', 'STATUS: blocked: stuck on the claim', 10000);
  assert.equal(r.computed, 'waiting'); assert.equal(r.case, 'background_wait'); assert.equal(r.stateWould, undefined);
  assert.ok(!pushes.some(([n]) => n === 'slive'), 'no owner push for a computed wait');
  facts = { bgJobs: 0, integrations: [], tickets: [], workers: [], timeMs: null };
  const b = await stop('sblock', 'STATUS: blocked: the API refuses my token · tried: three retries · need: the manager rotates it', 20000);
  assert.equal(b.computed, 'blocked'); assert.notEqual(b.case, 'background_wait');
});

const NOW = Date.parse('2026-11-11T20:00:00Z');
test('computeStopState: any wait fact makes blocked / failed / done / no status WAITING; no fact keeps the word; owner and manager asks stay', () => {
  const none = { bgJobs: 0, integrations: [], tickets: [], workers: [], timeMs: null };
  for (const said of ['blocked', 'failed', 'done', '']) {
    assert.equal(computeStopState({ said, facts: none, now: NOW }).computed, said || 'none', 'no fact: unchanged');
    for (const facts of [{ bgJobs: 1 }, { integrations: ['int-1a1c'] }, { tickets: ['t-abc123'] }, { workers: ['kpi-zap-fix'] }, { timeMs: NOW + 600e3 }]) {
      const r = computeStopState({ said, facts: { ...none, ...facts }, now: NOW });
      assert.equal(r.computed, 'waiting', `${said || 'none'} + ${JSON.stringify(facts)}`); assert.equal(r.mismatch, true); assert.equal(r.said, said || 'none');
    }
  }
  assert.equal(computeStopState({ said: 'blocked', facts: { ...none, timeMs: NOW - 1 }, now: NOW }).computed, 'blocked', 'a time that has passed is not a wait');
  assert.equal(computeStopState({ said: 'needs-owner', facts: { bgJobs: 2 }, now: NOW }).computed, 'needs-owner');
  const w = computeStopState({ said: 'waiting', facts: { bgJobs: 1 }, now: NOW }); assert.equal(w.mismatch, false);
  assert.match(waitingText([{ kind: 'integration', id: 'int-1a1c' }, { kind: 'time', id: '04:50 UTC' }]), /^waiting: integration int-1a1c, until 04:50 UTC$/);
});

