// The lane's `deploys` adapter (round 13, brief B): a deploy request through the existing deploy registry path, then wait for it.
//   request: deploy request <env> --scope <s> --ref <target> --agent integration:<id> --approved   -> the deploy id on stdout
//   wait:    the registry has a blocking `deploy wait` only on the legacy side (the central registry rejects it), so wait polls
//            `deploy list --json` for that id until it is finished; the version is the entry's own, else `deploy last <env> --json`.
// registry: (argv, opts) => { code, stdout, stderr } (leaseSource.deployRegistry()). Same-scope requests coalesce in the deploy queue
// (the runner finishes the merged requests with the winner's result), so a coalesced entry is followed to its result as any other.
const FINAL = { done: 'done', failed: 'failed', cancelled: 'cancelled', canceled: 'cancelled', error: 'failed', coalesced: 'done' };
const RUNNING = new Set(['running', 'started', 'in_progress', 'in-progress', 'deploying']);
const SCOPES = new Set(['frontend', 'server', 'host', 'full']);
const SAFE = /^[A-Za-z0-9][\w./:@+-]{0,120}$/;

export function requestArgv({ env, scope, ref, agent }) {
  return ['deploy', 'request', env, '--scope', scope, '--ref', ref, '--agent', agent, '--approved'];
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
  async function versionOf(d) {
    if (d?.version) return String(d.version);
    const r = await reg(['deploy', 'last', d?.env || '', '--json'].filter((x) => x !== ''));
    try {
      const j = JSON.parse(r.stdout), env = j.envs ? j.envs[d?.env] || Object.values(j.envs)[0] : j;
      const e = env && (env.server || env.frontend || env.host || env);   // per-target map or a flat entry
      return String(env?.version || e?.version || '') || null;
    } catch { return null; }
  }
  // -> { ok, state: 'done'|'failed'|'cancelled'|'timeout'|'unknown', version, tail, error? }
  async function wait(id, { timeoutMs = timeoutMin * 60000 } = {}) {
    const t0 = now();
    let misses = 0;
    for (;;) {
      const d = await listed(id);
      if (d) {
        misses = 0;
        const fin = FINAL[String(d.state || '').toLowerCase()];
        if (fin) return { ok: fin === 'done', state: fin, version: fin === 'done' ? await versionOf(d) : null, tail: String(d.tail || d.error || '').slice(-1000) };
      } else if (++misses >= 20) return { ok: false, state: 'unknown', version: null, tail: '', error: `deploy ${id} is not in the registry` };
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
