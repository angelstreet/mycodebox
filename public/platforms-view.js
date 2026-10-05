// Platforms page view model (TASK-44 redesign). Pure: snapshots in, one block per platform/env out.
// Inputs: leases from GET /api/leases ({id, env, resource, agent, purpose, kind, ttlLeftMin}), the deploy snapshot from
// GET /api/deploys (deploys with registry-computed `blocking`, `deployed` ledger), live tmux session names, machine set.
import { agentSession } from './platforms.js';
import { agoText } from './deployed.js';

const PENDING = ['awaiting-approval', 'queued'];
const GENERIC = ['frontend', 'server', 'hosts'];
const rank = (t) => (GENERIC.includes(t) ? GENERIC.indexOf(t) : GENERIC.length);
const STATUS_ORDER = { BLOCKED: 0, DEPLOYING: 1, FREE: 2 };

// vpt-lease kinds: `server` (old `run`) = a server restart breaks the holder; `host` (old `maintenance`) = only a restart
// of its host/device services does. Old names still arrive from an old registry: treat them as the new ones.
export const leaseKind = (kind) => (kind === 'host' || kind === 'maintenance' ? 'host' : 'server');
export const kindLabel = (kind) => (leaseKind(kind) === 'host' ? 'host-bound' : 'server-bound');

// Plain name for an agent id. `codebox:TASK-28-tp-worker` -> "task28", `claude-mac:labox-dongle-disk` -> "mac",
// `manager:deploy` -> "manager". A holder on this codebox / this host whose tmux session no longer exists -> gone.
export function whoName(agent, sessionNames = [], machines = new Set()) {
  const a = String(agent || '');
  const i = a.indexOf(':');
  const machine = (i > 0 ? a.slice(0, i) : a).toLowerCase();
  const rest = i > 0 ? a.slice(i + 1) : '';
  if (machine === 'manager') return { text: 'manager', gone: false, session: null };
  if (machines.has(machine)) {
    const session = agentSession(a, sessionNames, machines);
    if (!session) return { text: '', gone: true, session: null };
    const t = session.match(/^task-?(\d+)/i);
    return { text: t ? `task${t[1]}` : session, gone: false, session };
  }
  return { text: machine.replace(/^claude-/, '') || '?', gone: false, session: null };
}

// "~55 min" / "~1h40"
export function etaText(min) {
  if (min == null || isNaN(min)) return '';
  if (min < 1) return '<1 min';
  if (min < 60) return `~${min} min`;
  return `~${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
}
export function leftText(min) {
  if (min == null || isNaN(min)) return '';
  if (min < 1) return '<1 min left';
  if (min < 60) return `${min} min left`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')} left`;
}

// What the runner really waits on. The registry lists every lease that overlaps the scope (`blocking`), but the runner
// starts full / host requests with --skip-leased (deploy-runner.js skipsLeased, vpt-lease blockers(skip_leased=True)):
// a full deploy is blocked only by env-wide leases and by `server` leases (it restarts the server), a host deploy
// without a host list only by env-wide leases. Everything else is dropped by update_core and caught up later.
export function effectiveBlockers(d) {
  const b = d.blocking || [];
  if (d.scope === 'full') return b.filter((l) => l.resource === '*' || leaseKind(l.kind) === 'server');
  if (d.scope === 'host' && !(d.hosts && d.hosts.length)) return b.filter((l) => l.resource === '*');
  return b;
}

export const scopeText = (d) => (d.scope === 'host' && d.hosts?.length ? `host (${d.hosts.length})` : d.scope);

export function resourceLabel(l) {
  return l.resource === '*' ? `${l.env} (all)` : l.resource.replace('/', ' · ');
}

// Per env: 'BLOCKED' (a pending deploy waits on a lease) / 'DEPLOYING' (one runs) / 'FREE'.
export function envStatus(deploys) {
  if (deploys.some((d) => d.state === 'running')) return 'DEPLOYING';
  if (deploys.some((d) => PENDING.includes(d.state) && effectiveBlockers(d).length)) return 'BLOCKED';
  return 'FREE';
}

export function liveRows(ledger, nowMs) {
  const nowSec = nowMs / 1000;
  return Object.keys(ledger || {}).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((target) => {
    const e = ledger[target] || {};
    const la = e.lastAttempt && (!e.at || e.lastAttempt.at >= e.at) ? e.lastAttempt : null;   // only when newer than the live one
    const reason = la ? String(la.reason || la.note || la.error || '').trim().slice(0, 60) : '';
    return { target, version: e.version || e.ref || '', ago: e.at ? agoText(e.at, nowSec) : '', deployed: !!e.at,
      failed: !!la, reason, failedAgo: la ? agoText(la.at, nowSec) : '' };
  });
}

