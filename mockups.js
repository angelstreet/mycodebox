// Mockup-first default (round 9, item 7). For a UI feature the session posts an HTML mockup to the owner's feed and carries on building unless
// the owner objects within `mockupWindowMin` (manager config, default 10); the owner reviews at the end.
//   POST /api/mockups          (loopback + reporter token, like /api/alert)  { session, title, url, windowMin? } -> a feed record
//                              { kind: 'mockup', url, deadlineAt, mockupId, actions: [Object] }
//   POST /api/mockups/:id/object   the owner's "object" tap: the session is told to wait for the owner's notes
//   mockupRule(final, ...)     a stop asking "show me / approve the mockup before I build?" is answered "Proceed: post the mockup ... and build"
import { appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isLoopback, TOKEN_HEADER } from './reporter.js';

export const OBJECT_TEXT = 'The owner objects to the mockup: wait for their notes.';
export const WINDOW_DEFAULT_MIN = 10;

// --- the manager rule (pure) ------------------------------------------------------------------------------------------
const MOCKUP_WORD = /\b(?:mock-?ups?|wireframes?|design preview|prototype)\b/i;
const APPROVAL_ASK = /\b(?:approv\w*|show(?: you| me)?|let me see|review\w*|sign[- ]?off|ok(?:ay)?|go-?ahead|confirm\w*|want to see|look at|check|before (?:i|we) (?:build|implement|code|start)|before building)\b/i;
// -> the reply, or null. Applies to a stop that only asks about the mockup: no menu, no other topic (the caller keeps the hard floor in force).
export function mockupRule(final, { windowMin = WINDOW_DEFAULT_MIN, enabled = true } = {}) {
  if (!enabled || !(windowMin > 0) || !final) return null;
  if (!['owner_decision', 'continue', 'done', 'stopped_short'].includes(final.case) || (final.options?.length || 0) >= 1) return null;
  const q = String(final.question || '');
  if (!/\?/.test(q) || !MOCKUP_WORD.test(q) || !APPROVAL_ASK.test(q)) return null;
  return `Proceed: post the mockup to the feed (POST /api/mockups with your session, a title and the page link; the owner has ${windowMin} min to object) and build; the owner reviews at the end.`;
}

// --- the ledger and the routes ------------------------------------------------------------------------------------------
// Records: { id, at, session, title, url, deadlineAt, state: 'open' } and later { id, state: 'objected', at, late }.
export function createMockups({ file, push, send = async () => {}, tokenOk = () => false, now = () => Date.now(), windowMin = () => WINDOW_DEFAULT_MIN, maxPerHour = 20 } = {}) {
  const calls = [];
  const bad = (status, error) => ({ status, body: { ok: false, error } });
  async function rows() {
    let txt = ''; try { txt = await readFile(file, 'utf8'); } catch { return []; }
    const by = new Map();
    for (const l of txt.split('\n').filter(Boolean)) { let r; try { r = JSON.parse(l); } catch { continue; } if (!r?.id) continue; by.set(r.id, { ...(by.get(r.id) || {}), ...r }); }
    return [...by.values()];
  }
  async function post({ remoteAddress, headers = {}, body }) {
    if (!isLoopback(remoteAddress)) return bad(403, 'loopback only');
    if (!tokenOk(headers[TOKEN_HEADER])) return bad(401, 'bad token');
    const b = body && typeof body === 'object' ? body : {};
    if (typeof b.session !== 'string' || !/^[\w.-]{1,60}$/.test(b.session)) return bad(400, 'session must be a session name');
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 100) return bad(400, 'title must be a string of 1..100 characters');
    if (typeof b.url !== 'string' || b.url.length > 300 || !/^(\/|https?:\/\/)/.test(b.url)) return bad(400, 'url must start with / or http(s)://');
    const t = now();
    while (calls.length && t - calls[0] >= 3600e3) calls.shift();
    if (calls.length >= maxPerHour) return bad(429, `at most ${maxPerHour} mockups per hour`);
    calls.push(t);
    const win = Math.min(1440, Math.max(1, Number(b.windowMin) || Number(windowMin()) || WINDOW_DEFAULT_MIN));
    const rec = { id: randomUUID().slice(0, 8), at: t, session: b.session, title: b.title.trim(), url: b.url, deadlineAt: t + win * 60e3, state: 'open' };
    await appendFile(file, JSON.stringify(rec) + '\n');
    const item = push.record({ title: `Mockup: ${rec.title}`, body: `${b.session} builds on unless you object within ${win} min; you review at the end.`, url: rec.url, tag: 'mockup', kind: 'mockup', mockupId: rec.id, deadlineAt: rec.deadlineAt,
      actions: [{ action: 'object', title: 'Object' }] });
    return { status: 200, body: { ok: true, id: rec.id, deadlineAt: rec.deadlineAt, feedId: item.id } };
  }
  // The owner's tap. -> { status, body }. `send(session, text)` is the guarded typed send (an agent pane only).
  async function object(id, { by = 'owner' } = {}) {
    const r = (await rows()).find((x) => x.id === id);
    if (!r || !r.session) return bad(404, 'unknown mockup');
    if (r.state === 'objected') return bad(409, 'already objected');
    const t = now();
    try { await send(r.session, OBJECT_TEXT, by); } catch (e) { return bad(e.status || 502, `could not tell ${r.session}: ${e.message}`); }
    await appendFile(file, JSON.stringify({ id, state: 'objected', at: t, by, late: t > r.deadlineAt }) + '\n');
    return { status: 200, body: { ok: true, sent: true, session: r.session, text: OBJECT_TEXT, late: t > r.deadlineAt } };
  }
  return { post, object, rows };
}
