// Context advisory (token audit 2026-11-28, saving #2; manager decision): a `high-avg-context` finding of usage/waste.js
// (avg context > 300k per call over >= 30 calls, read from usage-summary.json `waste.findings`) becomes ONE advisory event to the
// manager (`<session>:context-advisory`, priority low) per finding id (the Langfuse trace id, stable for a session), then nothing
// for that id for `cooldownMs` (default 24 h), so the usage tick (every 30 s) never repeats it. Advisory only: the manager restarts
// only a session it started itself, at a natural stop, never an owner-started one. The detector is not redone here.
// State: <stateDir>/context-advisory.json { <finding id>: <ms last sent> } (old entries pruned).

import { join } from 'node:path';
import { promises as fsp } from 'node:fs';

import { CONTEXT_ADVISORY, SUBAGENT_ADVISORY, MANAGER_RESTART_ADVISORY, ADVISORY_KINDS } from './advisory-kinds.js';

export const KIND = CONTEXT_ADVISORY;
export const COOLDOWN_MS = 24 * 3600e3;
export const FILE_NAME = 'context-advisory.json';

// Pure: the event for one finding. startedBy: 'manager' | 'owner' | 'unknown'.
export const SUB_KIND = SUBAGENT_ADVISORY;
export const MGR_KIND = MANAGER_RESTART_ADVISORY;
export const HANDOVER_FILE = '~/vpt-manager/docs/manager-handover.log';
export function advisoryEvent(f, startedBy = 'unknown', at = new Date().toISOString()) {
  if (f.kind === 'subagent-heavy') {
    const who = startedBy === 'manager' ? 'started by the manager' : 'not started by the manager';
    return {
      at, key: `${f.session}:${SUB_KIND}`, priority: 'low', session: f.session,
      title: `${f.session}: advisory, subagent-heavy (${f.value}% of its context is subagents; ${who})`,
      body: `Advisory, no action required. ${f.detail}. Saving #3 of the token audit: give each subagent a narrow prompt (one question, the files to read, an output cap of about 10 lines), prefer Sonnet or Haiku for read-only lookups, and do not spawn one for work of a few tool calls. Brief text for the session owner: "Subagents: one question each, named files, answer in 10 lines, no whole-repo reads." Finding ${f.id}, cost $${f.cost ?? '?'} in the window.`,
      url: `/?s=${encodeURIComponent(f.session)}`,
      advisory: { findingId: f.id, kind: f.kind, share: f.value, startedBy, account: f.account || null, agent: f.agent || null },
    };
  }
  if (startedBy === 'self' && f.kind === 'high-avg-context') {
    const k = Math.round((f.value || 0) / 1e3);
    return {
      at, key: `${f.session}:${MGR_KIND}`, priority: 'low', session: f.session,
      title: `${f.session}: advisory, restart yourself fresh (avg context ${k}k per call)`,
      body: `Advisory, no action required now. Your own context averages ${k}k per call (limit 300k, ${f.detail || ''}). Rule: at your next natural stop (no turn running, no draft, no deploy in progress, never mid-wake), (1) append ONE handover line to ${HANDOVER_FILE}: UTC time | open items and who each waits on | decisions pending | last-seen event time | anything you promised; (2) then run scripts/manager-fresh.sh (reason "context ${k}k"); the fresh manager reads that last line first. Finding ${f.id}.`,
      url: `/?s=${encodeURIComponent(f.session)}`,
      advisory: { findingId: f.id, kind: 'manager-restart', avgContext: f.value, startedBy, account: f.account || null, agent: f.agent || null },
    };
  }
  const who = startedBy === 'manager' ? 'started by the manager' : startedBy === 'owner' ? 'started by the owner (or a worker, not the manager)' : 'starter unknown';
  const rule = startedBy === 'manager'
    ? 'You started it: you may restart it (fresh session, same task, a handover) at its next natural stop, never mid-turn.'
    : 'Not yours: do NOT restart it. The manager restarts only sessions it started itself, at a natural stop, never an owner-started session.';
  const k = Math.round((f.value || 0) / 1e3);
  return {
    at, key: `${f.session}:${KIND}`, priority: 'low', session: f.session,
    title: `${f.session}: advisory, big context (avg ${k}k per call; ${who})`,
    body: `Advisory, no action required. ${f.detail || `avg context ${k}k per call`}. ${rule} Finding ${f.id}, cost $${f.cost ?? '?'} in the window.`,
    url: `/?s=${encodeURIComponent(f.session)}`,
    advisory: { findingId: f.id, avgContext: f.value, startedBy, account: f.account || null, agent: f.agent || null },
  };
}

