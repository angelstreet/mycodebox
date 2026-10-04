// Wake shadow (TASK-47 G10): every line of manager-events.jsonl carries Jev's opinion on whether that event needed
// waking the manager agent (`jev`), and 15 minutes later what really happened (a `wake_outcome` record) so the
// scorecard can compare Jev and the rule default with the observed need. SHADOW ONLY: the rules still decide what
// is recorded; nothing here changes an alert, a push or a send.
//
//   jev: { pick, confidence, source, ruleDefault, decision_id?, ms }   Jev (or a floor) picked
//        { skipped: <why>, ruleDefault }                                no call: budget, credits, cool-down, not configured
//        { error: <kind>, ruleDefault, ms }                             the call failed or took longer than the 3 s cap
import { decide, floor, ruleDefault } from './router.js';

export const CAP_MS = 3000;                 // the event line never waits for Jev longer than this
export const OUTCOME_WINDOW_MS = 15 * 60e3;  // how long we watch for the manager / owner to act
export const OUTCOME_BY = 'observed-15min';
export const WAKE_PICKS = new Set(['wake_cheap', 'wake_opus']);
export const isWake = (pick) => WAKE_PICKS.has(pick);

// Facts the wake point reasons about (router.js POINTS.wake floor reads event.* / deploy / quota / disk_pct).
// in = { cls, event, priority, stall, agent, deploy, quota, diskPct, credits }
export function wakeFacts({ cls, event = {}, priority = null, stall = null, agent = null, deploy = null, quota = null, diskPct = null, credits = null } = {}) {
  const blockedKind = cls.kind === 'asks' || cls.kind === 'waiting';
  const ev = { kind: cls.kind, title: String(event.title || '').slice(0, 120), priority: priority || null };
  if (cls.session) {
    ev.session = cls.session;
    if (agent) ev.agent = agent;
    if (stall) {
      ev.stall_case = stall.case || null;
      ev.forbidden_topic = stall.forbidden || null;
      ev.escalated = !!stall.escalated;
    }
    ev.p0_blocked = priority === 'P0' && blockedKind;
  }
  const facts = { event: ev };
  if (cls.kind === 'deploy') facts.deploy = { id: cls.deployId, state: cls.state || deploy?.state || null };
  if (cls.kind === 'quota') facts.quota = quota || {};
  if (cls.kind === 'disk' && Number.isFinite(diskPct)) facts.disk_pct = diskPct;
  if (cls.kind === 'credits' && credits) facts.credits = credits;
  // Session events (asks / waiting / hold / ...): include the stop's closing text so Jev sees WHY a wake
  // may be needed, not just kind/priority flags. stall.question preferred, falls back to stall.excerpt, both
  // trimmed to the last 600 chars (the recent stop, not the whole pane history). stall.case and stall.no_status
  // are surfaced as facts.stall = { case, no_status } when present.
  if (cls.session && stall) {
    const text = String(stall.question || stall.excerpt || '').slice(-600);
    if (text) facts.stall_text = text;
    const sl = {};
    if (stall.case != null) sl.case = stall.case;
    if (stall.no_status) sl.no_status = true;
    if (Object.keys(sl).length) facts.stall = sl;
  }
  return facts;
}

// Quota plans -> { "plan:window": usedPercent } (what router.js's floor reads).
export function quotaPercents(q) {
  const out = {};
  for (const p of q?.plans || []) for (const w of p.windows || []) if (Number.isFinite(w.usedPercent)) out[`${p.plan}:${w.name}`] = w.usedPercent;
  return out;
}

