// Lease / deploy-wait measures for the daily report (TASK-58 C1). Pure except loadLeaseStats().
//   deploy request -> start: minutes from "ready" (approved request, or its approve event) to the runner's start; p95 target < 10 min.
//   blocked-deploy minutes: the same wait, summed over the deploys a lease held back (manager-events: deploy start/done with blockedBy).
//   unknown holders: leases whose agent ghosty cannot link to a session (lease-watch.json days[date]); target 0.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const P95_TARGET_MIN = 10;

export function p95(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.ceil(0.95 * v.length) - 1)];
}

// auditRows = parsed deploys.jsonl; eventRecs = parsed manager-events.jsonl; sinceMs..untilMs = window.
export function deployWaits(auditRows, eventRecs, sinceMs, untilMs) {
  const ready = new Map(), start = new Map();
  for (const r of auditRows || []) {
    if (!r || !r.id) continue;
    if (r.event === 'request' && r.approved) ready.set(r.id, Math.min(ready.get(r.id) ?? Infinity, r.ts));
    else if (r.event === 'approve') ready.set(r.id, Math.min(ready.get(r.id) ?? Infinity, r.ts));
    else if (r.event === 'start' && !start.has(r.id)) start.set(r.id, r.ts);
  }
  const blocked = new Set();
  for (const e of eventRecs || []) if (e && e.kind === 'deploy' && e.deployId && Array.isArray(e.blockedBy) && e.blockedBy.length) blocked.add(e.deployId);
  const rows = [];
  for (const [id, s] of start) {
    const r = ready.get(id);
    if (r == null || s * 1000 < sinceMs || s * 1000 >= untilMs) continue;
    rows.push({ id, waitMin: Math.max(0, (s - r) / 60), blocked: blocked.has(id) });
  }
  const blockedRows = rows.filter((x) => x.blocked);
  return { deploys: rows.length, p95Min: p95(rows.map((x) => x.waitMin)), blockedCount: blockedRows.length, blockedMinutes: Math.round(blockedRows.reduce((a, x) => a + x.waitMin, 0)) };
}

export function leaseLines(w1, w7, unknown) {
  const f = (n) => (n == null ? 'n/a' : `${Math.round(n * 10) / 10}`);
  const row = (label, w) => `- ${label}: ${w.deploys} deploys started, request -> start p95 ${f(w.p95Min)} min (target < ${P95_TARGET_MIN}), held back by a lease: ${w.blockedCount} deploys / ${w.blockedMinutes} min`;
  return ['## Leases (TASK-58 C1)', '', row('last 24 h', w1), row('last 7 days', w7),
    `- unknown-holder leases (agent ghosty cannot link to a session; target 0): now ${unknown?.last ?? 'n/a'}, max today ${unknown?.unknownMax ?? 'n/a'}`, ''];
}

const jsonl = (txt) => String(txt || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const readIf = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

// Reads the registry audit over ssh (override with LEASE_AUDIT_FILE for a local file) and ghosty's own state files.
export function loadLeaseStats({ stateDir, now = Date.now(), env = process.env } = {}) {
  let audit = '';
  if (env.LEASE_AUDIT_FILE) audit = readIf(env.LEASE_AUDIT_FILE);
  else {
    const r = spawnSync('ssh', ['-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', 'proxmox', 'cat ~/agent-leases/deploys.jsonl'], { encoding: 'utf8', timeout: 20000, maxBuffer: 16 << 20 });
    if (r.error || r.status !== 0) throw new Error(`registry audit unreadable (${r.error?.code || r.stderr?.trim().slice(0, 80) || `exit ${r.status}`})`);
    audit = r.stdout;
  }
  const rows = jsonl(audit);
  const events = [...jsonl(readIf(join(stateDir, 'manager-events.jsonl.1'))), ...jsonl(readIf(join(stateDir, 'manager-events.jsonl')))];
  let days = {};
  try { days = JSON.parse(readIf(join(stateDir, 'lease-watch.json')) || '{}').days || {}; } catch {}
  const today = new Date(now).toISOString().slice(0, 10);
  return leaseLines(deployWaits(rows, events, now - 86400e3, now), deployWaits(rows, events, now - 7 * 86400e3, now), days[today]);
}
