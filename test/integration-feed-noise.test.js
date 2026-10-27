// The owner's feed must not drown in integration notices (owner, 2026-10-23): ~40 integration events in 3 h
// filled the 50-item push feed and buried the one alert that mattered (a real question).
// A merged/deployed/superseded notice waits for the periodic digest; returned / CI red / deploy failed / cancelled stay
// individual alerts; an owner question is always pushed on its own, with its tag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPush, createAlerts, tierConfig, defaultTier } from '../push.js';
import { createIntegrationNotify, isQuietState, integrationDigestEnabled, QUIET_STATES } from '../integration-notify.js';
import { tmp } from './helpers-tmp.js';

const quiet = { error() {} };
// 2026-10-23T12:00:00Z = 14:00 in Zurich: the owner is awake, so the digest may fire.
const NOON = Date.parse('2026-10-23T12:00:00Z');

// The server wiring, without the server: the push hub, the alert fan-out, the lane notify.
function rig({ digest = true } = {}) {
  const dir = tmp('intnoise-');
  const push = createPush({ stateDir: dir, log: quiet });
  const clock = { t: NOON };
  const alerts = createAlerts({ push, now: () => clock.t, log: quiet,
    tiering: { config: () => tierConfig(), managerSessions: () => ['manager'], file: join(dir, 'push-digest.json') } });
  const events = [];
  const notify = createIntegrationNotify({
    status: () => undefined, isRemote: () => false, canSend: () => false, send: async () => {},
    feed: (item) => push.record(item),
    digest: (item) => alerts.queueDigest(`integration:${item.requestId}:${item.state}`,
      { title: item.title, body: item.body, url: item.url, meta: { session: item.session || 'lane', case: item.state, question: `${item.branch} -> ${item.target}` } }),
    quiet: (state) => digest && isQuietState(state),
    managerEvent: async (e) => { events.push(e); },
    log: () => {},
  });
  return { dir, push, alerts, notify, events, clock };
}

const request = (over = {}) => ({ id: 'int-1', repo: 'r', branch: 'feat/x', target: 'main', session: 'w1', sha: 'abcdef1234567890', ...over });

test('a merged or deployed notice takes no slot in the owner feed: it waits for the digest', async () => {
  const r = rig();
  await r.notify(request({ id: 'int-1', state: 'merged' }));
  await r.notify(request({ id: 'int-2', state: 'deployed' }));
  assert.equal(r.push.feedSince(0).length, 0, 'no feed entry, no bell slot');
  assert.equal(r.alerts.pendingDigest().length, 2, 'both wait for the digest');
  assert.equal(r.alerts.digestTick(), true);
  const feed = r.push.feedSince(0);
  assert.equal(feed.length, 1, 'one digest entry, not one per event');
  assert.equal(feed[0].tag, 'ghosty-digest');
  assert.match(feed[0].body, /feat\/x/);
  // the digest line is short: the feed entry keeps 500 chars and the owner reads it on a phone
  assert.deepEqual(feed[0].body.split('\n'), ['w1 · merged · feat/x -> main · -', 'w1 · deployed · feat/x -> main · -']);
});

test('the manager still wakes on a quiet event: manager-events.jsonl is unchanged', async () => {
  const r = rig();
  await r.notify(request({ id: 'int-1', state: 'merged' }));
  await r.notify(request({ id: 'int-2', state: 'deployed' }));
  assert.equal(r.events.length, 2);
  assert.deepEqual(r.events.map((e) => e.key), ['integration:int-1:merged', 'integration:int-2:deployed']);
});

test('a returned, CI-red, deploy-failed or cancelled request stays an individual feed entry', async () => {
  const r = rig();
  const states = ['returned', 'merged_ci_red', 'deploy_failed', 'cancelled'];
  for (const [i, state] of states.entries()) await r.notify(request({ id: `int-${i}`, state }));
  const feed = r.push.feedSince(0);
  assert.equal(feed.length, 4);
  assert.deepEqual(feed.map((f) => f.tag), ['integration-int-0', 'integration-int-1', 'integration-int-2', 'integration-int-3']);
  assert.equal(r.alerts.pendingDigest().length, 0, 'a failed request is never a digest item');
});

test('a superseded CI run needs nobody: it waits for the digest, like a merge', async () => {
  const r = rig();
  await r.notify(request({ id: 'int-1', state: 'merged_ci_superseded' }));
  assert.equal(r.push.feedSince(0).length, 0, 'no feed slot for a superseded run');
  assert.equal(r.alerts.pendingDigest().length, 1);
  assert.equal(r.events.length, 1, 'the manager still wakes on it');
});

test('an owner question is pushed on its own, with its tag, and survives 100 integration notices', async () => {
  const r = rig();
  // the key the ask-guard and scripts/manager-ask.js use
  assert.equal(r.alerts.alert('manager-agent:ask-Q1', { title: 'Needs you: Q1', body: 'Pay it?', url: '/', tag: 'ask-Q1', priority: 'high' }), true);
  assert.equal(r.alerts.pendingDigest().length, 0, 'a question is never a digest item');
  assert.deepEqual(r.push.feedSince(0).map((f) => f.tag), ['ask-Q1']);
  for (let i = 0; i < 100; i++) await r.notify(request({ id: `int-${i}`, state: i % 2 ? 'merged' : 'deployed' }));
  const feed = r.push.feedSince(0);
  assert.equal(feed.length, 1, 'the 100 integration notices took no feed slot');
  assert.equal(feed[0].tag, 'ask-Q1', 'the question is still in the feed');
});

test('the switch: manager.json integrationDigest (default on) can restore one feed entry per event', async () => {
  assert.equal(integrationDigestEnabled({}), true);
  assert.equal(integrationDigestEnabled({ integrationDigest: true }), true);
  assert.equal(integrationDigestEnabled({ integrationDigest: false }), false);
  assert.deepEqual(QUIET_STATES, ['merged', 'deployed', 'merged_ci_superseded']);
  const r = rig({ digest: false });
  await r.notify(request({ id: 'int-1', state: 'merged' }));
  assert.equal(r.push.feedSince(0).length, 1);
});

test('tier policy: an owner question is an interrupt, a plain stop is still a digest', () => {
  assert.equal(defaultTier('manager-agent:ask-Q219', { priority: 'high' }), 'interrupt');
  assert.equal(defaultTier('manager-agent:ask-Q219', {}), 'interrupt');
  assert.equal(defaultTier('s1:asks', { body: 'which colour?' }), 'digest');
  assert.equal(defaultTier('s1:asks', { body: 'P0 blocked on prod' }), 'interrupt');
});
