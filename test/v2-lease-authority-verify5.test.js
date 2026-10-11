// Independent verification round 5 (2cf2855, D-015/D-016): caller-supplied lease ids, the write-ahead + adopt()
// recovery pattern, and the controller-lease takeover pattern reproduced with the lease authority alone.
// Tests marked `todo: 'defect: ...'` assert the behaviour the design promises and report as todo until fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaseAuthority, fileBackend, fakeBackend } from '../orchestration/lease-authority.js';
import { deadControllerIntents } from '../orchestration/goal-loop.js';

const tmp = () => mkdtemp(join(tmpdir(), 'v2-lease-verify5-'));
const W = 'worktree:task-4';
const C = 'service:node-a:goal-loop';
const id = { owner: 'goal-loop', task_id: 'task-4' };
const wopts = (extra = {}) => ({ ...id, ttl_ms: 60_000, scope: 'worktree', ...extra });
const clock = (t = 1_800_000_000_000) => { const c = () => c.t; c.t = t; return c; };
const lid = (n) => `wt-task-4-${String(n).padStart(12, '0')}`;

// --- caller-supplied lease ids ------------------------------------------------------------------------------------------

test('lease_id: format is enforced before anything is touched; the held check wins over the reuse check', async () => {
  const backend = fakeBackend();
  const auth = createLeaseAuthority({ backend });
  for (const bad of ['', 'short', 'x'.repeat(129), 'has space 0123456789', 'slash/0123456789012', 'nul\u00000123456789012', 42, {}]) {
    const r = await auth.acquire(W, wopts({ lease_id: bad }));
    assert.equal(r.code, 'E_INVALID', JSON.stringify(bad));
  }
  assert.equal(backend.records.size, 0);
  for (const good of ['a'.repeat(16), 'wt-task-4:v2.0_x-000001', 'x'.repeat(128)]) {
    const r = await auth.acquire(`worktree:t-${good.length}`, wopts({ task_id: `t-${good.length}`, lease_id: good }));
    assert.ok(r.ok, good);
    assert.equal(r.lease.lease_id, good);
  }
  const a = await auth.acquire(W, wopts({ lease_id: lid(1) }));
  assert.ok(a.ok);
  const again = await auth.acquire(W, wopts({ lease_id: lid(1) }));
  assert.equal(again.code, 'E_HELD', 'a live holder answers E_HELD, never "reused" (which would confirm the id)');
});

for (const kind of ['fake', 'file']) {
  test(`lease_id (${kind}): an id is granted once per resource, by anyone, across release/renew/expiry; other resources are independent`, async () => {
    const c = clock();
    const dir = await tmp();
    const backend = kind === 'fake' ? fakeBackend({ now: c }) : fileBackend({ dir, now: c });
    const auth = createLeaseAuthority({ backend, now: c });
    const a = await auth.acquire(W, wopts({ lease_id: lid(1), ttl_ms: 1000 }));
    assert.ok(a.ok);
    assert.ok((await auth.renew(a.lease)).ok);
    assert.ok((await auth.release(a.lease)).ok);
    assert.equal((await auth.acquire(W, wopts({ lease_id: lid(1) }))).code, 'E_INVALID', 'same owner, after release');
    assert.equal((await auth.acquire(W, { owner: 'mallory', task_id: 'task-4', ttl_ms: 1000, lease_id: lid(1) })).code, 'E_INVALID', 'other owner');
    const b = await auth.acquire(W, wopts({ lease_id: lid(2), ttl_ms: 1000 }));
    assert.ok(b.ok);
    c.t += 5000;                                                           // expired, nobody released
    assert.equal((await auth.acquire(W, wopts({ lease_id: lid(2) }))).code, 'E_INVALID', 'expired holder\'s id');
    assert.equal((await auth.acquire(W, wopts({ lease_id: lid(1) }))).code, 'E_INVALID', 'older id still remembered');
    const d = await auth.acquire(W, wopts({ lease_id: lid(3) }));
    assert.ok(d.ok);
    assert.equal(d.lease.token, 3, 'a rejected reuse never burns a generation');
    assert.ok((await auth.acquire('worktree:task-5', wopts({ task_id: 'task-5', lease_id: lid(1) }))).ok, 'ids are per resource');
    if (kind === 'file') {
      const rec = JSON.parse(await readFile(join(dir, `${encodeURIComponent(W)}.lease.json`), 'utf8'));
      assert.deepEqual(rec.used_ids, [lid(1), lid(2), lid(3)]);
    }
    assert.ok(backend.kind === 'file' || backend.auditLog.some((e) => e.op === 'denied' && e.reason === 'lease_id reused' && e.owner === 'mallory'));
  });
}

