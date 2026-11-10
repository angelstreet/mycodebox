#!/usr/bin/env node
// Writes <LEASE_DIR>/health.json for the lease service (docs/LEASE-INVENTORY.md "Health"): which hosts answer. One TCP connect
// per host per run (no polling storm; run it from a 1-minute timer), only the hosts named in <LEASE_DIR>/health-targets.json:
//   { "<env>": { "hosts": { "<host>": "<address>:<port>" }, "devices": { "<host>/<deviceN>": { "present": false } } } }
// `devices` entries are copied as given (a device census can overwrite them from its own data). A host that does not answer within
// 3 s is `up: false`; the service then never offers it (or its devices) as a free equivalent. Atomic write, `at` stamped each run.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function tcpUp(addr, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const m = /^(.*):(\d+)$/.exec(String(addr));
    if (!m) return resolve({ up: false, reason: `bad address ${JSON.stringify(String(addr).slice(0, 40))}` });
    const sock = net.connect({ host: m[1], port: Number(m[2]) });
    const done = (up, reason) => { sock.destroy(); resolve(up ? { up: true } : { up: false, reason }); };
    sock.setTimeout(timeoutMs, () => done(false, `host ${m[1]} does not answer`));
    sock.once('connect', () => done(true));
    sock.once('error', (e) => done(false, `host ${m[1]} unreachable (${e.code || e.message})`));
  });
}

export async function probe(targets, { check = tcpUp, now = Date.now } = {}) {
  const out = {};
  for (const [env, t] of Object.entries(targets || {})) {
    const hosts = {};
    await Promise.all(Object.entries(t?.hosts || {}).map(async ([h, addr]) => { hosts[h.toLowerCase()] = await check(addr); }));
    out[env] = { at: new Date(now()).toISOString(), hosts, devices: t?.devices || {} };
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.env.LEASE_DIR || path.join(os.homedir(), '.local', 'state', 'mycodebox-lease');
  let targets; try { targets = JSON.parse(fs.readFileSync(path.join(dir, 'health-targets.json'), 'utf8')); } catch (e) { console.error(`lease-health-probe: no usable ${dir}/health-targets.json (${e.message})`); process.exit(1); }
  const res = await probe(targets);
  const f = path.join(dir, 'health.json');
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(res, null, 1)); fs.renameSync(`${f}.tmp`, f);
}
