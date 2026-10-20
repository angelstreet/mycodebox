// The lane's `deploys` adapter (round 13, brief B): a deploy request through the existing deploy registry path, then wait for it.
//   request: deploy request <env> --scope <s> --ref <target> --agent integration:<id> --approved   -> the deploy id on stdout
//   wait:    the registry has a blocking `deploy wait` only on the legacy side (the central registry rejects it), so wait polls
//            `deploy list --json` for that id until it is finished (a deploy it no longer lists, i.e. already finished, is asked
//            about with `deploy wait <id>`); the version is the entry's own, else this deploy's own entry in the
//            `deploy last <env> --json` ledger (one entry per target, see pickVersion).
// registry: (argv, opts) => { code, stdout, stderr } (leaseSource.deployRegistry()). Same-scope requests coalesce in the deploy queue
// (the runner finishes the merged requests with the winner's result), so a coalesced entry is followed to its result as any other.
const FINAL = { done: 'done', failed: 'failed', cancelled: 'cancelled', canceled: 'cancelled', error: 'failed', coalesced: 'done' };
const RUNNING = new Set(['running', 'started', 'in_progress', 'in-progress', 'deploying']);
const SCOPES = new Set(['frontend', 'server', 'host', 'full']);
const SAFE = /^[A-Za-z0-9][\w./:@+-]{0,120}$/;

export function requestArgv({ env, scope, ref, agent }) {
  return ['deploy', 'request', env, '--scope', scope, '--ref', ref, '--agent', agent, '--approved'];
}

// the ledger's `at` is epoch seconds (lease-service parseTs); an ISO string is read too
function stamp(e) {
  const v = e?.at ?? e?.lastAttempt?.at;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const ms = Date.parse(String(v ?? ''));
  return Number.isNaN(ms) ? -Infinity : Math.floor(ms / 1000);
}

// `deploy last <env> --json` is a per-target map { <target>: { at, version, agent, commit, status, deployId?, lastAttempt? } }
// (server, frontend, each host name), so `env.server || env.frontend || env.host` is NOT this deploy's entry: a scope-host
// deploy of 2026-10-20 23:44 put main-2026.10.20-89466 on every host while the lane reported the server's older
// main-2026.10.20-89445. The entry of THIS deploy wins, in that order: its deployId (on the entry, or on a done
// lastAttempt), then an entry recorded by its own agent, then the newest `at` inside the deploy's scope.
// A flat entry (no targets under it, e.g. { version }) has no target keys and keeps its own version.
function pickVersion(map, { id, scope, agent } = {}) {
  const targets = Object.entries(map || {}).filter(([, e]) => e && typeof e === 'object' && !Array.isArray(e) && (e.version || e.at || e.lastAttempt));
  const wanted = String(id || '');
  const mine = (e) => wanted && (String(e.deployId || '') === wanted
    || (String(e.lastAttempt?.deployId || '') === wanted && String(e.lastAttempt?.status || '') === 'done'));
  const inScope = ([t]) => scope === 'server' ? t === 'server' : scope === 'frontend' ? t === 'frontend'
    : scope === 'host' ? t !== 'server' && t !== 'frontend' : true;
  const newest = (list) => (list.length ? list.reduce((a, b) => (stamp(b[1]) > stamp(a[1]) ? b : a))[1] : null);
  const e = (wanted ? newest(targets.filter(([, x]) => mine(x))) : null)
    || (agent ? newest(targets.filter(([, x]) => String(x.agent || '') === String(agent))) : null)
    || newest(targets.filter(inScope)) || newest(targets);
  return e ? String(e.version || '') : '';
}

