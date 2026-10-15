// Owner round-trip ledger (round 9, item 9): one record per stop that reached the owner or was answered for the owner, written when
// the stop RESOLVES, so waits can be measured for every session and machine. File: <state>/owner-roundtrips.jsonl.
//   { id, session, machine, at (stop time), answered_at, wait_s, class (the stall case), by (owner | manager | owner-voice | remote-hook),
//     via (where the answer came from: dashboard | voice | pane | tmux | hook | mac | none), resolution (answered | superseded | moved_on | removed) }
// History: nothing in this repository ever wrote this file (the old writer was an out-of-tree helper that stopped on 2026-10-09,
// HARNESS-REVIEW-2026-10-14 finding 10); manager.js now writes it in-process, so it cannot silently stop while the service runs.
import { appendFile, readFile } from 'node:fs/promises';

export const FILE_NAME = 'owner-roundtrips.jsonl';
export const BY = ['owner', 'manager', 'owner-voice', 'remote-hook'];
const iso = (ms) => new Date(ms).toISOString();
const ms = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return v; const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

// -> the record to append, or null when the stop never mattered to the owner (plain finished turn, background work).
export function roundtripRecord({ id, session, machine = 'local', at, answeredAt, cls, by, via, resolution, reachedOwner }) {
  if (!id || !session || !reachedOwner) return null;
  const a = ms(at), b = ms(answeredAt);
  if (a == null) return null;
  const end = b != null && b >= a ? b : a;
  return { id, session, machine: machine || 'local', at: iso(a), answered_at: iso(end), wait_s: Math.round((end - a) / 1000), class: cls || 'unknown', by: BY.includes(by) ? by : 'owner', via: via || 'none', resolution: resolution || 'answered' };
}

export function createRoundtrips({ file }) {
  let chain = Promise.resolve();
  return {
    file,
    record(rec) {
      if (!rec) return Promise.resolve(false);
      chain = chain.then(() => appendFile(file, `${JSON.stringify(rec)}\n`)).then(() => true, (e) => { console.error('[roundtrips] write', e.message); return false; });
      return chain;
    },
    async read({ sinceMs = 0 } = {}) {
      let txt = '';
      try { txt = await readFile(file, 'utf8'); } catch { return []; }
      return txt.split('\n').flatMap((l) => { try { const r = l ? JSON.parse(l) : null; return r && ms(r.at) >= sinceMs ? [r] : []; } catch { return []; } });
    },
  };
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const mins = (s) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

// Waits the OWNER caused: only stops the owner answered (by owner / owner-voice) count towards "owner waits".
export function summarizeRoundtrips(recs = [], { hours = 24 } = {}) {
  const owned = recs.filter((r) => (r.by === 'owner' || r.by === 'owner-voice') && r.resolution === 'answered' && Number.isFinite(r.wait_s));
  const classes = {};
  for (const r of owned) (classes[r.class || 'unknown'] ||= []).push(r.wait_s);
  const byClass = Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, { n: v.length, median_s: Math.round(median(v)), mean_s: Math.round(mean(v)) }]));
  const all = owned.map((r) => r.wait_s);
  const byWho = {};
  for (const r of recs) byWho[r.by] = (byWho[r.by] || 0) + 1;
  const med = median(all), avg = mean(all);
  const win = hours === 24 ? 'today' : `in the last ${hours} hours`;
  let text = null;
  if (all.length) {
    const top = Object.entries(byClass).sort((a, b) => b[1].n - a[1].n).slice(0, 3).map(([k, v]) => `${k.replace(/_/g, ' ')} ${mins(v.median_s)} x${v.n}`);
    text = `owner waits ${win}: median ${mins(med)}, mean ${mins(avg)} over ${all.length} ${all.length === 1 ? 'stop' : 'stops'}${top.length > 1 ? ` (${top.join('; ')})` : ''}`;
  }
  return { count: recs.length, owner_stops: all.length, median_s: med == null ? null : Math.round(med), mean_s: avg == null ? null : Math.round(avg), byClass, byWho, text };
}
