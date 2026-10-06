// Handoff objects (TASK-58 C3). A hand-off is one agent session owing a resource to a second session, optionally
// by a local-time HH:MM deadline. Stored as a JSON array on disk so they survive a restart; rows can be created
// from a STATUS line at stop time, marked done when the "from" session releases the lease, or when the "to" session
// actually holds it. Rows that cross their due time once become overdue and fire exactly one handoff:overdue feed event.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { agentSession, normName } from './public/platforms.js';

const ARROW_RE = /^(.+?)\s*(?:->|\u2192)\s*(.+?)(?:\s+by\s+(\d{1,2}:\d{2}))?\s*$/;

export function parseHandoff(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(ARROW_RE);
  if (!m) return null;
  const resource = m[1].trim();
  const to = m[2].trim();
  const dueHM = m[3] ? m[3] : null;
  if (!resource || !to) return null;
  return { resource, to, dueHM };
}

// Local-time HH:MM today. If that point is already more than 6 h in the past, push to tomorrow.
export function dueFromHM(hm, nowMs) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  const d = new Date(nowMs);
  d.setHours(h, min, 0, 0);
  if (nowMs - d.getTime() > 6 * 3600 * 1000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const newId = () => randomBytes(8).toString('hex');
const ciEq = (a, b) => normName(a) === normName(b);

function matchesResource(row, env, resources) {
  if (!env || !row.resource) return false;
  const have = `${env}/${resources.join(',')}`.toLowerCase();
  const want = String(row.resource).toLowerCase();
  if (!want) return false;
  if (have.includes(want) || want.includes(have)) return true;
  const res = resources.find((r) => r && r !== '*');
  if (res) {
    const resNoH = res.replace(/^(vpt-|host-)/, '').toLowerCase();
    if (resNoH && (resNoH.includes(want) || want.includes(resNoH))) return true;
    const envShort = env.replace(/^vpt-/, '').toLowerCase();
    if (envShort && (envShort.includes(want) || want.includes(envShort))) return true;
  }
  if (env && env.toLowerCase().includes(want)) return true;
  return false;
}

export function createHandoffs({ file, now = Date.now, record = async () => {}, log = console, machines = null } = {}) {
  let rows = [];
  let loadErr = null;
  async function load() {
    try { rows = JSON.parse(await readFile(file, 'utf8')); if (!Array.isArray(rows)) rows = []; }
    catch (e) { loadErr = e; rows = []; }
  }
  async function save() {
    try {
      await mkdir(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
      await writeFile(tmp, JSON.stringify(rows));
      await rename(tmp, file);
    } catch (e) { log.error?.('[handoffs] save', e.message); }
  }

  function isDone(r) { return r.state === 'done'; }
  function findOpen(from, to, resource) {
    for (const r of rows) {
      if (isDone(r)) continue;
      if (!ciEq(r.from, from)) continue;
      if (!ciEq(r.to, to)) continue;
      if (!ciEq(r.resource, resource)) continue;
      return r;
    }
    return null;
  }

  return {
    async load() { await load(); },
    state: () => ({ rows, loadErr: loadErr ? loadErr.message : null }),
    async create({ resource, from, to, due }) {
      const t = now();
      const existing = findOpen(from, to, resource);
      if (existing) {
        if (due != null && existing.due !== due) { existing.due = due; await save(); }
        return existing;
      }
      const row = { id: newId(), resource, from, to, due: due == null ? null : due, state: 'open', createdAt: t };
      rows.push(row); await save(); return row;
    },
    async fromStop(session, text, at) {
      const p = parseHandoff(text);
      if (!p) return null;
      const due = p.dueHM ? dueFromHM(p.dueHM, at || now()) : null;
      return this.create({ resource: p.resource, from: session, to: p.to, due });
    },
    list({ state, session } = {}) {
      return rows.filter((r) => {
        if (state && r.state !== state) return false;
        if (session && r.from !== session && r.to !== session) return false;
        return true;
      });
    },
    forSession(name) {
      return rows.filter((r) => r.state !== 'done' && (r.from === name || r.to === name));
    },
    async done(id, by) {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      r.state = 'done'; r.doneAt = now(); r.doneBy = by || 'manual';
      await save(); return r;
    },
    async onLeaseEvent(ev) {
      if (!ev || !ev.agent) return;
      const env = ev.env || '';
      const resources = ev.resources || [];
      const eventKey = ev.key || '';
      let changed = false;
      for (const r of rows) {
        if (isDone(r)) continue;
        const fromMatch = machines
          ? agentSession(ev.agent, [r.from], machines) === r.from
          : ciEq(ev.agent, r.from) || ciEq(ev.agent, `codebox:${r.from}`);
        if (!fromMatch) continue;
        if (!matchesResource(r, env, resources)) continue;
        r.state = 'done'; r.doneAt = now(); r.doneBy = `lease:${eventKey || 'event'}`;
        changed = true;
      }
      if (changed) await save();
    },
    async onHolders(holders) {
      if (!Array.isArray(holders)) return;
      let changed = false;
      for (const r of rows) {
        if (isDone(r)) continue;
        for (const h of holders) {
          if (h.session !== r.to) continue;
          const env = h.env || '';
          const resources = h.resources || [];
          if (!matchesResource(r, env, resources)) continue;
          r.state = 'done'; r.doneAt = now(); r.doneBy = 'claimed';
          changed = true; break;
        }
      }
      if (changed) await save();
    },
    async tick() {
      const t = now();
      let changed = false;
      for (const r of rows) {
        if (r.state !== 'open') continue;
        if (r.due == null) continue;
        if (r.due >= t) continue;
        r.state = 'overdue';
        r.overdueAt = t;
        changed = true;
        const hm = new Date(r.due).toTimeString().slice(0, 5);
        await record({
          key: 'handoff:overdue',
          title: `handoff overdue: ${r.resource} ${r.from} -> ${r.to}`,
          body: `${r.from} owes ${r.resource} to ${r.to}, due ${hm}`,
          url: '/',
          priority: 'default',
          at: new Date(t).toISOString(),
          handoffId: r.id,
          session: r.from,
        });
      }
      if (changed) await save();
    },
  };
}