// Is a candidate a real equivalent? (owner/manager 2026-11-10, after a session was told to move to a host that is off the network and
// to a box with a hung IR dongle.) "Free" is not enough. A candidate is refused when
//   1. it (or its host) is on the known-broken list (data, owner/manager maintained: a device until a bug is fixed),
//   2. its host does not answer / the device is absent or not working (control path missing),
//   3. it is not registered on the same backend server as the claimant's resource (a testcase lives on one server; a host that server
//      does not list cannot run it).
// Pure; shared by the lease service (config.health) and the dashboard's nudge / done-check (<state>/lease-equivalence.json).
// Data, per env or "*":  { "known_broken": { "<host>/<deviceN>"|"<host>": "<why>" }, "servers": { "<server>": ["<host>", ...] },
//                          "hosts": { "<host>": { "up": false, "reason": "" } }, "devices": { "<host>/<deviceN>": { "present"|"working": false, "reason": "" } } }
import fs from 'node:fs';

const low = (s) => String(s || '').toLowerCase();
const hostOf = (r) => low(r).split('/')[0];

// -> reason string, or null when the candidate may be offered. from: the claimant's resource ('<host>' or '<host>/<deviceN>'), may be ''.
export function refusal(data, cand, from = '') {
  if (!data || typeof data !== 'object') return null;
  const c = low(cand), h = hostOf(c);
  const kb = data.known_broken || {};
  for (const k of [c, h]) { const why = kb[k] ?? Object.entries(kb).find(([x]) => low(x) === k)?.[1]; if (why != null) return `known broken: ${why || 'on the known-broken list'}`; }
  const hv = data.hosts?.[h];
  if (hv && hv.up === false) return hv.reason || `host ${h} does not answer`;
  const dv = data.devices?.[c];
  if (dv && (dv.present === false || dv.working === false)) return dv.reason || `device ${c} is ${dv.present === false ? 'not present' : 'not working'}`;
  const servers = data.servers && typeof data.servers === 'object' ? Object.entries(data.servers).map(([n, hs]) => [n, (Array.isArray(hs) ? hs : []).map(low)]) : [];
  if (servers.length && from) {
    const of = (x) => servers.filter(([, hs]) => hs.includes(x)).map(([n]) => n);
    const mine = of(hostOf(from)), theirs = of(h);
    if (mine.length && !theirs.some((n) => mine.includes(n))) return theirs.length ? `registered on ${theirs.join(',')}, not on ${mine.join(',')} where ${hostOf(from)} is` : `host ${h} is registered on no backend server (${mine.join(',')} lists ${hostOf(from)})`;
  }
  return null;
}

// Merge the env's data with "*" (env wins per key).
export function envData(file, env) {
  const out = { known_broken: {}, servers: {}, hosts: {}, devices: {} };
  for (const e of [file?.['*'], file?.[low(env)]]) {
    if (!e || typeof e !== 'object') continue;
    for (const k of Object.keys(out)) if (e[k] && typeof e[k] === 'object') Object.assign(out[k], e[k]);
  }
  return out;
}

// Reads <file> again when its mtime/size changes; missing or broken = no data. -> (env) => envData
export function equivalenceReader(file, log = console) {
  let key = null, val = {};
  return (env) => {
    let st; try { st = fs.statSync(file); } catch { key = null; val = {}; return envData(val, env); }
    const k = `${st.mtimeMs}:${st.size}`;
    if (k !== key) { key = k; try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); val = j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (e) { log.error?.(`[lease] equivalence ${file}: ${e.message}`); val = {}; } }
    return envData(val, env);
  };
}

// Split a ticket's offered equivalents (legacy names) into those that stay and those refused with a reason.
export function filterTicket(t, data) {
  const from = (t.resources || [])[0] || '';
  const ok = [], refused = [...(t.equivalentsRefused || [])];
  for (const e of t.equivalents || []) { const why = refusal(data, e, from); if (why) refused.push({ resource: e, reason: why }); else ok.push(e); }
  return { ...t, equivalents: ok, equivalentsRefused: refused };
}
// view (lease-source) -> the same view with every ticket filtered. dataOf(env) -> envData.
export function applyEquivalence(view, dataOf) {
  if (!view?.ok || !Array.isArray(view.tickets)) return view;
  return { ...view, tickets: view.tickets.map((t) => filterTicket(t, dataOf(t.env))) };
}
