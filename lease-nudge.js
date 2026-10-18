// The orchestrator asks a holder to release or narrow (OWNER_DECISIONS §19, round 12 part b). Every 2 minutes: for each queued deploy and
// each ticket that has waited more than 10 min, look at the leases that block it. A holder is nudgeable when its lease is past its own
// expect_min, when its codebox session has had no finished turn for 20 min (lease-watch's signal), or when the lease is broader than its
// purpose needs (env-wide / server-kind, purpose names one host / device / the frontend). Once per (holder, lease) per 30 min:
//  - a codebox session stopped on a finished turn with nothing typed gets one line through the guarded send (by 'lease-nudge');
//  - any other holder (Mac, a script) gets a manager event (kind lease) with the same text, for the manager to relay.
// It never releases or narrows anything. manager.json `leaseNudge`: "live" (default) | "dry" (log only) | "off".
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { effectiveBlockers } from './public/platforms-view.js';
import { normLease } from './lease-source.js';

export const WAIT_MS = 10 * 60 * 1000;      // a deploy or ticket waits this long before its holders are asked
export const IDLE_MIN = 20;                 // no finished turn for this long = idle
export const COOLDOWN_MS = 30 * 60 * 1000;  // one nudge per (holder, lease)
export const TICK_MS = 2 * 60 * 1000;
const SYSTEM_RE = /^(?:manager:deploy|update_core:)/;
const SINGLE_RE = /\bfrontend\b|\b(?:host|stb|device|node)[-\w]*\d/i;           // the purpose names one thing
const WIDE_RE = /\b(?:server|backend|full|everything|all (?:hosts|devices)|every)\b/i;   // ... unless it also says it needs the whole env

const mins = (ms) => Math.max(0, Math.round(ms / 60000));
const clean = (s, n = 60) => String(s ?? '').replace(/[`\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const resText = (l) => (l.resources?.length ? l.resources.join(',') : '*');

// A host-kind lease on named host(s) / device(s): the narrowest correct lease for a running script. A deploy that restarts that host
// blocked on it is a legitimate conflict (the deferred restart is a separate task), not an over-broad lease: never ask it to narrow.
export const narrowlyScoped = (l) => l.kind === 'host' && (l.resources || []).length > 0 && l.resources.every((r) => r && !['*', 'server', 'frontend'].includes(r));

// Why a lease is nudgeable: [] when it is not. lease: rich record (lease-source normLease); idleMin: minutes without a finished turn (null unknown).
export function reasonsOf(l, { now, idleMin = null }) {
  const out = [];
  if (l.expectMin != null && l.sinceMs && now - l.sinceMs > l.expectMin * 60000) out.push(`past its expected ${l.expectMin} min`);
  if (idleMin != null && idleMin >= IDLE_MIN) out.push(`idle ${idleMin} min`);
  const wide = (l.resources || []).includes('*') || l.kind === 'server';
  if (wide && SINGLE_RE.test(l.purpose || '') && !WIDE_RE.test(l.purpose || '')) out.push('broader than its purpose');
  return out;
}

// Pure. Inputs: deploys (runner snapshot `deploys`, created in seconds, `blocking`), view (lease-source view: leases, tickets),
// sessionOf(agent) -> codebox session name | null, idleMinOf(lease, session) -> minutes | null, last: Map<key, ms>.
// -> [{ key, leaseId, agent, session, env, resources, what, waitedMin, reasons, text }] (one per holder lease, longest wait first)
export function planNudges({ now, deploys = [], view = null, sessionOf = () => null, idleMinOf = () => null, last = new Map(), waitMs = WAIT_MS, cooldownMs = COOLDOWN_MS } = {}) {
  const leases = new Map(((view?.ok ? view.leases : null) || []).filter((l) => l.mode === 'exclusive').map((l) => [l.id, l]));
  const waits = [];   // { what, waitedMs, blockers: [lease-like] }
  for (const d of deploys || []) {
    if (d.state !== 'queued') continue;
    const waitedMs = now - (Number(d.created) || 0) * 1000;
    if (!(waitedMs > waitMs)) continue;
    const blockers = effectiveBlockers(d).map((b) => leases.get(String(b.id)) || normLease({ ...b, env: b.env || d.env, resources: b.resources ?? b.resource }, now));
    waits.push({ what: `deploy ${clean(d.id, 16)} (${clean(d.scope, 12)} ${clean(d.ref, 30)} to ${clean(d.env, 20)})`, waitedMs, blockers, deploy: true });
  }
  for (const t of view?.ok ? view.tickets || [] : []) {
    const waitedMs = t.createdMs ? now - t.createdMs : 0;
    if (!(waitedMs > waitMs)) continue;
    const ids = new Set(t.holderIds || []);
    const blockers = [...leases.values()].filter((l) => ids.has(l.id) || (!ids.size && l.env === t.env && (t.holders || []).includes(l.agent)));
    waits.push({ what: `${clean(t.agent, 40) || 'another agent'}'s claim ${clean(t.id, 16)} on ${clean(t.env, 20)}/${(t.resources || []).map((r) => clean(r, 30)).join(',') || '*'}`, waitedMs, blockers });
  }
  const out = new Map();
  for (const w of waits.sort((a, b) => b.waitedMs - a.waitedMs)) {
    for (const l of w.blockers) {
      if (!l.agent || SYSTEM_RE.test(l.agent) || l.deployId) continue;
      const key = `${l.agent}|${l.id}`;
      if (out.has(key) || now - (last.get(key) || 0) < cooldownMs) continue;
      if (w.deploy && narrowlyScoped(l)) continue;
      const session = /^mac:/i.test(l.agent) ? null : sessionOf(l.agent);
      const reasons = reasonsOf(l, { now, idleMin: idleMinOf(l, session) });
      if (!reasons.length) continue;
      const waitedMin = mins(w.waitedMs);
      const text = `Your lease ${l.id} on ${clean(l.env, 20)}/${resText(l)} blocks ${w.what} (waiting ${waitedMin} min). Release it if you are done (vpt-lease release ${l.id}), or narrow it to what you use (vpt-lease narrow ${l.id} --resource <host/device> --kind host).`;
      out.set(key, { key, leaseId: l.id, agent: l.agent, session, env: l.env, resources: l.resources || [], what: w.what, waitedMin, reasons, text });
    }
  }
  return [...out.values()];
}

