// Ghosty Sessions — service worker
// Cache the shell so the PWA launches offline (and reloads fast over Tailscale).

const SHELL_CACHE = 'ghosty-shell-v1';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
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
  // Network-first for HTML/JS/CSS so updates roll out.
  if (e.request.method !== 'GET') return;
  if (e.request.headers.get('accept')?.includes('text/html') ||
      url.pathname === '/app.js' || url.pathname === '/style.css') {
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