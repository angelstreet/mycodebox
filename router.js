// Router (TASK-47, shadow): lets Jev (POST /server/ai/decide, profile 'jev') pick, inside hard
// floors, who handles manager work. SHADOW ONLY: nothing live calls this yet. The pure module,
// the tests and the dry-run CLI live here; the wiring to the manager is a later step.
//
// Each POINTS entry knows:
//   - usage:           the Jev usage key (see server/ai/decide)
//   - options:         { id -> one-sentence criterion } (a reader with no context should understand)
//   - instructions:    the question Jev is asked, one sentence
//   - ruleDefault(f):  the option id we'd take if we could not call Jev
//   - floor(f):        { allowed: [ids], forced: id|null, reasons: [strings] } -- the hard rules
//
// buildRequest(point, facts, { teamId, refs }) returns the POST body for /server/ai/decide, or null
// when the floor already forced a pick (no need to call). pick(point, facts, jevJson, ...) collapses
// the server's reply with the rule default. decide(point, facts, { post, ... }) wraps both, never
// throws, and threads post() (injected, returns null on error).

// ---- shared helpers ----

const asArray = (v) => Array.isArray(v) ? v : [];
const hasAny = (haystack, needles) => asArray(haystack).some((x) => needles.includes(x));
const quotaAtOrAbove = (quota, threshold) => {
  if (!quota || typeof quota !== 'object') return false;
  for (const v of Object.values(quota)) if (typeof v === 'number' && v >= threshold) return true;
  return false;
};

// ---- wake ----
// Whether anything needs to be woken at all (and how strong).
const wake = {
  usage: 'text.decision.wake',
  options: {
    ignore: 'wake nothing: nothing actually needs attention right now',
    rules_handle: 'let the rules-only manager (stall.js + auto-cases) answer this one',
    wake_cheap: 'wake a small/cheap agent to investigate and answer',
    wake_opus: 'wake the strongest (Opus) agent: this is escalated, risky or already broken',
  },
  instructions: 'Given what is happening right now, who (if anyone) should the manager wake to handle it?',
  floor(facts) {
    const ev = facts?.event || {};
    const deploy = facts?.deploy || null;
    const diskPct = Number(facts?.disk_pct);
    const hot = !!(ev.p0_blocked
      || (ev.kind === 'deploy' && deploy && deploy.state === 'failed')
      || (Number.isFinite(diskPct) && diskPct >= 95)
      || quotaAtOrAbove(facts?.quota, 95));
    const reasons = [];
    if (hot) reasons.push('p0 blocked / failed deploy / disk or quota critical');
    let allowed = hot ? ['wake_cheap', 'wake_opus'] : ['ignore', 'rules_handle', 'wake_cheap', 'wake_opus'];
    if (ev.forbidden_topic) {
      allowed = allowed.filter((id) => id !== 'rules_handle');
      reasons.push('forbidden topic: rules-only auto-answer is off the table');
    }
    return { allowed, forced: null, reasons };
  },
  ruleDefault(facts) {
    return facts?.event?.escalated ? 'wake_opus' : 'rules_handle';
  },
};

// ---- builder ----
// Which builder (model / agent family) should do the work.
const builder = {
  usage: 'text.decision.route',
  options: {
    minimax: 'small, well-specified change (few files, a few hundred lines at most) in an app repo with tests; no infrastructure, secrets or deploys; a reviewer will check it',
    codex: 'small/medium change where Codex is a better fit (e.g. focused refactor, simple tests, well-scoped fix)',
    sonnet: 'big or complex: many files, UI wiring, stateful logic or an unclear spec; also anything touching auth/security on a private repo',
    opus: 'large or risky change: touches infra/deploy/secrets/migrations, or is a P0 product decision',
  },
  instructions: 'Which builder should do this work, given what it touches and where it lands?',
  floor(facts) {
    const reasons = [];
    const touches = asArray(facts?.work?.touches);
    const sensitive = hasAny(touches, ['infra', 'deploy', 'secrets', 'migrations']);
    const publicSecurity = !!facts?.work?.repo_public && touches.includes('security');
    let allowed = ['minimax', 'codex', 'sonnet', 'opus'];
    if (sensitive) {
      allowed = allowed.filter((id) => id !== 'minimax' && id !== 'codex');
      reasons.push(`touches ${touches.filter((t) => ['infra', 'deploy', 'secrets', 'migrations'].includes(t)).join('/')}: cheapest builders off the table`);
    }
    if (publicSecurity) {
      allowed = allowed.filter((id) => id !== 'minimax' && id !== 'codex');
      reasons.push('public repo + security: cheapest builders off the table');
    }
    const forced = facts?.work?.p0_product_decision ? 'opus' : null;
    if (forced) reasons.push('P0 product decision: Opus');
    return { allowed, forced, reasons };
  },
  // minimax only for a small, specific change: files_est <= 3 AND lines_est <= 200 (both must be given) AND not
  // ui_wiring AND not stateful AND spec_clear !== false. Optional booleans on facts.work: ui_wiring (touches
  // UI wiring), stateful (stateful logic), spec_clear (the spec is clear; only an explicit false counts against).
  // Anything else is sonnet. The infra floor above still removes minimax/codex first.
  ruleDefault(facts, allowed) {
    const w = facts?.work || {};
    const small = Number.isFinite(w.files_est) && w.files_est <= 3 && Number.isFinite(w.lines_est) && w.lines_est <= 200
      && !w.ui_wiring && !w.stateful && w.spec_clear !== false;
    if (small && allowed.includes('minimax')) return 'minimax';
    return 'sonnet';
  },
};

