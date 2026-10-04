// Platforms view model (TASK-44): who holds which lease, deploy-wait signals, chip text. Pure: used by server.js and the page.
// Ownership is EXACT: a lease belongs to a session iff its agent is `<machine>:<tmux session name>` (case-insensitive),
// where <machine> is `codebox` or this machine's hostname. No fuzzy matching: agents must use
// AGENT="codebox:$(tmux display-message -p '#S')" (see the deploy skill).
import { deployedView } from './deployed.js';

const PENDING = ['awaiting-approval', 'queued'];            // a deploy waiting for the platform; `running` already owns it
const ACTIVE = ['awaiting-approval', 'queued', 'running'];

export const machinesOf = (hostname) => {
  const m = new Set(['codebox']);
  const h = String(hostname || '').toLowerCase().split('.')[0];
  if (h) m.add(h);
  return m;
};

// session name for an agent id, or null
export function agentSession(agent, sessionNames, machines) {
  const a = String(agent || '');
  const i = a.indexOf(':');
  if (i <= 0 || !machines.has(a.slice(0, i).toLowerCase())) return null;
  const want = a.slice(i + 1).toLowerCase();
  if (!want) return null;
  const exact = sessionNames.find((n) => n === a.slice(i + 1));
  return exact ?? sessionNames.find((n) => n.toLowerCase() === want) ?? null;
}

// Does a deploy of this scope disturb a lease on res? Same table as vpt-lease scope_touches.
export function scopeTouches(scope, res) {
  if (res === '*' || scope === 'server' || scope === 'full') return true;
  if (scope === 'frontend') return res === 'frontend';
  return res !== 'frontend';
}
// A queued / awaiting-approval deploy on this env that the lease is in the way of.
export function blocksDeploy(lease, deploys) {
  return (deploys || []).some((d) => PENDING.includes(d.state) && d.env === lease.env && scopeTouches(d.scope, lease.resource));
}

const slim = (l, deploys) => ({ id: l.id, env: l.env, resource: l.resource, agent: l.agent, ttlLeftMin: l.ttlLeftMin, purpose: l.purpose || '', blocksDeploy: blocksDeploy(l, deploys) });

// the resources a session holds: [{env, resource, ttlLeftMin, purpose, blocksDeploy}]
export function holdingsOf(session, leases, deploys, sessionNames, machines) {
  return (leases || []).filter((l) => agentSession(l.agent, sessionNames, machines) === session)
    .map((l) => slim(l, deploys)).sort((a, b) => a.env.localeCompare(b.env) || a.resource.localeCompare(b.resource));
}

// "pi1/stb4" for "vpt-pi1/stb4"; the env name stands for "*"
export const shortResource = (l) => (l.resource === '*' ? l.env : l.resource.replace(/^(vpt-|host-)/, ''));
export function ttlText(min) {
  if (min == null || isNaN(min)) return '';
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
}
// "🔒 pi1/stb4 · 1h40" (+1 when more); the one that blocks a deploy, else the soonest to expire, leads. null = no chip.
export function chipModel(holdings) {
  if (!holdings || !holdings.length) return null;
  const first = [...holdings].sort((a, b) => (b.blocksDeploy - a.blocksDeploy) || ((a.ttlLeftMin ?? 1e9) - (b.ttlLeftMin ?? 1e9)))[0];
  const blocks = holdings.some((h) => h.blocksDeploy);
  const t = ttlText(first.ttlLeftMin);
  const more = holdings.length > 1 ? ` +${holdings.length - 1}` : '';
  return { text: `\u{1F512} ${shortResource(first)}${t ? ` · ${t}` : ''}${more}${blocks ? ' · blocks deploy' : ''}`, blocks, env: first.env, resource: first.resource };
}

// Is this session blocked on a deploy? null, or { kind: requested|waiter|said, id, state, env, blocking[], text }.
export function deployWaitOf(session, { deploys = [], waiters = [], stall = null, sessionNames, machines }) {
  const mine = (a) => agentSession(a, sessionNames, machines) === session;
  const req = deploys.filter((d) => ACTIVE.includes(d.state) && mine(d.agent)).sort((a, b) => a.created - b.created)[0];
  if (req) {
    const blocking = (req.blocking || []).map((l) => `${shortResource(l)}${l.agent ? ` (${l.agent})` : ''}`);
    const stateTxt = req.state === 'awaiting-approval' ? 'awaiting your approval' : req.state;
    return { kind: 'requested', id: req.id, state: req.state, env: req.env, blocking,
      text: `requested deploy #${req.id} (${stateTxt}${blocking.length ? `, blocked by ${blocking.join(', ')}` : ''})` };
  }
  const w = waiters.find((x) => mine(x.agent));
  if (w) {
    const d = deploys.find((x) => ACTIVE.includes(x.state) && (w.deployId ? x.id === w.deployId : x.env === w.env));
    return { kind: 'waiter', id: d?.id || w.deployId || '', state: d?.state || '', env: d?.env || w.env, blocking: [],
      text: d ? `waiting on deploy #${d.id}` : 'waiting on a deploy' };
  }
  if (stall && stall.case === 'waiting_deploy') return { kind: 'said', id: '', state: '', env: '', blocking: [], text: 'said it waits for a deploy' };
  return null;
}

// Platforms page data: per env the held resources, the deploy queue and the ledger summary.
export function platformsView({ leases = [], deploys = [], waiters = [], deployed = {}, sessionNames = [], machines, nowMs = Date.now() }) {
  const dv = new Map(deployedView(deployed, nowMs).map((e) => [e.env, e.rows]));
  const envs = new Set([...leases.map((l) => l.env), ...deploys.filter((d) => ACTIVE.includes(d.state)).map((d) => d.env), ...dv.keys()]);
  return [...envs].sort().map((env) => {
    const resources = leases.filter((l) => l.env === env).map((l) => {
      const s = agentSession(l.agent, sessionNames, machines);
      return { ...slim(l, deploys), session: s, unknown: s ? null : l.agent || '?' };
    }).sort((a, b) => a.resource.localeCompare(b.resource));
    const queue = deploys.filter((d) => d.env === env && ACTIVE.includes(d.state)).sort((a, b) => a.created - b.created)
      .map((d) => ({ ...d, session: agentSession(d.agent, sessionNames, machines) }));
    const rows = dv.get(env) || [];
    const done = rows.filter((r) => r.deployed);
    const newest = done.reduce((m, r) => (r.at > (m?.at || 0) ? r : m), null);
    const versions = new Set(done.map((r) => r.version || '?'));
    const summary = !rows.length ? 'nothing recorded' : `${versions.size === 1 ? [...versions][0] : `${versions.size} versions`} · ${rows.reduce((n, r) => n + r.targets.length, 0)} targets${newest ? ` · ${newest.ago}` : ''}${rows.some((r) => r.failed) ? ' · last attempt failed' : ''}`;
    return { env, resources, queue, waiters: waiters.filter((w) => (w.env || '') === env), deployedSummary: summary, deployedRows: rows };
  });
}