test('lease_id: the 256-window bound; a reused id beyond it is granted again but never resurrects the old grant', async () => {
  const c = clock();
  const backend = fakeBackend({ now: c });
  const auth = createLeaseAuthority({ backend, now: c });
  const first = await auth.acquire(W, wopts({ lease_id: lid(0) }));
  await auth.release(first.lease);
  for (let i = 1; i <= 256; i++) { const r = await auth.acquire(W, wopts({ lease_id: lid(i) })); assert.ok(r.ok, String(i)); await auth.release(r.lease); }
  assert.equal(backend.records.get(W).used_ids.length, 256);
  assert.equal((await auth.acquire(W, wopts({ lease_id: lid(1) }))).code, 'E_INVALID', 'still inside the window');
  const again = await auth.acquire(W, wopts({ lease_id: lid(0) }));          // fell out of the window
  assert.ok(again.ok);
  assert.equal(again.lease.token, 258);
  // a stale intent for lid(0) now adopts the *new* grant (same owner/task), not the old token
  const ad = await auth.adopt({ resource: W, lease_id: lid(0), ...id });
  assert.ok(ad.ok);
  assert.equal(ad.lease.token, 258);
  assert.equal((await auth.validate(first.lease)).code, 'E_FENCED', 'the old grant (token 1) is gone for good');
});

test('lease_id: records written before D-015 (no used_ids) keep working and start tracking', async () => {
  const backend = fakeBackend();
  const auth = createLeaseAuthority({ backend });
  const a = await auth.acquire(W, wopts());                                   // authority-generated id, used_ids = [id]
  delete backend.records.get(W).used_ids;
  await auth.release(a.lease);
  assert.equal(backend.records.get(W).used_ids, undefined);
  const b = await auth.acquire(W, wopts({ lease_id: lid(9) }));
  assert.ok(b.ok);
  assert.deepEqual(backend.records.get(W).used_ids, [lid(9)]);
});

// --- write-ahead + adopt(): crash windows at the authority level --------------------------------------------------------

test('write-ahead: every crash point between "intent persisted" and "grant persisted" is recoverable or fenced, never double-granted', async () => {
  const c = clock();
  const backend = fakeBackend({ now: c });
  const auth = createLeaseAuthority({ backend, now: c, opTimeoutMs: 20 });
  const intent = { resource: W, lease_id: lid(1), ...id };
  // (1) crashed after writing the intent, before acquire: nothing granted, the id is still usable by this owner
  assert.equal((await auth.adopt(intent)).code, 'E_FENCED');
  // (2) acquire committed but the answer was lost (timeout) -> adopt by the persisted id
  const slow = { ...backend, async update(...a) { const out = await backend.update(...a); await new Promise((r) => setTimeout(r, 40)); return out; } };
  const slowAuth = createLeaseAuthority({ backend: slow, now: c, opTimeoutMs: 20 });
  const t = await slowAuth.acquire(W, wopts({ lease_id: lid(1) }));
  assert.equal(t.code, 'E_UNAVAILABLE');
  assert.deepEqual(t.attempted, intent);
  await new Promise((r) => setTimeout(r, 50));
  const ad = await auth.adopt(intent);
  assert.ok(ad.ok);
  assert.equal(ad.lease.lease_id, lid(1));
  // (3) a retry of the same acquire after the crash cannot create a second grant under the same id
  assert.equal((await auth.acquire(W, wopts({ lease_id: lid(1) }))).code, 'E_HELD');
  await auth.release(ad.lease);
  assert.equal((await auth.acquire(W, wopts({ lease_id: lid(1) }))).code, 'E_INVALID');
  // (4) a twin that wrote its own intent and acquired in the meantime is not adoptable by the first's intent
  const twin = await auth.acquire(W, wopts({ lease_id: lid(2) }));
  assert.ok(twin.ok);
  assert.equal((await auth.adopt(intent)).code, 'E_FENCED');
  assert.ok(backend.auditLog.some((e) => e.op === 'denied' && e.action === 'adopt' && e.owner === 'goal-loop'));
  assert.ok(!backend.auditLog.some((e) => e.op === 'denied' && e.action === 'adopt' && e.lease_id), 'denied adopt never logs the claimed id');
});

test('adopt: guessed ids against a live holder are fenced and audited; expired holder is E_EXPIRED; foreign owner/task fenced', async () => {
  const c = clock();
  const backend = fakeBackend({ now: c });
  const auth = createLeaseAuthority({ backend, now: c });
  const a = await auth.acquire(W, wopts({ ttl_ms: 1000 }));                 // authority-generated UUID
  for (const guess of [lid(1), a.lease.lease_id.slice(0, -1) + 'x', a.lease.lease_id.toUpperCase()]) {
    assert.equal((await auth.adopt({ resource: W, lease_id: guess, ...id })).code, 'E_FENCED', guess);
  }
  assert.equal((await auth.adopt({ resource: W, lease_id: a.lease.lease_id, owner: 'mallory', task_id: 'task-4' })).code, 'E_FENCED');
  assert.equal((await auth.adopt({ resource: W, lease_id: a.lease.lease_id, owner: 'goal-loop', task_id: 'task-9' })).code, 'E_FENCED');
  assert.equal(backend.auditLog.filter((e) => e.op === 'denied' && e.action === 'adopt').length, 5);
  c.t += 1000;
  assert.equal((await auth.adopt({ resource: W, lease_id: a.lease.lease_id, ...id })).code, 'E_EXPIRED');
});

