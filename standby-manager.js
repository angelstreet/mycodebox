// The MiniMax standby manager (manager.json `standbyManagerSessions`, default ["mm-manager"]) is invisible to the owner while the
// failover state is `claude` (shadow); while it is `minimax` (standby active) it is a manager session like any other.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const STANDBY_DEFAULT = ['mm-manager'];
export const failoverStateFile = (env = process.env) => env.FAILOVER_STATE || join(homedir(), 'handovers', 'notes', '.failover-state');

export function standbyNames(config) {
  return Array.isArray(config?.standbyManagerSessions) ? config.standbyManagerSessions.filter((x) => typeof x === 'string' && x) : STANDBY_DEFAULT;
}

// 'claude' | 'minimax'; a missing or unreadable file is 'claude'. Cached a few seconds (status polls every second).
export function createFailoverState({ file = failoverStateFile(), ttlMs = 5000, now = Date.now, read = (f) => readFileSync(f, 'utf8') } = {}) {
  let at = -Infinity, val = 'claude';
  return () => {
    const t = now();
    if (t - at < ttlMs) return val;
    at = t;
    try { val = String(read(file)).trim() === 'minimax' ? 'minimax' : 'claude'; } catch { val = 'claude'; }
    return val;
  };
}

// { standby, hidden } for a session name.
export function standbyFlags(name, names, state) {
  const standby = names.includes(name);
  return { standby, hidden: standby && state !== 'minimax' };
}
