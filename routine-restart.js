// A routine device-side service restart is not an owner question (owner, 2026-10-27): `systemctl restart <unit>` (optionally
// followed by `is-active` / `status` of the same unit) of an allowlisted vpt-* device / host service, run on a lab host the
// session leases. Everything else about services stays hard floor in stall.js: stop, start-only, enable, disable, mask,
// daemon-reload, unit files, sudoers, a restart of anything outside the allowlist, the ghosty-sessions service, the server unit,
// production or customer hosts.
//
// Allowlist: GHOSTY_RESTART_UNITS (comma separated globs, `*` = any characters of a unit name) replaces the default
// below; setRoutineRestartUnits(list) is the same for tests. A restart needs the HOST lease only (kind host), never the server
// or an env-wide lease; without a lease on that host the answer is "claim the host lease first".
//
// stall.js asks neutralizeRoutineRestart() first, like neutralizeRoutineHostUnit(): only the routine restart fragments are
// replaced by RESTART_OK, so the rest of the floor still reads the same text, and a disguised or extra unit stays a hit.

// owner 2026-10-31: the lab-host service families that proved routine (per-adapter BLE daemons, KPI, AV quality, archiver, timeline,
// audio, mediamtx) are answered by the manager too. NOT vpt-vnc / vpt-websockify / lircd / bluetooth / vpt-server / databases / nginx.
export const DEFAULT_RESTART_UNITS = ['vpt-monitor-img', 'vpt-host', 'vpt-stream*', 'vpt-grabber*', 'vpt-kpi', 'vpt-ble-remote@*', 'hid-remote@*',
  'vpt-avq', 'vpt-archiver', 'vpt-timeline', 'vpt-audio*', 'vpt-monitor-audio', 'vpt-mediamtx'];
// units that drive no device: a restart of these is fine beside another session's device lease on the same host
export const DEVICELESS_UNITS = ['vpt-kpi', 'vpt-avq', 'vpt-archiver', 'vpt-timeline'];

const globRe = (g) => `${String(g).trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\w.@-]*')}`;
let unitRe = null, unitGlobs = null;
export function setRoutineRestartUnits(list) {
  const g = (Array.isArray(list) ? list : String(list ?? '').split(',')).map((x) => String(x).trim()).filter((x) => /^[\w.@*-]+$/.test(x) && x !== '*');
  unitGlobs = g.length ? g : null; unitRe = null;
}
export const restartUnits = () => unitGlobs || (process.env.GHOSTY_RESTART_UNITS ? (setRoutineRestartUnits(process.env.GHOSTY_RESTART_UNITS), unitGlobs) : null) || DEFAULT_RESTART_UNITS;
const UNIT = () => { if (!unitRe) unitRe = `(?:${restartUnits().map(globRe).join('|')})`; return unitRe; };

// never routine, whatever the unit is: the product's own service, production / customer hosts, sudoers, reboots, credentials
const STILL_FLOOR = [
  /sudoers|\/etc\/sudo|visudo/i,
  /(?<!non-)\bprod(?:uction)?\b|\bcustomer|\bclient[- ]facing\b|\blive host\b/i,
  /\bghosty-sessions\b|\bghosty\b/i,
  /\breboot|\bshutdown\b|\bpower[- ]?cycle\b/i,
  /\.env\b|credential|password|passphrase|\bsecret|\btoken|bearer\b|\bapi[_ -]?key|ssh key|private key/i,
];
// a second unit riding along ("restart vpt-host and nginx", "vpt-host, ghosty-sessions") is not covered by the first one's allowance
const BENIGN = String.raw`(?:then|check(?:ing)?|verify(?:ing)?|confirm(?:ing)?|wait(?:ing)?|see|make|report|release|keep|tell|log|it|is|that|run|read|look|re-?check|continue|proceed|carry|go|come|resume|retry|re-?run|test|the\s+(?:result|status|logs?|output|lease)|i\b|we\b|if\b)`;
const MORE_UNITS = String.raw`(?!\s*(?:,|\band\b|&(?!&)|\+|\bplus\b)\s*(?!${BENIGN})\S)`;
const SERVICE_SUFFIX = String.raw`(?:\.service)?`;
const SUDO = String.raw`(?:sudo(?:\s+-\w+)*\s+)?`;
const TAIL = String.raw`(?=\s*$|\s*[\s&;|'"\`)\].,?!:>-])`;

