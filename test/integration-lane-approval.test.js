// Approval identity (2026-10-20): a working session approved its own update_core change by passing `--approved-by manager`.
// Only a manager session may approve now: another session's claim is ignored, the request is evaluated as if none was
// given (so a floor still returns it), the attempt is stored as approvalRefused and the manager gets one event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationLane } from '../integration-lane.js';
import { makeWorld } from './helpers-lane.js';
import { tmp } from './helpers-tmp.js';

const MANAGERS = ['manager'];

const mk = (w, o = {}) => {
  const stateDir = o.stateDir || tmp('lane-approval-');
  const events = [], items = [], journal = [];
  const lane = createIntegrationLane({ stateDir, config: { repos: { 'env-a': w.cfg(o.cfg) } }, notify: (r, e) => events.push({ id: r.id, ...e }),
    managerItem: (it) => items.push(it), journal: (j) => journal.push(j),
    pollMs: 1, sleep: () => new Promise((r) => setTimeout(r, 1)), ...o.lane });
  lane.start();
  return { lane, stateDir, events, items, journal, refusals: () => items.filter((i) => String(i.key || '').startsWith('lane:self-approval:')) };
};
const go = async (lane, input, ms = 30000) => { const q = lane.enqueue({ repo: 'env-a', ...input }); return lane.wait(q.id, ms); };

test('a manager session may approve: the approval is honoured and journaled', async () => {
  const w = makeWorld(); w.branch('infra', { 'scripts/update_core.sh': 'echo\n' });
  const { lane, items, journal } = mk(w, { lane: { managerSessions: () => MANAGERS } });
  const r = await go(lane, { branch: 'infra', session: 'manager', approvedBy: 'manager' });
  assert.equal(r.state, 'merged', JSON.stringify(r));
  assert.equal(r.approvedBy, 'manager'); assert.ok(r.approvedAt);
  assert.equal(r.approvalRefused, undefined, 'nothing refused');
  const appr = journal.filter((j) => j.approvedBy);
  assert.equal(appr.length, 1, JSON.stringify(journal.map((j) => j.decision_id)));
  assert.equal(appr[0].kind, 'merge'); assert.equal(appr[0].request, r.id);
  assert.equal(items.filter((i) => String(i.key || '').startsWith('lane:self-approval:')).length, 0, 'no refusal event');
  lane.stop();
});

test('a non-manager session is refused: no approval, one manager event, and the floor still returns the request', async () => {
  const w = makeWorld(); w.branch('infra', { 'scripts/update_core.sh': 'echo\n' });
  const { lane, items, journal, refusals } = mk(w, { lane: { managerSessions: () => MANAGERS } });
  const before = w.main();
  const q = lane.enqueue({ repo: 'env-a', branch: 'infra', session: 'worker', approvedBy: 'manager', migrationApplied: true });
  assert.equal(q.approvalIgnored, true, 'the caller is told the claim was ignored');
  assert.equal(q.approvalRefused.by, 'manager'); assert.equal(q.approvalRefused.session, 'worker');
  const r = await lane.wait(q.id, 30000);
  assert.equal(r.state, 'returned', JSON.stringify(r));
  assert.equal(r.outcome, 'needs_approval', 'the infra-path floor returns it exactly as without an approval');
  assert.equal(w.main(), before, 'nothing merged');
  assert.equal(r.approvedBy, undefined, 'the approval was not honoured');
  assert.equal(r.migrationApplied, undefined, 'nor the attestation that goes with it');
  assert.equal(r.approvalRefused.by, 'manager'); assert.equal(r.approvalRefused.session, 'worker'); assert.ok(r.approvalRefused.at);
  assert.equal(journal.filter((j) => j.approvedBy).length, 0, 'no approval decision record');
  const ev = refusals();
  assert.equal(ev.length, 1, JSON.stringify(items.map((i) => i.key)));
  assert.equal(ev[0].key, `lane:self-approval:${r.id}`);
  assert.equal(ev[0].title, 'worker passed --approved-by on infra');
  assert.match(ev[0].body, /ignored/); assert.match(ev[0].body, /only a manager session may approve/);
  lane.stop();
});

test('a coalesce carrying a claim from another session is refused the same way, once', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const { lane, journal, refusals } = mk(w, { cfg: { settleMs: 5000 }, lane: { managerSessions: () => MANAGERS } });
  const first = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 'worker' });
  assert.equal(lane.get(first.id).state, 'queued');
  const again = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 'worker', approvedBy: 'manager' });
  assert.equal(again.id, first.id, 'coalesced into the queued request');
  assert.equal(again.coalesced, true);
  assert.equal(again.approvalIgnored, true);
  const r = lane.get(first.id);
  assert.equal(r.approvedBy, undefined, 'the newest claim did not become an approval');
  assert.equal(r.approvalRefused.by, 'manager'); assert.equal(r.approvalRefused.session, 'worker');
  assert.equal(journal.filter((j) => j.approvedBy).length, 0, 'a refused claim is not journaled');
  // repeating the same claim on the same request must not fill the manager's feed
  lane.enqueue({ repo: 'env-a', branch: 'feat', session: 'worker', approvedBy: 'manager' });
  const ev = refusals();
  assert.equal(ev.length, 1, JSON.stringify(ev.map((e) => e.key)));
  assert.equal(ev[0].key, `lane:self-approval:${r.id}`);
  lane.stop();
});

test('a claim from a caller that names no session is refused, even on a manager session\'s request', async () => {
  const w = makeWorld(); w.branch('feat', { 'new.js': 'x\n' });
  const { lane, journal, refusals } = mk(w, { cfg: { settleMs: 5000 }, lane: { managerSessions: () => MANAGERS } });
  const first = lane.enqueue({ repo: 'env-a', branch: 'feat', session: 'manager' });
  const again = lane.enqueue({ repo: 'env-a', branch: 'feat', approvedBy: 'manager' });   // no session of its own
  assert.equal(again.id, first.id);
  assert.equal(again.approvalIgnored, true, 'the manager\'s own session name does not carry an unnamed caller');
  const r = lane.get(first.id);
  assert.equal(r.approvedBy, undefined);
  assert.equal(r.approvalRefused.session, null);
  assert.equal(journal.filter((j) => j.approvedBy).length, 0);
  assert.equal(refusals().length, 1);
  assert.match(refusals()[0].title, /^an unnamed session passed --approved-by on feat$/);
  lane.stop();
});

test('without the managerSessions option every caller keeps today\'s behaviour', async () => {
  const w = makeWorld(); w.branch('infra', { 'scripts/update_core.sh': 'echo\n' });
  const { lane, journal, items } = mk(w);   // no managerSessions: an older wiring
  const r = await go(lane, { branch: 'infra', session: 'worker', approvedBy: 'manager' });
  assert.equal(r.state, 'merged', JSON.stringify(r));
  assert.equal(r.approvedBy, 'manager'); assert.ok(r.approvedAt);
  assert.equal(r.approvalRefused, undefined);
  assert.equal(journal.filter((j) => j.approvedBy).length, 1);
  assert.equal(items.filter((i) => String(i.key || '').startsWith('lane:self-approval:')).length, 0);
  lane.stop();
});