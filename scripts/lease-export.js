#!/usr/bin/env node
// Print the central service's open leases and active deploys in the legacy `vpt-lease list --json` shape (rollback aid):
//   node scripts/lease-export.js [--dir <state>/leases]
// Opens the state read-only (never writes, never takes the writer's place), so it is safe while the server runs.
import os from 'node:os';
import path from 'node:path';
import { createLeaseService, toLegacyRows } from '../lease-service.js';

const a = process.argv.slice(2);
const i = a.indexOf('--dir');
const dir = i >= 0 ? a[i + 1] : path.join(process.env.GHOSTY_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'ghosty'), 'leases');
const svc = createLeaseService({ dir, config: { readonly: true } });
const r = await svc.list();
if (!r.ok) { console.error(`cannot read the lease state: ${r.error}`); process.exit(1); }
console.log(JSON.stringify({ now: r.now_s, leases: toLegacyRows(r.leases), deploys: r.deploys, waiters: r.waiters, tickets: r.tickets }, null, 2));
