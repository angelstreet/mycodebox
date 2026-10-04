// TASK-47 G10: wake shadow. Jev's opinion on each manager event line, the 3 s cap, the switch, the 15 min outcome and the scorecard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagerEvents, classifyKey } from '../manager-events.js';
import { createWakeAnnotator, wakeFacts, quotaPercents, observedNeed, dueOutcomes } from '../wake-shadow.js';
import { wakeShadowSection, buildScorecard } from '../scorecard.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ghosty-wake-'));
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reply = (choice, p = 0.9, extra = {}) => ({ success: true, ms: 7, cost: 0.00001, decision_id: 'd-' + choice, answers: { choice: { choice, probabilities: { [choice]: p } } }, ...extra });

// Wires an annotator the way server.js does: facts from the event's classification, a mocked /server/ai/decide.
function rig({ call, enabled = () => true, guard = () => null, capMs = 3000, onError } = {}) {
  const annotator = createWakeAnnotator({ enabled, guard, call, capMs, onError, kindOf: (m) => (/timeout|abort/i.test(m) ? 'timeout' : 'other') });
  const annotate = (event, cls) => annotator(wakeFacts({ cls, event, priority: 'P1', stall: cls.session ? { case: 'owner_decision' } : null }));
  const dir = tmp();
  const ev = createManagerEvents({ stateDir: dir, annotate });
  return { dir, ev, file: join(dir, 'manager-events.jsonl') };
}
const alert = (key, extra = {}) => ({ key, title: key, body: 'b', url: '/', priority: 'high', ...extra });

test('annotation is present on a recorded line', async () => {
  const bodies = [];
  const r = rig({ call: async (b) => { bodies.push(b); return reply('wake_cheap'); } });
  assert.equal(await r.ev.record(alert('web:asks')), true);
  const [l] = lines(r.file);
  assert.equal(l.jev.pick, 'wake_cheap');
  assert.equal(l.jev.source, 'jev');
  assert.equal(l.jev.ruleDefault, 'rules_handle');
  assert.equal(l.jev.decision_id, 'd-wake_cheap');
  assert.ok(Number.isFinite(l.jev.ms) && l.jev.confidence === 0.9);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].usage, 'text.decision.wake');
  assert.equal(JSON.parse(bodies[0].state).event.session, 'web');
});

test('skipped events (manager-agent, done, manager session) are not asked', async () => {
  let calls = 0;
  const r = rig({ call: async () => { calls++; return reply('ignore'); } });
  assert.equal(await r.ev.record(alert('manager-agent:x')), false);
  assert.equal(await r.ev.record(alert('web:done')), false);
  assert.equal(calls, 0);
});

test('a guard reason writes jev.skipped with the rule default and makes no call', async () => {
  let calls = 0;
  const r = rig({ call: async () => { calls++; return reply('ignore'); }, guard: () => 'daily budget reached' });
  await r.ev.record(alert('web:asks'));
  assert.deepEqual(lines(r.file)[0].jev, { skipped: 'daily budget reached', ruleDefault: 'rules_handle' });
  assert.equal(calls, 0);
});

test('3 s cap: a hanging Jev call still writes the line (jev.error timeout)', async () => {
  const r = rig({ call: () => new Promise(() => {}), capMs: 80 });
  const t = Date.now();
  await r.ev.record(alert('web:asks'));
  assert.ok(Date.now() - t < 1000);
  const [l] = lines(r.file);
  assert.equal(l.jev.error, 'timeout');
  assert.equal(l.jev.ruleDefault, 'rules_handle');
});

