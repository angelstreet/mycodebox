// Router shadow (TASK-47 G2): one Jev call per NEW distinct stop with three questions (stop case, owner needed,
// who to wake), logged in the product's decision log next to what the rules did. SHADOW ONLY: nothing here may
// change a reply, an escalation, a push, a hold or a wake. The question texts are the ones the benchmark used
// (283 recorded stops: case 40 % rules vs 60 % Jev, owner-needed 18 vs 64 of 78, Opus wakes 72 vs 5).
import { isDisabledReply, DISABLED } from './jev-switch.js';
export const SHADOW_SOURCE = 'ghosty-router';
export const OWNER_THRESHOLD = 0.7;   // noul >= this = "only the owner can answer" (the benchmark's cut)

export const CASE_CRITERIA = {
  done: 'finished, nothing pending', owner_decision: 'asks the owner to choose / approve / give information only they have',
  continue: 'finished a step and only asks whether to go on', menu_recommended: 'offers options and marks one as recommended',
  stopped_short: 'says its next step and stops without asking anything real', waiting_deploy: 'waits for a deploy, a lease or a deploy go-ahead',
  owner_action: 'asks the owner for a small manual action', permission: 'a tool-permission prompt is open',
  error: 'crashed, API error or stuck', background_wait: 'still running background work',
};
export const WAKE_CRITERIA = {
  ignore: 'nothing to do now; e.g. genuinely done and reported',
  rules_handle: 'a fixed reply such as "Yes, continue." or "take your recommended option" is safe',
  wake_cheap: 'a small model manager should look: forward to the owner with a one-line summary, ask for a status, queue a deploy, answer a factual question',
  wake_opus: 'needs real judgment by a strong model before anything is sent: a plan, a risky technical call, conflicting work',
};

// facts = { session, agent, forbidden, no_status, excerpt, stallId, ruleCase, escalated }
export function shadowBody(facts, { usage, teamId } = {}) {
  const state = JSON.stringify({ session: facts.session, agent: facts.agent, flags: { forbidden_topic: facts.forbidden || null, no_status: !!facts.no_status }, closing_text: facts.excerpt });
  return {
    usage, profile: 'jev', log: !!teamId, timeout_s: 20,
    ...(teamId ? { team_id: teamId, refs: { source: SHADOW_SOURCE, point: 'stop', stall_id: facts.stallId, rule_case: facts.ruleCase, escalated: !!facts.escalated } } : {}),
    state: 'An AI coding agent working for one owner in a terminal has stopped. Facts (JSON):\n' + state,
    questions: {
      case: { type: 'choice', instructions: 'What kind of stop is this?', criteria: CASE_CRITERIA },
      owner: { type: 'noul', instructions: 'Can only the owner rightly answer this stop (a preference, approval, credentials, product decision or physical action)?', criteria: { true: 'only the owner can answer', false: 'an agent or a fixed reply can handle it, or nothing is needed' } },
      wake: { type: 'choice', instructions: 'What is the cheapest handler that is enough for this stop?', criteria: WAKE_CRITERIA },
    },
  };
}

const conf = (a) => { const p = a?.probabilities?.[a?.choice]; const c = Number(p ?? a?.confidence); return Number.isFinite(c) ? c : null; };
// The server's reply -> { case, caseConf, owner, wake, wakeConf, decision_id } or null when an answer is missing.
export function parseShadow(j) {
  const a = j?.answers;
  if (!j?.success || !a?.case?.choice || !a?.wake?.choice) return null;
  const owner = Number(a.owner?.noul);
  return { case: a.case.choice, caseConf: conf(a.case), owner: Number.isFinite(owner) ? owner : null, wake: a.wake.choice, wakeConf: conf(a.wake), ...(j.decision_id ? { decision_id: j.decision_id } : {}) };
}

// Fire-and-forget core, never throws. post(body) -> { r, j } as fetch gave it. Returns the record's `router` value:
// { case, ..., ms, cost, model } | { error, kind } | { skipped }.
// kindOf(msg): classify an error string (same scheme as manager.js jevErrorKind: 'network' | 'http' | 'timeout' | 'credits' | 'other').
// sleep(ms): wait between attempts; injected so tests can skip the 2 s delay.
// One retry after 2 s on a network error ONLY (the VPT server restarting during a deploy). Never on HTTP 4xx/5xx,
// timeout, credits or anything else. The error kind is stored on the router record alongside the error string.
export async function runShadow({ facts, usage, teamId, post, now = () => Date.now(), kindOf = (m) => 'other', sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const started = now();
  const doPost = () => post(shadowBody(facts, { usage, teamId }));
  try {
    let r, j;
    try {
      ({ r, j } = await doPost());
    } catch (e) {
      const msg = String(e?.message || e);
      if (kindOf(msg) !== 'network') return { error: msg.slice(0, 200), kind: kindOf(msg), ms: now() - started };
      await sleep(2000);
      ({ r, j } = await doPost());
    }
    if (isDisabledReply(j)) return { skipped: DISABLED };   // the server's JEV_ENABLED=false: not an error
    const parsed = parseShadow(j);
    const meta = { ms: j?.ms ?? now() - started, cost: Number(j?.cost || 0), model: j?.model };
    if (!parsed) {
      const err = String(j?.error || `http ${r?.status}`).slice(0, 200);
      return { error: err, kind: kindOf(err), ...meta, ...(j?.decision_id ? { decision_id: j.decision_id } : {}) };
    }
    return { ...parsed, ...meta };
  } catch (e) { return { error: String(e?.message || e).slice(0, 200), kind: kindOf(String(e?.message || e)), ms: now() - started }; }
}
