// public/sw.js: notification buttons (push feed -> showNotification actions; notificationclick -> /api/voice/answer or the voice page).
// The worker file is run in a vm with stubbed self / clients / fetch / caches.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function boot({ feed = [], answer = { ok: true, status: 200, body: { ok: true, status: 'sent', say: 'Sent Rewrite to alpha.' } }, maxActions = 2, windows = [] } = {}) {
  const handlers = {}, shown = [], fetched = [], opened = [], store = new Map();
  const self = {
    addEventListener: (t, f) => { handlers[t] = f; },
    location: { origin: 'https://box.test' },
    registration: { showNotification: async (title, o) => { shown.push({ title, ...o }); } },
    clients: { matchAll: async () => windows, openWindow: async (u) => { opened.push(u); }, claim: async () => {} },
    skipWaiting() {},
  };
  const cache = { match: async (k) => store.get(String(k)) , put: async (k, v) => { store.set(String(k), v); }, addAll: async () => {} };
  const ctx = {
    self, URL, Response, console,
    Notification: { maxActions },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true, match: async () => null },
    fetch: async (url, opt) => {
      fetched.push({ url: String(url), opt });
      if (String(url).startsWith('/api/push/feed')) return { ok: true, json: async () => ({ items: feed }) };
      if (String(url) === '/api/voice/answer') return { ok: answer.ok, status: answer.status, json: async () => answer.body };
      throw new Error('unexpected fetch');
    },
  };
  vm.runInNewContext(SRC, ctx);
  const waits = [];
  const fire = async (type, ev) => { ev.waitUntil = (p) => waits.push(p); handlers[type](ev); await Promise.all(waits.splice(0)); };
  return { fire, shown, fetched, opened };
}
const item = (o = {}) => ({ id: 7, title: 'alpha asks you', body: 'b', url: '/?s=alpha', tag: 'ghosty-alpha', priority: 'high', ...o });
const click = (action, data) => ({ action, notification: { data, close() { this.closed = true; } } });

test('a needs-you push with a voiceId shows Do recommended + Speak it; Wait is dropped first on a 2-button platform', async () => {
  const w = boot({ feed: [item({ voiceId: 'stop:alpha:s1', actions: [{ action: 'recommended', title: 'Do recommended' }, { action: 'wait', title: 'Wait' }] })], maxActions: 2 });
  await w.fire('push', {});
  assert.deepEqual([...w.shown[0].actions.map((a) => a.action)], ['recommended', 'speak']);
  assert.equal(w.shown[0].data.voiceId, 'stop:alpha:s1');
  const w3 = boot({ feed: [item({ voiceId: 'stop:alpha:s1', actions: [{ action: 'recommended', title: 'Do recommended' }, { action: 'wait', title: 'Wait' }] })], maxActions: 3 });
  await w3.fire('push', {});
  assert.deepEqual([...w3.shown[0].actions.map((a) => a.action)], ['recommended', 'wait', 'speak']);
});
test('a push without a voiceId has no buttons (the old shape)', async () => {
  const w = boot({ feed: [item()] });
  await w.fire('push', {});
  assert.equal('actions' in w.shown[0], false);
  assert.equal(w.shown[0].data.url, '/?s=alpha');
});
test('clicking "Do recommended" posts the answer with via=notification and shows the result', async () => {
  const w = boot();
  const ev = click('recommended', { url: '/?s=alpha', voiceId: 'stop:alpha:s1' });
  await w.fire('notificationclick', ev);
  assert.equal(ev.notification.closed, true);
  const post = w.fetched.find((f) => f.url === '/api/voice/answer');
  assert.equal(post.opt.method, 'POST');
  assert.deepEqual(JSON.parse(post.opt.body), { id: 'stop:alpha:s1', option: 'recommended', via: 'notification' });
  assert.equal(w.shown.at(-1).title, 'Answered'); assert.match(w.shown.at(-1).body, /^Sent Rewrite/);
  assert.equal(w.opened.length, 0);
});
test('"Wait" posts option=wait', async () => {
  const w = boot();
  await w.fire('notificationclick', click('wait', { voiceId: 'stop:alpha:s1' }));
  assert.equal(JSON.parse(w.fetched.find((f) => f.url === '/api/voice/answer').opt.body).option, 'wait');
});
test('a refused answer (stale / needs confirm) tells the owner and points at the voice page, never claims success', async () => {
  const w = boot({ answer: { ok: true, status: 200, body: { ok: true, status: 'open', say: 'That needs a confirmation. Open the app.' } } });
  await w.fire('notificationclick', click('recommended', { voiceId: 'stop:alpha:s1' }));
  assert.equal(w.shown.at(-1).title, 'Not answered');
  assert.equal(w.shown.at(-1).data.url, '/?voice=1');
  const w2 = boot({ answer: { ok: false, status: 409, body: { ok: false, status: 'stale', say: 'That one is already handled.' } } });
  await w2.fire('notificationclick', click('recommended', { voiceId: 'stop:alpha:s1' }));
  assert.equal(w2.shown.at(-1).title, 'Not answered');
});
test('"Speak it" opens the voice page; a plain tap still opens the session deep link', async () => {
  const w = boot();
  await w.fire('notificationclick', click('speak', { url: '/?s=alpha', voiceId: 'stop:alpha:s1' }));
  assert.deepEqual(w.opened, ['https://box.test/?voice=1']);
  assert.equal(w.fetched.some((f) => f.url === '/api/voice/answer'), false);
  const w2 = boot();
  await w2.fire('notificationclick', click('', { url: '/?s=alpha', voiceId: 'stop:alpha:s1' }));
  assert.deepEqual(w2.opened, ['https://box.test/?s=alpha']);
});
test('an action click on a notification without a voiceId never posts an answer', async () => {
  const w = boot();
  await w.fire('notificationclick', click('recommended', { url: '/' }));
  assert.equal(w.fetched.some((f) => f.url === '/api/voice/answer'), false);
});
test('cache version bumped', () => { assert.match(SRC, /ghosty-shell-v167/); });
