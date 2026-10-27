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

export const DEFAULT_RESTART_UNITS = ['vpt-monitor-img', 'vpt-host', 'vpt-stream*', 'vpt-grabber*'];

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

// view: lease-source view(); -> { text, covered, units, hosts } | null when the text is not a routine restart.
// A restart of a unit on a leased host needs an exclusive lease of this session that covers that host (a host-kind lease, or an
// env-wide one that names it); without one the answer is "claim the host lease first".
export function answerRoutineRestart({ text, view, session = '' } = {}) {
  const r = routineRestart(text);
  if (!r.routine) return null;
  const hosts = hostsNamed(text);
  const own = (view?.ok ? view.leases || [] : []).filter((l) => l.mode === 'exclusive' && mine(l, session));
  const covers = (l, h) => (l.resources || []).some((x) => x === '*' || String(x).toLowerCase().includes(h) || h.includes(String(x).toLowerCase()));
  const covered = view?.ok && own.length > 0 && (hosts.length ? hosts.every((h) => own.some((l) => covers(l, h))) : true);
  if (covered) return { text: 'Yes, go ahead: this is a routine restart of a device-side service on a host you lease. Release or keep your lease as usual.', covered: true, units: r.units, hosts };
  const why = view?.ok ? 'You do not hold a lease that covers that host.' : 'The lease source is unreachable, so treat the host as busy.';
  return { text: `${why} ${RESTART_LEASE_RULE}`, covered: false, units: r.units, hosts };
}
