// V2 incident store (spec §12.4, docs/v2/ARCHITECTURE.md §11). Durable, append-only JSONL of incident events; the
// current incident state is a replay of that log. Persist before acknowledging (fsync per line). A torn last line is
// dropped and truncated on init. Free text is length-capped and scrubbed of token/IP/e-mail/home-path lookalikes so a
// public record never carries them.
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const INCIDENT_TYPES = [
  'host.cpu_pressure', 'host.memory_pressure', 'host.disk_pressure', 'service.unhealthy', 'service.crash_loop',
  'tmux.resource_exhaustion', 'worktree.storage_exceeded', 'runner.starved', 'health.unknown',
];
export const INCIDENT_EVENTS = [
  'incident.opened', 'incident.acknowledged', 'incident.mitigation_requested', 'incident.approval_required',
  'incident.resolved', 'incident.escalated', 'incident.unknown',
  // internal, not part of the spec's seven: dedup link, before/after record, failed-action reconciliation
  'incident.report_linked', 'incident.action_recorded', 'incident.reconciling',
];
export const PRIORITIES = ['low', 'normal', 'high', 'critical'];
export const OPEN_STATES = ['open', 'acknowledged', 'mitigation_requested', 'approval_required', 'reconciling', 'escalated', 'unknown'];

const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const err = (code, msg) => Object.assign(new Error(msg || code), { code });
const MAX_TEXT = 500;
const MAX_ITEMS = 50;

const HEX_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;   // git SHAs are evidence, not secrets
export function sanitizeText(v, max = MAX_TEXT) {
  if (v == null) return '';
  let s = String(v);
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]');
  s = s.replace(/(?:\/home|\/Users|\/root)(?:\/[^\s"'`;,)]*)?/g, '[path]').replace(/~\/[^\s"'`;,)]*/g, '[path]');
  s = s.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  s = s.replace(/\b(token|secret|password|passwd|api[_-]?key|auth)\s*[=:]\s*\S+/gi, '$1=[redacted]');
  s = s.replace(/\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[abpr]|AKIA)[-_A-Za-z0-9]{8,}/g, '[redacted]');
  s = s.replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, (m) => (HEX_ID.test(m) ? m : '[redacted]'));
  s = s.replace(/\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/gi, '[host]');
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]');
  s = s.replace(/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, '[ip]').replace(/(?:^|[\s(])(?:[0-9a-f]{0,4}:){2,7}:[0-9a-f]{0,4}(?=$|[\s)])/gi, ' [ip]');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const sanList = (a, max = MAX_ITEMS) => (Array.isArray(a) ? a.slice(0, max).map((x) => sanitizeText(x, 200)) : []);
export function sanitizeMeasurements(ms) {
  if (!Array.isArray(ms)) return [];
  return ms.slice(0, MAX_ITEMS).map((m) => ({
    name: sanitizeText(m?.name, 64),
    value: Number.isFinite(m?.value) ? m.value : null,       // unknown stays null, never 0
    unit: sanitizeText(m?.unit, 16),
    ts: Number.isFinite(m?.ts) ? m.ts : null,
    source: sanitizeText(m?.source, 100),
  }));
}

function normalizeReporter(r) {
  if (typeof r === 'string') return { reporter: sanitizeText(r, 100), task_id: null };
  return { reporter: sanitizeText(r?.reporter ?? r?.id ?? 'unknown', 100), task_id: r?.task_id ? sanitizeText(r.task_id, 100) : null };
}

