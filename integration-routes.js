// HTTP front of the integration lane: /api/integration/* (docs/v2/INTEGRATION-LANE.md). server.js only calls handle() for paths
// under PREFIX. Who may call: (a) a loopback peer with the reporter token (sessions on the codebox), or (b) a bearer token of a
// clients.json client flagged `integrate` (lease-token.js add <name> --integrate) from the tailnet/loopback range (the Mac).
//   POST /requests                    { repo?, origin?, cwd?, branch, session?, deploy?, note? } -> { ok, id, position, repo }
//   GET  /requests?repo=&state=&limit=                                                          -> { ok, requests: [...] }
//   GET  /requests/:id                                                                          -> { ok, request, ...summary }
//   GET  /requests/:id/wait?timeout=30   long-poll (max 30 s) until a final state               -> { ok, request, final, ...summary }
//   POST /requests/:id/cancel            only while queued                                      -> { ok, request }
//   GET  /repos                          configured repositories + queue depth                  -> { ok, repos: [...] }
// `?format=kv` answers key=value lines (+ `---` and the output tail) for the POSIX-sh CLI, which has no JSON parser.
import fs from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CIDRS, parseCidrs, addrAllowed, readClients, clientOf, readBody } from './lease-routes.js';
import { FINAL } from './integration-lane.js';
import { integrationText } from './integration-notify.js';

export const PREFIX = '/api/integration';
export const MAX_WAIT_S = 30;
const STATUS = { E_INVALID: 400, E_NOT_FOUND: 404, E_STATE: 409 };
export const EXIT = { merged: 0, deployed: 0, returned: 3, cancelled: 3, merged_ci_red: 4, deploy_failed: 4 };

// One line for a session / the CLI: the notify path's own wording (integrationText) for a final state.
export function describe(r) {
  const t = integrationText({ ...r, version: r.deployed?.version, env: r.deployed?.env });
  if (t) return t.split('\n')[0];
  const base = `Integration ${r.id}`;
  return r.state === 'queued' ? `${base}: queued${r.position ? ` (position ${r.position})` : ''}.` : `${base}: running${r.step ? ` (${r.step})` : ''}.`;
}
export const summary = (r) => ({ id: r.id, repo: r.repo, branch: r.branch, target: r.target, state: r.state, final: FINAL.includes(r.state),
  exit: FINAL.includes(r.state) ? EXIT[r.state] : null, sha: r.sha || null, version: r.deployed?.version ?? null, reason: r.reason || null,
  step: r.step || null, position: r.position ?? null, text: describe(r) });
const one = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ');
export const kv = (o, tail = '') => `${Object.entries(o).map(([k, v]) => `${k}=${one(v)}`).join('\n')}\n${tail ? `---\n${tail}\n` : ''}`;