export function createIntegrationDeploys({ registry, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, pollMs = 5000, timeoutMin = 60 } = {}) {
  const reg = async (argv, opts) => { try { return await registry(argv, opts); } catch (e) { return { code: 255, stdout: '', stderr: String(e?.message || e) }; } };
  // -> { ok, id } | { ok: false, error }
  async function request({ env, scope, ref, sha, agent } = {}) {
    if (!SAFE.test(String(env || ''))) return { ok: false, error: 'deploy request needs an env' };
    if (!SCOPES.has(scope)) return { ok: false, error: `deploy scope must be one of ${[...SCOPES].join(', ')}` };
    if (!SAFE.test(String(ref || ''))) return { ok: false, error: 'deploy request needs a ref' };
    if (!/^integration:[\w.-]{1,60}$/.test(String(agent || ''))) return { ok: false, error: 'deploy agent must be integration:<id>' };
    const r = await reg(requestArgv({ env, scope, ref, agent }));
    const id = String(r.stdout || '').trim().split(/\s+/).pop() || '';
    if (r.code !== 0 || !id) return { ok: false, error: String(r.stderr || `deploy request exit ${r.code}`).trim().slice(0, 300) };
    return { ok: true, id, sha: sha || null };
  }
  async function listed(id) {
    const r = await reg(['deploy', 'list', '--json']);
    if (r.code !== 0) return null;
    try { const j = JSON.parse(r.stdout); return (Array.isArray(j) ? j : j.deploys || []).find((d) => String(d.id) === String(id)) || null; } catch { return null; }
  }
  // -> the id of a live-or-done deploy already requested for this agent (a restart between request and the saved id), else null
  async function find({ agent } = {}) {
    if (!/^integration:[\w.-]{1,60}$/.test(String(agent || ''))) return null;
    const r = await reg(['deploy', 'list', '--json']);
    if (r.code !== 0) return null;
    try {
      const j = JSON.parse(r.stdout), all = (Array.isArray(j) ? j : j.deploys || []).filter((d) => String(d.agent || '') === agent && !['failed', 'error', 'cancelled', 'canceled'].includes(String(d.state || '').toLowerCase()));
      return all.length ? String(all[all.length - 1].id) : null;
    } catch { return null; }
  }
  // -> the version of THIS deploy, read out of the ledger: its own target entry (see pickVersion), not the first target.
  // `d` carries the deploy's id, env, scope and agent as the list reports them; any of them may be missing.
  async function versionOf(d) {
    if (d?.version) return String(d.version);
    const r = await reg(['deploy', 'last', d?.env || '', '--json'].filter((x) => x !== ''));
    try {
      const j = JSON.parse(r.stdout), env = j?.envs ? j.envs[d?.env] || Object.values(j.envs)[0] : j;
      return String(pickVersion(env, d) || env?.version || '') || null;
    } catch { return null; }
  }
  // The list only holds queued/running deploys, so one that finishes between two polls (or before the first) is gone from it:
  // ask the registry itself for that id's final state before a miss is counted, else a deploy that succeeded is reported
  // as not in the registry (real case 2026-10-20: two lane deploys, both `deploy wait <id>` said done).
  // `deploy wait <id> --timeout 5` prints one line and exits 0 on done / 1 on failed|cancelled; anything else (still queued or
  // running, timeout, unreachable, unknown id) returns null so the poll carries on.
  // `d` is the last listed entry of this deploy (null when it was never listed): its env/scope/agent pick the ledger entry.
  async function finalById(id, d) {
    const r = await reg(['deploy', 'wait', String(id), '--timeout', '5']);
    const line = String(r.stdout || '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('deploy ')) || '';
    let m = r.code === 0 ? /^deploy\s+\S+\s+done(?:\s+\(version\s+(.+)\))?$/.exec(line) : null;
    if (m) return { ok: true, state: 'done', version: m[1] ? String(m[1]) : await versionOf({ id, env: d?.env, scope: d?.scope, agent: d?.agent }), tail: '' };
    m = r.code === 1 ? /^deploy\s+\S+\s+(failed|cancelled|canceled)(?:\s+\((.*)\))?$/.exec(line) : null;
    if (m) return { ok: false, state: m[1] === 'failed' ? 'failed' : 'cancelled', version: null, tail: String(m[2] || '').slice(-1000) };
    return null;
  }
  // -> { ok, state: 'done'|'failed'|'cancelled'|'timeout'|'unknown', version, tail, error? }
  async function wait(id, { timeoutMs = timeoutMin * 60000 } = {}) {
    const t0 = now();
    let misses = 0, seen = null;   // seen: the last listed entry, so a deploy gone from the list still knows its env/scope/agent
    for (;;) {
      const d = await listed(id);
      if (d) {
        misses = 0;
        seen = d;
        const fin = FINAL[String(d.state || '').toLowerCase()];
        if (fin) return { ok: fin === 'done', state: fin, version: fin === 'done' ? await versionOf({ ...d, id }) : null, tail: String(d.tail || d.error || '').slice(-1000) };
      } else {
        const fin = await finalById(id, seen);   // finished and gone from the list: its result is not a miss
        if (fin) return fin;
        if (++misses >= 20) return { ok: false, state: 'unknown', version: null, tail: '', error: `deploy ${id} is not in the registry` };
      }
      if (now() - t0 > timeoutMs) {
        // never report failure for a deploy that may still run later: a started deploy is waited out (up to 3x the timeout); a queued one is cancelled first,
        // and if it cannot be cancelled (or the state is unknown) the wait goes on
        const st = String(d?.state || '').toLowerCase();
        if (d && !RUNNING.has(st)) {
          const c = await reg(['deploy', 'cancel', String(id)]);
          const after = c.code === 0 ? await listed(id) : null;
          if (c.code === 0 && (!after || FINAL[String(after.state || '').toLowerCase()] === 'cancelled')) return { ok: false, state: 'timeout', version: null, tail: '', error: `deploy ${id} was still queued after ${Math.round(timeoutMs / 60000)} min and has been cancelled` };
        }
      }
      if (now() - t0 > timeoutMs * 3) return { ok: false, state: 'timeout', version: null, tail: '', error: `deploy ${id} is still running after ${Math.round(timeoutMs * 3 / 60000)} min` };   // hard cap on a started deploy
      await sleep(pollMs);
    }
  }
  return { request, wait, find };
}
