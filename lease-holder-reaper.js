// Releases a lease whose holder process on THIS host is gone (owner 2026-10-27, "a dead holder must not block a device").
// The registry runs on proxmox and cannot probe codebox pids, so this runs where the pids live: every 30 s it reads the lease rows, and for each
// exclusive lease whose holder is a local pid it checks /proc. Gone, or reused (the process started after the lease), on 2 consecutive polls ->
// `vpt-lease release <id> --by lease-holder-reaper --reason "holder-gone: ..."` (journaled in the lease events, shown in the owner feed by lease-watch).
// Pid sources: the claim's holder_pid with holder_host == this host (dispatchers pass both), else the -<pid> of a codebox:<name>-<pid> agent; a name pid
// counts only after it was seen alive once (a number inside a free-form name is not a pid) and never while a dashboard session of that name exists.
// Untouched: mac:* and other hosts, pin/observe, system / deploy leases, leases without a pid (TTL as before). GHOSTY_HOLDER_REAPER=off disables.
import fs from 'node:fs';
import os from 'node:os';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const CHECKS = 2;
const SKEW_S = 10;                    // the holder exists before it claims; a process that started later than the grant is a reused pid
const MAX_PER_POLL = 3;               // circuit breaker
const SYSTEM_RE = /^(manager:deploy|update_core:)/;

// Epoch seconds when a local pid started, or null when it is gone.
export function procStartSec(pid, { readFile = (f) => fs.readFileSync(f, 'utf8'), clk = 100 } = {}) {
  try {
    const st = readFile(`/proc/${pid}/stat`);
    const ticks = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[19]);
    const btime = Number(/^btime (\d+)/m.exec(readFile('/proc/stat'))?.[1]);
    return Number.isFinite(ticks) && Number.isFinite(btime) ? btime + ticks / clk : null;
  } catch { return null; }
}

// Pure. rows: vpt-lease list --json leases. Returns [{ id, agent, pid, src }] worth watching.
export function watchable(rows, { host = os.hostname(), sessionNames = [] } = {}) {
  const out = [];
  for (const l of rows || []) {
    if (l.mode !== 'exclusive' || l.system || l.deploy_id || SYSTEM_RE.test(l.agent || '')) continue;
    if (l.holder_pid > 1 && l.holder_host === host) { out.push({ id: l.id, agent: l.agent, pid: l.holder_pid, src: 'claim', since: l.since }); continue; }
    if (l.holder_pid != null) continue;                                  // a pid on another host
    const m = /^codebox:(.+)-(\d{2,9})$/.exec(l.agent || '');
    if (m && Number(m[2]) > 1 && !sessionNames.includes(`${m[1]}-${m[2]}`)) out.push({ id: l.id, agent: l.agent, pid: Number(m[2]), src: 'agent-name', since: l.since });
  }
  return out;
}

export function createHolderReaper({ stateDir, run, listSessionNames = async () => [], startOf = procStartSec, now = Date.now, pollMs = 30000, log = console, enabled = () => process.env.GHOSTY_HOLDER_REAPER !== 'off' } = {}) {
  const dead = new Map();      // lease id -> consecutive dead polls
  const armed = new Set();     // name-derived pids seen alive
  let timer = null, busy = false, snap = { at: 0, watched: 0, released: [] };

  async function poll() {
    if (busy || !enabled()) return snap;
    busy = true;
    try {
      const r = await run(['list', '--json']);
      if (r.code !== 0) return snap;
      let rows; try { rows = JSON.parse(r.stdout).leases; } catch { return snap; }
      const list = watchable(rows, { sessionNames: await listSessionNames().catch(() => []) });
      const seen = new Set(list.map((w) => w.id));
      for (const id of [...dead.keys()]) if (!seen.has(id)) dead.delete(id);
      let acted = 0;
      const released = [];
      for (const w of list) {
        const sinceSec = Number(w.since) || 0;
        const st = startOf(w.pid);
        const alive = st != null && (!sinceSec || st <= sinceSec + SKEW_S);       // started later than the lease = a reused pid
        if (alive) { armed.add(w.id); dead.delete(w.id); continue; }
        if (w.src === 'agent-name' && !armed.has(w.id)) continue;
        const n = (dead.get(w.id) || 0) + 1;
        dead.set(w.id, n);
        if (n < CHECKS || acted >= MAX_PER_POLL) continue;
        acted++;
        const reason = `holder-gone: released stale lease ${w.id}: holder pid ${w.pid} is gone`;
        const rr = await run(['release', w.id, '--by', 'lease-holder-reaper', '--reason', reason]);
        const line = { at: new Date(now()).toISOString(), id: w.id, agent: w.agent, pid: w.pid, src: w.src, ok: rr.code === 0, out: (rr.stdout || rr.stderr || '').trim().slice(0, 120) };
        await mkdir(stateDir, { recursive: true }).then(() => appendFile(join(stateDir, 'lease-actions.jsonl'), JSON.stringify({ ...line, by: 'lease-holder-reaper', type: 'holder-gone' }) + '\n')).catch(() => {});
        if (rr.code === 0) { dead.delete(w.id); armed.delete(w.id); released.push(line); log.log?.(`[lease-holder-reaper] ${reason}`); }
      }
      snap = { at: now(), watched: list.length, released };
    } catch (e) { log.error?.('[lease-holder-reaper]', e.message); }
    finally { busy = false; }
    return snap;
  }
  return { poll, snapshot: () => snap, start() { if (!timer) { timer = setInterval(() => { poll(); }, pollMs); timer.unref?.(); } }, stop() { clearInterval(timer); timer = null; } };
}
