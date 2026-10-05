// Lease <-> session binding (TASK-58 C1). Polls the vpt-lease registry on proxmox every 30 s and
//  1. turns the registry's release / expiry / narrow lines (`vpt-lease events`) into `lease:*` manager events (no push),
//  2. releases a lease whose holder session has ENDED (owner decision 2026-10-05: allowed),
//  3. narrows a kind=server lease whose holder has had no finished turn for 30 min to kind=host (NEVER releases an idle holder),
//  4. counts "unknown holders" (agents ghosty cannot map to a session) for the daily report.
// Nothing else is ever touched: mac:* holders, unknown names, update_core:* and the deploy runner are left alone.
// Every automatic action is appended to <stateDir>/lease-actions.jsonl with by:"TASK58-C1" (and shows up as a lease:* event).
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { agentLocalName, agentSession, normName } from './public/platforms.js';

export const BY = 'TASK58-C1';
export const IDLE_MS = 30 * 60 * 1000;
const GRACE_MS = 2 * 60 * 1000;        // a lease younger than this is never touched
const MAX_ACTIONS_PER_POLL = 3;        // circuit breaker
const SYSTEM_RE = /^(manager:deploy|update_core:)/;

// Pure. Group lease rows by id and say what is going on with each holder.
// status: system | remote (mac:*, not observable from here) | unknown (free-form name, or a codebox name no session ever had)
//       | live | ended (its session existed before and is gone)
export function classifyHolders({ leases, sessionNames, knownNames = [], machines, activity = () => null, now, idleMs = IDLE_MS }) {
  const byId = new Map();
  for (const l of leases || []) { const e = byId.get(l.id) || { id: l.id, agent: l.agent || '', env: l.env, rows: [] }; e.rows.push(l); byId.set(l.id, e); }
  const gone = knownNames.filter((n) => !sessionNames.includes(n));
  const out = [];
  for (const h of byId.values()) {
    const kind = h.rows.some((r) => (r.kind || 'server') === 'server') ? 'server' : 'host';
    const since = Math.min(...h.rows.map((r) => (Number(r.since) || 0) * 1000)) || 0;
    const base = { id: h.id, agent: h.agent, env: h.env, resources: h.rows.map((r) => r.resource || '*'), kind, since, session: null, status: 'unknown', idleMin: null, plan: null };
    if (SYSTEM_RE.test(h.agent)) { out.push({ ...base, status: 'system' }); continue; }
    const m = h.agent.indexOf(':') > 0 ? h.agent.slice(0, h.agent.indexOf(':')).toLowerCase() : '';
    if (m === 'mac') { out.push({ ...base, status: 'remote' }); continue; }
    if (!agentLocalName(h.agent, machines)) { out.push(base); continue; }
    const session = agentSession(h.agent, sessionNames, machines);
    if (session) {
      const act = activity(session);
      const at = act ? Math.max(act.turnAt || 0, act.promptAt || 0) : 0;
      const idleMs_ = at ? now - at : null;
      const r = { ...base, status: 'live', session, idleMin: idleMs_ == null ? null : Math.floor(idleMs_ / 60000) };
      if (kind === 'server' && act && !act.working && idleMs_ != null && idleMs_ > idleMs && now - since > GRACE_MS) r.plan = { type: 'narrow', reason: `idle ${r.idleMin} min (no finished turn)` };
      out.push(r); continue;
    }
    const was = agentSession(h.agent, gone, machines);
    if (was) {
      const r = { ...base, status: 'ended', session: was };
      if (now - since > GRACE_MS) r.plan = { type: 'release', reason: 'session-ended' };
      out.push(r); continue;
    }
    out.push(base);
  }
  return out;
}