// ---- reviewer ----
// Whether a reviewer (and which) should look over the work.
const reviewer = {
  usage: 'text.decision.route',
  options: {
    none: 'no reviewer needed: trivial change in a private repo with tests',
    haiku: 'light reviewer: cheap pass over a small change in a private repo',
    sonnet: 'default reviewer: catches real issues in a normal change',
    opus: 'strong reviewer: public repo, auth-adjacent, or anything where a missed bug is costly',
  },
  instructions: 'Should a reviewer look at this work, and if so how strong?',
  floor(facts) {
    const reasons = [];
    const touches = asArray(facts?.work?.touches);
    const publicRepo = !!facts?.work?.repo_public;
    const authTouch = touches.includes('auth');
    let allowed = ['none', 'haiku', 'sonnet', 'opus'];
    if (publicRepo) {
      allowed = allowed.filter((id) => id !== 'none' && id !== 'haiku');
      reasons.push('public repo: a real reviewer must look');
    } else if (authTouch) {
      allowed = allowed.filter((id) => id !== 'none' && id !== 'haiku');
      reasons.push('touches auth: a real reviewer must look');
    }
    return { allowed, forced: null, reasons };
  },
  ruleDefault() { return 'sonnet'; },
};

// ---- retry ----
// What to do after a rejection.
const retry = {
  usage: 'text.decision.retry',
  options: {
    retry_same_with_notes: 'ask the same builder to redo, with notes on what to change',
    step_up_one: 'give the same work to a stronger builder or model',
    owner: 'stop retrying and surface this to the owner',
  },
  instructions: 'After this rejection, what is the right next move?',
  floor(facts) {
    const reasons = [];
    let allowed = ['retry_same_with_notes', 'step_up_one', 'owner'];
    if (Number(facts?.reject?.round) >= 2) {
      allowed = allowed.filter((id) => id !== 'retry_same_with_notes');
      reasons.push(`reject round ${facts.reject.round}: no more same-builder retries`);
    }
    return { allowed, forced: null, reasons };
  },
  ruleDefault() { return 'step_up_one'; },
};

// ---- stop ----
// Should the manager answer a stopped coding session itself, or escalate it to the owner?
// facts shape: { session, agent, case, priority, forbidden_topic, closing_text (<= 1500 chars), proposed_reply }
//   - session:        session id/name (string)
//   - agent:          'claude' | 'codex' | 'minimax' (string)
//   - case:           the stop's rule case (continue | stopped_short | menu_recommended | done | permission |
//                     owner_decision | waiting_deploy | owner_action | error | background_wait | unknown)
//   - priority:       'P0' | 'P1' | 'P2' (string; informational)
//   - forbidden_topic: true when the closing text / proposed reply hits the manager's forbidden list
//   - closing_text:   the agent's own closing text (<= 1500 chars) so Jev sees the stop
//   - proposed_reply: the AI reviewer's candidate reply for this stop (string, optional)
// floor: forbidden_topic OR case in {permission, owner_action, waiting_deploy} -> forced 'escalate'.
// ruleDefault: 'escalate' (conservative), except case 'continue' -> 'answer'.
const stop = {
  usage: 'text.decision.manager',
  options: {
    answer: 'a safe reply exists that cannot make a choice the owner should make: continue a planned step, take a clearly recommended option, or give a fact the manager knows; the proposed reply (if any) is safe',
    escalate: 'only the owner can rightly answer: a preference, an approval, credentials, a product decision, a physical action, a deploy go-ahead, or anything risky or unclear',
  },
  instructions: 'Should the manager answer this stopped session itself, or escalate it to the owner?',
  floor(facts) {
    const reasons = [];
    const c = facts?.case;
    let forced = null;
    if (facts?.forbidden_topic) { forced = 'escalate'; reasons.push('forbidden topic: the manager must not answer'); }
    else if (['permission', 'owner_action', 'waiting_deploy'].includes(c)) { forced = 'escalate'; reasons.push(`case "${c}": only the owner can answer`); }
    return { allowed: ['answer', 'escalate'], forced, reasons };
  },
  ruleDefault(facts) {
    return facts?.case === 'continue' ? 'answer' : 'escalate';
  },
};

// ---- model (suggestion only) ----
// A hint about which model a non-decision step should use. Suggestions only.
const model = {
  usage: 'text.decision.model',
  options: {
    keep: 'keep the current model: no reason to change',
    sonnet: 'use Sonnet for this step',
    opus: 'use Opus for this step',
    hold: 'hold: do not call any model for this step yet',
  },
  instructions: 'Given the situation, which model (if any) should handle this step?',
  floor() { return { allowed: ['keep', 'sonnet', 'opus', 'hold'], forced: null, reasons: [] }; },
  ruleDefault() { return 'keep'; },
};

