#!/usr/bin/env node
// Read-only audit: which hosts never received which merged ref, because a deploy skipped them and the catch-up that was to
// cover them was cancelled (superseded) or never ran. Output only: the manager re-queues. Never writes to the registry.
//   node scripts/deploy-catchup-audit.js [--file deploys.json] [--repo <git dir>] [--env <env>] [--json]
// Input: `vpt-lease deploy list --json (finished ones included up to keepFinished)` on the registry host (default: read through the runner's registry client, ssh),
// or a saved JSON file ({deploys:[...]}). --repo (default $DEPLOY_REPO_DIR, ~/virtualpytest) decides ref containment; without
// it only an identical ref counts as covered (every other case is listed as "unverified").
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { gitContains } from '../catchup-supersede.js';
import { defaultRegistry, isCatchUp } from '../deploy-runner.js';

const FIN = new Set(['done', 'failed']);
const num = (d) => Number(d.finished || d.created || 0);
const hostsOf = (d) => (Array.isArray(d.hosts) ? d.hosts : []);
const deploysHost = (d, h) => ['host', 'full'].includes(d.scope) && (!hostsOf(d).length || hostsOf(d).includes(h));

// deploys: registry list; contains(newer, older): true|false|null. Returns [{env, host, ref, owedBy, state, via, note}]
export function audit(deploys, contains = (n, o) => (n === o ? true : null)) {
  const out = [];
  const byEnv = new Map();
  for (const d of deploys || []) { if (!byEnv.has(d.env)) byEnv.set(d.env, []); byEnv.get(d.env).push(d); }
  for (const [env, list] of byEnv) {
    // refs a host is owed: a finished deploy (done or failed) that skipped it
    const owed = new Map();   // host|ref -> {host, ref, by}
    for (const d of list) if (FIN.has(d.state)) for (const h of d.skippedHosts || []) { const k = `${h}|${d.ref}`; if (!owed.has(k) || num(d) > num(owed.get(k).d)) owed.set(k, { host: h, ref: d.ref, by: d.id, d }); }
    for (const { host, ref, by, d } of owed.values()) {
      // received: a later finished deploy that deployed the host (not skipped it) at a ref that contains `ref`
      let verdict = null;
      for (const x of list) {
        if (x.id === by || !FIN.has(x.state) || x.state !== 'done' || !deploysHost(x, host) || (x.skippedHosts || []).includes(host) || num(x) < num(d)) continue;
        const c = x.ref === ref ? true : contains(x.ref, ref);
        if (c === true) { verdict = { state: 'covered', via: x.id }; break; }
        if (c === null && !verdict) verdict = { state: 'unverified', via: x.id };
      }
      if (verdict?.state === 'covered') continue;
      const pending = list.filter((x) => isCatchUp(x) && ['queued', 'running'].includes(x.state) && hostsOf(x).includes(host) && (x.ref === ref || contains(x.ref, ref) === true));
      if (pending.length) { out.push({ env, host, ref, owedBy: by, state: 'pending', via: pending.map((x) => `${x.id} (${x.state}@${x.ref})`).join(', '), note: 'a catch-up that contains this ref is queued/running' }); continue; }
      const cancelled = list.filter((x) => isCatchUp(x) && x.state === 'cancelled' && hostsOf(x).includes(host) && /superseded/.test(String(x.reason || '')));
      out.push({ env, host, ref, owedBy: by, state: verdict?.state === 'unverified' ? 'unverified' : 'behind', via: cancelled.map((x) => `${x.id} cancelled: ${x.reason}`).join('; ') || (verdict ? `later deploy ${verdict.via} at a ref not known to contain it` : 'no catch-up'), note: verdict ? 'containment not verified (give --repo)' : 'host never received this ref: re-queue a catch-up' });
    }
  }
  return out;
}

// The ledger (`vpt-lease deploy last --json`: per env, per host, the ref it last received) is the ground truth for "never received":
// a host is behind when its last done ref does not contain the env's newest done ref. `deploys` (the queue) says who is already queued.
export function auditLedger(envs, deploys, contains = (n, o) => (n === o ? true : null)) {
  const out = [];
  for (const [env, hosts] of Object.entries(envs || {})) {
    const rows = Object.entries(hosts).filter(([, v]) => v && v.ref && v.status === 'done');
    const newest = rows.sort((a, b) => (b[1].at || 0) - (a[1].at || 0))[0]?.[1];
    if (!newest) continue;
    for (const [host, v] of Object.entries(hosts)) {
      if (!v?.ref || v.ref === newest.ref) continue;
      const c = contains(v.ref, newest.ref);
      if (c === true) continue;
      const q = (deploys || []).filter((x) => x.env === env && isCatchUp(x) && x.state === 'queued' && hostsOf(x).includes(host));
      out.push({ env, host, ref: newest.ref, has: v.ref, state: q.length ? 'pending' : c === false ? 'behind' : 'unverified', via: q.map((x) => `${x.id}@${x.ref}`).join(', ') || 'no queued catch-up', note: `last received ${v.ref.slice(0, 12)} (${v.version || '?'}), newest done ref ${newest.ref.slice(0, 12)} (${newest.version || '?'})` });
    }
  }
  return out;
}

async function main() {
  const a = process.argv.slice(2), opt = (n) => { const i = a.indexOf(n); return i < 0 ? null : a[i + 1]; };
  let j;
  if (opt('--file')) j = JSON.parse(fs.readFileSync(opt('--file'), 'utf8'));
  else { const r = await defaultRegistry()(['deploy', 'list', '--json'], { timeout: 30000 }); if (r.code) { console.error(`registry unreadable: ${r.stderr.trim()}`); process.exit(2); } j = JSON.parse(r.stdout); }
  const repo = opt('--repo') || process.env.DEPLOY_REPO_DIR || (fs.existsSync(join(os.homedir(), 'virtualpytest', '.git')) ? join(os.homedir(), 'virtualpytest') : '');
  const reg = defaultRegistry();
  let ledger = null;
  if (!opt('--file')) { const r = await reg(['deploy', 'last', '--json'], { timeout: 30000 }); if (!r.code) ledger = JSON.parse(r.stdout).envs; }
  else if (j.ledger) ledger = j.ledger;
  const lrows = ledger ? auditLedger(ledger, (j.deploys || []).filter((d) => !opt('--env') || d.env === opt('--env')), gitContains(repo)) : [];
  const rows = audit((j.deploys || []).filter((d) => !opt('--env') || d.env === opt('--env')), gitContains(repo));
  if (a.includes('--json')) return console.log(JSON.stringify({ history: rows, ledger: lrows }, null, 2));
  console.log('-- ledger: hosts whose last deployed ref does not contain the env\'s newest done ref --');
  for (const r of lrows) console.log(`${r.state.toUpperCase().padEnd(10)} ${r.env} ${r.host} | ${r.note} | ${r.via}`);
  if (lrows.some((r) => r.state !== 'pending')) process.exitCode = 1;
  console.log(`catch-up audit (${j.deploys?.length || 0} deploys listed, repo ${repo || 'none'}): ${rows.length} host/ref owed`);
  for (const r of rows) console.log(`${r.state.toUpperCase().padEnd(10)} ${r.env} ${r.host} missing ${r.ref} (skipped by ${r.owedBy}) | ${r.via} | ${r.note}`);
  if (rows.some((r) => r.state === 'behind')) process.exitCode = 1;
}
if (import.meta.url === `file://${process.argv[1]}`) main();
