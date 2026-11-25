// Live truth of a deploy (owner 2026-11-25): "deployed" is not "live". A host deploy that skipped a leased host synced its code but
// deferred the vpt-host restart to a catch-up deploy, so that host still runs old code (117 of 273 deploy runs 2026-11-24..25 ended
// "SKIPPED: RUNNING OLD CODE"; vpt-pi1 was deferred ~20 times behind one long lease) and sessions said "deployed" anyway.
//
//   state `live`     no host of the deploy is skipped / waiting for a catch-up (or the deploy skipped none)
//   state `pending`  at least one host still waits: { hosts: [{ host, holder, until, catchUp, running }] }
//   state `unknown`  the registry view is not available: callers treat it as "no statement" (never block a session on an outage)
//
// Facts: deploy-runner.js writes `<deploys>/<id>.skipped.json` ({ env, ref, hosts, at }) BEFORE it finishes the deploy (recordSkipped); a
// host is waiting while an active (queued / running) catch-up deploy of the same env lists it (the registry's `old_code` is exactly that),
// or for 90 s after the record (the catch-up request is queued just after the finish). A host with a skip record and no active catch-up
// is live: the catch-up ran (or the registry dropped it). The holder is the lease that blocks the catch-up (`blocking` of the deploy row,
// else a lease of the lease view on the host or one of its devices).
//
// Consumers: integration-notify.js (the line to the requesting session), own-jobs.js (`STATUS: waiting: integration|deploy <id>` is not
// ended while pending, and is woken when the truth turns live), done-check.js (a closing text that claims deployed / live for a pending
// integration gets one push), integration-routes.js (GET /live), scripts/manager-status-scan.sh (one line per pending integration).
// Pure parts are exported for test/deploy-live.test.js.
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const GRACE_MS = 90 * 1000;
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isCatchUp = (d) => /^catch-up[ :]/.test(String(d?.purpose || ''));
const ACTIVE = new Set(['queued', 'running']);
const SAFE_ID = /^[\w.-]{1,64}$/;
const ms = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; const n = Date.parse(v); return Number.isFinite(n) ? n : null; };
const hhmm = (t) => (t ? `${new Date(t).toISOString().slice(11, 16)} UTC` : '');

// ---- the record the runner leaves --------------------------------------------------------------------------------------------------
export const skippedFile = (dir, id) => join(dir, `${id}.skipped.json`);
// ids: the deploy id and every request it closed (coalesced). Best effort: a failed write only means "no statement".
export function recordSkipped(dir, ids, { env, ref, hosts, at = Date.now() } = {}) {
  const list = (hosts || []).map(one).filter(Boolean);
  if (!dir || !list.length) return false;
  try {
    mkdirSync(dir, { recursive: true });
    for (const id of [...new Set((ids || []).map(String))].filter((x) => SAFE_ID.test(x))) {
      const f = skippedFile(dir, id), tmp = `${f}.tmp`;
      writeFileSync(tmp, JSON.stringify({ id, env: one(env), ref: one(ref), hosts: list, at }));
      renameSync(tmp, f);
    }
    return true;
  } catch { return false; }
}
export function readSkipped(dir, id) {
  if (!dir || !SAFE_ID.test(String(id || ''))) return null;
  try { const j = JSON.parse(readFileSync(skippedFile(dir, id), 'utf8')); return Array.isArray(j.hosts) ? j : null; } catch { return null; }
}

// ---- the truth (pure) --------------------------------------------------------------------------------------------------------------
// records: [{ env, hosts, at }]; deploys: the registry's deploy rows (queued / running carry `hosts`, `blocking`); leases: normalized lease rows
// ({ agent, resources, ttlLeftMin, kind, mode }); at: now (ms). -> { state, hosts: [...], skipped: [host] }
export function liveTruth({ records = [], deploys = null, leases = [], now = Date.now() } = {}) {
  const recs = (records || []).filter((r) => r && Array.isArray(r.hosts) && r.hosts.length);
  const skipped = [...new Set(recs.flatMap((r) => r.hosts))];
  if (!recs.length) return { state: 'live', hosts: [], skipped: [] };
  if (!Array.isArray(deploys)) return { state: 'unknown', hosts: [], skipped };
  const hosts = [];
  for (const h of skipped) {
    const mine = recs.filter((r) => r.hosts.includes(h));
    const catchUp = deploys.find((d) => isCatchUp(d) && ACTIVE.has(String(d.state)) && (d.hosts || []).includes(h) && (!d.env || mine.some((r) => !r.env || r.env === d.env)));
    const fresh = mine.some((r) => now - (Number(r.at) || 0) < GRACE_MS);
    if (!catchUp && !fresh) continue;   // the catch-up ran (or the registry dropped it): this host is live
    const blocking = (catchUp?.blocking || []).find((b) => b && b.agent);
    const lease = blocking || (leases || []).find((l) => l && l.agent && !/^(update_core|integration|manager:deploy)/.test(l.agent)
      && (l.resources || []).some((r) => String(r) === h || String(r).startsWith(`${h}/`)) && l.mode !== 'shared');
    const untilMs = blocking ? ms(blocking.expires_at ?? blocking.expires) : lease && Number.isFinite(lease.ttlLeftMin) ? now + lease.ttlLeftMin * 60000 : null;
    hosts.push({ host: h, holder: lease ? one(lease.agent).slice(0, 80) : null, until: untilMs || null, catchUp: catchUp ? String(catchUp.id) : null, running: catchUp?.state === 'running' });
  }
  return hosts.length ? { state: 'pending', hosts, skipped } : { state: 'live', hosts: [], skipped };
}

