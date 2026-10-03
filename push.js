// Web Push (payload-less, VAPID ES256) + the notification feed + the generic alert() fan-out.
//
// Payload-less push: the push service gets an empty POST signed with our VAPID key; the service
// worker wakes up and fetches /api/push/feed to learn what to show. That avoids RFC 8291
// payload encryption entirely and keeps the feed behind the app's own (Tailscale) network.
//
// State (in stateDir): vapid.json (private key, chmod 600), push-subs.json, push-feed.json.

import { generateKeyPairSync, createPrivateKey, createSign, createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const FEED_MAX = 50;

// --- VAPID ------------------------------------------------------------------

export function loadOrCreateVapid(stateDir) {
  const file = join(stateDir, 'vapid.json');
  if (existsSync(file)) {
    try {
      const k = JSON.parse(readFileSync(file, 'utf8'));
      if (k.publicKey && k.privateJwk) return k;
    } catch { /* regenerate below */ }
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const keys = {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')])),
    privateJwk: privateKey.export({ format: 'jwk' }),
  };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
  return keys;
}

export function vapidJwt(keys, endpoint, { sub = 'mailto:admin@codebox.local', nowSec = Math.floor(Date.now() / 1000), ttlSec = 12 * 3600 - 60 } = {}) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: nowSec + ttlSec, sub }));
  const signer = createSign('SHA256');
  signer.update(`${head}.${body}`);
  const sig = signer.sign({ key: createPrivateKey({ key: keys.privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

export function verifyVapidJwt(jwt, publicKeyB64u) {
  const [h, b, s] = jwt.split('.');
  const raw = Buffer.from(publicKeyB64u, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: 'jwk' });
  return verify('SHA256', Buffer.from(`${h}.${b}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
}

// --- push hub: subscriptions + feed + send ---------------------------------

export function createPush({ stateDir, fetchImpl = fetch, log = console } = {}) {
  mkdirSync(stateDir, { recursive: true });
  const keys = loadOrCreateVapid(stateDir);
  const subsFile = join(stateDir, 'push-subs.json');
  const feedFile = join(stateDir, 'push-feed.json');
  const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
  const saveJson = (f, v) => { try { writeFileSync(f, JSON.stringify(v)); } catch (e) { log.error('[push] save', e.message); } };

  let subs = readJson(subsFile, []);
  let feed = readJson(feedFile, []);
  let nextId = feed.reduce((m, i) => Math.max(m, i.id), 0) + 1;

  function validSub(s) {
    if (!s || typeof s.endpoint !== 'string') return false;
    try {
      const proto = new URL(s.endpoint).protocol;
      return proto === 'https:' || (proto === 'http:' && process.env.GHOSTY_PUSH_ALLOW_HTTP === '1');   // http only for tests
    } catch { return false; }
  }
  function subscribe(sub) {
    if (!validSub(sub)) throw Object.assign(new Error('invalid subscription'), { status: 400 });
    subs = subs.filter((s) => s.endpoint !== sub.endpoint);
    subs.push({ endpoint: sub.endpoint, keys: sub.keys || null, at: Date.now() });
    saveJson(subsFile, subs);
  }
  function unsubscribe(endpoint) {
    const n = subs.length;
    subs = subs.filter((s) => s.endpoint !== endpoint);
    if (subs.length !== n) saveJson(subsFile, subs);
    return subs.length !== n;
  }

  function record({ title, body = '', url = '/', tag = '', priority = 'default' }) {
    const item = { id: nextId++, at: Date.now(), title, body: String(body).slice(0, 500), url, tag, priority };
    feed.push(item);
    if (feed.length > FEED_MAX) feed = feed.slice(-FEED_MAX);
    saveJson(feedFile, feed);
    return item;
  }
  // since=undefined -> only the newest item (a fresh SW has no cursor and must not replay history).
  function feedSince(since) {
    if (since === undefined || since === null || Number.isNaN(Number(since))) return feed.slice(-1);
    return feed.filter((i) => i.id > Number(since));
  }

  async function sendOne(sub, urgency) {
    try {
      const r = await fetchImpl(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `vapid t=${vapidJwt(keys, sub.endpoint)}, k=${keys.publicKey}`,
          TTL: '3600',
          Urgency: urgency,
          'Content-Length': '0',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 404 || r.status === 410) { unsubscribe(sub.endpoint); return 'gone'; }
      if (!r.ok) { log.error('[push]', r.status, new URL(sub.endpoint).host); return 'error'; }
      return 'ok';
    } catch (e) { log.error('[push]', e.message); return 'error'; }
  }
  // Record then wake every subscription. Resolves with per-subscription results.
  async function notify(item) {
    const it = record(item);
    const urgency = item.priority === 'high' || item.priority === 'urgent' ? 'high' : 'normal';
    const results = await Promise.all(subs.map((s) => sendOne(s, urgency)));
    return { item: it, results };
  }

  return { publicKey: keys.publicKey, keys, subscribe, unsubscribe, notify, record, feedSince, count: () => subs.length, subs: () => subs.slice() };
}

// --- alert(): one call -> Web Push + (optional) ntfy, with per-key debounce -----

export function createAlerts({ push, ntfyTopic = '', ntfyUrl = 'https://ntfy.sh', publicUrl = '', fetchImpl = fetch, now = Date.now, defaultDebounceMs = 60000, log = console } = {}) {
  const last = new Map();
  const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '').slice(0, 200);

  function alert(key, { title, body = '', url = '/', tag = '', priority = 'default', ntfyTags = '' }, debounceMs = defaultDebounceMs) {
    const t = now();
    if (t - (last.get(key) || 0) < debounceMs) return false;
    last.set(key, t);
    const text = String(body || title).slice(0, 500);
    if (push) push.notify({ title, body: text, url, tag, priority }).catch((e) => log.error('[push]', e.message));
    if (ntfyTopic) {
      const headers = { Title: ascii(title), Priority: priority };
      if (ntfyTags) headers.Tags = ntfyTags;
      if (publicUrl) headers.Click = `${publicUrl}${url.startsWith('/') ? '' : '/'}${url}`;
      try {
        fetchImpl(`${ntfyUrl}/${encodeURIComponent(ntfyTopic)}`, { method: 'POST', headers, body: text, signal: AbortSignal.timeout(8000) })
          .catch((e) => log.error('[ntfy]', e.message));
      } catch (e) { log.error('[ntfy]', e.message); }
    }
    return true;
  }
  return { alert, resetDebounce: (key) => last.delete(key) };
}