// createWakeAnnotator({ enabled, guard, call, teamId, capMs, now })
//   enabled() -> bool        the wakeShadow switch
//   guard()   -> string|null a reason NOT to call (not configured / budget / no credit / 402 cool-down), same guards as the stop shadow
//   call(body) -> json       POST /server/ai/decide (throws on transport errors); does the budget accounting itself
//   onError(kind)            optional: called with the failure kind (the 402 cool-down hangs here)
// annotate(facts) -> the `jev` value, or undefined when the switch is off. Never throws; answers within capMs.
export function createWakeAnnotator({ enabled = () => true, guard = () => null, call, teamId = '', onError = () => {}, kindOf = (m) => 'other', capMs = CAP_MS, now = () => Date.now() } = {}) {
  return async function annotate(facts) {
    if (!enabled()) return undefined;
    const started = now();
    let rd = null;
    try { rd = ruleDefault('wake', facts); } catch { /* facts always valid; defensive */ }
    const forced = floor('wake', facts).forced;
    if (!forced) {
      let why = null;
      try { why = guard(); } catch { why = null; }
      if (why) return { skipped: why, ruleDefault: rd };
    }
    let reply = null, err = null;
    const post = async (body) => {
      try {
        const b = { ...body };
        if (!teamId) { delete b.team_id; b.log = false; }
        reply = await call(b);
        return reply;
      } catch (e) { err = String(e?.message || e); return null; }
    };
    let timer;
    const timeout = new Promise((res) => { timer = setTimeout(() => res({ timeout: true }), capMs); });
    const refs = { event_kind: facts.event?.kind, session: facts.event?.session };
    const out = await Promise.race([decide('wake', facts, { post, teamId, refs, threshold: 0 }), timeout]);
    clearTimeout(timer);
    const ms = now() - started;
    if (out.timeout) { onError('timeout'); return { error: 'timeout', ruleDefault: rd, ms }; }
    if (out.source === 'forced') return { pick: out.choice, confidence: 1, source: 'forced', ruleDefault: out.ruleDefault, ms };
    if (out.source === 'jev') return { pick: out.choice, confidence: out.confidence, source: 'jev', ruleDefault: out.ruleDefault, ...(out.decision_id ? { decision_id: out.decision_id } : {}), ms: Number.isFinite(reply?.ms) ? reply.ms : ms };
    const text = err || String(reply?.error || (reply ? 'no valid answer' : 'no answer'));
    const kind = err || reply?.error ? kindOf(text) : 'invalid';
    onError(kind);
    return { error: kind, ruleDefault: out.ruleDefault ?? rd, ms, ...(out.decision_id ? { decision_id: out.decision_id } : {}) };
  };
}

// ---- outcome: what really happened within 15 min of an event ----
export const eventKey = (e) => `${e.at}|${e.key}`;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const names = (text, name) => !!name && new RegExp(`(^|[^\\w-])${escapeRe(name)}($|[^\\w-])`, 'i').test(text);
const KIND_WORD = { deploy: /deploy/i, quota: /quota/i, disk: /disk/i, credits: /credit/i };

// Did the manager agent or the owner act on this event inside the window? 'needed' | 'not_needed'.
// recs = the records of stalls.jsonl (any order). Session events: a send by someone other than the owner (the manager
// agent, the auto-answer), an auto answer, a manager-agent alert naming the session, or the owner sending / answering
// (send by owner, outcome, popup choice). Deploy: such an alert, or the owner's deploy action on that deploy id.
// Quota / disk / credits: only a manager-agent alert about it (ghosty records no owner action there: a known gap).
export function observedNeed(ev, cls, recs, windowMs = OUTCOME_WINDOW_MS) {
  const t0 = Date.parse(ev.at);
  for (const r of recs) {
    const t = Date.parse(r.at);
    if (!(t >= t0 && t <= t0 + windowMs)) continue;
    const text = `${r.title || ''} ${r.body || ''}`;
    if (r.type === 'agent-alert') {
      if (cls.session ? names(text, cls.session)
        : cls.kind === 'deploy' ? (names(text, cls.deployId) || KIND_WORD.deploy.test(text))
        : KIND_WORD[cls.kind] ? KIND_WORD[cls.kind].test(text) : text.includes(ev.key)) return 'needed';
    }
    if (cls.session && r.session === cls.session) {
      if (r.type === 'send' || r.type === 'answer' || r.type === 'outcome' || r.type === 'choice') return 'needed';   // owner or manager: both are action
    }
    if (cls.kind === 'deploy' && r.type === 'deploy_action' && r.id === cls.deployId) return 'needed';
  }
  return 'not_needed';
}

// Events due for a label (older than the window, not labelled yet, not too old) -> [{ event, label }].
export function dueOutcomes({ events, recs, classify, now, windowMs = OUTCOME_WINDOW_MS, maxAgeMs = 2 * 86400e3 }) {
  const done = new Set(recs.filter((r) => r.type === 'wake_outcome').map((r) => r.event_key));
  const out = [];
  for (const ev of events) {
    const t = Date.parse(ev.at);
    if (!Number.isFinite(t) || now - t < windowMs || now - t > maxAgeMs) continue;
    const k = eventKey(ev);
    if (done.has(k)) continue;
    out.push({ event: ev, key: k, label: observedNeed(ev, classify(ev.key), recs, windowMs) });
  }
  return out;
}
