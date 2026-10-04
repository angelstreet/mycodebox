// "Deployed now" view model (TASK-44 deploy ledger). Pure: the registry's `deploy last --json` map in, display rows out.
// Input: { "<env>": { "<target>": { at, ref, commit, version, agent, source?, lastAttempt?: {at, ref, version, agent, status} } } } (epoch seconds)
const GENERIC = ['frontend', 'server', 'hosts'];

export function agoText(sec, nowSec) {
  const d = Math.max(0, Math.round(nowSec - sec));
  if (d < 90) return `${d}s ago`;
  if (d < 5400) return `${Math.round(d / 60)}m ago`;
  if (d < 172800) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}

const rank = (t) => (GENERIC.includes(t) ? GENERIC.indexOf(t) : GENERIC.length);

// One row per target; named hosts that are identical (same version/ref/commit/agent, no failed attempt) fold into one row.
export function deployedView(deployed, nowMs = Date.now()) {
  const nowSec = nowMs / 1000;
  const out = [];
  for (const env of Object.keys(deployed || {}).sort()) {
    const targets = Object.keys(deployed[env] || {}).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const rows = [];
    for (const t of targets) {
      const e = deployed[env][t] || {};
      const la = e.lastAttempt && (!e.at || e.lastAttempt.at >= e.at) ? e.lastAttempt : null;      // only when newer than the deployed one
      const row = {
        targets: [t], version: e.version || '', ref: e.ref || '', commit: (e.commit || '').slice(0, 9), at: e.at || 0,
        ago: e.at ? agoText(e.at, nowSec) : '', by: e.agent || '', backfill: e.source === 'backfill', deployed: !!e.at,
        failed: la ? { ago: agoText(la.at, nowSec), version: la.version || '', ref: la.ref || '', by: la.agent || '' } : null,
      };
      const key = (r) => [r.version, r.ref, r.commit, r.by, r.backfill].join('|');
      const twin = rank(t) === GENERIC.length && !row.failed && row.deployed
        ? rows.find((r) => rank(r.targets[0]) === GENERIC.length && !r.failed && r.deployed && key(r) === key(row)) : null;
      if (twin) { twin.targets.push(t); if (row.at > twin.at) { twin.at = row.at; twin.ago = row.ago; } } else rows.push(row);
    }
    out.push({ env, rows });
  }
  return out;
}

// "host-clone-1, labox-web +8" for a long folded list.
export function targetLabel(targets, max = 2) {
  return targets.length <= max ? targets.join(', ') : `${targets.slice(0, max).join(', ')} +${targets.length - max}`;
}
