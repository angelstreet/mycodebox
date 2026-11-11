// Releases a lease whose holder process on THIS host is gone (owner 2026-10-27, "a dead holder must not block a device").
// The registry runs on proxmox and cannot probe codebox pids, so this runs where the pids live: every 30 s it reads the lease rows, and for each
// exclusive lease whose holder is a local pid it checks /proc. Gone, or reused (the process started after the lease), on 2 consecutive polls ->
// `vpt-lease release <id> --by lease-holder-reaper --reason "holder-gone: ..."` (journaled in the lease events, shown in the owner feed by lease-watch).
// Pid sources: the claim's holder_pid with holder_host == this host (dispatchers pass both), else the -<pid> of a codebox:<name>-<pid> agent; a name pid
// counts only after it was seen alive once (a number inside a free-form name is not a pid) and never while a dashboard session of that name exists.
// Untouched: mac:* and other hosts, pin/observe, system / deploy leases, leases without a pid (TTL as before). GHOSTY_HOLDER_REAPER=off disables.
// Unused grant (owner 2026-11-11, the Mi held ~11 h by grants nobody used): an exclusive lease of a codebox:<session> agent that someone else
// waits for, granted while that session sat idle, with no heartbeat or renewal and no turn of the session since the grant, is released after
// GHOSTY_UNUSED_GRANT_MIN (default 10; 0 = off) on 2 consecutive polls. A waiter that exits on its grant wakes its session at once, so a
// lease in real use always shows a turn or a heartbeat; a claim made inside a turn ends that turn after the grant and never qualifies.
// Idle release (owner 2026-11-11, TASK-239 item 3): an exclusive lease of a live codebox:<session> whose session sits at its prompt (not working, no
// turn / prompt / heartbeat / grant) for GHOSTY_IDLE_RELEASE_MIN (default 10; 0 = off) is released on 2 consecutive polls, journaled, and the session is told
// how to claim again. Never when the session has a live background job (hasLiveJob: reporter backgroundWork / crons, a pane task, a child process of the
// agent), nor a lease with a holder pid, a pin, a system / deploy lease. Mode: manager.json `leaseIdleRelease` "dry" (default: journal only, dryRun:true) | "live" | "off".
import fs from 'node:fs';
import os from 'node:os';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const CHECKS = 2;
export const UNUSED_GRACE_MS = 10 * 60 * 1000;
const unusedGraceFromEnv = () => { const v = process.env.GHOSTY_UNUSED_GRANT_MIN; const n = v == null || v === '' ? 10 : Number(v); return Number.isFinite(n) && n > 0 ? n * 60000 : 0; };
export const IDLE_RELEASE_MS = 10 * 60 * 1000;
const idleFromEnv = () => { const v = process.env.GHOSTY_IDLE_RELEASE_MIN; const n = v == null || v === '' ? 10 : Number(v); return Number.isFinite(n) && n > 0 ? n * 60000 : 0; };
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

// Pure. rows/tickets: vpt-lease list --json. activityOf(session) -> { working, turnAt, promptAt } | null (reporter.activityOf).
// -> [{ id, agent, session, waiters }] granted to an idle codebox session that never used them while others wait, older than graceMs.
export function unusedGrants(rows, tickets, { sessionNames = [], activityOf = () => null, now = Date.now(), graceMs = UNUSED_GRACE_MS } = {}) {
  const out = [];
  if (!(graceMs > 0)) return out;
  for (const l of rows || []) {
    if (l.mode !== 'exclusive' || l.system || l.deploy_id || SYSTEM_RE.test(l.agent || '')) continue;
    const m = /^codebox:(.+)$/.exec(l.agent || '');
    if (!m || !sessionNames.includes(m[1])) continue;                   // only a live dashboard session can be idle; closed ones are holder-gone
    const sinceMs = (Number(l.since) || 0) * 1000;
    if (!sinceMs || now - sinceMs < graceMs) continue;
    const hb = Date.parse(l.lastHeartbeatAt || l.last_heartbeat_at || '') || 0;
    if (hb > sinceMs + 60000) continue;                                 // heartbeat or renewal after the grant: in use
    const waiters = (tickets || []).filter((t) => t.agent !== l.agent && (t.holders || []).some((h) => (h && typeof h === 'object' ? h.id : h) === l.id)).map((t) => t.agent);
    if (!waiters.length) continue;                                      // nobody waits: TTL as before
    let act; try { act = activityOf(m[1]); } catch { act = null; }
    if (!act || act.working || Math.max(act.turnAt || 0, act.promptAt || 0) >= sinceMs) continue;   // unknown, working, or a turn since the grant
    out.push({ id: l.id, agent: l.agent, session: m[1], waiters, sinceMs });
  }
  return out;
}

// Pure. -> [{ id, agent, session, idleMin, sinceMs }] exclusive leases of an idle live codebox session; the caller still asks hasLiveJob before acting.
export function idleHolders(rows, { sessionNames = [], activityOf = () => null, now = Date.now(), idleMs = IDLE_RELEASE_MS } = {}) {
  const out = [];
  if (!(idleMs > 0)) return out;
  for (const l of rows || []) {
    if (l.mode !== 'exclusive' || l.system || l.deploy_id || l.holder_pid != null || SYSTEM_RE.test(l.agent || '')) continue;
    const m = /^codebox:(.+)$/.exec(l.agent || '');
    if (!m || !sessionNames.includes(m[1])) continue;
    let act; try { act = activityOf(m[1]); } catch { act = null; }
    if (!act || act.working) continue;                                  // unknown (nobody may act on it) or working
    const sinceMs = (Number(l.since) || 0) * 1000;
    const hb = Date.parse(l.lastHeartbeatAt || l.last_heartbeat_at || '') || 0;
    const ref = Math.max(sinceMs, hb, act.turnAt || 0, act.promptAt || 0);
    if (!ref || now - ref < idleMs) continue;
    out.push({ id: l.id, agent: l.agent, session: m[1], idleMin: Math.floor((now - ref) / 60000), sinceMs });
  }
  return out;
}

