// Leases view (round 10 design section 6): pure HTML builders for GET /api/leases/view. No DOM, no fetch (unit tested).
// Per env: held leases (resource, mode, holder with a session link, purpose, since, TTL left, last heartbeat, idle), the ticket queue
// (position, ETA), the deploy queue, pins that an exclusive lease overrides, and shadow disagreements (central / shadow data only).
// Owner actions exist only under the central authority: force-release and downgrade to pin, each armed by a first tap (the second tap
// is client-side, see armed). Under the legacy registry the actions are not offered.
import { icon } from './icons.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const LONG_TTL_MIN = 240;   // above this a hold is shown in amber (design section 5)
export const ACTIVE_DEPLOY = ['awaiting-approval', 'queued', 'approved', 'running'];

export function fmtMin(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  if (min < 1) return '<1m';
  if (min < 60) return `${Math.round(min)}m`;
  return `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}`;
}
export const fmtAgo = (ms, now) => (ms == null || !Number.isFinite(ms) ? '—' : `${fmtMin(Math.max(0, (now - ms) / 60000))} ago`);
export const fmtEta = (ms, now) => (ms == null || !Number.isFinite(ms) ? 'unknown' : ms <= now ? 'now' : `in ${fmtMin((ms - now) / 60000)}`);
export const resText = (l) => (l.resources || []).map((r) => (r === '*' ? `${l.env}/*` : r)).join(', ') || '*';

// two resource lists overlap when one equals, contains (host contains its devices) or is the env-wide `*` of the other
const overlap = (a, b) => (a || []).some((x) => (b || []).some((y) => x === '*' || y === '*' || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
// pins (and observers) that an exclusive lease of another agent now overlaps: { pinId -> exclusive lease }
export function pinsOverridden(leases) {
  const ex = (leases || []).filter((l) => l.mode === 'exclusive');
  const out = {};
  for (const p of (leases || []).filter((l) => l.mode === 'pin')) { const o = ex.find((e) => e.env === p.env && e.agent !== p.agent && overlap(p.resources, e.resources)); if (o) out[p.id] = o; }
  return out;
}

export function groupByEnv(data) {
  const envs = new Map();
  const get = (e) => { const k = e || '(no env)'; if (!envs.has(k)) envs.set(k, { env: k, leases: [], tickets: [], deploys: [] }); return envs.get(k); };
  for (const l of data.leases || []) get(l.env).leases.push(l);
  for (const t of data.tickets || []) get(t.env).tickets.push(t);
  for (const d of data.deploys || []) if (ACTIVE_DEPLOY.includes(d.state)) get(d.env).deploys.push(d);
  for (const e of envs.values()) { e.tickets.sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9)); }
  return [...envs.values()].sort((a, b) => a.env.localeCompare(b.env));
}

const holderHtml = (l) => (l.holderSession
  ? `<a href="/?s=${encodeURIComponent(l.holderSession)}" data-lv-open="${esc(l.holderSession)}">${esc(l.agent)}</a>`
  : esc(l.agent || '?'));

// armed: "release:<id>" | "pin:<id>" | null. First tap arms (button text turns to "tap again"), the second tap sends.
export function actionsHtml(l, armed, central) {
  if (!central || l.mode !== 'exclusive') return '';
  const btn = (act, label, ic) => `<button class="sbtn${armed === `${act}:${l.id}` ? ' danger' : ''}" data-lv-act="${act}:${esc(l.id)}">${icon(ic, 12)} ${armed === `${act}:${l.id}` ? 'tap again to confirm' : label}</button>`;
  return `<span class="lv-acts">${btn('pin', 'downgrade to pin', 'pin')}${btn('release', 'force release', 'unlock')}</span>`;
}

export function leaseRowHtml(l, { now = Date.now(), armed = null, central = false, overriddenBy = null } = {}) {
  const long = l.ttlLeftMin != null && l.ttlLeftMin > LONG_TTL_MIN, idle = l.mode === 'exclusive' && l.idleMin != null && l.idleMin >= 10;
  const kv = (k, v) => `<span class="lv-c"><span class="lv-k">${k}</span> ${v}</span>`;
  return `<div class="lv-row ${esc(l.mode)}${idle ? ' idle' : ''}" data-lv-id="${esc(l.id)}">`
    + `<span class="lv-c lv-res"><b>${icon(l.mode === 'pin' ? 'pin' : 'lock', 13)} ${esc(resText(l))}</b><span class="lv-badge ${esc(l.mode)}">${esc(l.mode)}</span></span>`
    + kv('holder', holderHtml(l)) + (l.purpose ? kv('purpose', esc(l.purpose)) : '')
    + kv('since', esc(fmtAgo(l.sinceMs, now))) + kv('ttl left', `<span${long ? ' class="lv-amber"' : ''}>${esc(fmtMin(l.ttlLeftMin))}${long ? ` ${icon('alert', 11)}` : ''}</span>`)
    + kv('heartbeat', esc(fmtAgo(l.lastHeartbeatMs, now))) + kv('idle', `<span${idle ? ' class="lv-amber"' : ''}>${l.idleMin == null ? '—' : esc(fmtMin(l.idleMin))}</span>`)
    + (overriddenBy ? `<span class="lv-c lv-over">${icon('alert', 11)} overridden by ${esc(overriddenBy.agent)} (${esc(resText(overriddenBy))})</span>` : '')
    + actionsHtml(l, armed, central) + '</div>';
}