// the words for a session / the scan: `NOT live yet on vpt-pi1: restart deferred (lease X, until ~21:24 UTC)`
export function pendingText(t) {
  if (!t || t.state !== 'pending' || !t.hosts?.length) return '';
  const why = (h) => (h.running ? 'catch-up deploy running' : h.holder ? `lease ${h.holder}${h.until ? `, until ~${hhmm(h.until)}` : ''}` : `waiting for its catch-up deploy${h.catchUp ? ` ${h.catchUp}` : ''}`);
  const names = t.hosts.map((h) => h.host).join(', ');
  return t.hosts.length === 1 ? `NOT live yet on ${names}: restart deferred (${why(t.hosts[0])})`
    : `NOT live yet on ${names}: restart deferred (${t.hosts.map((h) => `${h.host}: ${why(h)}`).join('; ')})`;
}
export const liveAfterSkipText = (t) => (t?.state === 'live' && t.skipped?.length ? `now live on every host: the deferred restart of ${t.skipped.join(', ')} ran` : '');

// ---- closing text that claims "deployed / live" ----------------------------------------------------------------------------------
const CLAIM = /\b(?:deployed|live\s+(?:in|on)\s+prod\w*|(?:is|are|now|went|goes)\s+live|in\s+prod(?:uction)?|rolled\s+out|released\s+to\s+(?:prod|all))\b/i;
const NEGATED = /\b(?:not|never|n't|isn't|no longer|un)\s*(?:yet\s+)?(?:been\s+)?(?:deployed|live|in\s+prod)/i;
// the session's last STATUS line is a deploy / integration wait: it already says the truth
const WAITS_DEPLOY = /^\W*STATUS:[*_`]*\s*waiting\s*:\s*(?:deploy|integration)\b/im;
export function claimsLive(text) {
  const t = String(text || '');
  const last = t.split('\n').filter((l) => /^\W*STATUS:/i.test(l.trim())).pop() || '';
  if (WAITS_DEPLOY.test(last)) return false;
  const body = t.split('\n').filter((l) => !/^\W*STATUS:\s*waiting/i.test(l.trim())).join('\n');
  return CLAIM.test(body) && !NEGATED.test(body);
}
export function claimMessage(items) {
  const one1 = (i) => `integration ${i.id} is ${pendingText(i.truth).replace(/^NOT live yet on /, 'not live on ')}`;
  const first = items[0];
  const waitId = first.deployId ? `deploy ${first.deployId}` : `integration ${first.id}`;
  return `Done check: ${items.map(one1).join('; ')}. Your closing text says it is deployed / live: it is not on ${items.flatMap((i) => i.truth.hosts.map((h) => h.host)).filter((x, k, a) => a.indexOf(x) === k).join(', ')} yet. `
    + `Reword it (code merged and synced; the restart waits for the lease) and end on STATUS: waiting: ${waitId}; the harness wakes you the moment it is live.`;
}

// ---- the service -------------------------------------------------------------------------------------------------------------------
// deps: dir (the runner's deploys dir), deploys: () => registry deploy rows | null, leases: async () => lease rows, now.
export function createDeployLive({ dir, deploys = () => null, leases = async () => [], now = Date.now } = {}) {
  async function truthOfIds(ids) {
    const uniq = [...new Set((ids || []).filter(Boolean).map(String))];
    const records = uniq.map((id) => readSkipped(dir, id)).filter(Boolean);
    if (!records.length) return { state: 'live', hosts: [], skipped: [] };
    let l = []; try { l = (await leases()) || []; } catch { /* holder unknown */ }
    return liveTruth({ records, deploys: deploys(), leases: l, now: now() });
  }
  return {
    truthOfIds,
    // a lane request (the lane's own shape: deployed { id }, deployId): only a request that deployed has a truth
    async forRequest(r) {
      if (!r || r.state !== 'deployed' || r.deployed?.scope === 'self') return null;
      const ids = [r.deployed?.id, r.deployId].filter(Boolean);
      return ids.length ? truthOfIds(ids) : null;
    },
    forDeploy: (id) => truthOfIds([id]),
    // the pending ones among the session's / the lane's requests: [{ id, deployId, truth }]
    async pendingOf(requests) {
      const out = [];
      for (const r of requests || []) { const truth = await this.forRequest(r).catch(() => null); if (truth?.state === 'pending') out.push({ id: r.id, deployId: r.deployed?.id || r.deployId || null, branch: r.branch, truth }); }
      return out;
    },
  };
}