export function createHolderReaper({ stateDir, run, listSessionNames = async () => [], activityOf = () => null, startOf = procStartSec, now = Date.now, pollMs = 30000, log = console, enabled = () => process.env.GHOSTY_HOLDER_REAPER !== 'off', unusedGraceMs = () => unusedGraceFromEnv(), idleReleaseMs = () => idleFromEnv(), idleMode = () => 'dry', hasLiveJob = async () => false, notify = async () => {} } = {}) {
  const dead = new Map();      // lease id -> consecutive dead polls
  const unused = new Map();    // lease id -> consecutive polls seen as an unused grant
  const idleSeen = new Map();  // lease id -> consecutive polls seen idle
  const armed = new Set();     // name-derived pids seen alive
  let timer = null, busy = false, snap = { at: 0, watched: 0, released: [] };

  async function poll() {
    if (busy || !enabled()) return snap;
    busy = true;
    try {
      const r = await run(['list', '--json']);
      if (r.code !== 0) return snap;
      let rows; try { rows = JSON.parse(r.stdout).leases; } catch { return snap; }
      let tickets = []; try { tickets = JSON.parse(r.stdout).tickets || []; } catch { /* rows parsed above */ }
      const names = await listSessionNames().catch(() => []);
      const list = watchable(rows, { sessionNames: names });
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
      const idle = unusedGrants(rows, tickets, { sessionNames: names, activityOf, now: now(), graceMs: unusedGraceMs() });
      const idleIds = new Set(idle.map((u) => u.id));
      for (const id of [...unused.keys()]) if (!idleIds.has(id)) unused.delete(id);
      for (const u of idle) {
        const n = (unused.get(u.id) || 0) + 1;
        unused.set(u.id, n);
        if (n < CHECKS || acted >= MAX_PER_POLL) continue;
        acted++;
        const reason = `unused-grant: released lease ${u.id}: granted at ${new Date(u.sinceMs).toISOString().slice(11, 16)} UTC to idle session ${u.session}, never used since (no turn, no heartbeat) while ${u.waiters.slice(0, 3).join(', ')} wait${u.waiters.length > 1 ? '' : 's'}`;
        const rr = await run(['release', u.id, '--by', 'lease-holder-reaper', '--reason', reason]);
        const line = { at: new Date(now()).toISOString(), id: u.id, agent: u.agent, session: u.session, waiters: u.waiters, ok: rr.code === 0, out: (rr.stdout || rr.stderr || '').trim().slice(0, 120) };
        await mkdir(stateDir, { recursive: true }).then(() => appendFile(join(stateDir, 'lease-actions.jsonl'), JSON.stringify({ ...line, by: 'lease-holder-reaper', type: 'unused-grant' }) + '\n')).catch(() => {});
        if (rr.code === 0) { unused.delete(u.id); released.push(line); log.log?.(`[lease-holder-reaper] ${reason}`); }
      }
      const im = idleMode();
      const idleAll = im === 'off' ? [] : idleHolders(rows, { sessionNames: names, activityOf, now: now(), idleMs: idleReleaseMs() }).filter((u) => !released.some((r) => r.id === u.id));
      const idleIds2 = new Set(idleAll.map((u) => u.id));
      for (const id of [...idleSeen.keys()]) if (!idleIds2.has(id)) idleSeen.delete(id);
      for (const u of idleAll) {
        const n = (idleSeen.get(u.id) || 0) + 1;
        idleSeen.set(u.id, n);
        if (n < CHECKS || acted >= MAX_PER_POLL) continue;
        let job = false; try { job = await hasLiveJob(u.session); } catch { job = true; }   // unknown = busy
        if (job) continue;
        const reason = `idle-release: released lease ${u.id}: session ${u.session} idle at its prompt ${u.idleMin} min, no background job`;
        const line = { at: new Date(now()).toISOString(), id: u.id, agent: u.agent, session: u.session, idleMin: u.idleMin, by: 'lease-holder-reaper', type: 'idle-release', dryRun: im !== 'live' };
        if (im === 'live') {
          acted++;
          const rr = await run(['release', u.id, '--by', 'lease-holder-reaper', '--reason', reason]);
          line.ok = rr.code === 0; line.out = (rr.stdout || rr.stderr || '').trim().slice(0, 120);
          if (rr.code === 0) {
            idleSeen.delete(u.id); released.push(line); log.log?.(`[lease-holder-reaper] ${reason}`);
            await notify(u.session, `Lease watchdog: your lease ${u.id} was released: you sat idle at the prompt ${u.idleMin} min with no background job. Claim again when you need it: vpt-lease claim <env> --any <group> --wait (or vpt-lease run <env> <resource> -- <cmd>).`).catch(() => {});
          }
        } else if (n === CHECKS) log.log?.(`[lease-holder-reaper] DRY ${reason}`);   // dry: one line when first confirmed
        if (im !== 'live' && n !== CHECKS) continue;
        await mkdir(stateDir, { recursive: true }).then(() => appendFile(join(stateDir, 'lease-actions.jsonl'), JSON.stringify(line) + '\n')).catch(() => {});
      }
      snap = { at: now(), watched: list.length, released };
    } catch (e) { log.error?.('[lease-holder-reaper]', e.message); }
    finally { busy = false; }
    return snap;
  }
  return { poll, snapshot: () => snap, start() { if (!timer) { timer = setInterval(() => { poll(); }, pollMs); timer.unref?.(); } }, stop() { clearInterval(timer); timer = null; } };
}