test('a failing call is an error kind, never a lost line', async () => {
  const r = rig({ call: async () => { throw new Error('fetch failed ECONN'); } });
  await r.ev.record(alert('web:asks'));
  assert.equal(lines(r.file)[0].jev.error, 'other');
  const r2 = rig({ call: async () => ({ success: false, error: '402 insufficient credits' }) });
  const seen = [];
  const r3 = rig({ call: async () => ({ success: false, error: 'x' }), onError: (k) => seen.push(k) });
  await r2.ev.record(alert('web:asks')); await r3.ev.record(alert('web:asks'));
  assert.ok(lines(r2.file)[0].jev.error);
  assert.deepEqual(seen, ['other']);
});

test('concurrent events: one slow call does not block the others and none is lost', async () => {
  let n = 0;
  const r = rig({ call: async () => { const me = ++n; if (me === 1) await sleep(300); return reply('wake_cheap'); } });
  const t = Date.now();
  const p = [r.ev.record(alert('a:asks')), r.ev.record(alert('b:asks')), r.ev.record(alert('c:asks')), r.ev.record(alert('d:waiting'))];
  await p[1];
  assert.ok(Date.now() - t < 250, 'fast events did not wait for the slow one');
  await Promise.all(p);
  const keys = lines(r.file).map((l) => l.key).sort();
  assert.deepEqual(keys, ['a:asks', 'b:asks', 'c:asks', 'd:waiting']);
  assert.ok(lines(r.file).every((l) => l.jev.pick === 'wake_cheap'));
});

test('switch off: no call and lines identical to a feed without annotation, minus jev', async () => {
  let calls = 0;
  const off = rig({ call: async () => { calls++; return reply('wake_opus'); }, enabled: () => false });
  const dir = tmp();
  const plain = createManagerEvents({ stateDir: dir });
  const e = alert('web:asks', { at: '2026-10-04T10:00:00.000Z' });
  await off.ev.record(e); await plain.record(e);
  assert.equal(calls, 0);
  assert.deepEqual(lines(off.file), lines(join(dir, 'manager-events.jsonl')));
  assert.equal('jev' in lines(off.file)[0], false);
});

test('floor: a forced pick makes no call (source forced)', async () => {
  // router.js's wake floor forces nothing today; prove the path with a floor that does by checking the annotator contract directly
  const { POINTS } = await import('../router.js');
  const orig = POINTS.wake.floor;
  POINTS.wake.floor = () => ({ allowed: ['wake_opus'], forced: 'wake_opus', reasons: ['test'] });
  try {
    let calls = 0, guards = 0;
    const a = createWakeAnnotator({ call: async () => { calls++; return reply('ignore'); }, guard: () => { guards++; return 'x'; } });
    const j = await a(wakeFacts({ cls: classifyKey('web:asks'), event: {} }));
    assert.equal(j.source, 'forced'); assert.equal(j.pick, 'wake_opus'); assert.equal(calls, 0); assert.equal(guards, 0);
  } finally { POINTS.wake.floor = orig; }
});

test('hot floor (P0 blocked / deploy failed / disk 96 %) only allows wake picks; facts carry the context', async () => {
  const bodies = [];
  const a = createWakeAnnotator({ call: async (b) => { bodies.push(b); return reply('wake_cheap'); } });
  await a(wakeFacts({ cls: classifyKey('web:asks'), event: {}, priority: 'P0', stall: { case: 'permission', forbidden: 'deploy', escalated: true }, agent: 'claude' }));
  const f = JSON.parse(bodies[0].state).event;
  assert.equal(f.p0_blocked, true); assert.equal(f.forbidden_topic, 'deploy'); assert.equal(f.escalated, true); assert.equal(f.agent, 'claude'); assert.equal(f.priority, 'P0');
  assert.deepEqual(Object.keys(bodies[0].questions.choice.criteria), ['wake_cheap', 'wake_opus']);
  const d = wakeFacts({ cls: classifyKey('deploy:ab:failed'), event: {} });
  assert.equal(d.deploy.state, 'failed');
  assert.equal(wakeFacts({ cls: classifyKey('disk:/'), event: {}, diskPct: 96 }).disk_pct, 96);
  assert.deepEqual(quotaPercents({ plans: [{ plan: 'claude', windows: [{ name: '5h', usedPercent: 97 }, { name: 'week', usedPercent: null }] }] }), { 'claude:5h': 97 });
});