// deps: stateDir, getInputs() -> { deploys, view }, sessionOf, idleMinOf, canSend(session) -> bool (stopped on a finished turn, no draft, no menu),
// send(session, text) -> guarded send, record(event) -> manager event, mode() -> live|dry|off.
export function createLeaseNudge({ stateDir, getInputs, sessionOf = () => null, idleMinOf = () => null, canSend = () => false, send = async () => {}, record = async () => {}, mode = () => 'live', now = Date.now, log = console, tickMs = TICK_MS } = {}) {
  const stateFile = join(stateDir, 'lease-nudge.json');
  const actionsFile = join(stateDir, 'lease-nudges.jsonl');
  const last = new Map();
  let loaded = false, busy = false, timer = null, snap = { at: 0, mode: 'off', planned: 0, sent: 0, events: 0 };
  async function load() { loaded = true; try { for (const [k, v] of Object.entries(JSON.parse(await readFile(stateFile, 'utf8')))) last.set(k, v); } catch { /* none yet */ } }
  async function save() {
    const t = now();
    for (const [k, v] of [...last]) if (t - v > 24 * 3600 * 1000) last.delete(k);
    try { await mkdir(stateDir, { recursive: true }); await writeFile(stateFile, JSON.stringify(Object.fromEntries(last))); } catch (e) { log.error?.('[lease-nudge] save', e.message); }
  }
  async function tick() {
    if (busy) return snap;
    busy = true;
    try {
      const m = mode();
      const t = now();
      if (m === 'off') { snap = { at: t, mode: m, planned: 0, sent: 0, events: 0 }; return snap; }
      if (!loaded) await load();
      const inp = await getInputs();
      const plan = planNudges({ now: t, deploys: inp?.deploys, view: inp?.view, sessionOf, idleMinOf, last });
      let sent = 0, events = 0;
      for (const n of plan) {
        const rec = { at: new Date(t).toISOString(), by: 'lease-nudge', leaseId: n.leaseId, agent: n.agent, session: n.session, env: n.env, reasons: n.reasons, waitedMin: n.waitedMin, via: n.session ? 'session' : 'event', dryRun: m !== 'live' };
        if (m === 'live') {
          if (n.session) {
            if (!canSend(n.session)) continue;   // working, a draft, a menu: try again on the next tick
            try { await send(n.session, n.text); sent++; } catch (e) { log.error?.('[lease-nudge] send', n.session, e.message); continue; }
          } else {
            try { await record({ key: 'lease:nudge', title: `ask ${n.agent} to release or narrow ${n.leaseId}`, body: `${n.text} (${n.reasons.join('; ')})`, url: '/?leases=1', priority: 'default', leaseId: n.leaseId, agent: n.agent, env: n.env, resources: n.resources }); events++; } catch (e) { log.error?.('[lease-nudge] record', e.message); continue; }
          }
          last.set(n.key, t);
        } else last.set(n.key, t);   // dry: log once per cooldown, not every tick (not saved)
        try { await appendFile(actionsFile, JSON.stringify(rec) + '\n'); } catch { /* audit only */ }
        log.log?.(`[lease-nudge] ${m === 'live' ? '' : 'DRY '}${n.session ? `to ${n.session}` : 'event'}: ${n.leaseId} (${n.reasons.join('; ')})`);
      }
      if (sent || events) await save();
      snap = { at: t, mode: m, planned: plan.length, sent, events };
      return snap;
    } catch (e) { log.error?.('[lease-nudge]', e.message); return snap; } finally { busy = false; }
  }
  return { tick, start() { tick(); timer = setInterval(tick, tickMs); timer.unref?.(); }, stop() { if (timer) clearInterval(timer); }, snapshot: () => snap, last };
}