// --- D-016 controller lease: the takeover pattern, reproduced with the authority alone ----------------------------------

// Mirrors goal-loop.js holdController({ takeover: true }) after the round-5 fix (Z1): write intent (pid, host,
// heartbeat) -> acquire -> on E_HELD adopt only intents the goal loop's own deadControllerIntents() rule calls dead
// (process gone on this host, or no heartbeat for 2 intervals), release, acquire again.
const HOST = 'node-a';
const livePids = new Set();
function controller(auth, intents, instance, { pid, alive = true, now = () => 0 } = {}) {
  const p = pid ?? 10_000 + intents.size;
  if (alive) livePids.add(p); else livePids.delete(p);
  const intent = { resource: C, lease_id: `ctl-${instance}-0000000001`, owner: 'goal-loop', task_id: null, instance, pid: p, host: HOST, heartbeat_at: now() };
  intents.set(instance, intent);
  return {
    intent,
    die() { livePids.delete(p); },
    async hold() {
      const opts = { owner: 'goal-loop', ttl_ms: 60_000, scope: `controller ${instance}`, lease_id: intent.lease_id };
      let a = await auth.acquire(C, opts);
      if (!a.ok && a.code === 'E_HELD') {
        const others = [...intents.values()].filter((x) => x.instance !== instance);
        for (const pi of deadControllerIntents(others, { hostname: HOST, isAlive: (x) => livePids.has(x), now: now(), heartbeatMs: 20_000 })) {
          const ad = await auth.adopt({ resource: pi.resource, lease_id: pi.lease_id, owner: pi.owner, task_id: null });
          intents.delete(pi.instance);
          if (ad.ok) { await auth.release(ad.lease); break; }
        }
        a = await auth.acquire(C, opts);
      }
      return a;
    },
  };
}

test('D-016 takeover: a second instance\'s recover() displaces a live controller through its intent file',
  async () => {
    const auth = createLeaseAuthority({ backend: fakeBackend() });
    const intents = new Map();
    const live = controller(auth, intents, 'inst-live');
    const first = await live.hold();
    assert.ok(first.ok);
    const second = await controller(auth, intents, 'inst-second').hold();
    assert.equal(second.ok, false, 'a live controller must not be displaced');
    assert.equal(second.code, 'E_HELD');
    assert.deepEqual(await auth.validate(first.lease), { ok: true });
  });

test('D-016 takeover: two restarting instances each see the other\'s fresh intent; the acquire loser displaces the winner',
  async () => {
    const c = clock();
    const backend = fakeBackend({ now: c });
    const auth = createLeaseAuthority({ backend, now: c });
    const intents = new Map();
    const dead = controller(auth, intents, 'inst-dead', { now: c });
    const d = await dead.hold();
    assert.ok(d.ok);
    dead.die();                                      // its process exits
    c.t += 30_000;                                   // the dead instance's lease is still live when the restarts happen
    const A = controller(auth, intents, 'inst-A', { now: c }), B = controller(auth, intents, 'inst-B', { now: c });
    const a = await A.hold();                        // A wins: took over the dead instance
    assert.ok(a.ok);
    const b = await B.hold();                        // B: E_HELD by A, then "takes over" A through A's intent
    assert.equal(b.ok, false, 'the winner must keep control');
    assert.deepEqual(await auth.validate(a.lease), { ok: true });
  });

test('D-016 takeover of a dead instance works and fences the dead handle; a third party without the intent cannot', async () => {
  const auth = createLeaseAuthority({ backend: fakeBackend() });
  const intents = new Map();
  const deadCtl = controller(auth, intents, 'inst-dead');
  const dead = (await deadCtl.hold()).lease;
  deadCtl.die();
  const stranger = await auth.adopt({ resource: C, lease_id: 'ctl-guess-00000000001', owner: 'goal-loop', task_id: null });
  assert.equal(stranger.code, 'E_FENCED');
  const next = await controller(auth, intents, 'inst-next').hold();
  assert.ok(next.ok);
  assert.equal(next.lease.token, dead.token + 1);
  assert.equal((await auth.validate(dead)).code, 'E_FENCED', 'the dead handle can never write again');
  assert.equal((await auth.renew(dead)).code, 'E_FENCED');
});
