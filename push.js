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

const PUSH_HOSTS = /^(?:fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[\w.-]+\.notify\.windows\.com|web\.push\.apple\.com)$/;

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
      const u = new URL(s.endpoint);
      if (u.protocol === 'http:') return process.env.GHOSTY_PUSH_ALLOW_HTTP === '1';   // http only for tests
      // Only real browser push services: the server POSTs to this URL, so it must not be arbitrary.
      return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname);
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

// --- two-tier escalation (TASK-58 C7, MANAGER.md section 6) -----------------------
// interrupt tier: pushed at once (still debounced per key). digest tier: collected, ONE push per
// digestMs while the owner is awake, nothing in quiet hours (held for the first digest after they end).

export const TIER_DEFAULTS = { digestMinutes: 30, awakeFrom: '07:00', awakeTo: '23:00', timezone: 'Europe/Zurich', interruptPct: 95 };

// Pure. cfg = TIER_DEFAULTS merged with manager.json keys pushDigestMinutes/pushAwakeFrom/pushAwakeTo/pushTimezone/pushInterruptPct.
export function tierConfig(j = {}) {
  const c = { ...TIER_DEFAULTS };
  if (Number(j.pushDigestMinutes) > 0) c.digestMinutes = Number(j.pushDigestMinutes);
  if (/^\d{1,2}:\d{2}$/.test(j.pushAwakeFrom || '')) c.awakeFrom = j.pushAwakeFrom;
  if (/^\d{1,2}:\d{2}$/.test(j.pushAwakeTo || '')) c.awakeTo = j.pushAwakeTo;
  if (typeof j.pushTimezone === 'string' && j.pushTimezone) c.timezone = j.pushTimezone;
  if (Number(j.pushInterruptPct) > 0) c.interruptPct = Number(j.pushInterruptPct);
  return c;
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Pure. Minutes since midnight in cfg.timezone at epoch ms `t`.
export function localMinutes(t, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
  const g = (type) => Number(parts.find((p) => p.type === type).value);
  return g('hour') * 60 + g('minute');
}

// Pure. True while the owner is asleep: outside [awakeFrom, awakeTo).
export function isQuietHours(t, cfg = TIER_DEFAULTS) {
  const m = localMinutes(t, cfg.timezone);
  const from = toMin(cfg.awakeFrom), to = toMin(cfg.awakeTo);
  return from <= to ? !(m >= from && m < to) : !(m >= from || m < to);
}

const P0_RE = /\bP0\b|\bblocked\b|credential|secret|api[ _-]?key|password|customer/i;

// Pure. 'interrupt' | 'digest' for an alert. An explicit opts.tier wins; otherwise by key:
// disk:* and deploy failed/approve are interrupts, a stop that names P0 / blocked / credentials / customer is,
// urgent priority is, everything else (done, holds, plain asks, quota < interruptPct, credits) is digest.
export function defaultTier(key, opts = {}, cfg = TIER_DEFAULTS) {
  if (opts.tier === 'interrupt' || opts.tier === 'digest') return opts.tier;
  if (opts.priority === 'urgent') return 'interrupt';
  const head = String(key).split(':')[0];
  if (head === 'disk') return 'interrupt';
  if (head === 'deploy') return /^(failed|orphan|approve)/.test(String(key).split(':')[2] || '') ? 'interrupt' : 'digest';
  if (head === 'quota') return Number(opts.pct) >= cfg.interruptPct ? 'interrupt' : 'digest';
  if (/^(asks|waiting)$/.test(String(key).slice(head.length + 1))) return P0_RE.test(`${opts.title || ''}\n${opts.body || ''}`) ? 'interrupt' : 'digest';
  return 'digest';
}

// Pure. One digest line: `session · case · question · proposed answer`.
export function digestLine(item) {
  const first = (s) => String(s || '').split('\n')[0].trim();
  const session = item.session || String(item.key).split(':')[0];
  const kase = item.case || String(item.key).slice(session.length + 1) || 'event';
  const question = first(item.question || item.body || item.title).slice(0, 140);
  const answer = first(item.answer).slice(0, 80) || '-';
  return [session, kase, question, answer].join(' \u00b7 ');
}

// Optional onFired(event) is called once per actually-fired alert (debounced calls do not call it), for both tiers, when the
// alert happens (a digest item is "fired" when queued). `event` = { at, key, title, body (<=300 chars), url, priority }.
// tiering = { config: () => tierConfig, managerSessions: () => [names], file?: path } turns the two tiers on; without it every alert is an interrupt.
export function createAlerts({ push, ntfyTopic = '', ntfyUrl = 'https://ntfy.sh', publicUrl = '', fetchImpl = fetch, now = Date.now, defaultDebounceMs = 60000, log = console, onFired = null, tiering = null } = {}) {
  const last = new Map();
  const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '').slice(0, 200);
  let pending = [];                 // digest items, newest key wins
  let lastDigestAt = 0;
  const digestFile = tiering?.file || null;
  if (digestFile) { try { const j = JSON.parse(readFileSync(digestFile, 'utf8')); pending = j.pending || []; lastDigestAt = j.lastDigestAt || 0; } catch {} }
  const saveDigest = () => { if (digestFile) { try { writeFileSync(digestFile, JSON.stringify({ pending, lastDigestAt })); } catch (e) { log.error('[digest] save', e.message); } } };
  const cfg = () => (tiering?.config ? tiering.config() : TIER_DEFAULTS);

  function deliver({ title, text, url, tag, priority, ntfyTags }) {
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
  }

  function alert(key, { title, body = '', url = '/', tag = '', priority = 'default', ntfyTags = '', tier, pct, meta, blockedBy = null, turn = null } = {}, debounceMs = defaultDebounceMs) {
    if (tiering) {
      const head = String(key).split(':')[0];
      if ((tiering.managerSessions?.() || []).includes(head)) return false;   // the manager's own session never pushes the owner
    }
    const t = now();
    if (t - (last.get(key) || 0) < debounceMs) return false;
    last.set(key, t);
    const text = String(body || title).slice(0, 500);
    const which = tiering ? defaultTier(key, { tier, priority, title, body, pct }, cfg()) : 'interrupt';
    if (which === 'interrupt') deliver({ title, text, url, tag, priority, ntfyTags });
    else {
      pending = pending.filter((p) => p.key !== key);
      pending.push({ key, at: t, title, body: text, url, ...(meta || {}) });
      saveDigest();
    }
    if (onFired) {
      try { onFired({ at: new Date(t).toISOString(), key, title, body: text.slice(0, 300), url, priority, ...(blockedBy ? { blockedBy } : {}), ...(turn ? { turn } : {}) }); }
      catch (e) { log.error(`[alerts] onFired: ${e.message}`); }
    }
    return true;
  }

  // Called on a timer. Sends ONE push with every pending item when awake and digestMs has passed since the last one.
  function digestTick() {
    if (!tiering || !pending.length) return false;
    const t = now(), c = cfg();
    if (isQuietHours(t, c) || t - lastDigestAt < c.digestMinutes * 60000) return false;
    const items = pending;
    pending = []; lastDigestAt = t; saveDigest();
    const n = items.length;
    deliver({ title: `${n} item${n === 1 ? '' : 's'} for you`, text: items.map(digestLine).join('\n'), url: '/', tag: 'ghosty-digest', priority: 'default', ntfyTags: 'inbox_tray' });
    return true;
  }
  return { alert, resetDebounce: (key) => last.delete(key), digestTick, pendingDigest: () => pending.slice() };
}