const parse = (r) => { try { return r.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };

export function createLeaseWatch({
  stateDir, run, listSessionNames, activityOf = () => null, machines, record = async () => {}, mode = () => 'live',
  now = Date.now, pollMs = 30000, log = console, onChange = () => {},
} = {}) {
  const stateFile = join(stateDir, 'lease-watch.json');
  const actionsFile = join(stateDir, 'lease-actions.jsonl');
  let st = { cursor: null, known: [], days: {} };
  let snap = { ok: false, at: 0, mode: 'off', leases: 0, unknown: 0, remote: 0, holders: [], planned: [] };
  let timer = null, busy = false;
  const strikes = new Map();     // lease id -> consecutive polls it was 'ended'

  async function load() { try { st = { ...st, ...JSON.parse(await readFile(stateFile, 'utf8')) }; } catch {} }
  async function save() { try { await mkdir(stateDir, { recursive: true }); await writeFile(stateFile, JSON.stringify(st)); } catch (e) { log.error?.('[lease-watch] save', e.message); } }
  const day = (t) => new Date(t).toISOString().slice(0, 10);

  async function pullEvents() {
    const r = await run(['events', '--json', '--after', String(st.cursor == null ? 999999999 : st.cursor)]);
    const j = parse(r);
    if (!j) return;
    if (st.cursor == null) { st.cursor = j.next; return; }       // first run ever: start at the end, do not replay history
    for (const e of j.events || []) {
      const where = `${e.env}/${(e.resources || []).join(',')}`;
      const title = e.event === 'released' ? `lease released: ${where} (${e.agent})`
        : e.event === 'expired' ? `lease expired: ${where} (${e.agent})`
        : `lease narrowed to host: ${where} (${e.agent})`;
      const body = `lease ${e.id}${e.by ? ` by ${e.by}` : ''}${e.reason ? ` (${e.reason})` : ''}; purpose: ${e.purpose || '-'}`;
      await record({ key: `lease:${e.event}`, title, body, url: '/?platforms=1', priority: 'default', at: new Date((e.ts || 0) * 1000).toISOString(), leaseId: e.id });
    }
    st.cursor = j.next;
  }

  async function act(h) {
    const args = h.plan.type === 'release' ? ['release', h.id, '--by', BY, '--reason', h.plan.reason] : ['narrow', h.id, '--kind', 'host', '--by', BY, '--reason', h.plan.reason];
    const r = await run(args);
    return { ok: r.code === 0, out: (r.stdout || r.stderr || '').trim().slice(0, 120) };
  }

  async function poll() {
    if (busy) return snap;
    busy = true;
    try {
      const m = mode();
      const t = now();
      const lj = parse(await run(['list', '--json']));
      if (!lj) { snap = { ...snap, ok: false, at: t, mode: m }; return snap; }
      if (m !== 'off') await pullEvents();
      const names = (await listSessionNames()) || [];
      let holders = [];
      if (names.length) {
        st.known = [...new Set([...(st.known || []), ...names])].slice(-500);
        holders = classifyHolders({ leases: lj.leases || [], sessionNames: names, knownNames: st.known, machines, activity: activityOf, now: t });
      }
      // two-strike: a holder must look 'ended' on two polls in a row before anything is released
      const endedNow = new Set(holders.filter((h) => h.plan?.type === 'release').map((h) => h.id));
      for (const id of [...strikes.keys()]) if (!endedNow.has(id)) strikes.delete(id);
      for (const id of endedNow) strikes.set(id, (strikes.get(id) || 0) + 1);
      const planned = holders.filter((h) => h.plan && (h.plan.type !== 'release' || strikes.get(h.id) >= 2));
      let done = 0;
      for (const h of planned) {
        if (done >= MAX_ACTIONS_PER_POLL) break;
        const rec = { at: new Date(t).toISOString(), by: BY, action: h.plan.type, id: h.id, agent: h.agent, env: h.env, resources: h.resources, session: h.session, reason: h.plan.reason, dryRun: m !== 'live' };
        if (m === 'live') { const r = await act(h); rec.ok = r.ok; rec.result = r.out; done += 1; }
        try { await appendFile(actionsFile, JSON.stringify(rec) + '\n'); } catch {}
        log.log?.(`[lease-watch] ${m === 'live' ? '' : 'DRY '}${h.plan.type} ${h.id} ${h.agent}: ${h.plan.reason}`);
      }
      const unknown = holders.filter((h) => h.status === 'unknown').length;
      const d = day(t);
      const dd = st.days[d] || { unknownMax: 0, polls: 0 };
      dd.unknownMax = Math.max(dd.unknownMax, unknown); dd.polls += 1; dd.last = unknown;
      st.days[d] = dd;
      for (const k of Object.keys(st.days).sort().slice(0, -30)) delete st.days[k];
      await save();
      snap = { ok: true, at: t, mode: m, leases: holders.length, unknown, remote: holders.filter((h) => h.status === 'remote').length,
        holders: holders.map(({ id, agent, env, resources, kind, status, session, idleMin, plan }) => ({ id, agent, env, resources, kind, status, session, idleMin, plan })), planned: planned.map((h) => ({ id: h.id, ...h.plan })) };
      onChange(snap);
      return snap;
    } catch (e) { log.error?.('[lease-watch]', e.message); return snap; } finally { busy = false; }
  }

  return {
    async start() { await load(); poll(); timer = setInterval(poll, pollMs); timer.unref?.(); },
    stop() { if (timer) clearInterval(timer); },
    poll, snapshot: () => snap, state: () => st,
  };
}
