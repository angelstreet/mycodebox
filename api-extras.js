// Small API pieces the manager agent needs (TASK-44): who did an action, and the alert endpoint.
// Kept apart from server.js (which starts listening on import) so they can be unit-tested.

import { isLoopback, TOKEN_HEADER } from './reporter.js';

export const ACTOR_MAX = 40;
export const DEFAULT_ACTOR = 'owner';

// The optional `by` of a request body: who acted. Default 'owner' (the UI never sends it); the manager
// agent passes 'manager-agent'. Anything but a short non-empty string is a 400.
export function actorOf(body) {
  const v = body && typeof body === 'object' ? body.by : undefined;
  if (v === undefined || v === null) return DEFAULT_ACTOR;
  if (typeof v !== 'string' || !v.trim() || v.trim().length > ACTOR_MAX) throw Object.assign(new Error(`by must be a string of 1..${ACTOR_MAX} characters`), { status: 400 });
  return v.trim();
}

export const ALERT_PRIORITIES = ['min', 'low', 'default', 'high', 'urgent'];
export const ALERT_MAX_PER_HOUR = 10;

// POST /api/alert {title, body, url?, priority?, tag?}: the manager agent's own channel to the owner.
// Loopback peers + the reporter token only; goes through the normal alert() (debounce, feed, Web Push, ntfy);
// at most ALERT_MAX_PER_HOUR calls per hour. handle() is async and returns { status, body }; readBody() is only called after the peer and token check.
export function createAlertApi({ alert, tokenOk, now = Date.now, maxPerHour = ALERT_MAX_PER_HOUR } = {}) {
  const calls = [];
  const bad = (status, error) => ({ status, body: { ok: false, error } });
  return {
    async handle({ remoteAddress, headers = {}, readBody }) {
      if (!isLoopback(remoteAddress)) return bad(403, 'loopback only');
      if (!tokenOk(headers[TOKEN_HEADER])) return bad(401, 'bad token');
      const body = await readBody();
      const b = body && typeof body === 'object' ? body : {};
      if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 120) return bad(400, 'title must be a string of 1..120 characters');
      if (typeof b.body !== 'string' || !b.body.trim() || b.body.length > 1000) return bad(400, 'body must be a string of 1..1000 characters');
      if (b.url != null && (typeof b.url !== 'string' || b.url.length > 300 || !/^(\/|https?:\/\/)/.test(b.url))) return bad(400, 'url must start with / or http(s)://');
      if (b.priority != null && !ALERT_PRIORITIES.includes(b.priority)) return bad(400, `priority must be one of: ${ALERT_PRIORITIES.join(', ')}`);
      if (b.tag != null && (typeof b.tag !== 'string' || b.tag.length > 60)) return bad(400, 'tag must be a string of at most 60 characters');
      const t = now();
      while (calls.length && t - calls[0] >= 3600e3) calls.shift();
      if (calls.length >= maxPerHour) return bad(429, `at most ${maxPerHour} alerts per hour`);
      calls.push(t);
      const tag = b.tag || 'manager-agent';
      const sent = alert(`manager-agent:${b.tag || b.title}`, {
        title: b.title.trim(), body: b.body, url: b.url || '/', tag, priority: b.priority || 'default', ntfyTags: 'robot',
      });
      return { status: 200, body: { ok: true, sent, ...(sent ? {} : { debounced: true }) } };
    },
  };
}
