// Ghosty Sessions — service worker
// Cache the shell so the PWA launches offline (and reloads fast over Tailscale).

const SHELL_CACHE = 'ghosty-shell-v147';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/prio.js',
  '/policy.js',
  '/usage.js',
  '/review.js',
  '/jev-view.js',
  '/icons.js',
  '/tasks-view.js',
  '/history-view.js',
  '/leases-view.js',
  '/decided-view.js',
  '/voice-view.js',
  '/tip.js',
  '/buttons.js',
  '/deployed.js',
  '/platforms.js',
  '/platforms-view.js',
  '/state.js',
  '/ask-model.js',
  '/ask-popup.js',
  '/sw-update.js',
  '/page-preview.html',
  '/page-preview.css',
  '/page-preview.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/vendor/xterm.js',
  '/vendor/xterm-addon-fit.js',
  '/vendor/xterm.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache the live data: API + WebSocket.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
    return; // passthrough
  }
  // Network-first for the app's own HTML / JS / CSS / SVG (every module, not just app.js) so updates roll out;
  // the cache is only the offline fallback. Cache-first stays for /vendor/ and the PNG icons.
  if (e.request.method !== 'GET') return;
  if (e.request.headers.get('accept')?.includes('text/html') ||
      (!url.pathname.startsWith('/vendor/') && /\.(js|css|svg|webmanifest)$/.test(url.pathname))) {
    e.respondWith(
      fetch(e.request).then((resp) => {
        const copy = resp.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy));
        return resp;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Cache-first for vendor assets and icons.
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((resp) => {
      const copy = resp.clone();
      caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy));
      return resp;
    }))
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
// --- Web Push -------------------------------------------------------------
// Pushes are payload-less: the push only wakes us, and /api/push/feed says what happened.
// The last seen feed id lives in a Cache entry (service workers have no localStorage).
const CURSOR_CACHE = 'ghosty-push-cursor';
const CURSOR_URL = '/__push-cursor';

async function readCursor() {
  try {
    const hit = await (await caches.open(CURSOR_CACHE)).match(CURSOR_URL);
    return hit ? await hit.text() : null;
  } catch { return null; }
}
async function writeCursor(id) {
  try { await (await caches.open(CURSOR_CACHE)).put(CURSOR_URL, new Response(String(id))); } catch {}
}

// Buttons of a needs-you notification: the server's actions (Do recommended / Wait, only for a safe recommended option) plus
// "Speak it" (opens the voice page). Android shows at most Notification.maxActions (often 2): Wait is dropped first.
function notificationActions(it) {
  if (!it.voiceId) return [];
  const list = [...(Array.isArray(it.actions) ? it.actions : []).filter((a) => a && a.action && a.title), { action: 'speak', title: 'Speak it' }];
  const max = typeof Notification !== 'undefined' && Number.isInteger(Notification.maxActions) ? Notification.maxActions : list.length;
  while (list.length > max) { const i = list.findIndex((a) => a.action === 'wait'); list.splice(i >= 0 ? i : list.length - 2, 1); }
  return list;
}

async function showFeed() {
  let items = [];
  try {
    const cur = await readCursor();
    const r = await fetch('/api/push/feed' + (cur ? `?since=${encodeURIComponent(cur)}` : ''), { cache: 'no-store' });
    if (r.ok) items = (await r.json()).items || [];
  } catch { /* fall through to the generic notification */ }
  if (!items.length) {
    // Chrome requires a visible notification for every push.
    return self.registration.showNotification('codebox needs you', {
      body: 'Open Ghosty to see what changed.', tag: 'ghosty-generic', icon: '/icon-192.png', badge: '/icon-192.png', data: { url: '/' },
    });
  }
  await writeCursor(items[items.length - 1].id);
  for (const it of items.slice(-5)) {
    const high = it.priority === 'high' || it.priority === 'urgent';
    const actions = notificationActions(it);
    await self.registration.showNotification(it.title, {
      body: it.body, tag: it.tag || `ghosty-${it.id}`, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png',
      requireInteraction: high, data: { url: it.url || '/', voiceId: it.voiceId || null },
      ...(actions.length ? { actions } : {}),
    });
  }
}

self.addEventListener('push', (e) => { e.waitUntil(showFeed()); });

// A button on a "needs you" notification answers it without opening the app (POST /api/voice/answer re-validates the stop on the server;
// an option touching a sensitive topic is never answered from here, the app opens instead). "Speak it" opens the voice page.
async function answerFromNotification(voiceId, action) {
  let say = '', ok = false;
  try {
    const r = await fetch('/api/voice/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: voiceId, option: action, via: 'notification' }) });
    const j = await r.json().catch(() => ({}));
    ok = r.ok && j.status === 'sent';
    say = j.say || (r.ok ? '' : 'Could not answer. Open the app.');
  } catch { say = 'Could not reach the dashboard. Open the app.'; }
  if (say) {
    try { await self.registration.showNotification(ok ? 'Answered' : 'Not answered', { body: say, tag: `ghosty-voice-${voiceId}`, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: ok ? '/' : '/?voice=1' } }); } catch {}
  }
  return ok;
}

// Tap on a notification -> focus an open window and navigate it to the deep link, or open one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  if ((e.action === 'recommended' || e.action === 'wait') && data.voiceId) { e.waitUntil(answerFromNotification(data.voiceId, e.action)); return; }
  const target = new URL(e.action === 'speak' ? '/?voice=1' : data.url || '/', self.location.origin);
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      for (const c of list) {
        const session = target.searchParams.get('s');
        if (session) c.postMessage({ type: 'focus', session });   // in-app switch, no reload
        await c.focus();
        if (!session && 'navigate' in c) { try { await c.navigate(target.href); } catch {} }
        return;
      }
      return self.clients.openWindow(target.href);
    })
  );
});
