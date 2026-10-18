#!/usr/bin/env node
// Import the legacy registry's open leases and queued deploys into the central lease service (cut-over step 4).
//   node scripts/lease-import.js --leases list.json [--deploys deploys.json] [--url U --token-file F --apply]
// Inputs are the registry's `list --json` (leases, and its active deploys) and `deploy list --json`; a file or `-` for stdin.
// --shadow seeds the shadow store instead (the shadow period compares against the legacy registry's current leases).
// Dry-run by default: prints what would be imported. --apply POSTs to <url>/api/lease/v1/import (the service is the only writer;
// this script never touches its state dir). Legacy lease ids and `expires` are kept verbatim, so `release <old-id>` still works;
// imported leases declare no heartbeat.
import fs from 'node:fs';
import { parseResource } from '../lease-service.js';

export function planImport(list = {}, deploys = {}, nowS = Date.now() / 1000) {
  const groups = new Map();
  const skipped = [];
  for (const row of list.leases || []) {
    if (!row?.id || !parseResource(String(row.resource || ''))) { skipped.push({ id: row?.id, reason: 'bad row' }); continue; }
    if ((row.expires || 0) <= nowS) { skipped.push({ id: row.id, reason: 'expired' }); continue; }
    (groups.get(row.id) || groups.set(row.id, []).get(row.id)).push(row);
  }
  const active = (d) => ['awaiting-approval', 'queued', 'running'].includes(d?.state);
  const seen = new Set();
  const ds = [];
  for (const d of [...(list.deploys || []), ...(deploys.deploys || [])]) if (active(d) && !seen.has(d.id)) { seen.add(d.id); ds.push(d); }
  return { leases: [...groups.values()].flat(), leaseIds: [...groups.keys()], deploys: ds, skipped };
}

const read = (f) => (f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f, 'utf8'));
async function main() {
  const a = process.argv.slice(2);
  const opt = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
  if (!opt('--leases') && !opt('--deploys')) { console.error('usage: lease-import.js --leases <file|-> [--deploys <file|->] [--url U --token-file F --apply [--shadow]]'); process.exit(1); }
  const plan = planImport(opt('--leases') ? JSON.parse(read(opt('--leases'))) : {}, opt('--deploys') ? JSON.parse(read(opt('--deploys'))) : {});
  console.log(`${plan.leaseIds.length} lease(s), ${plan.deploys.length} deploy(s) to import, ${plan.skipped.length} skipped`);
  for (const id of plan.leaseIds) console.log(`  lease ${id}: ${plan.leases.filter((r) => r.id === id).map((r) => `${r.env}/${r.resource}`).join(', ')} (${plan.leases.find((r) => r.id === id).agent})`);
  for (const d of plan.deploys) console.log(`  deploy ${d.id}: ${d.env} ${d.scope} ${d.state}`);
  for (const s of plan.skipped) console.log(`  skipped ${s.id || '?'}: ${s.reason}`);
  if (!a.includes('--apply')) { console.log('dry run: add --apply --url <service> --token-file <file> to import'); return; }
  if (!opt('--url') || !opt('--token-file')) { console.error('--apply needs --url and --token-file'); process.exit(1); }
  const token = fs.readFileSync(opt('--token-file'), 'utf8').trim();
  const r = await fetch(`${opt('--url').replace(/\/$/, '')}/api/lease/v1/import`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ leases: plan.leases, deploys: plan.deploys, ...(a.includes('--shadow') ? { shadow: true } : {}) }) });
  const j = await r.json().catch(() => ({}));
  console.log(r.ok ? `imported ${j.leases} lease(s), ${j.deploys} deploy(s)` : `import failed: ${j.code || r.status} ${j.error || ''}`);
  if (!r.ok) process.exit(1);
  const clash = (j.skipped || []).filter((x) => x.conflict);
  for (const x of clash) console.log(`  NOT imported (conflict) ${x.id}: ${x.reason}`);
  if (clash.length) { console.error(`${clash.length} lease(s) skipped because they conflict with a live lease: resolve them by hand`); process.exit(1); }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