export function ticketRowHtml(t, now = Date.now()) {
  return `<div class="lv-row ticket" data-lv-ticket="${esc(t.id)}"><span class="lv-c lv-res"><b>#${esc(t.position ?? '?')} ${esc((t.resources || []).join(', ') || '*')}</b></span>`
    + `<span class="lv-c"><span class="lv-k">waiting</span> ${esc(t.agent || '?')}</span>`
    + `<span class="lv-c"><span class="lv-k">ETA</span> ${icon('timer', 11)} ${esc(fmtEta(t.etaMs, now))}</span>`
    + ((t.holders || []).length ? `<span class="lv-c"><span class="lv-k">behind</span> ${esc(t.holders.join(', '))}</span>` : '') + '</div>';
}

export function deployRowHtml(d) {
  return `<div class="lv-row deploy"><span class="lv-c lv-res"><b>${esc(d.scope || '?')} ${esc(d.ref || '')}</b><span class="lv-badge">${esc(d.state)}</span></span><span class="lv-c"><span class="lv-k">by</span> ${esc(d.agent || '?')}</span></div>`;
}

export function shadowHtml(items) {
  if (!items || !items.length) return '';
  return `<h4 class="lv-h">${icon('alert', 12)} shadow disagreements (${items.length})</h4>`
    + items.slice(0, 20).map((r) => `<div class="lv-row shadow"><span class="lv-c lv-res"><b>${esc(r.machine || '?')}</b> <code>${esc(r.command || '')}</code></span>`
      + `<span class="lv-c"><span class="lv-k">registry</span> exit ${esc(r.legacy?.code ?? '?')}</span><span class="lv-c"><span class="lv-k">service</span> exit ${esc(r.central?.code ?? '?')}</span></div>`).join('');
}

export function viewHtml(data, { now = Date.now(), armed = null } = {}) {
  if (!data || data.ok === false) return `<div class="sheet-empty" role="alert">${esc(data?.error || 'leases unavailable')} (${esc(data?.authority || 'unknown')} authority; treated as busy)</div>`;
  const central = data.authority === 'central';
  const head = `<div class="lv-auth"><span class="lv-badge ${central ? 'central' : 'legacy'}">${central ? 'central lease service' : 'legacy registry'}</span>`
    + `${central ? '' : ' <span class="lv-k">read-only: release a lease on the registry host</span>'}</div>`;
  const envs = groupByEnv(data);
  const over = pinsOverridden(data.leases);
  if (!envs.length) return `${head}<div class="sheet-empty">No leases held, nobody waiting.</div>${shadowHtml(data.shadow)}`;
  const body = envs.map((e) => {
    const held = e.leases.filter((l) => l.mode === 'exclusive'), soft = e.leases.filter((l) => l.mode !== 'exclusive');
    return `<section class="lv-env"><h3 class="lv-h">${icon('server', 13)} ${esc(e.env)}</h3>`
      + (held.length ? held.map((l) => leaseRowHtml(l, { now, armed, central })).join('') : '<div class="sheet-empty">no exclusive lease held</div>')
      + (soft.length ? `<h4 class="lv-h">pins and observers</h4>${soft.map((l) => leaseRowHtml(l, { now, armed, central, overriddenBy: over[l.id] || null })).join('')}` : '')
      + (e.tickets.length ? `<h4 class="lv-h">${icon('timer', 12)} queue (${e.tickets.length})</h4>${e.tickets.map((t) => ticketRowHtml(t, now)).join('')}` : '')
      + (e.deploys.length ? `<h4 class="lv-h">deploy queue (${e.deploys.length})</h4>${e.deploys.map(deployRowHtml).join('')}` : '') + '</section>';
  }).join('');
  return head + body + shadowHtml(data.shadow);
}

// the two-tap rule: a tap on a button arms it, the same button tapped again fires. -> { arm, fire } ('release:<id>' | 'pin:<id>')
export function tap(armed, key) { return armed === key ? { arm: null, fire: key } : { arm: key, fire: null }; }
export function actionRequest(key) {
  const i = key.indexOf(':');
  const act = key.slice(0, i), id = key.slice(i + 1);
  if (!id) return null;
  if (act === 'release') return { url: '/api/leases/owner/release', body: { id } };
  if (act === 'pin') return { url: '/api/leases/owner/mode', body: { id, mode: 'pin' } };
  return null;
}