export function createIntegrationRoutes({ lane, stateDir, isLoopback, reporterOk, sessionCwd = async () => null, remoteResolve = () => null, cidrs = process.env.LEASE_ALLOW_CIDRS } = {}) {
  const allow = parseCidrs([...DEFAULT_CIDRS, ...String(cidrs || '').split(',')].join(','));
  const clientsFile = join(stateDir, 'leases', 'clients.json');
  let cache = { key: '', clients: [] };
  const clients = () => {
    try { const st = fs.statSync(clientsFile); const key = `${st.mtimeMs}:${st.size}`; if (key !== cache.key) cache = { key, clients: readClients(clientsFile) }; } catch { cache = { key: '', clients: [] }; }
    return cache.clients;
  };
  const send = (res, code, obj, fmt) => {
    if (fmt === 'kv') {
      const body = obj.ok === false ? kv({ ok: 0, error: obj.error }) : kv({ ok: 1, ...(obj.flat || {}) }, obj.tail || '');
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); return;
    }
    const { flat: _f, ...rest } = obj;
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(rest));
  };

  // -> { by } | null (already answered)
  // The dashboard (same origin, no token; Tailscale is the gate) may list, read, wait and cancel; creating a request stays token-gated.
  // 'same' | 'cross' | null (no browser signal). Browsers send Origin on same-origin writes and Sec-Fetch-Site on every fetch.
  const originOf = (req) => {
    const o = req.headers.origin, sf = req.headers['sec-fetch-site'];
    if (o) { try { return new URL(o).host === req.headers.host ? 'same' : 'cross'; } catch { return 'cross'; } }
    if (sf) return sf === 'same-origin' ? 'same' : 'cross';
    return null;
  };
  function authorize(req, res, fmt, sub = '') {
    const addr = req.socket?.remoteAddress;
    const auth = /^Bearer\s+(\S{8,512})$/i.exec(req.headers.authorization || '');
    if (auth) {
      if (!addrAllowed(addr, allow)) { send(res, 403, { ok: false, error: 'source address not allowed' }, fmt); return null; }
      const c = clientOf(clients(), auth[1]);
      if (!c) { send(res, 401, { ok: false, error: 'missing or invalid bearer token' }, fmt); return null; }
      if (!c.integrate) { send(res, 403, { ok: false, error: 'this client may not use the integration lane (lease-token.js add <name> --integrate)' }, fmt); return null; }
      return { by: `client:${c.name}`, client: c.name, loopback: isLoopback(addr) };
    }
    const dashOp = (req.method === 'GET' && /^\/(requests|repos)/.test(sub)) || (req.method === 'POST' && /^\/requests\/[\w-]{1,64}\/cancel$/.test(sub));
    if (!req.headers['x-ghosty-reporter-token'] && dashOp) {
      const o = originOf(req);
      if (o === 'cross') { send(res, 403, { ok: false, error: 'cross-origin request refused' }, fmt); return null; }
      if (o === 'same') return { by: 'dashboard', loopback: false };
    }
    if (!isLoopback(addr)) { send(res, 403, { ok: false, error: 'loopback only without a bearer token' }, fmt); return null; }
    if (!reporterOk(req.headers['x-ghosty-reporter-token'])) { send(res, 401, { ok: false, error: 'bad token' }, fmt); return null; }
    return { by: 'loopback', loopback: true };
  }

  async function resolveRepo(body, who) {
    if (body.repo) return String(body.repo);
    if (body.origin) { const k = await lane.repoForUrl(String(body.origin)); if (k) return k; }
    if (who.loopback && body.cwd) { const k = await lane.repoForCwd(String(body.cwd)); if (k) return k; }
    if (body.session && !who.by.startsWith('client:')) { const cwd = await sessionCwd(String(body.session)).catch(() => null); const k = cwd ? await lane.repoForCwd(cwd) : null; if (k) return k; }
    const keys = lane.repoKeys();
    return keys.length === 1 ? keys[0] : null;
  }

  // -> true when the request belonged to the integration API (and has been answered)
  async function handle(req, res) {
    const url = new URL(req.url, 'http://integration.local');
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const fmt = url.searchParams.get('format') === 'kv' ? 'kv' : 'json';
    const sub = url.pathname.slice(PREFIX.length) || '/';
    const who = authorize(req, res, fmt, sub);
    if (!who) return true;
    const fail = (code, error) => send(res, STATUS[code] || 400, { ok: false, code, error }, fmt);
    try {
      let m;
      if (req.method === 'POST' && sub === '/requests') {
        let body; try { body = await readBody(req, 64 * 1024); } catch (e) { fail('E_INVALID', e.message); return true; }
        const repo = await resolveRepo(body, who);
        if (!repo) { fail('E_INVALID', `repo not recognised: name it (--repo) — configured: ${lane.repoKeys().join(', ') || 'none'}`); return true; }
        // A remote (client:*) caller's session name is the Mac's: it resolves to ONE registered `mac:` session of that same client (exact or by slug prefix), else null; never a local tmux one.
        const session = who.by.startsWith('client:') ? (typeof body.session === 'string' ? remoteResolve(body.session, who.client) : null) : body.session;
        const out = lane.enqueue({ repo, branch: body.branch, session, deploy: body.deploy || null, note: body.note, by: who.by });
        send(res, 200, { ok: true, ...out, flat: { id: out.id, position: out.position, repo: out.repo } }, fmt);
      } else if (req.method === 'GET' && sub === '/requests') {
        const q = url.searchParams;
        const requests = lane.list({ repo: q.get('repo') || undefined, state: q.get('state') || undefined, limit: q.get('limit') || 50 });
        send(res, 200, { ok: true, requests, flat: { count: requests.length }, tail: requests.map((r) => `${r.id} ${r.state} ${r.repo} ${r.branch}${r.session ? ` (${r.session})` : ''}${r.state === 'queued' ? ` position ${r.position}` : ''}`).join('\n') }, fmt);
      } else if (req.method === 'GET' && (m = /^\/requests\/([\w-]{1,64})(\/wait)?$/.exec(sub))) {
        let r;
        if (m[2]) {
          const t = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get('timeout')) || 0));
          r = await lane.wait(m[1], t * 1000);
        } else r = lane.get(m[1]);
        if (!r) { fail('E_NOT_FOUND', 'no such request'); return true; }
        send(res, 200, { ok: true, request: r, ...summary(r), flat: summary(r), tail: r.tail || '' }, fmt);
      } else if (req.method === 'POST' && (m = /^\/requests\/([\w-]{1,64})\/cancel$/.exec(sub))) {
        const r = lane.cancel(m[1], { by: who.by });
        send(res, 200, { ok: true, request: r, ...summary(r), flat: summary(r) }, fmt);
      } else if (req.method === 'GET' && sub === '/repos') {
        const repos = lane.repoKeys().map((key) => ({ key, queued: lane.list({ repo: key, state: 'queued', limit: 500 }).length, running: lane.list({ repo: key, state: 'running' }).length }));
        send(res, 200, { ok: true, repos }, fmt);
      } else send(res, /^\/(requests|repos)/.test(sub) ? 405 : 404, { ok: false, code: 'E_NOT_FOUND', error: 'no such route' }, fmt);
    } catch (e) {
      if (STATUS[e.code]) fail(e.code, e.message);
      else { console.error('[integration]', e?.message); send(res, 500, { ok: false, error: 'internal error' }, fmt); }
    }
    return true;
  }
  return { handle, clients };
}
