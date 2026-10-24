// E58: two consumers mapped a lease holder by machine prefix only (agentSession), so a bare-named holder - the
// case E47 was about - was invisible to them: its work was unprotected and its lease was never released.
// The two call sites live in server.js (the lease-nudge's sessionOf and the central activity tick). The server
// cannot be imported here, so the test reads the two expressions out of server.js and runs them: a change at the
// call site is a change in what this test runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentSession, holderSession, machinesOf } from '../public/platforms.js';
import { classifyHolders } from '../lease-watch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'server.js'), 'utf8');
const M = machinesOf('codebox-vm');
const NOW = 1_800_000_000_000;
const SESSIONS = ['bare-session', 'other-session', 'manager'];
const NAMES = SESSIONS;

// the body of the two call sites, as server.js writes it
const body = (re) => {
  const m = re.exec(SRC);
  assert.ok(m, `server.js no longer holds the call site ${re}`);
  return m[1].trim();
};
const NUDGE = body(/sessionOf: \(agent\) => (.+),$/m);
const TICK = body(/sessionOf: \(l\) => (.+?), activityOf:/);
// run it with the same names and machines the server has
const run = (expr, { agent = null, l = null, names = NAMES, latest = { status: {} } } = {}) =>
  new Function('holderSession', 'agentSession', 'MACHINES', 'names', 'latest', 'agent', 'l', `return (${expr});`)(
    holderSession, agentSession, M, names, latest, agent, l);

test('E58: both call sites map a bare-named lease holder to its session', () => {
  assert.equal(run(NUDGE, { agent: 'bare-session', latest: { status: { 'bare-session': {} } } }), 'bare-session');
  assert.equal(run(TICK, { l: { agent: 'bare-session', session: '' } }), 'bare-session');
});

test('E58: a machine-prefixed holder still maps the same way', () => {
  assert.equal(run(NUDGE, { agent: 'codebox:bare-session', latest: { status: { 'bare-session': {} } } }), 'bare-session');
  assert.equal(run(TICK, { l: { agent: 'codebox:bare-session', session: '' } }), 'bare-session');
  assert.equal(run(TICK, { l: { agent: 'codebox:other-session', session: 'bare-session' } }), 'bare-session',
    'the lease\'s own session string still wins');
});

test('E58: a holder that cannot be identified stays unknown and is never released', () => {
  assert.equal(run(NUDGE, { agent: 'never-heard-of-it', latest: { status: { 'bare-session': {} } } }), null);
  assert.equal(run(TICK, { l: { agent: 'never-heard-of-it', session: '' } }), null);
  // and the lease watch keeps its safety direction: an unidentifiable holder has no plan, so nothing is released
  const h = classifyHolders({ leases: [{ id: 'l1', env: 'env-a', resource: '*', agent: 'never-heard-of-it', kind: 'server', since: (NOW - 3600e3) / 1000 }],
    sessionNames: NAMES, knownNames: NAMES, machines: M, now: NOW })[0];
  assert.equal(h.status, 'unknown');
  assert.equal(h.session, null);
  assert.equal(h.plan, null, 'an unknown holder is never released or narrowed');
});

test('E58: agentSession keeps its own contract (machine prefix only)', () => {
  assert.equal(agentSession('codebox:bare-session', NAMES, M), 'bare-session');
  assert.equal(agentSession('bare-session', NAMES, M), null, 'the bare name is the holder\'s job, not the agent id\'s');
  assert.equal(holderSession('bare-session', NAMES, M), 'bare-session');
});