// ---- outcome ----
const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const at = (min) => new Date(T0 + min * 60e3).toISOString();
const ev = (key, extra = {}) => ({ at: at(0), key, kind: classifyKey(key).kind, ...(classifyKey(key).session ? { session: classifyKey(key).session } : {}), ...extra });

test('outcome: needed by a manager send, by an owner send, by a manager-agent alert; not needed otherwise', () => {
  const e = ev('web:asks');
  const c = classifyKey(e.key);
  assert.equal(observedNeed(e, c, [{ type: 'send', at: at(3), session: 'web', by: 'manager-agent', text: 'Yes' }]), 'needed');
  assert.equal(observedNeed(e, c, [{ type: 'send', at: at(3), session: 'web', by: 'owner', text: 'go' }]), 'needed');
  assert.equal(observedNeed(e, c, [{ type: 'outcome', at: at(9), session: 'web', via: 'terminal' }]), 'needed');
  assert.equal(observedNeed(e, c, [{ type: 'answer', at: at(1), session: 'web' }]), 'needed');
  assert.equal(observedNeed(e, c, [{ type: 'agent-alert', at: at(2), title: 'web needs a decision', body: '' }]), 'needed');
  assert.equal(observedNeed(e, c, []), 'not_needed');
  assert.equal(observedNeed(e, c, [{ type: 'send', at: at(16), session: 'web', by: 'owner' }]), 'not_needed', 'after the window');
  assert.equal(observedNeed(e, c, [{ type: 'send', at: at(3), session: 'other', by: 'owner' }]), 'not_needed', 'another session');
  assert.equal(observedNeed(e, c, [{ type: 'agent-alert', at: at(2), title: 'webapp slow', body: '' }]), 'not_needed', 'name must match whole');
  assert.equal(observedNeed(e, c, [{ type: 'send', at: at(-1), session: 'web', by: 'owner' }]), 'not_needed', 'before the event');
});

test('outcome: deploy / quota / disk / credits events', () => {
  const d = ev('deploy:ab12:failed'), dc = classifyKey(d.key);
  assert.equal(observedNeed(d, dc, [{ type: 'deploy_action', at: at(4), id: 'ab12', action: 'approve', by: 'owner' }]), 'needed');
  assert.equal(observedNeed(d, dc, [{ type: 'deploy_action', at: at(4), id: 'zz', action: 'approve', by: 'owner' }]), 'not_needed');
  assert.equal(observedNeed(d, dc, [{ type: 'agent-alert', at: at(4), title: 'deploy ab12 failed', body: '' }]), 'needed');
  const q = ev('quota:claude:5h'), qc = classifyKey(q.key);
  assert.equal(observedNeed(q, qc, [{ type: 'agent-alert', at: at(5), title: 'Claude quota high', body: '' }]), 'needed');
  assert.equal(observedNeed(q, qc, [{ type: 'send', at: at(5), session: 'web', by: 'owner' }]), 'not_needed');
  assert.equal(observedNeed(ev('disk:/'), classifyKey('disk:/'), [{ type: 'agent-alert', at: at(5), title: 'disk almost full', body: '' }]), 'needed');
  assert.equal(observedNeed(ev('openrouter:credits'), classifyKey('openrouter:credits'), [{ type: 'agent-alert', at: at(5), title: 'credits low', body: '' }]), 'needed');
});

