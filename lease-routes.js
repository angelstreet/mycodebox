// HTTP front of the central lease service: /api/lease/v1/* (docs/v2/LEASES-CENTRAL.md, Appendix A).
// Order of checks: source address (loopback, the tailnet range, LEASE_ALLOW_CIDRS) -> bearer token (clients.json, sha256
// hashes, constant-time compare) -> JSON body (size capped) -> route. Long-poll routes wait at most 30 s.
// server.js only calls handle() for paths under PREFIX; everything else stays as it was.
import fs from 'node:fs';
import { join } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

export const PREFIX = '/api/lease/v1';
export const MAX_BODY = 256 * 1024;
export const MAX_WAIT_S = 30;
export const DEFAULT_CIDRS = ['127.0.0.0/8', '::1/128', '100.64.0.0/10', 'fd7a:115c:a1e0::/48'];   // loopback, tailnet (CGNAT v4 and the Tailscale ULA)
const STATUS = { E_INVALID: 400, E_AUTH: 401, E_NOT_FOUND: 404, E_HELD: 409, E_DEPLOY_PENDING: 409, E_FENCED: 409, E_UNAVAILABLE: 503 };

export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

// ---- address allowlist ----------------------------------------------------------------------------------------------
function ipToBig(ip) {
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((x) => x > 255)) return null;
    return { bits: 32, n: o.reduce((a, x) => (a << 8n) | BigInt(x), 0n) };
  }
  if (!/^[0-9a-f:]+$/i.test(ip) || !ip.includes(':')) return null;
  const [head, tail, extra] = ip.split('::');
  if (extra !== undefined) return null;
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  if (tail === undefined ? h.length !== 8 : h.length + t.length > 7) return null;
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return { bits: 128, n: groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n) };
}
export function parseCidrs(list) {
  const out = [];
  for (const raw of String(list || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [ip, len] = raw.split('/');
    const b = ipToBig(ip);
    const l = len === undefined ? (b ? b.bits : 0) : Number(len);
    if (b && Number.isInteger(l) && l >= 0 && l <= b.bits) out.push({ ...b, len: l });
  }
  return out;
}
export function addrAllowed(addr, cidrs) {
  const a = ipToBig(String(addr || ''));
  if (!a) return false;
  return cidrs.some((c) => c.bits === a.bits && (a.n >> BigInt(c.bits - c.len)) === (c.n >> BigInt(c.bits - c.len)));
}

// ---- tokens ---------------------------------------------------------------------------------------------------------
export function readClients(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j.clients) ? j.clients.filter((c) => c && typeof c.name === 'string' && /^[0-9a-f]{64}$/.test(c.sha256 || '')) : [];
  } catch { return []; }
}
function clientOf(clients, token) {
  const h = Buffer.from(hashToken(token), 'hex');
  let hit = null;
  for (const c of clients) {                                  // no early exit: the time does not depend on which entry matches
    const ok = timingSafeEqual(h, Buffer.from(c.sha256, 'hex'));
    if (ok && !hit) hit = c.name;
  }
  return hit;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let dead = false;
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > MAX_BODY) { dead = true; chunks.length = 0; reject(Object.assign(new Error('body too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      const txt = Buffer.concat(chunks).toString('utf8');
      if (!txt.trim()) return resolve({});
      try { const j = JSON.parse(txt); resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : Object.assign(new Error('body must be a JSON object'), { bad: true }) && reject(Object.assign(new Error('body must be a JSON object'), { status: 400 }))); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const bool = (v) => v === true || v === '1' || v === 'true';
const num = (v) => (v === undefined || v === '' ? undefined : Number(v));

export function createLeaseRoutes({ service, dir, cidrs = process.env.LEASE_ALLOW_CIDRS } = {}) {
  const allow = parseCidrs([...DEFAULT_CIDRS, ...String(cidrs || '').split(',')].join(','));
  const clientsFile = join(dir, 'clients.json');
  let cache = { key: '', clients: [] };
  const clients = () => {
    try { const st = fs.statSync(clientsFile); const key = `${st.mtimeMs}:${st.size}`; if (key !== cache.key) cache = { key, clients: readClients(clientsFile) }; } catch { cache = { key: '', clients: [] }; }
    return cache.clients;
  };

  // [method, regexp, handler({ body, query, m, client }) -> result | { shadowOp, args }]
  const R = [];
  const route = (method, path, fn) => R.push([method, new RegExp(`^${path}$`), fn]);
  const post = (path, op, fn = (b) => b) => route('POST', path, ({ body, client }) => ({ op, args: { ...fn(body), client } }));
  post('/claim', 'claim');
  route('GET', '/tickets/([^/]+)', ({ m, query }) => ({ op: 'ticket', args: { id: m[1], wait_s: Math.min(MAX_WAIT_S, Math.max(0, num(query.wait) || 0)) } }));
  route('DELETE', '/tickets/([^/]+)', ({ m }) => ({ op: 'cancelTicket', args: { id: m[1] } }));
  post('/release', 'release');
  post('/renew', 'renew');
  post('/heartbeat', 'heartbeat');
  post('/narrow', 'narrow');
  post('/mode', 'setMode');
  post('/owner/release', 'ownerRelease', (b) => ({ ...b, by: b.by || 'owner' }));
  post('/import', 'importLegacy');
  route('GET', '/list', ({ query }) => ({ op: 'list', args: { env: query.env || undefined } }));
  route('GET', '/check', ({ query }) => ({ op: 'check', args: { env: query.env, resources: query.resources, ignore_agent: query.ignore_agent, skip_leased: bool(query.skip_leased), hosts: query.hosts } }));
  route('GET', '/events', ({ query }) => ({ op: 'events', args: { after: num(query.after), limit: num(query.limit) } }));
  route('GET', '/status', () => ({ op: 'status', args: {} }));
  for (const name of ['request', 'approve', 'cancel', 'start', 'finish', 'record']) post(`/deploy/${name}`, `deploy.${name}`);
  route('GET', '/deploy/list', ({ query }) => ({ op: 'deploy.list', args: { env: query.env || undefined, all: bool(query.all) } }));
  route('GET', '/deploy/wait', ({ query }) => ({ op: 'deploy.wait', args: { id: query.id || undefined, env: query.env || undefined, agent: query.agent || undefined, timeout_s: Math.min(MAX_WAIT_S, Math.max(0, num(query.timeout) || 0)) } }));
  route('GET', '/deploy/last', ({ query }) => ({ op: 'deploy.last', args: { env: query.env || undefined } }));
  route('POST', '/shadow-report', ({ body }) => ({ op: 'shadow.report', args: body }));
  route('GET', '/shadow-reports', () => ({ op: 'shadow.list', args: {} }));

  async function run(op, args) {
    switch (op) {
      case 'ticket': return service.ticket(args.id, args);
      case 'cancelTicket': return service.cancelTicket(args.id);
      case 'status': return service.status();
      case 'shadow.report': return service.shadow.report(args);
      case 'shadow.list': return service.shadow.list();
      default:
        if (op.startsWith('deploy.')) return service.deploy[op.slice(7)](args);
        return service[op](args);
    }
  }
  function send(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  const err = (res, code, msg, extra) => send(res, STATUS[code] || 400, { ok: false, code, error: msg, ...extra });

  // -> true when the request belonged to the lease API (and has been answered)
  async function handle(req, res) {
    const url = new URL(req.url, 'http://lease.local');
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    if (!addrAllowed(req.socket?.remoteAddress, allow)) { err(res, 'E_AUTH', 'source address not allowed'); res.statusCode = 403; return true; }
    const auth = /^Bearer\s+(\S{8,512})$/i.exec(req.headers.authorization || '');
    const client = auth ? clientOf(clients(), auth[1]) : null;
    if (!client) { err(res, 'E_AUTH', 'missing or invalid bearer token'); return true; }
    const sub = url.pathname.slice(PREFIX.length) || '/';
    const query = Object.fromEntries(url.searchParams);
    const hit = R.find(([method, re]) => method === req.method && re.test(sub));
    if (!hit) {
      const known = R.some(([, re]) => re.test(sub));
      send(res, known ? 405 : 404, { ok: false, code: known ? 'E_INVALID' : 'E_NOT_FOUND', error: known ? 'method not allowed' : 'no such route' });
      return true;
    }
    let body = {};
    if (req.method === 'POST') {
      try { body = await readBody(req); } catch (e) { send(res, e.status || 400, { ok: false, code: 'E_INVALID', error: e.message }); return true; }
    }
    const { op, args } = hit[2]({ body, query, m: hit[1].exec(sub), client });
    let out;
    try {
      const shadow = req.method === 'POST' ? body.shadow === true : bool(query.shadow);
      out = shadow && !op.startsWith('shadow.') && op !== 'status' ? await service.shadow.op(op, { ...args, client }) : await run(op, args);
    } catch { out = { ok: false, code: 'E_UNAVAILABLE', error: 'lease service error' }; }
    send(res, out.ok === false ? (STATUS[out.code] || 400) : 200, out);
    return true;
  }
  return { handle, clients };
}