export function createIncidentStore({ dir, fs = nodeFs, now = Date.now, randomId = randomUUID, onEvent = null } = {}) {
  if (!dir) throw new Error('incident store: dir required');
  const p = fs.promises || fs;
  const file = join(dir, 'incidents.jsonl');
  const incidents = new Map();
  const events = [];
  let seq = 0;
  let ready = null;
  let chain = Promise.resolve();
  const serial = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

  function apply(e) {
    const { incident_id: id, kind, payload: x } = e;
    let inc = incidents.get(id);
    if (kind === 'incident.opened') {
      incidents.set(id, { ...structuredClone(x), incident_id: id, state: 'open', opened_at: e.ts, updated_at: e.ts, actions: [], approvals: [], requests: [], resolution: null });
      return;
    }
    if (!inc) return;
    if (inc.state === 'resolved') return;
    inc.updated_at = e.ts;
    switch (kind) {
      case 'incident.report_linked':
        inc.reporters.push(x.reporter);
        inc.measurements = [...inc.measurements, ...x.measurements].slice(-MAX_ITEMS);
        break;
      case 'incident.acknowledged': if (inc.state === 'open') inc.state = 'acknowledged'; break;
      case 'incident.mitigation_requested': inc.state = 'mitigation_requested'; inc.requests.push({ ...x, ts: e.ts }); break;
      case 'incident.approval_required': inc.state = 'approval_required'; inc.approvals.push({ ...x, ts: e.ts, status: 'pending' }); break;
      case 'incident.reconciling': inc.state = 'reconciling'; inc.reconcile = x; break;
      case 'incident.action_recorded': inc.actions.push({ ...x, ts: e.ts }); break;
      case 'incident.escalated': inc.state = 'escalated'; inc.escalation = x; break;
      case 'incident.unknown': inc.state = 'unknown'; inc.unknown = x; break;
      case 'incident.resolved': inc.state = 'resolved'; inc.resolved_at = e.ts; inc.resolution = x; break;
      default:
    }
  }

  async function init() {
    return (ready ||= (async () => {
      await p.mkdir(dir, { recursive: true });
      let txt = '';
      try { txt = await p.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      let good = 0; let torn = false;
      for (let off = 0; off < txt.length;) {
        const nl = txt.indexOf('\n', off);
        if (nl < 0) { torn = true; break; }                 // no newline: unfinished write
        let e;
        try { e = JSON.parse(txt.slice(off, nl)); } catch { torn = true; break; }
        if (!e || !INCIDENT_EVENTS.includes(e.kind)) { torn = true; break; }
        events.push(e); apply(e); seq = Math.max(seq, e.seq || 0);
        off = nl + 1; good = off;
      }
      if (torn) await p.truncate(file, Buffer.byteLength(txt.slice(0, good)));
      return { torn, incidents: incidents.size };
    })().catch((e) => { ready = null; throw e; }));
  }

  async function append(incident_id, kind, payload) {
    const e = { event_id: String(randomId()), incident_id, seq: ++seq, ts: now(), kind, payload };
    const fh = await p.open(file, 'a', 0o600);
    try { await fh.writeFile(`${JSON.stringify(e)}\n`); await fh.sync(); } finally { await fh.close(); }
    events.push(e); apply(e);
    try { onEvent?.(structuredClone(e)); } catch {}
    return e;
  }

  const view = (id) => (incidents.has(id) ? structuredClone(incidents.get(id)) : null);
  const need = (id) => { const i = incidents.get(id); if (!i) throw err('E_NOT_FOUND', `no incident ${id}`); return i; };
  const live = (id) => { const i = need(id); if (i.state === 'resolved') throw err('E_ILLEGAL_TRANSITION', `incident ${id} is resolved`); return i; };
  const op = (fn) => serial(async () => { await init(); return fn(); });

  const findOpen = (key) => [...incidents.values()].find((i) => i.dedup_key === key && i.state !== 'resolved');

  const transition = (kind, fn = (x) => x) => (id, detail = {}) => op(async () => {
    live(id); await append(id, kind, fn(detail)); return view(id);
  });
  const cleanDetail = (d) => ({ ...d, reason: d.reason ? sanitizeText(d.reason) : undefined, action: d.action ? sanitizeText(d.action, 100) : undefined, by: d.by ? sanitizeText(d.by, 100) : undefined });

  return {
    file, init,
    // One incident per dedup_key while open: a repeat report is linked, never a second incident (T36).
    report(r) {
      return op(async () => {
        if (!INCIDENT_TYPES.includes(r?.type)) throw err('E_INVALID', 'unknown incident type');
        if (!SEG.test(String(r.host_id ?? ''))) throw err('E_INVALID', 'host_id required (plain id)');
        if (r.service_id != null && !SEG.test(String(r.service_id))) throw err('E_INVALID', 'invalid service_id');
        const priority = r.priority ?? (['host.disk_pressure', 'service.crash_loop'].includes(r.type) ? 'high' : 'normal');
        if (!PRIORITIES.includes(priority)) throw err('E_INVALID', 'invalid priority');
        const dedup_key = sanitizeText(r.dedup_key || `${r.type}:${r.host_id}:${r.service_id ?? '-'}`, 200);
        const reporter = normalizeReporter(r.reporter);
        const measurements = sanitizeMeasurements(r.measurements);
        const open = findOpen(dedup_key);
        if (open) {
          await append(open.incident_id, 'incident.report_linked', { reporter: { ...reporter, ts: now() }, measurements });
          return { incident: view(open.incident_id), deduped: true };
        }
        const incident_id = `inc-${randomId()}`;
        await append(incident_id, 'incident.opened', {
          dedup_key, reporters: [{ ...reporter, ts: now() }], host_id: String(r.host_id), service_id: r.service_id == null ? null : String(r.service_id),
          type: r.type, symptom: sanitizeText(r.symptom), measurements, priority, evidence_refs: sanList(r.evidence_refs),
          workload_impact: sanitizeText(r.workload_impact), candidate_remediation: sanitizeText(r.candidate_remediation),
          requested_owner_action: sanitizeText(r.requested_owner_action),
        });
        return { incident: view(incident_id), deduped: false };
      });
    },
    acknowledge: transition('incident.acknowledged', cleanDetail),
    requestMitigation: transition('incident.mitigation_requested', cleanDetail),
    approvalRequired: transition('incident.approval_required', cleanDetail),
    reconciling: transition('incident.reconciling', cleanDetail),
    recordAction: transition('incident.action_recorded', (d) => ({
      ...d, action: sanitizeText(d.action, 100), error: d.error ? sanitizeText(d.error) : undefined,
      before: sanitizeMeasurements(d.before), after: sanitizeMeasurements(d.after),
    })),
    escalate: transition('incident.escalated', cleanDetail),
    markUnknown: transition('incident.unknown', (d) => ({ ...cleanDetail(d), readings: sanitizeMeasurements(d.readings) })),
    resolve: transition('incident.resolved', (d) => ({ ...cleanDetail(d), measurements: sanitizeMeasurements(d.measurements) })),
    get: (id) => op(() => view(id)),
    findOpenByKey: (key) => op(() => { const i = findOpen(key); return i ? view(i.incident_id) : null; }),
    list: ({ state, open, host_id } = {}) => op(() => [...incidents.values()]
      .filter((i) => (state ? i.state === state : true) && (open ? i.state !== 'resolved' : true) && (host_id ? i.host_id === host_id : true))
      .map((i) => structuredClone(i))),
    events: () => op(() => structuredClone(events)),
  };
}
