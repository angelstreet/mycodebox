// Lease registry reader for ghosty: `vpt-lease list --json` (leases with ttlLeftMin, active deploys, waiters), cached 15 s.
// `run(args)` is injected (default: ssh proxmox); returns {code, stdout, stderr}.
import { execFile } from 'node:child_process';

const SAFE = /^[A-Za-z0-9_.\/:@=+-]+$/;
export function sshRun(args) {
  const cmd = `~/bin/vpt-lease ${args.map((s) => (SAFE.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)).join(' ')}`;
  return new Promise((resolve) => execFile('ssh', ['-o', 'ConnectTimeout=3', '-o', 'BatchMode=yes', 'proxmox', cmd], { timeout: 8000, maxBuffer: 4 << 20 },
    (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 255) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })));
}

export function createLeaseStore({ run = sshRun, ttlMs = 15000, now = Date.now } = {}) {
  let cache = { at: 0, value: null };
  async function get(force = false) {
    if (!force && cache.value && now() - cache.at < ttlMs) return cache.value;
    let value;
    const r = await run(['list', '--json']);
    try {
      if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim().slice(0, 200));
      const j = JSON.parse(r.stdout);
      value = { ok: true, leases: (j.leases || []).map((l) => ({ id: l.id, env: l.env, resource: l.resource || '*', agent: l.agent || '', purpose: l.purpose || '', kind: l.kind || 'run', ttlLeftMin: l.ttlLeftMin,
        // rich fields the client passes through from the central service (mode, idle, hold time, session): feed the Leases view, lease-ask and lease-nudge
        ...(l.mode ? { mode: l.mode } : {}), ...(l.session ? { session: l.session } : {}), ...(l.since ? { since: l.since } : {}), idleMin: l.idleMin ?? null, expect_min: l.expect_min ?? null,
        heartbeat_s: l.heartbeat_s ?? null, lastHeartbeatAt: l.lastHeartbeatAt ?? l.last_heartbeat_at ?? null, deploy_id: l.deploy_id ?? null })),
        waiters: j.waiters || [], tickets: Array.isArray(j.tickets) ? j.tickets : [] };
    } catch (e) { value = { ok: false, error: String(e.message || e).slice(0, 200) }; }
    cache = { at: now(), value };
    return value;
  }
  return { get, peek: () => cache.value };
}
