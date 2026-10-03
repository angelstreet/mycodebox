import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateVapid, vapidJwt, verifyVapidJwt, createPush, createAlerts } from '../push.js';

process.env.GHOSTY_PUSH_ALLOW_HTTP = '1';   // mock push services are plain http
const tmp = () => mkdtempSync(join(tmpdir(), 'ghosty-push-'));
const quiet = { error() {} };

// A mock push service. `status` can be changed per test; every request is recorded.
async function mockPushService(status = 201) {
  const reqs = [];
  const ctl = { status };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { reqs.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(ctl.status); res.end(); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { reqs, ctl, origin: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.close(); srv.closeAllConnections(); } };
}

test('VAPID keys are generated once, chmod 600, and reloaded', () => {
  const dir = tmp();
  const a = loadOrCreateVapid(dir);
  assert.equal(statSync(join(dir, 'vapid.json')).mode & 0o777, 0o600);
  assert.equal(Buffer.from(a.publicKey, 'base64url').length, 65);
  assert.equal(loadOrCreateVapid(dir).publicKey, a.publicKey);
});

test('VAPID JWT is valid ES256 with aud/exp/sub', () => {
  const keys = loadOrCreateVapid(tmp());
  const now = 1_800_000_000;
  const jwt = vapidJwt(keys, 'https://fcm.googleapis.com/fcm/send/abc', { nowSec: now });
  assert.ok(verifyVapidJwt(jwt, keys.publicKey));
  const [h, b] = jwt.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p, 'base64url')));
  assert.deepEqual(h, { typ: 'JWT', alg: 'ES256' });
  assert.equal(b.aud, 'https://fcm.googleapis.com');
  assert.equal(b.sub, 'mailto:admin@codebox.local');
  assert.ok(b.exp > now && b.exp - now <= 12 * 3600);
  // tampering breaks it
  const bad = jwt.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal(verifyVapidJwt(bad, keys.publicKey), false);
});