// VPT take-control locks (GET /api/vpt-locks) next to the leases, for the one env that server belongs to.
const shortName = (s) => String(s || '').toLowerCase().replace(/^(vpt-|host-)/, '');
// The locks that belong to a lease resource ("vpt-pi1/stb4" = host/device, "vpt-pi1" = a whole host, "*" = every device).
export function locksForResource(resource, locks) {
  if (resource === '*') return locks;
  const [h, d] = String(resource).split('/');
  return locks.filter((l) => shortName(l.host) === shortName(h) && (d == null || d === '' || shortName(l.device) === shortName(d)));
}
export function lockText(l) {
  const age = l.ageMin == null ? '' : l.ageMin < 1 ? ', <1m' : l.ageMin < 60 ? `, ${l.ageMin}m` : `, ${Math.floor(l.ageMin / 60)}h${String(l.ageMin % 60).padStart(2, '0')}`;
  const who = [l.owner, l.reason].filter(Boolean).join(' · ');
  return `${l.ownerType}${who ? ` · ${who}` : ''}${age}`;
}
// "VPT lock: free" / "VPT lock: manual_control · jo, 4m" / "VPT lock: unknown" (the server could not be asked)
export function vptLockLabel(vpt, resource) {
  if (!vpt || !vpt.ok) return 'VPT lock: unknown';
  const m = locksForResource(resource, vpt.locks || []);
  return m.length ? `VPT lock: ${m.map(lockText).join('; ')}` : 'VPT lock: free';
}

export function platformsBlocks({ leases = [], deploys = [], deployed = {}, sessionNames = [], machines = new Set(), nowMs = Date.now(), vptLocks = null }) {
  const nowSec = nowMs / 1000;
  const active = (d) => PENDING.includes(d.state) || d.state === 'running';
  const envs = new Set([...leases.map((l) => l.env), ...deploys.filter(active).map((d) => d.env), ...Object.keys(deployed || {})]);
  if (vptLocks?.ok && vptLocks.locks?.length && vptLocks.env) envs.add(vptLocks.env);   // a held lock shows even when no lease or deploy names the env
  const who = (a) => whoName(a, sessionNames, machines);
  return [...envs].map((env) => {
    const ds = deploys.filter((d) => d.env === env);
    const status = envStatus(ds);
    const blockIds = new Set(ds.filter((d) => PENDING.includes(d.state)).flatMap((d) => effectiveBlockers(d).map((l) => l.id)));
    const running = ds.filter((d) => d.state === 'running').sort((a, b) => (a.started || 0) - (b.started || 0))[0];
    const next = ds.filter((d) => PENDING.includes(d.state)).sort((a, b) => a.created - b.created).map((d) => {
      const bl = effectiveBlockers(d);
      const mins = bl.length ? Math.max(...bl.map((l) => l.ttlLeftMin ?? 0)) : null;
      return { id: d.id, scope: scopeText(d), ref: d.ref, who: who(d.agent), state: d.state, approve: d.state === 'awaiting-approval',
        blocked: bl.length > 0, eta: mins == null ? '' : etaText(mins), etaMin: mins };
    });
    const inUse = leases.filter((l) => l.env === env).map((l) => ({
      id: l.id, resource: l.resource, label: resourceLabel(l), who: who(l.agent), kind: leaseKind(l.kind), kindLabel: kindLabel(l.kind),
      left: leftText(l.ttlLeftMin), min: l.ttlLeftMin ?? 1e9, blocks: blockIds.has(l.id),
      vptLock: vptLocks && vptLocks.env === env ? vptLockLabel(vptLocks, l.resource) : '',
    })).sort((a, b) => (b.blocks - a.blocks) || (a.min - b.min) || a.resource.localeCompare(b.resource));
    const history = ds.filter((d) => !active(d)).sort((a, b) => (b.finished || 0) - (a.finished || 0)).slice(0, 8).map((d) => ({
      id: d.id, ago: d.finished ? agoText(d.finished, nowSec) : '', ok: d.state === 'done', state: d.state, scope: scopeText(d), ref: d.ref, who: who(d.agent),
    }));
    // The take-control locks no lease row accounts for (a person took control, or a script runs, without a vpt-lease).
    const mine = !!vptLocks && vptLocks.env === env;
    const covered = new Set(inUse.flatMap((r) => locksForResource(r.resource, vptLocks?.ok ? vptLocks.locks || [] : [])));
    const vptOther = mine && vptLocks.ok ? (vptLocks.locks || []).filter((x) => !covered.has(x)).map((x) => ({ resource: `${x.host}${x.device ? ` · ${x.device}` : ''}`, text: lockText(x) })) : [];
    const vptUnknown = mine && !vptLocks.ok;
    return {
      env, status, inUse, vptOther, vptUnknown, next, history, live: liveRows(deployed[env], nowMs),
      deploying: running ? { id: running.id, scope: scopeText(running), ref: running.ref, who: who(running.agent), startedAgo: running.started ? agoText(running.started, nowSec) : '' } : null,
    };
  }).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.env.localeCompare(b.env));
}
