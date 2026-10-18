#!/usr/bin/env node
// Standalone central lease service, for the registry host (LEASES-CENTRAL §2; manager decision 2026-10-18: the service runs
// next to the legacy registry, loopback only, and every machine keeps reaching it through `ssh <registry> vpt-lease ...`).
// Same lease-service.js and lease-routes.js as the dashboard; nothing else from mycodebox is needed.
//   LEASE_PORT  listen port on 127.0.0.1 (default 17777)
//   LEASE_DIR   state dir: journal, snapshot, clients.json, shadow store (default ~/.local/state/mycodebox-lease)
//   LEASE_ENVS  comma-separated valid environments (empty: any sane name)
// Tokens: node scripts/lease-token.js add <name> --dir "$LEASE_DIR" [--exempt ...] [--owner]
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLeaseService } from '../lease-service.js';
import { createLeaseRoutes, PREFIX } from '../lease-routes.js';

export function startLeaseServer({ dir, port = 17777, host = '127.0.0.1', envs = [], log = console } = {}) {
  // No tmux here: liveness is unknown (never releases anything); holders are reclaimed by TTL and declared heartbeats only.
  const service = createLeaseService({ dir, sessions: { isAlive: () => undefined, trackable: () => false },
    onEvent: (ev) => log.log(`[lease] ${ev.kind || 'event'} ${ev.id || ''} ${ev.agent || ''}`.trim()), config: { envs } });
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
  const s = startLeaseServer({ dir, port: Number(process.env.LEASE_PORT || 17777), envs });
  s.ready.then((p) => console.log(`[lease] central lease service on 127.0.0.1:${p}, state ${dir}`))
    .catch((e) => { console.error(`[lease] cannot listen: ${e.message}`); process.exit(1); });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { s.close().finally(() => process.exit(0)); });
}