function fragments() {
  const u = UNIT();
  return [
    // the command: [sudo -n] systemctl restart <unit>[.service] [&& systemctl is-active|status <same unit>]
    new RegExp(String.raw`${SUDO}systemctl\s+restart\s+${u}${SERVICE_SUFFIX}(?![\w.@-])(?:\s*(?:&&|;)\s*${SUDO}systemctl\s+(?:is-active|status)(?:\s+--?[\w-]+)*\s+${u}${SERVICE_SUFFIX}(?![\w.@-]))?${MORE_UNITS}`, 'gi'),
    // the prose: "I will restart vpt-monitor-img on <lab-host>"
    new RegExp(String.raw`\brestart(?:s|ed|ing)?\s+(?:the\s+)?(?:(?:systemd\s+)?(?:service|unit)\s+)?${u}${SERVICE_SUFFIX}(?![\w.@-])(?:\s+(?:service|unit))?(?:\s+on\s+(?:the\s+)?(?:lab\s+)?(?:host\s+)?[\w<>.-]+)?${MORE_UNITS}`, 'gi'),
  ];
}

const readings = (text, variants) => { const raw = String(text || ''); return [raw, ...(typeof variants === 'function' ? variants(raw) : [])]; };

// the units a text restarts in the routine form
export function routineRestarts(text) {
  const out = [];
  for (const re of fragments()) for (const m of String(text || '').matchAll(re)) {
    const unit = new RegExp(String.raw`systemctl\s+restart\s+(${UNIT()})|restart\w*\s+(?:the\s+)?(?:(?:systemd\s+)?(?:service|unit)\s+)?(${UNIT()})`, 'i').exec(m[0]);
    const name = (unit && (unit[1] || unit[2])) || '';
    if (name && !out.includes(name.toLowerCase())) out.push(name.toLowerCase());
  }
  return out;
}

// -> { routine, units, why }
export function routineRestart(text, variants) {
  const all = readings(text, variants);
  for (const t of all) for (const re of STILL_FLOOR) { const m = re.exec(t); if (m) return { routine: false, units: [], why: `still floor: "${m[0]}"` }; }
  const units = routineRestarts(all[0]);
  return units.length ? { routine: true, units, why: `routine restart of ${units.join(', ')}` } : { routine: false, units: [], why: 'no routine restart of an allowlisted unit' };
}

// The text with every routine restart fragment replaced by RESTART_OK; unchanged unless the whole text is routine.
// One still-floor word anywhere (also in a spelling variant) cancels it.
export function neutralizeRoutineRestart(text, variants) {
  const raw = String(text || '');
  if (!routineRestart(raw, variants).routine) return raw;
  let t = raw;
  for (const re of fragments()) t = t.replace(re, 'RESTART_OK');
  return t;
}

// ---- lease-awareness -------------------------------------------------------------------------------------------------
const mine = (l, session) => !!session && (l.session === session || l.session === `codebox:${session}` || String(l.agent || '').endsWith(`:${session}`) || l.agent === session);
const HOST_TOKEN = /\b(?:on\s+(?:the\s+)?(?:lab\s+)?(?:host\s+)?)([\w<>.-]+)|\bssh\s+(?:-\S+\s+)*([\w<>@.-]+)/gi;
export const hostsNamed = (text) => {
  const out = new Set();
  for (const m of String(text || '').matchAll(HOST_TOKEN)) { const h = (m[1] || m[2] || '').replace(/^.*@/, '').toLowerCase(); if (h && !/^(?:the|a|it|this|that|now|my|your|vpt-(?:monitor|host|stream|grabber))/.test(h)) out.add(h); }
  return [...out];
};