test('push request: vapid headers, TTL, urgency, empty body', async () => {
  const svc = await mockPushService();
  const push = createPush({ stateDir: tmp(), log: quiet });
  push.subscribe({ endpoint: `${svc.origin}/send/1`, keys: { p256dh: 'x', auth: 'y' } });
  await push.notify({ title: 't', priority: 'high' });
  await push.notify({ title: 'u', priority: 'default' });
  svc.close();
  assert.equal(svc.reqs.length, 2);
  const [r1, r2] = svc.reqs;
  assert.equal(r1.url, '/send/1');
  assert.equal(r1.body.length, 0);
  assert.equal(r1.headers.ttl, '3600');
  assert.equal(r1.headers.urgency, 'high');
  assert.equal(r2.headers.urgency, 'normal');
  const m = /^vapid t=([^,]+), k=(\S+)$/.exec(r1.headers.authorization);
  assert.ok(m, r1.headers.authorization);
  assert.equal(m[2], push.publicKey);
  assert.ok(verifyVapidJwt(m[1], push.publicKey));
  assert.equal(JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url')).aud, svc.origin);
});

test('404/410 from the push service drops the subscription; 5xx keeps it', async () => {
  const svc = await mockPushService(410);
  const dir = tmp();
  const push = createPush({ stateDir: dir, log: quiet });
  push.subscribe({ endpoint: `${svc.origin}/a` });
  await push.notify({ title: 'x' });
  assert.equal(push.count(), 0);
  assert.equal(createPush({ stateDir: dir, log: quiet }).count(), 0, 'removal persisted');
  svc.ctl.status = 404;
  push.subscribe({ endpoint: `${svc.origin}/b` });
  await push.notify({ title: 'x' });
  assert.equal(push.count(), 0);
  svc.ctl.status = 503;
  push.subscribe({ endpoint: `${svc.origin}/c` });
  await push.notify({ title: 'x' });
  assert.equal(push.count(), 1);
  svc.close();
});

test('subscribe validates, dedupes by endpoint, persists; unsubscribe removes', () => {
  const dir = tmp();
  const push = createPush({ stateDir: dir, log: quiet });
  assert.throws(() => push.subscribe({}), /invalid/);
  assert.throws(() => push.subscribe({ endpoint: 'ftp://evil.example/x' }), /invalid/);
  push.subscribe({ endpoint: 'https://fcm.googleapis.com/a' });
  push.subscribe({ endpoint: 'https://fcm.googleapis.com/a' });
  assert.equal(push.count(), 1);
  assert.equal(createPush({ stateDir: dir, log: quiet }).count(), 1);
  assert.equal(push.unsubscribe('https://fcm.googleapis.com/a'), true);
  assert.equal(push.unsubscribe('https://fcm.googleapis.com/a'), false);
});

test('feed: ids increase, since filters, no cursor -> newest only, ring keeps 50, persisted', () => {
  const dir = tmp();
  const push = createPush({ stateDir: dir, log: quiet });
  for (let i = 1; i <= 60; i++) push.record({ title: `n${i}`, tag: 't' });
  const all = push.feedSince(0);
  assert.equal(all.length, 50);
  assert.equal(all[0].title, 'n11');
  assert.deepEqual(push.feedSince(58).map((i) => i.title), ['n59', 'n60']);
  assert.deepEqual(push.feedSince(60), []);
  assert.deepEqual(push.feedSince(undefined).map((i) => i.title), ['n60']);
  const item = all[49];
  assert.deepEqual(Object.keys(item).sort(), ['at', 'body', 'id', 'priority', 'tag', 'title', 'url']);
  const again = createPush({ stateDir: dir, log: quiet });
  assert.equal(again.record({ title: 'next' }).id, 61, 'ids continue after restart');
});

test('alert(): fans out to web push and ntfy, debounced per key', async () => {
  const svc = await mockPushService();
  const push = createPush({ stateDir: tmp(), log: quiet });
  push.subscribe({ endpoint: `${svc.origin}/s` });
  const ntfyCalls = [];
  let t = 1_000_000;
  const { alert, resetDebounce } = createAlerts({
    push, ntfyTopic: 'topic', ntfyUrl: 'http://ntfy.test', publicUrl: 'https://box.ts.net', now: () => t,
    fetchImpl: async (u, o) => { ntfyCalls.push({ u, o }); return { ok: true }; }, log: quiet,
  });
  const a = { title: 'web needs you', body: 'pick one', url: '/?s=web', tag: 'ghosty-web', priority: 'high', ntfyTags: 'warning' };
  assert.equal(alert('web:waiting', a), true);
  assert.equal(alert('web:waiting', a), false, 'debounced');
  assert.equal(alert('web:done', { ...a, title: 'web is done' }), true, 'other kind not swallowed');
  t += 61000;
  assert.equal(alert('web:waiting', a), true, 'after the window');
  resetDebounce('web:waiting');
  assert.equal(alert('web:waiting', a), true, 'reset');
  await new Promise((r) => setTimeout(r, 100));
  svc.close();
  assert.equal(ntfyCalls.length, 4);
  assert.equal(ntfyCalls[0].u, 'http://ntfy.test/topic');
  assert.equal(ntfyCalls[0].o.headers.Click, 'https://box.ts.net/?s=web');
  assert.equal(ntfyCalls[0].o.headers.Tags, 'warning');
  assert.equal(svc.reqs.length, 4);
  assert.equal(push.feedSince(0)[0].url, '/?s=web');
});

test('alert(): no ntfy call without a topic, web push still recorded', async () => {
  const push = createPush({ stateDir: tmp(), log: quiet });
  let called = 0;
  const { alert } = createAlerts({ push, fetchImpl: async () => { called++; return { ok: true }; }, log: quiet });
  alert('k', { title: 'hi' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(called, 0);
  assert.equal(push.feedSince(0).length, 1);
});
