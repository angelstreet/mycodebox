// The orchestrator asks a holder to release or narrow (OWNER_DECISIONS §19, round 12 part b). Every 2 minutes: for each queued deploy and
// each ticket that has waited more than 10 min, look at the leases that block it. A holder is nudgeable when its lease is past its own
// expect_min, when its codebox session has had no finished turn for 20 min (lease-watch's signal), or when the lease is broader than its
// purpose needs (env-wide / server-kind, purpose names one host / device / the frontend). Once per (holder, lease) per 30 min:
//  - a codebox session stopped on a finished turn with nothing typed gets one line through the guarded send (by 'lease-nudge');
//  - any other holder (Mac, a script) gets a manager event (kind lease) with the same text, for the manager to relay.
// It never releases or narrows anything. manager.json `leaseNudge`: "live" (default) | "dry" (log only) | "off".
// Wait watchdog (owner 2026-10-31: "agents are not waiting for a lease or a device when we have another one available"): a ticket
// that has waited WAIT_MS on a named resource while an equivalent one is free (the service's `equivalents_free`, from the inventory
// groups), or on a host that only device leases block (`hint`), gets one line in the WAITER's own chat with the command that ends
// the wait. No AI call; once per ticket per cooldown. systemResolvable() tells server.js a lease/deploy stop the system resolves
// itself (a live ticket, a running or queued deploy), so it does not wake the manager.
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { effectiveBlockers } from './public/platforms-view.js';
import { normLease, renewalIdleMin } from './lease-source.js';

export const WAIT_MS = 5 * 60 * 1000;       // a deploy or ticket waits this long before its holders (and the waiter) are told (owner 2026-10-31: 5 min)
export const EQ_WAIT_MS = 30 * 1000;        // a ticket with a healthy free equivalent is told after 30 s, not 5 min (owner 2026-11-10: never wait while an equivalent is free)
export const EQ_COOLDOWN_MS = 10 * 60 * 1000;  // ... and again every 10 min while it still waits
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
  // the waiter first: a free equivalent ends the wait at once, no holder has to do anything
  for (const t of view?.ok ? view.tickets || [] : []) {
    const waitedMs = t.createdMs ? now - t.createdMs : 0;
    const known = !!(t.equivalents?.length || t.hint);
    // owner 2026-11-10: no healthy free equivalent and no device-only block = nothing to say (the old 15 min "probe other hosts" push assumed
    // equivalents exist and misled a session on unique hardware); the waiter keeps waiting silently
    const eqNow = !!t.equivalents?.length;
    if (!(waitedMs > (eqNow ? Math.min(waitMs, EQ_WAIT_MS) : waitMs)) || t.any || !known) continue;
    const key = `${t.agent}|${t.id}|waiter`;
    if (now - (last.get(key) || 0) < (eqNow ? Math.min(cooldownMs, EQ_COOLDOWN_MS) : cooldownMs)) continue;
    const session = /^mac:/i.test(t.agent || '') ? null : sessionOf(t.agent);
    if (!session) continue;                  // only a chat can act on it; no manager event for this (the system resolves it)
    const env = clean(t.env, 20), res = (t.resources || []).map((r) => clean(r, 40)).join(',') || '*', waitedMin = mins(waitedMs);
    const eq = (t.equivalents || []).map((r) => clean(r, 40));
    const notOffered = (t.equivalentsRefused || []).slice(0, 4).map((x) => `${clean(x.resource, 40)} (${clean(x.reason, 80)})`);
    const text = eq.length
      ? `Lease watchdog: STOP WAITING: your ticket ${clean(t.id, 16)} on ${env}/${res} is queued while a healthy equivalent is free now: ${eq.join(', ')}. Run: vpt-lease ticket ${clean(t.id, 16)} --cancel && vpt-lease claim ${env} ${eq[0]} --agent ${clean(t.agent, 60)} --kind host --wait   (next time: vpt-lease claim ${env} --any ${clean(t.groups?.[0] || '<group>', 30)} --wait, which never waits while a member is free). Only keep waiting if your work needs exactly ${res}: say which difference makes the others unusable (model, firmware, backend server, known broken) in your STATUS line.${notOffered.length ? ` Not offered, and why: ${notOffered.join('; ')}.` : ''}`
      : `Lease watchdog: your ticket ${clean(t.id, 16)} on ${env}/${res} has waited ${waitedMin} min and only device runs block it: ${clean(t.hint, 220)}. If you need one device, vpt-lease ticket ${clean(t.id, 16)} --cancel and claim ${env} <host>/<device> --kind host --wait.`;
    out.set(key, { key, leaseId: null, ticketId: t.id, waiter: true, agent: t.agent, session, env: t.env, resources: t.resources || [], what: `ticket ${t.id}`, waitedMin, reasons: [eq.length ? `free equivalent ${eq.join(',')}` : 'host blocked only by device leases'], text });
  }
  for (const w of waits.sort((a, b) => b.waitedMs - a.waitedMs)) {
    for (const l of w.blockers) {
      if (!l.agent || SYSTEM_RE.test(l.agent) || l.deployId) continue;
      const key = `${l.agent}|${l.id}`;
      if (out.has(key) || now - (last.get(key) || 0) < cooldownMs) continue;
      if (w.deploy && narrowlyScoped(l)) continue;
      const session = /^mac:/i.test(l.agent) ? null : sessionOf(l.agent);
      // A holder with no session cannot be observed: the registry then reports the time since the claim as "idle". A lease
      // renewed after the claim proves its holder is alive, so the time since the last renewal is the honest idle number.
      const honest = session ? null : renewalIdleMin(l, now);
      const reasons = reasonsOf(l, { now, idleMin: honest ?? idleMinOf(l, session) });
      if (!reasons.length) continue;
      const waitedMin = mins(w.waitedMs);
      const text = `Your lease ${l.id} on ${clean(l.env, 20)}/${resText(l)} blocks ${w.what} (waiting ${waitedMin} min). Release it if you are done (vpt-lease release ${l.id}), or narrow it to what you use (vpt-lease narrow ${l.id} --resource <host/device> --kind host).`;
      out.set(key, { key, leaseId: l.id, agent: l.agent, session, env: l.env, resources: l.resources || [], what: w.what, waitedMin, reasons, text });
    }
  }
  return [...out.values()];
}

