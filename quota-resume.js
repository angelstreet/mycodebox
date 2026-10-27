// Resume a session stopped on a provider usage limit once its plan's window has reset. A MiniMax (mcode) session that hits
// the 5 h limit prints "Usage limit reached ... Your prompt is preserved." and sits with the prompt in the input box;
// one Enter resends it. Pure decision function plus a tick with injected IO (the pattern of crash-resume.js).
// A login stop ("Sign in to MiniMax ... /login") is a credentials problem: never auto-handled, only escalated.

const PLANS = { minimax: 'minimax', claude: 'claude', codex: 'codex' };   // pane agent -> quota plan
export const LIMIT_PCT = 95;                  // a window at or above this is still full (quota.js CRIT_PCT)
export const QUOTA_MAX_AGE_MS = 15 * 60e3;    // quota.js polls every 5 min: three missed polls = stale
export const REPEAT_MS = 10 * 60e3;           // a limit hit again this soon after a resume backs off to the next reset
const WINDOW_MS = 5 * 3600e3;
const TAIL = 15;
const LIMIT_RE = /\busage limit reached\b/i;
const PRESERVED_RE = /prompt is preserved/i;
const LOGIN_RE = /Sign in to MiniMax|Run \/login\b/i;

// What the pane's last lines say: { kind: 'login' | 'limit' | null, preserved }. A login stop wins over a limit line.
export function scanLimit(lines) {
  const tail = (Array.isArray(lines) ? lines : []).map((x) => String(x ?? '')).filter((l) => l.trim()).slice(-TAIL);
  if (tail.some((l) => LOGIN_RE.test(l))) return { kind: 'login', preserved: false };
  if (!tail.some((l) => LIMIT_RE.test(l))) return { kind: null, preserved: false };
  return { kind: 'limit', preserved: tail.some((l) => PRESERVED_RE.test(l)) };
}

// The windows that still block the plan, or null when the reading cannot be trusted. A window is open when it is
// unlimited, already reset (expired) or under LIMIT_PCT. Returns { blocked: [windows], reset: latest resetsAt (s) | null }.
export function planBlock(plan, now, maxAgeMs = QUOTA_MAX_AGE_MS) {
  if (!plan || plan.stale || !plan.windows?.length) return null;
  if (plan.at != null && now - plan.at > maxAgeMs) return null;
  const blocked = plan.windows.filter((w) => !w.unlimited && !w.expired && !(Number.isFinite(w.usedPercent) && w.usedPercent < LIMIT_PCT));
  const resets = blocked.map((w) => w.resetsAt).filter(Number.isFinite);
  return { blocked, reset: resets.length ? Math.max(...resets) : null };
}

// state: { name, agent, lines, input, closed }. sighting: { draft, reset, firstSeen } of the current stop, last: { at, key }
// of the previous resume, backoffUntil in ms. Returns { ok, reason, plan?, key? }.
export function decideQuotaResume({ state, plan = null, managerSessions = [], allowManager = false, paused = false, held = false, sighting = null, last = null, backoffUntil = null, now = Date.now() } = {}) {
  if (!state) return { ok: false, reason: 'no-state' };
  if (!allowManager && managerSessions.includes(state.name)) return { ok: false, reason: 'manager-session' };
  if (state.closed) return { ok: false, reason: 'closed' };
  if (paused) return { ok: false, reason: 'paused' };
  if (held) return { ok: false, reason: 'held' };
  const planName = PLANS[state.agent];
  if (!planName) return { ok: false, reason: 'no-plan' };
  const scan = scanLimit(state.lines);
  if (scan.kind === 'login') return { ok: false, reason: 'login-stop', plan: planName };
  if (scan.kind !== 'limit') return { ok: false, reason: 'no-limit-stop' };
  if (!scan.preserved) return { ok: false, reason: 'no-preserved-prompt', plan: planName };
  // The preserved prompt itself sits in the input box; anything else typed there since the stop is somebody's draft.
  if (state.input && sighting?.draft != null && state.input !== sighting.draft) return { ok: false, reason: 'foreign-draft', plan: planName };
  if (backoffUntil != null && now < backoffUntil) return { ok: false, reason: 'backoff', plan: planName };
  const block = planBlock(plan, now);
  if (!block) return { ok: false, reason: 'quota-stale', plan: planName };
  if (block.blocked.length) return { ok: false, reason: 'window-not-reset', plan: planName };
  const key = sighting?.reset != null ? `r${sighting.reset}` : `w${Math.floor((sighting?.firstSeen ?? now) / WINDOW_MS)}`;
  if (last?.key === key) return { ok: false, reason: 'already-resumed', plan: planName, key };
  return { ok: true, plan: planName, key };
}

export function createQuotaResumer({ getState, getQuota, sendEnter, record, managerSessions = () => [], allowManager = () => false, isPaused = () => false, isHeld = () => false, now = Date.now } = {}) {
  const sightings = new Map(), lasts = new Map(), backoffs = new Map(), escalated = new Set();
  const planOf = (q, agent) => (q?.plans || []).find((p) => p.plan === PLANS[agent]);
  async function tick(names) {
    const out = [];
    const q = getQuota();
    for (const name of names || []) {
      const state = await getState(name);
      if (!state) continue;
      const t = now(), plan = planOf(q, state.agent), scan = scanLimit(state.lines);
      if (scan.kind !== 'limit') {   // the stop is over (or never was): the next one is a new sighting
        sightings.delete(name);
      }
      if (scan.kind !== 'login') escalated.delete(name);
      if (scan.kind === 'login' && PLANS[state.agent] && !escalated.has(name)) {
        escalated.add(name);
        await record?.({ key: `health:session-login-stop:${name}`, kind: 'health', title: `session needs a login, not resumed: ${name}`, body: 'the agent asks to sign in; credentials are never handled automatically' });
      }
      if (scan.kind === 'limit' && !sightings.has(name)) {
        const b = planBlock(plan, t);
        sightings.set(name, { draft: state.input || null, reset: b?.reset ?? null, firstSeen: t });
      }
      const sighting = sightings.get(name) || null;
      const d = decideQuotaResume({ state, plan, managerSessions: managerSessions(), allowManager: allowManager(), paused: !!isPaused(name), held: !!isHeld(name), sighting, last: lasts.get(name), backoffUntil: backoffs.get(name) ?? null, now: t });
      if (d.reason === 'no-limit-stop' || d.reason === 'no-plan' || d.reason === 'no-state') continue;
      out.push({ name, ...d });
      if (!d.ok) continue;
      // A limit hit again soon after a resume: the window was not really open. Back off to the next reset, no more tries before it.
      const prev = lasts.get(name);
      if (prev && t - prev.at < REPEAT_MS) {
        const next = planBlock(plan, t)?.reset;
        backoffs.set(name, next != null ? next * 1000 : t + WINDOW_MS);
        out[out.length - 1] = { name, ok: false, reason: 'repeat-limit', plan: d.plan, key: d.key };
        await record?.({ key: `health:session-quota-backoff:${name}`, kind: 'health', title: `usage limit hit again, backing off: ${name}`, body: `plan=${d.plan} next try after the next reset` });
        continue;
      }
      await sendEnter(name);
      lasts.set(name, { at: t, key: d.key });
      backoffs.delete(name);
      await record?.({ key: `health:session-quota-resumed:${name}`, kind: 'health', title: `session resumed after usage limit: ${name}`, body: `plan=${d.plan} window=${d.key}` });
    }
    return out;
  }
  return { tick, decide: decideQuotaResume };
}