export const RESTART_LEASE_RULE = 'Claim the host lease first: `vpt-lease claim ... --kind host --wait` (or `vpt-lease run ... -- <cmd>`); a restart needs the host lease only, never the server lease. Never ask the owner about a lease.';
export const DEVICE_LEASE_RULE = (host, dev) => `Claim ${host ? `${host}/${dev}` : `the host/${dev}`} first: \`vpt-lease claim <env>/${host || '<host>'}/${dev} --kind host --wait\` (or \`vpt-lease run ... -- <cmd>\`); a restart of one device's unit needs that device's lease (or the host lease), never the server lease. Never ask the owner about a lease.`;

// Per-device unit instances (owner 2026-11-01): `<family>@<instance>` of these families only touches one device, so it needs a lease on
// that device and is blocked only by another session's lease on the SAME device. The instance suffix is usually an adapter (hci1),
// not a device id, so the device comes from a `deviceN` in the unit suffix or, failing that, from exactly one `deviceN` the asker
// names in the text ("restart hid-remote@hci1 (device5) on <lab-host>"). Any other restart is host-wide: host lease, any device lease blocks.
export const PER_DEVICE_FAMILIES = ['hid-remote', 'vpt-ble-remote', 'vpt-stream', 'vpt-grabber', 'vpt-monitor-img'];
const isInstance = (u) => { const [fam, inst] = String(u).split('@'); return !!inst && PER_DEVICE_FAMILIES.includes(fam); };
export function deviceOfRestart(text, units) {
  const named = [...new Set([...String(text || '').matchAll(/\bdevice\s?(\d+)\b/gi)].map((m) => `device${m[1]}`))];
  const ids = new Set();
  for (const u of units) { const m = /device(\d+)/i.exec(u.split('@')[1] || ''); if (m) ids.add(`device${m[1]}`); else if (named.length === 1) ids.add(named[0]); else return null; }
  return ids.size === 1 ? [...ids][0] : null;
}

// view: lease-source view(); -> { text, covered, units, hosts, device? } | null when the text is not a routine restart.
// A restart of a unit on a leased host needs an exclusive lease of this session that covers that host (a host-kind lease, or an
// env-wide one that names it); without one the answer is "claim the host lease first". A per-device unit instance (see above) needs
// the host lease or a lease on that device, and only another session's lease on the same device blocks it.
export function answerRoutineRestart({ text, view, session = '' } = {}) {
  const r = routineRestart(text);
  if (!r.routine) return null;
  const hosts = hostsNamed(text);
  const own = (view?.ok ? view.leases || [] : []).filter((l) => l.mode === 'exclusive' && mine(l, session));
  const covers = (l, h) => (l.resources || []).some((x) => x === '*' || String(x).toLowerCase().includes(h) || h.includes(String(x).toLowerCase()));
  const covered = view?.ok && own.length > 0 && (hosts.length ? hosts.every((h) => own.some((l) => covers(l, h))) : true);
  const deviceUnits = r.units.filter((u) => !DEVICELESS_UNITS.includes(u));
  // per-device: every device-touching unit is an instance of one device
  const dev = deviceUnits.length && deviceUnits.every(isInstance) ? deviceOfRestart(text, deviceUnits) : null;
  if (dev) {
    const onDev = (l, h) => (l.resources || []).some((x) => { const v = String(x).toLowerCase(); return v.endsWith(`/${dev}`) && (!h || v.includes(h)); });
    const ownDev = own.some((l) => hosts.length ? hosts.some((h) => onDev(l, h)) : onDev(l, ''));
    const other = view?.ok && (view.leases || []).find((l) => l.mode === 'exclusive' && !mine(l, session) && (hosts.length ? hosts.some((h) => onDev(l, h)) : onDev(l, '')));
    if (other) return { text: `Another session holds the lease on ${dev} (${other.id || other.agent || 'another session'}); ${deviceUnits.join(', ')} drives that device. Wait for it with \`vpt-lease claim ... --wait\`, then restart. A lease on a different device of the host does not matter. Never ask the owner about a lease.`, covered: false, units: r.units, hosts, device: dev };
    if (ownDev || covered) return { text: `Yes, go ahead: this is a routine restart of a per-device service (${dev}) and you hold the lease. Release or keep your lease as usual.`, covered: true, units: r.units, hosts, device: dev };
    const why = view?.ok ? `You hold no lease on ${dev} or its host.` : 'The lease source is unreachable, so treat the device as busy.';
    return { text: `${why} ${DEVICE_LEASE_RULE(hosts[0], dev)}`, covered: false, units: r.units, hosts, device: dev };
  }
  // a run's device lease on that host (another session) blocks a restart of a unit that touches devices
  const busy = covered && deviceUnits.length && (view.leases || []).find((l) => l.kind === 'device' && l.mode === 'exclusive' && !mine(l, session) && hosts.some((h) => covers(l, h)));
  if (busy) return { text: `A run holds a device lease on that host (${busy.id || busy.agent || 'another session'}); ${deviceUnits.join(', ')} touches devices. Wait for it with \`vpt-lease claim ... --wait\`, then restart. Never ask the owner about a lease.`, covered: false, units: r.units, hosts };
  if (covered) return { text: 'Yes, go ahead: this is a routine restart of a device-side service on a host you lease. Release or keep your lease as usual.', covered: true, units: r.units, hosts };
  const why = view?.ok ? 'You do not hold a lease that covers that host.' : 'The lease source is unreachable, so treat the host as busy.';
  return { text: `${why} ${RESTART_LEASE_RULE}`, covered: false, units: r.units, hosts };
}