export const POINTS = { wake, builder, reviewer, retry, stop, model };
export const SUGGEST_ONLY = new Set(['model']);

// ---- floor + ruleDefault for a point ----
// ruleDefault is clamped to the allowed list: if the rule's pick is not allowed, the first allowed
// option wins. Both are pure.
export function floor(point, facts) {
  const p = POINTS[point];
  if (!p) throw new Error(`unknown point: ${point}`);
  const f = p.floor(facts) || { allowed: [], forced: null, reasons: [] };
  const allowed = Array.isArray(f.allowed) ? f.allowed.slice() : [];
  // force the forced pick inside allowed (defensive: floor() should already do this)
  if (f.forced && !allowed.includes(f.forced)) allowed.unshift(f.forced);
  return { allowed, forced: f.forced || null, reasons: Array.isArray(f.reasons) ? f.reasons.slice() : [] };
}

export function ruleDefault(point, facts) {
  const p = POINTS[point];
  if (!p) throw new Error(`unknown point: ${point}`);
  const f = floor(point, facts);
  const pick = p.ruleDefault(facts, f.allowed) || f.allowed[0] || null;
  return f.allowed.includes(pick) ? pick : (f.allowed[0] || null);
}

// ---- build the POST /server/ai/decide body ----
// Returns null when the floor already forced a pick (no need to call Jev).
export function buildRequest(point, facts, { teamId, refs = {} } = {}) {
  const p = POINTS[point];
  if (!p) throw new Error(`unknown point: ${point}`);
  const f = floor(point, facts);
  if (f.forced) return null;
  const rd = p.ruleDefault(facts, f.allowed);
  const rulePick = f.allowed.includes(rd) ? rd : (f.allowed[0] || null);
  const criteria = {};
  for (const id of f.allowed) {
    if (p.options[id]) criteria[id] = p.options[id];
  }
  return {
    usage: p.usage,
    profile: 'jev',
    log: true,
    timeout_s: 20,
    team_id: teamId,
    refs: { source: 'ghosty-router', point, rule_default: rulePick, floor: f.reasons, ...refs },
    state: JSON.stringify(facts),
    questions: { choice: { type: 'choice', instructions: p.instructions, criteria } },
  };
}

// ---- collapse a server reply with the rule default ----
// jevJson shape (matches what decisions.js / manager.js read):
//   { success, answers: { choice: { choice, confidence, probabilities } }, decision_id, ... }
//   on failure / no answer: success:false / no answers / null
export function pick(point, facts, jevJson, { threshold = 0.7 } = {}) {
  const p = POINTS[point];
  if (!p) throw new Error(`unknown point: ${point}`);
  const f = floor(point, facts);
  const rd = p.ruleDefault(facts, f.allowed);
  const rulePick = f.allowed.includes(rd) ? rd : (f.allowed[0] || null);

  if (f.forced) {
    return { choice: f.forced, source: 'forced', confidence: 1, ruleDefault: rulePick, allowed: f.allowed };
  }
  const a = jevJson && jevJson.answers && jevJson.answers.choice;
  const ok = !!(jevJson && jevJson.success !== false && a);
  const choice = ok ? a.choice : null;
  const confidenceRaw = ok ? Number(a.confidence) : null;
  const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : null;
  const allowed = f.allowed;
  if (ok && choice != null && allowed.includes(choice) && confidence != null && confidence >= threshold) {
    return { choice, source: 'jev', confidence, ruleDefault: rulePick, allowed };
  }
  return { choice: rulePick, source: 'rule', confidence: confidence ?? 0, ruleDefault: rulePick, allowed };
}

// ---- end-to-end: floor -> buildRequest -> post -> pick ----
// post(body) -> Promise<json|null>: injected; should resolve to null on transport / parse error.
// Never throws. Returns pick(...) plus decision_id when the reply carries one.
export async function decide(point, facts, { post, teamId, refs, threshold } = {}) {
  const p = POINTS[point];
  if (!p) return { choice: null, source: 'rule', confidence: 0, ruleDefault: null, allowed: [], error: `unknown point: ${point}` };
  const f = floor(point, facts);
  if (f.forced) {
    const rd = p.ruleDefault(facts, f.allowed);
    const rulePick = f.allowed.includes(rd) ? rd : (f.allowed[0] || null);
    return { choice: f.forced, source: 'forced', confidence: 1, ruleDefault: rulePick, allowed: f.allowed };
  }
  if (typeof post !== 'function') return pick(point, facts, null, { threshold });
  const body = buildRequest(point, facts, { teamId, refs });
  let reply = null;
  try {
    reply = await post(body);
  } catch {
    reply = null;
  }
  const out = pick(point, facts, reply, { threshold });
  const decisionId = reply && reply.decision_id ? reply.decision_id : null;
  return decisionId ? { ...out, decision_id: decisionId } : out;
}