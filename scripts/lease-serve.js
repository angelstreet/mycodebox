#!/usr/bin/env node
// Standalone central lease service, for the registry host (LEASES-CENTRAL §2; manager decision 2026-10-18: the service runs
// next to the legacy registry, loopback only, and every machine keeps reaching it through `ssh <registry> vpt-lease ...`).
// Same lease-service.js and lease-routes.js as the dashboard; nothing else from mycodebox is needed.
//   LEASE_PORT  listen port on 127.0.0.1 (default 17777)
//   LEASE_DIR   state dir: journal, snapshot, clients.json, shadow store (default ~/.local/state/mycodebox-lease)
//   LEASE_ENVS  comma-separated valid environments (empty: any sane name)
//   LEASE_TUNE  numeric config overrides, e.g. deployGateMaxMs=300,deployStarveMs=700 (tests only; the startup line names them)
//   <LEASE_DIR>/inventory.json  groups of equivalent resources for `claim --any <group>` (docs/LEASE-INVENTORY.md); re-read when it changes
//   <LEASE_DIR>/health.json     which hosts answer / devices are present, per env (scripts/lease-health-probe.js writes it); an unhealthy member is
//                               never offered as a free equivalent nor switched to. Missing or older than 15 min = unknown = healthy.
//   <LEASE_DIR>/equivalence.json known_broken / servers / manual host+device state per env (lease-equivalence.js); no freshness limit
// Tokens: node scripts/lease-token.js add <name> --dir "$LEASE_DIR" [--exempt ...] [--owner]
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLeaseService } from '../lease-service.js';
import { equivalenceReader } from '../lease-equivalence.js';
import { createLeaseRoutes, PREFIX } from '../lease-routes.js';
import fs from 'node:fs';

// Reads <dir>/inventory.json again whenever its mtime or size changes; a missing or broken file is "no groups" (claims by name still work).
export function inventoryReader(file, log = console) {
  let key = null, val = {};
  return () => {
    let st; try { st = fs.statSync(file); } catch { key = null; val = {}; return val; }
    const k = `${st.mtimeMs}:${st.size}`;
    if (k === key) return val;
    key = k;
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); val = j && typeof j === 'object' && !Array.isArray(j) ? j : {}; }
    catch (e) { log.error?.(`[lease] inventory ${file}: ${e.message}`); val = {}; }
    return val;
  };
}

export const HEALTH_MAX_AGE_MS = 15 * 60 * 1000;
// -> (env) => { hosts, devices } | null. { "<env>"|"*": { at: ISO, hosts: { h: { up, reason? } }, devices: { "h/dN": { present, reason? } } } }.
export function healthReader(file, log = console, now = Date.now) {
  const read = inventoryReader(file, log);
  return (env) => {
    const j = read();
    const out = { hosts: {}, devices: {} };
    for (const e of [j['*'], j[env]]) {
      if (!e || typeof e !== 'object') continue;
      const at = Date.parse(e.at);
      if (!Number.isFinite(at) || now() - at > HEALTH_MAX_AGE_MS) continue;   // stale data is no data
      Object.assign(out.hosts, e.hosts || {}); Object.assign(out.devices, e.devices || {});
    }
    return out;
  };
}

// health.json (probe output, 15 min freshness) + equivalence.json (manager data: known_broken, servers, manual host/device state)
export const mergedHealth = (health, equiv) => (env) => {
  const h = health(env) || {}, e = equiv(env) || {};
  return { known_broken: e.known_broken || {}, servers: e.servers || {}, hosts: { ...(h.hosts || {}), ...(e.hosts || {}) }, devices: { ...(h.devices || {}), ...(e.devices || {}) } };
};

export function startLeaseServer({ dir, port = 17777, host = '127.0.0.1', envs = [], ownServers = {}, tune = {}, log = console } = {}) {
  // No tmux here: liveness is unknown (never releases anything); holders are reclaimed by TTL and declared heartbeats only.
  const service = createLeaseService({ dir, sessions: { isAlive: () => undefined, trackable: () => false },
    onEvent: (ev) => log.log(`[lease] ${ev.kind || 'event'} ${ev.id || ''} ${ev.agent || ''}`.trim()), config: { ...tune, envs, ownServers, inventory: inventoryReader(path.join(dir, 'inventory.json'), log), health: mergedHealth(healthReader(path.join(dir, 'health.json'), log), equivalenceReader(path.join(dir, 'equivalence.json'), log)) } });
  const routes = createLeaseRoutes({ service, dir });
  const server = http.createServer(async (req, res) => {
    try {
      if (String(req.url || '').startsWith(PREFIX) && await routes.handle(req, res)) return;
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"ok":false,"code":"E_NOT_FOUND"}');
    } catch (e) {
      log.error('[lease] request', e.message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end('{"ok":false,"code":"E_UNAVAILABLE"}');
    }
  });
  const tick = setInterval(() => Promise.resolve(service.tick()).catch((e) => log.error('[lease] tick', e.message)), 5000);
  tick.unref?.();
  const ready = new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address().port)); });
  const close = async () => { clearInterval(tick); await new Promise((r) => server.close(r)); await service.close(); };
  return { service, server, ready, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.env.LEASE_DIR || path.join(os.homedir(), '.local', 'state', 'mycodebox-lease');
  const envs = String(process.env.LEASE_ENVS || '').split(',').map((x) => x.trim()).filter(Boolean);
  // LEASE_OWN_SERVERS="node1-vpt:vpt-pi1,vpt-pi4;other-env:host"  hosts that run their own secondary server (TASK-129)
  const ownServers = Object.fromEntries(String(process.env.LEASE_OWN_SERVERS || '').split(';').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [e, hs] = x.split(':'); return [e.trim().toLowerCase(), String(hs || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]; }));
  // LEASE_TUNE="deployGateMaxMs=300,deployStarveMs=700"  numeric config overrides (tests of the deploy gate with a real clock)
  const tune = Object.fromEntries(String(process.env.LEASE_TUNE || '').split(',').map((x) => x.split('=')).filter(([k, v]) => k && Number.isFinite(Number(v))).map(([k, v]) => [k.trim(), Number(v)]));
  const s = startLeaseServer({ dir, port: Number(process.env.LEASE_PORT || 17777), envs, ownServers, tune });
  s.ready.then((p) => console.log(`[lease] central lease service on 127.0.0.1:${p}, state ${dir}${Object.keys(tune).length ? `, tuned ${JSON.stringify(tune)}` : ''}`))
    .catch((e) => { console.error(`[lease] cannot listen: ${e.message}`); process.exit(1); });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { s.close().finally(() => process.exit(0)); });
}
