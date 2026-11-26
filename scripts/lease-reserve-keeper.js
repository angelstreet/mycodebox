#!/usr/bin/env node
// Holds one multi-resource exclusive lease for a named agent until a fixed end time (a reservation made of leases).
// Why: the registry caps a claim at 60 min and refuses renewals at the cap while anyone waits, so a 24 h reservation
// needs a process that heartbeats, renews, and re-claims at once when the cap or a loss ends the lease.
// Restart-safe: state file with the lease id and the end time; a new keeper releases the old lease and re-claims.
// Usage: lease-reserve-keeper.js start --env E --agent A --until ISO --state FILE [--on-end CMD] [--ttl 60] RES...
//        lease-reserve-keeper.js stop --state FILE        (SIGTERM to the keeper: it releases, runs --on-end, exits)
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const MIN = 60 * 1000;

export function parseArgs(argv) {
  const o = { cmd: argv[0], res: [], ttl: 60, hb: 2, renewEvery: 20, bin: process.env.VPT_LEASE_BIN || 'vpt-lease' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--env') o.env = v(); else if (a === '--agent') o.agent = v(); else if (a === '--until') o.until = Date.parse(v());
    else if (a === '--state') o.state = v(); else if (a === '--on-end') o.onEnd = v(); else if (a === '--ttl') o.ttl = +v();
    else if (a === '--purpose') o.purpose = v(); else o.res.push(a);
  }
  return o;
}

const defaultLease = (bin) => (args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20 * 60 * 1000 });
  return { code: r.status ?? 5, out: r.stdout || '', err: r.stderr || '' };
};

// One reservation cycle. deps: { lease(args)->{code,out,err}, now(), sleep(ms), log(msg), save(state), pid }
export async function keep(o, deps) {
  const { lease, now, sleep, log, save } = deps;
  let id = null, lastRenew = 0, lastHb = 0, stopped = false;
  deps.onStop = () => { stopped = true; };
  const claim = () => {
    const args = ['claim', o.env, ...o.res, '--agent', o.agent, '--kind', 'host', '--ttl', String(o.ttl), '--priority', 'P1',
      '--provider', 'claude', '--purpose', o.purpose || 'reservation (keeper)', '--holder-pid', String(deps.pid), '--wait', '--no-auto-equivalent'];
    const r = lease(args);
    const m = r.code === 0 && /^([0-9a-f]{6,})\s*$/m.exec(r.out);
    if (!m) { log(`claim failed code=${r.code} ${r.err.trim().slice(-200)}`); return null; }
    log(`claimed ${m[1]}`); lastRenew = lastHb = now(); save({ lease: m[1], until: o.until, agent: o.agent, pid: deps.pid });
    return m[1];
  };
  const release = () => { if (id) lease(['release', id]); lease(['release', '--agent', o.agent, '--by', 'lease-reserve-keeper', '--reason', 'reservation ended']); id = null; };
  // a stale lease of this agent from an earlier keeper is dropped before re-claiming (its holder pid is gone)
  const prev = deps.prev; if (prev && prev.lease) lease(['release', prev.lease]);
  while (!stopped && now() < o.until) {
    if (!id) { id = claim(); if (!id) { await sleep(30 * 1000); continue; } }
    await sleep(Math.min(o.hb * MIN, Math.max(1000, o.until - now())));
    if (stopped || now() >= o.until) break;
    const hb = lease(['heartbeat', '--active', id]);
    if (hb.code !== 0) { log(`heartbeat lost the lease (code ${hb.code}); re-claiming`); id = null; continue; }
    if (now() - lastRenew >= o.renewEvery * MIN) {
      const r = lease(['renew', id, '--ttl', String(o.ttl)]);
      if (r.code === 0 && !/HOLD CAP/.test(r.out)) lastRenew = now();
      else { log(`renew refused/capped (code ${r.code}); release and re-claim at once`); lease(['release', id]); id = null; }
    }
  }
  release();
  log(stopped ? 'stopped early' : 'reservation ended');
  if (o.onEnd) deps.runEnd?.(o.onEnd);
  return { stopped };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.cmd === 'stop') {
    const s = JSON.parse(fs.readFileSync(o.state, 'utf8'));
    process.kill(s.pid, 'SIGTERM'); console.log(`SIGTERM sent to keeper pid ${s.pid}`); return;
  }
  if (o.cmd !== 'start' || !o.env || !o.agent || !o.until || !o.state || !o.res.length) { console.error('usage: see header'); process.exit(2); }
  let prev = null; try { prev = JSON.parse(fs.readFileSync(o.state, 'utf8')); } catch { /* first start */ }
  const deps = {
    lease: defaultLease(o.bin), now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.log(`${new Date().toISOString()} ${m}`), pid: process.pid, prev,
    save: (s) => fs.writeFileSync(o.state, JSON.stringify(s), { mode: 0o600 }),
    runEnd: (cmd) => spawnSync('sh', ['-c', cmd], { stdio: 'inherit' }),
  };
  deps.save({ lease: prev?.lease || null, until: o.until, agent: o.agent, pid: process.pid });
  process.on('SIGTERM', () => deps.onStop?.());
  process.on('SIGINT', () => deps.onStop?.());
  await keep(o, deps);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
