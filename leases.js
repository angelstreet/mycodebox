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
      value = { ok: true, leases: (j.leases || []).map((l) => ({ id: l.id, env: l.env, resource: l.resource || '*', agent: l.agent || '', purpose: l.purpose || '', kind: l.kind || 'run', ttlLeftMin: l.ttlLeftMin })), waiters: j.waiters || [] };
    } catch (e) { value = { ok: false, error: String(e.message || e).slice(0, 200) }; }
    cache = { at: now(), value };
    return value;
  }
  return { get, peek: () => cache.value };
}
