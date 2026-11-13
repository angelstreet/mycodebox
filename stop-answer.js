// Every session stop the manager is woken for ends in a message to that session or a recorded decision (owner 2026-11-12; S7a of the
// daily scorecard counts the stops it left unanswered: 28 of 121 empty wakes on 2026-11-12, and 4 more after the manager adopted the rule).
// A rule in the manager's prompt is not enough, so this is a check: a stop event older than GRACE_MS with no send from the manager to
// that session and no manager-actions.jsonl line naming it after the stop is sent back to the manager once (pending-wakes key per stop).
// Pure: findUnanswered(); the server tick reads the three files and types the result (server.js, stopAnswerTick).

export const GRACE_MS = 10 * 60 * 1000;      // the manager gets this long, a wake and a few turns, before it is reminded
export const MAX_AGE_MS = 6 * 3600 * 1000;   // older stops are history, not a reminder
export const MAX_PER_PUSH = 5;

const STOP_KIND = /(^|:)(asks|needs-manager)$/;

// The session a stop event is about, or null when the event is no stop for the manager.
export function stopSession(e) {
  if (!e || typeof e !== 'object' || e.handled) return null;
  const kind = String(e.kind || ''), key = String(e.key || ''), body = String(e.body || '');
  if (STOP_KIND.test(kind) || STOP_KIND.test(key)) {
    const k = key.replace(/:(asks|needs-manager)$/, '');
    return (k && k !== key ? k : String(e.session || '')) || null;
  }
  if (key.endsWith(':manager-item')) { const m = body.match(/^(\S+) asks:/); if (m) return m[1]; }
  return null;
}

const bare = (s) => String(s || '').replace(/^mac:/, '');
const names = (a, b) => { const x = bare(a), y = bare(b); return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x)); };

// events: manager-events rows; sends: stalls.jsonl `send` rows ({at, session, by}); actions: manager-actions.jsonl rows.
// -> [{ key, session, at, title }] stops that are older than the grace and still unanswered.
export function findUnanswered({ events = [], sends = [], actions = [], now = Date.now(), graceMs = GRACE_MS, maxAgeMs = MAX_AGE_MS, done = new Set() } = {}) {
  const out = [];
  for (const e of events) {
    const session = stopSession(e);
    const at = Date.parse(e?.at);
    if (!session || !Number.isFinite(at) || now - at < graceMs || now - at > maxAgeMs) continue;
    const key = String(e.key || `${session}:stop`) + '@' + e.at;
    if (done.has(key)) continue;
    const mine = sends.some((s) => s && s.type === 'send' && s.by === 'manager-agent' && Date.parse(s.at) >= at && names(s.session, session));
    const recorded = actions.some((a) => a && Date.parse(a.at) >= at - 120000 && (names(a.session, session) || (a.item && String(a.item).includes(bare(session)))));
    if (!mine && !recorded) out.push({ key, session, at: e.at, title: String(e.title || '').slice(0, 100) });
  }
  return out;
}

export function reminderText(list) {
  const lines = list.slice(0, MAX_PER_PUSH).map((s) => `- ${s.session} (stopped ${s.at.slice(11, 16)} UTC): ${s.title}`);
  return `Harness check: ${list.length} session stop(s) you were woken for have no message to the session and no line in manager-actions.jsonl:\n${lines.join('\n')}\n`
    + 'Every stop ends in a message to that session (api/send or SendMessage) or a recorded decision line (kind decision, session <name>). Do that now for each, then carry on.';
}