// A lease or deploy stop the system resolves without the manager (owner 2026-10-31): the session has a live ticket (the queue grants
// it, the watchdog points it at a free equivalent), or a deploy is queued or running on its env. -> reason string | null.
export function systemResolvable({ session, kind, case: stopCase = '', view = null, deploys = [], sessionOf = () => null } = {}) {
  if (!session || (kind !== 'lease' && kind !== 'deploy')) return null;
  const mine = (agent) => { const a = String(agent || ''); return a === `codebox:${session}` || a.endsWith(`:${session}`) || sessionOf(a) === session; };
  const tk = (view?.ok ? view.tickets || [] : []).find((t) => mine(t.agent));
  if (tk) return `ticket ${tk.id} on ${tk.env}/${(tk.resources || []).join(',') || '*'} is queued: the lease service grants it (watchdog points at free equivalents)`;
  const d = (deploys || []).find((x) => x.state === 'running' || (x.state === 'queued' && x.approved !== false));
  if (kind === 'deploy' && stopCase === 'waiting_deploy' && d) return `deploy ${d.id} (${d.scope}) is ${d.state}: the deploy runner finishes it`;
  return null;
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
        const rec = { at: new Date(t).toISOString(), by: n.waiter ? 'lease-watchdog' : 'lease-nudge', leaseId: n.leaseId, ...(n.ticketId ? { ticketId: n.ticketId } : {}), agent: n.agent, session: n.session, env: n.env, reasons: n.reasons, waitedMin: n.waitedMin, via: n.session ? 'session' : 'event', dryRun: m !== 'live' };
        if (m === 'live') {
          if (n.session) {
            if (!canSend(n.session)) {   // working, a draft, a menu: try again on the next tick
              // owner 2026-11-11: an idle holder the chat guard cannot reach was skipped silently while others queued for hours (the Mi, ~11 h):
              // the manager is told, once per cooldown; the chat line is still retried every tick
              const fk = `${n.key}|flag`;
              if (!n.waiter && n.reasons.some((r) => /^idle /.test(r)) && t - (last.get(fk) || 0) >= COOLDOWN_MS) {
                try {
                  await record({ key: 'lease:idle-blocking', title: `${n.session} holds ${n.leaseId} idle while ${n.what} waits`, body: `${n.text} (${n.reasons.join('; ')}); the session's chat cannot take the note now`, url: '/?leases=1', priority: 'default', leaseId: n.leaseId, agent: n.agent, env: n.env, resources: n.resources });
                  last.set(fk, t); events++;
                  try { await appendFile(actionsFile, JSON.stringify({ ...rec, via: 'event', flag: 'idle-blocking' }) + '\n'); } catch { /* audit only */ }
                } catch (e) { log.error?.('[lease-nudge] record', e.message); }
              }
              continue;
            }
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
