// "Decided for you" view: pure HTML builders for GET /api/manager/decided (items newest first, grouped by hour). No DOM, no fetch.
// A merge / push / deploy item has a Revert (or Roll back) button that needs a second tap; every other item has Correct, which
// opens the session card with a draft in its input (nothing is sent).
import { icon } from './icons.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const p2 = (n) => String(n).padStart(2, '0');
export const SENDS = ['merge', 'push', 'deploy'];   // kinds whose button sends the revert text (after a second tap)
export const KIND_LABEL = { merge: 'merge', push: 'push', deploy: 'deploy', menu: 'menu pick', continue: 'continue', ai_reply: 'AI reply', info: 'information' };

// local "2026-10-14 09:00" bucket of an ISO time
export function hourKey(at) {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return 'unknown time';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:00`;
}
export const timeOf = (at) => { const d = new Date(at); return Number.isFinite(d.getTime()) ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : ''; };

// items (newest first) -> [{ label, items }] in the same order
export function groupByHour(items) {
  const out = [];
  for (const it of items || []) {
    const k = hourKey(it.at);
    const last = out[out.length - 1];
    if (last && last.label === k) last.items.push(it); else out.push({ label: k, items: [it] });
  }
  return out;
}

// armed: the id of the item whose button waits for the second tap
export function itemHtml(it, armed = null) {
  const sends = SENDS.includes(it.kind);
  const isArmed = armed === it.id;
  const btn = it.revert
    ? `<button class="sbtn dv-act${sends ? ' danger' : ''}${isArmed ? ' armed' : ''}" data-dv-act="${esc(it.id)}">${isArmed ? 'Tap again to confirm' : esc(it.revert.label)}</button>`
    : '';
  const ev = (it.evidence || []).length ? `<ul class="dv-ev">${it.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '';
  return `<li class="dv-item dv-${esc(it.kind)}"><div class="dv-top"><span class="dv-time">${esc(timeOf(it.at))}</span><span class="hs-badge dv-kind">${esc(KIND_LABEL[it.kind] || it.kind)}</span>`
    + `<a class="dv-sess" href="${esc(it.url || '#')}" data-dv-open="${esc(it.session)}">${icon('chevron-right', 12)}${esc(it.session)}</a></div>`
    + `<div class="dv-what">${esc(it.what)}</div><div class="dv-why">${esc(it.why)}</div>${ev}<div class="dv-foot">${btn}</div></li>`;
}

export function viewHtml(data, armed = null) {
  const items = data?.items || [];
  const sum = data?.summary?.text ? `<p class="dv-sum">${icon('check-check', 14)} ${esc(data.summary.text)}</p>` : '';
  if (!items.length) return `${sum}<div class="sheet-empty">Nothing was decided for you in this period.</div>`;
  return sum + groupByHour(items).map((g) => `<h4 class="hs-h dv-hour">${esc(g.label)}</h4><ul class="dv-list">${g.items.map((i) => itemHtml(i, armed)).join('')}</ul>`).join('');
}

export const HOURS = [1, 24, 168];
export const hoursHtml = (cur) => `<div class="hs-filters">${HOURS.map((h) => `<button class="sbtn${h === cur ? ' on' : ''}" data-dv-hours="${h}">${h === 1 ? 'last hour' : h === 24 ? 'last 24 h' : 'last 7 days'}</button>`).join('')}</div>`;