// ---- hard guard (bug-486f0188) -----------------------------------------------------------------------------------------
// answerRoutineRestart() only answers a question; an agent that just runs `systemctl restart vpt-host` was never stopped, and
// it killed a kirby run under another session's vpt-pi3/device2 lease. restartBlocker() is the mechanical check used by the
// PreToolUse hook (scripts/restart-guard.js): a restart of a device-driving unit on host H is refused while any exclusive lease
// that is not the caller's covers H or one of its devices. Per-device instances (see above) are blocked by the same device only.
// No override. Not decidable (no host named, lease source unreachable) -> null: the hook lets it through, the lease rules still apply.
const leaseResources = (l) => [...(l.resources || []), l.resource, ...(l.legacy || [])].filter(Boolean).map((x) => String(x).toLowerCase());
export function restartBlocker({ text, leases, session = '' } = {}) {
  const r = routineRestart(text);
  if (!r.routine) return null;
  const units = r.units.filter((u) => !DEVICELESS_UNITS.includes(u));
  const hosts = hostsNamed(text);
  if (!units.length || !hosts.length || !Array.isArray(leases)) return null;
  const dev = units.every(isInstance) ? deviceOfRestart(text, units) : null;
  for (const l of leases) {
    if (l.mode && l.mode !== 'exclusive') continue;
    if (mine(l, session)) continue;
    const res = leaseResources(l);
    const hit = hosts.some((h) => res.some((x) => {
      if (x === h || x === '*') return true;                       // whole host (or env-wide) lease of someone else
      if (!x.startsWith(`${h}/`)) return false;                    // another host
      return dev ? x === `${h}/${dev}` : true;                     // a device of this host: any for host-wide units, the same one for instances
    }));
    if (!hit) continue;
    const exp = l.expires_at || (l.expires ? new Date(l.expires * 1000).toISOString() : 'unknown');
    return `restart-guard: not restarting ${units.join(', ')} on ${hosts.join(', ')}: lease ${l.id || '?'} held by ${l.agent || l.session || 'another session'} on ${[...new Set(res.filter((x) => hosts.some((h) => x === h || x.startsWith(`${h}/`))))].join(', ') || res.join(', ')} (expires ${exp}) would be broken by it. Wait for it: \`vpt-lease claim <env>/${dev ? `${hosts[0]}/${dev}` : hosts[0]} --kind host --wait\` (or \`vpt-lease run ... -- <cmd>\`), then restart. There is no --force.`;
  }
  return null;
}
