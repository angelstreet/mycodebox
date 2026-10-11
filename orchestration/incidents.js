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

const HEX_ID = /^[0-9a-f]{40}$/i;   // only a git SHA-1 is exempt: 64-hex is a typical generated secret
// The input is cut to ~4x the cap BEFORE any regex so a hostile reporter cannot make the scrub superlinear (ReDoS).
export function sanitizeText(v, max = MAX_TEXT) {
  if (v == null) return '';
  // C0/C1 controls (U+009B is CSI on xterm-class terminals) and bidi overrides are stripped.
  let s = String(v).slice(0, max * 4).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]');
  s = s.replace(/(?:\/home|\/Users|\/root)(?:\/[^\s"'`;,)]*)?/g, '[path]').replace(/~\/[^\s"'`;,)]*/g, '[path]');
  s = s.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]+/gi, '$1 [redacted]');
  s = s.replace(/(--?(?:token|secret|password|passwd|api-?key))[ =]+\S+/gi, '$1 [redacted]');
  // Compound names too (REPORTER_TOKEN, access_token, VAPID_PRIVATE_KEY, NTFY_TOPIC, secret_key), and `NAME value`.
  s = s.replace(/(["']?)\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|private[_-]?key|topic|_key))(["']?)(?:\s*[=:]\s*|\s+)(["']?)[^\s"',;}]+/gi, '$1$2$3=[redacted]');
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

const MAX_REPORTERS = 50;
const str = (v, n = MAX_TEXT) => (v == null ? undefined : sanitizeText(v, n));
// Persisted transition details are a whitelist, never a spread of caller input.
const pickDetail = (d = {}) => ({
  reason: str(d.reason), action: str(d.action, 100), by: str(d.by, 100), status: str(d.status, 50), error: str(d.error),
  checkpoint: str(d.checkpoint, 200), rolled_back: typeof d.rolled_back === 'boolean' ? d.rolled_back : undefined,
  owner: d.owner === true ? true : undefined,
  before: d.before === undefined ? undefined : sanitizeMeasurements(d.before), after: d.after === undefined ? undefined : sanitizeMeasurements(d.after),
  readings: d.readings === undefined ? undefined : sanitizeMeasurements(d.readings),
  measurements: d.measurements === undefined ? undefined : sanitizeMeasurements(d.measurements),
});

// Exactly ONE process may own an incident directory (documented single-instance contract). To stay consistent across a
// restart overlap, every operation first replays whatever another instance appended since our last known offset.
export function createIncidentStore({ dir, fs = nodeFs, now = Date.now, randomId = randomUUID, onEvent = null } = {}) {
  if (!dir) throw new Error('incident store: dir required');
  const p = fs.promises || fs;
  const file = join(dir, 'incidents.jsonl');
  const incidents = new Map();
  const events = [];
  let seq = 0;
  let size = 0;                 // bytes of the log we have applied
  let ready = null;
  let dirty = false;
  let chain = Promise.resolve();
  const serial = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

  function apply(e) {
    const { incident_id: id, kind, payload: x } = e;
    if (kind === 'incident.opened') {
      incidents.set(id, { ...structuredClone(x), reporter_count: x.reporters.length, incident_id: id, state: 'open', opened_at: e.ts, updated_at: e.ts, actions: [], approvals: [], requests: [], resolution: null });
      return;
    }
    const inc = incidents.get(id);
    if (!inc || inc.state === 'resolved') return;
    inc.updated_at = e.ts;
    switch (kind) {
      case 'incident.report_linked':
        inc.reporters = [...inc.reporters, x.reporter].slice(-MAX_REPORTERS); inc.reporter_count++;
        inc.measurements = [...inc.measurements, ...x.measurements].slice(-MAX_ITEMS);
        break;
      // An owner acknowledgement is the only way out of `reconciling` (a failed rollback must not be auto-hidden).
      case 'incident.acknowledged': if (inc.state === 'open' || (inc.state === 'reconciling' && x.owner === true)) inc.state = 'acknowledged'; break;
      case 'incident.mitigation_requested': inc.state = 'mitigation_requested'; inc.requests.push({ ...x, ts: e.ts }); break;
      case 'incident.approval_required': inc.state = 'approval_required'; inc.approvals.push({ ...x, ts: e.ts, status: 'pending' }); break;
      case 'incident.reconciling': inc.state = 'reconciling'; inc.reconcile = x; break;
      case 'incident.action_recorded': inc.actions.push({ ...x, ts: e.ts }); break;
      case 'incident.escalated': inc.state = 'escalated'; inc.escalation = x; break;
      case 'incident.unknown': inc.state = 'unknown'; inc.unknown = x; break;
      case 'incident.resolved': inc.state = 'resolved'; inc.resolved_at = e.ts; inc.resolution = x; break;
      default:                    // unknown future kind: kept in the log, ignored here
    }
  }

  const shaped = (e) => e && typeof e === 'object' && typeof e.kind === 'string' && typeof e.payload === 'object' && (e.incident_id === null || typeof e.incident_id === 'string');
  const bad = (m) => Object.assign(new Error(m), { code: 'E_UNAVAILABLE' });

  // Applies complete lines of `txt` (which starts at byte offset `base`). Returns { good, torn }: only the FINAL line may
  // be torn; a bad line followed by anything else is corruption and fails closed.
  function replay(txt) {
    let good = 0; let torn = false;
    for (let off = 0; off < txt.length;) {
      const nl = txt.indexOf('\n', off);
      const last = nl < 0;
      const line = txt.slice(off, last ? txt.length : nl);
      let e = null;
      if (!last) { try { e = JSON.parse(line); } catch { e = null; } }
      if (!shaped(e)) {
        if (last || txt.slice(nl + 1).trim() === '') { torn = true; break; }
        throw bad('incident log corrupt before its final line');
      }
      events.push(e); apply(e); seq = Math.max(seq, e.seq || 0);
      off = nl + 1; good = off;
    }
    return { good, torn };
  }

  async function init() {
    return (ready ||= (async () => {
      await p.mkdir(dir, { recursive: true });
      let txt = '';
      try { txt = await p.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const { good, torn } = replay(txt);
      size = Buffer.byteLength(txt.slice(0, good));
      if (torn) {
        await p.truncate(file, size);
        await append(null, 'recovered_torn_tail', { dropped_bytes: Buffer.byteLength(txt) - size });   // meta record, not an incident event
      }
      return { torn, incidents: incidents.size };
    })().catch((e) => { ready = null; incidents.clear(); events.length = 0; seq = 0; size = 0; throw e; }));
  }

  // Replay what another writer appended since `size` (restart overlap); a torn/partial tail is left for its writer.
  async function refresh() {
    let st;
    try { st = await p.stat(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (st.size <= size) return;
    const fh = await p.open(file, 'r');
    let buf;
    try { buf = Buffer.alloc(st.size - size); await fh.read(buf, 0, buf.length, size); } finally { await fh.close(); }
    const txt = buf.toString('utf8');
    const cut = txt.lastIndexOf('\n') + 1;
    if (!cut) return;
    const { good } = replay(txt.slice(0, cut));
    size += Buffer.byteLength(txt.slice(0, good));
  }

  async function append(incident_id, kind, payload) {
    const e = { event_id: String(randomId()), incident_id, seq: seq + 1, ts: now(), kind, payload };
    const line = `${JSON.stringify(e)}\n`;
    try {
      if (dirty) { await p.truncate(file, size); dirty = false; }   // never append after a torn line from our own failed write
      const fh = await p.open(file, 'a', 0o600);
      try { await fh.writeFile(line); await fh.sync(); } finally { await fh.close(); }
    } catch (err) {
      dirty = true;                                           // a half-written line may be on disk: repaired before the next op
      throw err;
    }
    seq += 1; size += Buffer.byteLength(line);
    events.push(e); apply(e);
    try { onEvent?.(structuredClone(e)); } catch {}
    return e;
  }

  const view = (id) => (incidents.has(id) ? structuredClone(incidents.get(id)) : null);
  const need = (id) => { const i = incidents.get(id); if (!i) throw err('E_NOT_FOUND', `no incident ${id}`); return i; };
  const live = (id) => { const i = need(id); if (i.state === 'resolved') throw err('E_ILLEGAL_TRANSITION', `incident ${id} is resolved`); return i; };
  const op = (fn) => serial(async () => {
    await init();
    await refresh();
    return fn();
  });

  // Canonical key is derived here, never taken from the caller (a caller key would defeat dedup, T36).
  // Host and service ids compare case-insensitively: Host-A and host-a are one host.
  const canonicalKey = (type, host, svc) => `${type}:${String(host).toLowerCase()}:${svc == null ? '-' : String(svc).toLowerCase()}`;
  const findOpen = (key) => [...incidents.values()].find((i) => i.dedup_key === key && i.state !== 'resolved');

  const transition = (kind) => (id, detail = {}) => op(async () => {
    live(id); await append(id, kind, pickDetail(detail)); return view(id);
  });

  return {
    file, init,
    // One incident per canonical key while open: a repeat report is linked, never a second incident (T36).
    // The caller's dedup_key is kept only as a correlation key (replay = this exact correlation key was already linked).
    report(r) {
      return op(async () => {
        if (!INCIDENT_TYPES.includes(r?.type)) throw err('E_INVALID', 'unknown incident type');
        if (!SEG.test(String(r.host_id ?? ''))) throw err('E_INVALID', 'host_id required (plain id)');
        if (r.service_id != null && !SEG.test(String(r.service_id))) throw err('E_INVALID', 'invalid service_id');
        const priority = r.priority ?? (['host.disk_pressure', 'service.crash_loop'].includes(r.type) ? 'high' : 'normal');
        if (!PRIORITIES.includes(priority)) throw err('E_INVALID', 'invalid priority');
        const dedup_key = canonicalKey(r.type, r.host_id, r.service_id);
        const correlation_key = r.dedup_key ? sanitizeText(r.dedup_key, 200) : null;
        const reporter = { ...normalizeReporter(r.reporter), correlation_key, ts: now() };
        const measurements = sanitizeMeasurements(r.measurements);
        const open = findOpen(dedup_key);
        if (open) {
          const replay_ = correlation_key != null && open.reporters.some((x) => x.correlation_key === correlation_key);
          await append(open.incident_id, 'incident.report_linked', { reporter, measurements });
          return { incident: view(open.incident_id), deduped: true, replay: replay_ };
        }
        const incident_id = `inc-${randomId()}`;
        await append(incident_id, 'incident.opened', {
          dedup_key, reporters: [reporter], host_id: String(r.host_id), service_id: r.service_id == null ? null : String(r.service_id),
          type: r.type, symptom: sanitizeText(r.symptom), measurements, priority, evidence_refs: sanList(r.evidence_refs),
          workload_impact: sanitizeText(r.workload_impact), candidate_remediation: sanitizeText(r.candidate_remediation),
          requested_owner_action: sanitizeText(r.requested_owner_action),
        });
        return { incident: view(incident_id), deduped: false, replay: false };
      });
    },
    acknowledge: transition('incident.acknowledged'),
    requestMitigation: transition('incident.mitigation_requested'),
    approvalRequired: transition('incident.approval_required'),
    reconciling: transition('incident.reconciling'),
    recordAction: transition('incident.action_recorded'),
    escalate: transition('incident.escalated'),
    markUnknown: transition('incident.unknown'),
    resolve: transition('incident.resolved'),
    get: (id) => op(() => view(id)),
    findOpenByKey: (key) => op(() => { const i = findOpen(key); return i ? view(i.incident_id) : null; }),
    list: ({ state, open, host_id } = {}) => op(() => [...incidents.values()]
      .filter((i) => (state ? i.state === state : true) && (open ? i.state !== 'resolved' : true) && (host_id ? i.host_id === host_id : true))
      .map((i) => structuredClone(i))),
    events: () => op(() => structuredClone(events)),
  };
}