// Pure: which findings are due. sent: { id: ms }. Returns the findings to send now.
// Dedupe key: the trace id is shared by every finding of one session, so a kind other than high-avg-context gets its own key (the old id-only key stays for high-avg-context: state files already hold it).
// Pure: when did each advisory kind last reach the manager feed? rows = manager-events.jsonl records (any order).
// -> { kinds: { <kind>: { at, session } | null }, since: <oldest row's at in the feed, so "never" can say how far back it looked> }
export function lastFired(rows) {
  const kinds = Object.fromEntries(ADVISORY_KINDS.map((k) => [k, null]));
  let since = null;
  for (const r of rows || []) {
    if (!r || typeof r.at !== 'string') continue;
    if (since === null || r.at < since) since = r.at;
    if (r.kind in kinds && (kinds[r.kind] === null || r.at > kinds[r.kind].at)) kinds[r.kind] = { at: r.at, session: typeof r.session === 'string' ? r.session : '' };
  }
  return { kinds, since };
}
export const sentKey = (f) => (f.kind === 'high-avg-context' ? f.id : `${f.kind}:${f.id}`);
export function dueFindings(findings, sent, now, { cooldownMs = COOLDOWN_MS, isLive = () => true } = {}) {
  const out = [], ids = new Set();
  for (const f of findings || []) {
    if (!f || (f.kind !== 'high-avg-context' && f.kind !== 'subagent-heavy') || !f.id || !f.session || ids.has(sentKey(f))) continue;
    if (!isLive(f.session)) continue;
    const prev = sent[sentKey(f)];
    if (Number.isFinite(prev) && now - prev < cooldownMs) continue;
    ids.add(sentKey(f)); out.push(f);
  }
  return out;
}

// getSummary(): the usage summary (usage-view.js get()); record(ev): managerEvents.record; startedBy(name): 'manager'|'owner'|'unknown'.
export function createContextAdvisory({ stateDir, getSummary, record, startedBy = () => 'unknown', isLive = () => true, now = Date.now, cooldownMs = COOLDOWN_MS, fs = fsp, log = console } = {}) {
  const file = join(stateDir, FILE_NAME);
  let sent = null, busy = false;
  async function load() {
    try { const j = JSON.parse(await fs.readFile(file, 'utf8')); sent = j && typeof j === 'object' ? j : {}; } catch { sent = {}; }
  }
  async function tick() {
    if (busy) return 0;
    busy = true;
    try {
      if (!sent) await load();
      const summary = await getSummary();
      const t = now();
      const due = dueFindings(summary?.waste?.findings, sent, t, { cooldownMs, isLive });
      let n = 0;
      for (const f of due) {
        let by = 'unknown';
        try { by = startedBy(f.session) || 'unknown'; } catch { /* unknown */ }
        await record(advisoryEvent(f, by, new Date(t).toISOString()));
        sent[sentKey(f)] = t; n++;
      }
      for (const [id, at] of Object.entries(sent)) if (!Number.isFinite(at) || t - at > 4 * cooldownMs) delete sent[id];
      if (n) { await fs.mkdir(stateDir, { recursive: true }); await fs.writeFile(file, JSON.stringify(sent)); }
      return n;
    } catch (e) { log.error?.('[context-advisory]', e.message); return 0; }
    finally { busy = false; }
  }
  return { tick };
}