test('dueOutcomes: only events past the window, once (restart-safe: derived from the records)', () => {
  const events = [ev('web:asks'), ev('api:asks', { at: at(10) })];
  const recs = [{ type: 'send', at: at(2), session: 'web', by: 'owner' }];
  const due = dueOutcomes({ events, recs, classify: classifyKey, now: T0 + 20 * 60e3 });
  assert.equal(due.length, 1);
  assert.deepEqual([due[0].event.key, due[0].label], ['web:asks', 'needed']);
  const again = dueOutcomes({ events, recs: [...recs, { type: 'wake_outcome', event_key: due[0].key, label: 'needed' }], classify: classifyKey, now: T0 + 20 * 60e3 });
  assert.equal(again.length, 0);
  assert.equal(dueOutcomes({ events, recs, classify: classifyKey, now: T0 + 30 * 60e3 }).length, 2, 'both due later');
  assert.equal(dueOutcomes({ events, recs, classify: classifyKey, now: T0 + 3 * 86400e3 }).length, 0, 'too old to label');
});

// ---- scorecard ----
test('scorecard wakeShadow: counts, agreement, misses and false alarms by kind, rule default on the same events', () => {
  const E = (min, key, jev) => ({ at: at(min), key, kind: classifyKey(key).kind, ...(jev ? { jev } : {}) });
  const wk = (pick, rule = 'rules_handle') => ({ pick, confidence: 0.9, source: 'jev', ruleDefault: rule });
  const eventRecs = [
    E(0, 'a:asks', wk('wake_cheap')),                       // needed, jev wake  -> agree ; rule no-wake -> miss
    E(1, 'b:asks', wk('ignore')),                           // needed, jev no    -> miss ; rule no-wake -> miss
    E(2, 'c:asks', wk('wake_opus')),                        // not needed, jev wake -> false alarm ; rule no-wake agree
    E(3, 'd:asks', wk('rules_handle', 'wake_opus')),        // not needed, jev no -> agree ; rule wake -> false alarm
    E(4, 'quota:x:5h', { skipped: 'daily budget reached', ruleDefault: 'rules_handle' }),
    E(5, 'disk:/', { error: 'timeout', ruleDefault: 'rules_handle' }),
    E(6, 'e:asks'),                                         // no annotation
    E(7, 'f:asks', wk('wake_cheap')),                       // no label yet -> pending
  ];
  const lab = (e, label) => ({ type: 'wake_outcome', event_key: `${e.at}|${e.key}`, label });
  const stallRecs = [lab(eventRecs[0], 'needed'), lab(eventRecs[1], 'needed'), lab(eventRecs[2], 'not_needed'), lab(eventRecs[3], 'not_needed'), lab(eventRecs[4], 'not_needed')];
  const s = wakeShadowSection({ eventRecs, stallRecs, from: T0 - 1, to: T0 + 86400e3 });
  assert.equal(s.events, 8); assert.equal(s.annotated, 5); assert.equal(s.skipped, 1); assert.equal(s.errors, 1); assert.equal(s.unannotated, 1);
  assert.deepEqual(s.jevSays, { wake: 3, noWake: 2 });
  assert.deepEqual(s.observed, { needed: 2, notNeeded: 3, pending: 3 });
  assert.equal(s.jev.n, 4); assert.equal(s.jev.agree, 2); assert.equal(s.jev.agreement, 0.5);
  assert.deepEqual(s.jev.misses, { count: 1, byKind: { asks: 1 } });
  assert.deepEqual(s.jev.falseAlarms, { count: 1, byKind: { asks: 1 } });
  assert.equal(s.rule.n, 4); assert.equal(s.rule.agree, 1); assert.equal(s.rule.agreement, 0.25);
  assert.equal(s.rule.misses.count, 2); assert.equal(s.rule.falseAlarms.count, 1);
  // window filter, and it is part of the scorecard
  assert.equal(wakeShadowSection({ eventRecs, stallRecs, from: T0 + 86400e3, to: T0 + 2 * 86400e3 }).events, 0);
  const sc = buildScorecard({ eventRecs, stallRecs, from: T0 - 1, to: T0 + 86400e3 });
  assert.equal(sc.wakeShadow.annotated, 5);
});
