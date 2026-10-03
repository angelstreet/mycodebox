// Manager policy by priority and quota (TASK-44 phase 6). Pure: no I/O, shared by the server and the UI.
//   evaluatePolicy({ priority, agent, paused, quota, now, config }) -> { action: 'allow'|'hold', reason, pct?, window? }
//   suggestAgent(priority, quota, config)                           -> { agent, reason }
// `quota` is the /api/quota payload ({ plans:[{plan, label, stale, windows:[{name, usedPercent, resetsAt, expired}]}] }).
// P0 is always allowed (the Phase 4 safety gates still apply elsewhere). Missing / stale / expired data
// never holds anything. The policy only decides whether a stopped session is continued; it never interrupts.

export const POLICY_DEFAULTS = { policyEnabled: true, p1MaxPct: 80, p2MaxPct: 80, minimaxMonthlyTokenBudget: null };
export const PLAN_OF_AGENT = { claude: 'claude', codex: 'codex', minimax: 'minimax' };
const WEEK_MS = 7 * 86400e3;
const MIN_ELAPSED = 0.1;       // weekly projection needs at least 10 % of the window behind it
const CLAUDE_FULL_PCT = 95;    // P0 suggestion leaves Claude only above this

const cfgOf = (c) => ({ ...POLICY_DEFAULTS, ...(c || {}) });
const usable = (plan, w) => !!plan && !plan.stale && w && !w.expired && Number.isFinite(w.usedPercent);

// Short-term (5 h) fill of a plan in %, or null when unknown. MiniMax has tokens only: with a monthly
// budget configured, month tokens / budget stands in for it.
export function shortPercent(plan, config) {
  if (!plan) return null;
  if (plan.plan === 'minimax') {
    const budget = Number(cfgOf(config).minimaxMonthlyTokenBudget);
    const mo = (plan.windows || []).find((w) => w.name === 'month');
    if (!(budget > 0) || !mo || plan.stale) return null;
    return Math.round(((mo.input || 0) + (mo.output || 0)) / budget * 1000) / 10;
  }
  const w = (plan.windows || []).find((x) => x.name === '5h');
  return usable(plan, w) ? w.usedPercent : null;
}

// Weekly window projected to run out before its reset: linear extrapolation of the usage so far.
export function weeklyProjection(plan, now) {
  const w = (plan?.windows || []).find((x) => x.name === 'week');
  if (!usable(plan, w) || !Number.isFinite(w.resetsAt)) return null;
  const left = w.resetsAt * 1000 - now;
  const elapsed = 1 - left / WEEK_MS;
  if (!(elapsed >= MIN_ELAPSED - 1e-9) || elapsed > 1) return null;
  const projected = w.usedPercent / elapsed;
  return { used: w.usedPercent, projected, runsOut: projected > 100 };
}

const planOf = (quota, agent) => (quota?.plans || []).find((p) => p.plan === PLAN_OF_AGENT[agent]);

export function evaluatePolicy({ priority = 'P2', agent, quota, now = Date.now(), config } = {}) {
  const c = cfgOf(config);
  if (!c.policyEnabled) return { action: 'allow', reason: 'policy off' };
  if (priority === 'P0') return { action: 'allow', reason: 'P0 always continues' };
  const plan = planOf(quota, agent);
  if (!plan) return { action: 'allow', reason: 'quota unknown' };
  const label = plan.label || plan.plan;
  const pct = shortPercent(plan, c);
  if (priority === 'P1') {
    if (pct == null) return { action: 'allow', reason: 'quota unknown' };
    return pct >= c.p1MaxPct
      ? { action: 'hold', reason: `${label} 5h ${Math.round(pct)}%`, pct, window: '5h' }
      : { action: 'allow', reason: `${label} 5h ${Math.round(pct)}% under ${c.p1MaxPct}%`, pct };
  }
  // P2 (and anything unrecognised is treated as P2)
  if (pct != null && pct >= c.p2MaxPct) return { action: 'hold', reason: `${label} 5h ${Math.round(pct)}%`, pct, window: '5h' };
  const wk = weeklyProjection(plan, now);
  if (wk?.runsOut) return { action: 'hold', reason: `${label} week ${Math.round(wk.used)}% would run out before reset`, pct: wk.used, window: 'week' };
  if (pct == null && !wk) return { action: 'allow', reason: 'quota unknown' };
  return { action: 'allow', reason: `${label} has headroom`, pct };
}

// Which agent to preselect when creating a session. Suggestion only: the owner's pick wins.
export function suggestAgent(priority, quota, config) {
  const c = cfgOf(config);
  const info = ['claude', 'codex', 'minimax'].map((a) => {
    const p = planOf(quota, a);
    const pct = shortPercent(p, c);
    return { agent: a, pct, label: p?.label || a };
  });
  const by = Object.fromEntries(info.map((i) => [i.agent, i]));
  const head = (i) => (i.pct == null ? null : 100 - i.pct);
  const text = (i) => (i.pct == null ? `${i.label} (quota unknown)` : `${i.label} 5h ${Math.round(i.pct)}%`);
  // most headroom among known plans; Claude wins ties and is the fallback when nothing is known
  const best = (list) => {
    const known = list.filter((i) => head(i) != null);
    if (!known.length) return null;
    return known.sort((a, b) => head(b) - head(a) || (a.agent === 'claude' ? -1 : b.agent === 'claude' ? 1 : 0))[0];
  };
  const pick = (i, why) => ({ agent: i.agent, reason: `${why}: ${text(i)}` });
  if (priority === 'P0') {
    if (!(by.claude.pct >= CLAUDE_FULL_PCT)) return pick(by.claude, 'P0 prefers Claude');
    const o = best([by.codex, by.minimax]);
    return o ? pick(o, 'Claude is full, most headroom') : pick(by.claude, 'P0 prefers Claude');
  }
  if (priority === 'P1') {
    const b = best(info);
    return b ? pick(b, 'most headroom') : pick(by.claude, 'no quota known');
  }
  // P2 bulk work: MiniMax unless it is known to be under pressure
  if (!(by.minimax.pct >= c.p2MaxPct)) return pick(by.minimax, 'P2 prefers MiniMax');
  const o = best([by.claude, by.codex]);
  return o ? pick(o, 'MiniMax is under pressure, most headroom') : pick(by.minimax, 'P2 prefers MiniMax');
}
