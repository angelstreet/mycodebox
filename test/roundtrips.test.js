// Round 9 item 9: owner-roundtrips.jsonl is written when a stop resolves (owner reply, manager answer, superseded, removed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roundtripRecord, summarizeRoundtrips, createRoundtrips } from '../roundtrips.js';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-rt-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const m = await import('../manager.js');
await m.initManager({ onOwnerNeeded: () => {} });

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const ledger = () => (existsSync(join(dir, 'owner-roundtrips.jsonl')) ? readFileSync(join(dir, 'owner-roundtrips.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { const r = ledger().find(pred); if (r) return r; await settle(20); } throw new Error('timed out waiting for a ledger record'); }
const tick = (name, state, plain, now, extra = {}) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now, ...extra });
const ASK = pane('The schema change is ready.\nShould I rename the column or keep both?\nSTATUS: needs-owner: rename or keep both?');

test('roundtripRecord: shape, owner-only classes, clamped wait', () => {
  assert.equal(roundtripRecord({ id: 'a', session: 's', at: 0, answeredAt: 5, reachedOwner: false }), null);
  const r = roundtripRecord({ id: 'a', session: 's', at: 1000, answeredAt: 61000, cls: 'owner_decision', by: 'owner-voice', via: 'voice', resolution: 'answered', reachedOwner: true });
  assert.deepEqual({ ...r }, { id: 'a', session: 's', machine: 'local', at: '1970-01-01T00:00:01.000Z', answered_at: '1970-01-01T00:01:01.000Z', wait_s: 60, class: 'owner_decision', by: 'owner-voice', via: 'voice', resolution: 'answered' });
  assert.equal(roundtripRecord({ id: 'a', session: 's', at: 5000, answeredAt: 1000, reachedOwner: true }).wait_s, 0);   // an answer "before" the stop never goes negative
  assert.equal(roundtripRecord({ id: 'a', session: 's', at: 0, answeredAt: 9, by: 'someone', reachedOwner: true }).by, 'owner');
});

test('summarizeRoundtrips: median / mean per class, owner waits only', () => {
  const rec = (cls, wait, by = 'owner', resolution = 'answered') => ({ class: cls, wait_s: wait, by, resolution });
  const s = summarizeRoundtrips([rec('owner_decision', 60), rec('owner_decision', 180), rec('permission', 600), rec('continue', 5, 'manager'), rec('owner_decision', 9999, 'owner', 'superseded')], { hours: 24 });
  assert.equal(s.owner_stops, 3);
  assert.equal(s.median_s, 180);
  assert.equal(s.mean_s, 280);
  assert.deepEqual(s.byClass.owner_decision, { n: 2, median_s: 120, mean_s: 120 });
  assert.match(s.text, /^owner waits today: median 3 min, mean 5 min over 3 stops/);
  assert.equal(summarizeRoundtrips([], { hours: 24 }).text, null);
  assert.match(summarizeRoundtrips([rec('permission', 120)], { hours: 6 }).text, /^owner waits in the last 6 hours: median 2 min, mean 2 min over 1 stop/);
});

test('a stop the owner answered is recorded when the session moves on', async () => {
  const t0 = Date.now();
  tick('rt1', 'working', ['busy'], t0 - 90000);
  tick('rt1', 'done', ASK, t0 - 60000); tick('rt1', 'done', ASK, t0 - 50000);
  await settle(300);
  m.noteAnswerer('rt1', 'owner-voice');
  tick('rt1', 'working', ['busy'], t0, { realWork: true, lastSendAt: t0 - 10000, lastSendText: 'keep both' });
  const r = await until((x) => x.session === 'rt1');
  assert.equal(r.by, 'owner-voice'); assert.equal(r.via, 'voice'); assert.equal(r.resolution, 'answered'); assert.equal(r.class, 'owner_decision');
  assert.equal(r.machine, 'local');
  assert.ok(r.wait_s === 40, `wait ${r.wait_s}`);
  await settle(100);
  assert.equal(ledger().filter((x) => x.session === 'rt1').length, 1, 'one record per stop');
});

test('a stop replaced by a newer one is recorded as superseded; a removed session too; plain done stops are not', async () => {
  const t0 = Date.now();
  tick('rt2', 'working', ['busy'], t0 - 9e4);
  tick('rt2', 'done', ASK, t0 - 8e4); tick('rt2', 'done', ASK, t0 - 7e4);
  await settle(300);
  const ASK2 = pane('Different problem now.\nShall I delete the staging copy or leave it?\nSTATUS: needs-owner: delete or leave?');
  tick('rt2', 'done', ASK2, t0 - 6e4); tick('rt2', 'done', ASK2, t0 - 5e4);
  const sup = await until((x) => x.session === 'rt2' && x.resolution === 'superseded');
  assert.equal(sup.by, 'owner'); assert.equal(sup.via, 'none');
  await settle(300);
  m.forget('rt2');
  await until((x) => x.session === 'rt2' && x.resolution === 'removed');
  tick('rt3', 'working', ['busy'], t0 - 9e4);
  const PLAIN = pane('All done, tests pass.\nSTATUS: done');
  tick('rt3', 'done', PLAIN, t0 - 8e4); tick('rt3', 'done', PLAIN, t0 - 7e4);
  await settle(300);
  m.forget('rt3');
  await settle(100);
  assert.equal(ledger().filter((x) => x.session === 'rt3').length, 0);
});

test('createRoundtrips.read filters by time and tolerates junk lines; the view summarises', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'ghosty-rt2-'));
  const rt = createRoundtrips({ file: join(d2, 'x.jsonl') });
  await rt.record(roundtripRecord({ id: 'old', session: 's', at: 1000, answeredAt: 2000, reachedOwner: true }));
  await rt.record(roundtripRecord({ id: 'new', session: 's', at: Date.now() - 1000, answeredAt: Date.now(), reachedOwner: true }));
  const got = await rt.read({ sinceMs: Date.now() - 3600e3 });
  assert.deepEqual(got.map((r) => r.id), ['new']);
  const v = await m.roundtripsView({ hours: 24 });
  assert.equal(v.hours, 24); assert.ok(Array.isArray(v.records)); assert.ok(v.summary.count >= 1);
});

test('every actor is recorded: manager-agent and own-job wakes are manager, a mockup object is the owner, only real owner sends are by owner', async () => {
  const t0 = Date.now();
  const cases = [['rt-agent', 'manager-agent', 'manager', 'agent'], ['rt-job', 'own-job', 'manager', 'own-job'], ['rt-mock', 'owner', 'owner', 'mockup'], ['rt-lease', 'lease-service', 'manager', 'lease-service'], ['rt-own', 'owner', 'owner', 'dashboard']];
  for (const [name, actor, by, via] of cases) {
    tick(name, 'working', ['busy'], t0 - 90000);
    tick(name, 'done', ASK, t0 - 60000); tick(name, 'done', ASK, t0 - 50000);
    await settle(300);
    m.noteAnswerer(name, actor, actor === 'owner' && name === 'rt-mock' ? 'mockup' : null);
    tick(name, 'working', ['busy'], t0, { realWork: true, lastSendAt: t0 - 10000, lastSendText: 'ok' });
    const r = await until((x) => x.session === name);
    assert.equal(r.by, by, `${actor} -> ${by}`); assert.equal(r.via, via);
  }
  const s = summarizeRoundtrips(ledger().filter((x) => x.session.startsWith('rt-')), { hours: 24 });
  assert.equal(s.owner_stops, 2, 'only the owner sends count as owner waits');
});
