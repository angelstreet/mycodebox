// History view: pure helpers and HTML builders for GET /api/history (one row per session instance, newest first).
// No DOM, no fetch: the formatting rules are unit-tested. Unknown stays unknown: a missing cost is "unknown", never $0;
// a subscription session shows "subscription" (per-token cost is not meaningful there).
import { icon } from './icons.js';
import { fmtTok, fmtUsd } from './usage.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const PAGE = 50;
export const STARTED_BY = ['dashboard', 'cbsession', 'v2', 'manager', 'unknown'];
export const PROVIDERS = ['claude', 'codex', 'minimax', 'opencode'];
const p2 = (n) => String(n).padStart(2, '0');

// 90061000 -> "1d 1h"; 3725000 -> "1h 2m"; 125000 -> "2m 5s"; 4000 -> "4s"; null -> "—"
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${p2(s % 60)}s`.replace(' 0', ' ');
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
// local "2026-10-14 09:30"; null -> "—"
export function fmtWhen(ts) {
  if (ts == null || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
// tokens {input,output,cache_read,cache_write} | null -> "in 1.2k · out 300 · cache 5k"; null (no turns seen) -> "—"
export function fmtTokens(t) {
  if (!t) return '—';
  return `in ${fmtTok(t.input)} · out ${fmtTok(t.output)} · cache ${fmtTok((t.cache_read || 0) + (t.cache_write || 0))}`;
}
// -> { text, cls }: subscription | unknown | $x.xx
export function fmtCost(row) {
  if (row.billing === 'subscription') return { text: 'subscription', cls: 'sub' };
  if (row.cost_usd == null || !Number.isFinite(row.cost_usd)) return { text: 'unknown', cls: 'unk' };
  return { text: fmtUsd(row.cost_usd), cls: '' };
}
export const fmtModel = (r) => [r.provider, r.model].filter(Boolean).join(' / ') || 'unknown';

// filters {provider, model, started_by, from, to (YYYY-MM-DD, local), status} -> query string for /api/history
export function buildQuery(f, offset = 0, limit = PAGE) {
  const q = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  for (const k of ['provider', 'model', 'started_by', 'status']) if (f[k]) q.set(k, f[k]);
  const day = (s, end) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3], end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0).getTime() : null; };
  const from = day(f.from, false), to = day(f.to, true);
  if (from != null) q.set('from', String(from));
  if (to != null) q.set('to', String(to));
  return q.toString();
}

// path-like -> <code>; otherwise the short text. Never a link: there is no route for viewing these files.
const refHtml = (label, v) => (v ? `<span class="hs-ref"><span class="hs-k">${label}</span> <code>${esc(v)}</code></span>` : '');

export function filtersHtml(f, seen = {}) {
  const opts = (vals, cur) => ['<option value="">all</option>', ...[...new Set([...vals, cur].filter(Boolean))].map((v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`)].join('');
  const sel = (k, label, vals) => `<label class="hs-f">${label}<select data-hs-f="${k}">${opts(vals, f[k])}</select></label>`;
  return `<div class="hs-filters">${sel('provider', 'provider', [...PROVIDERS, ...(seen.provider || [])])}${sel('model', 'model', seen.model || [])}${sel('started_by', 'started by', STARTED_BY)}`
    + `<label class="hs-f">status<select data-hs-f="status"><option value="">all</option><option value="running"${f.status === 'running' ? ' selected' : ''}>running</option><option value="ended"${f.status === 'ended' ? ' selected' : ''}>ended</option></select></label>`
    + `<label class="hs-f">from<input type="date" data-hs-f="from" value="${esc(f.from || '')}"></label><label class="hs-f">to<input type="date" data-hs-f="to" value="${esc(f.to || '')}"></label>`
    + `<button class="sbtn" data-hs-clear>clear</button></div>`;
}

export function rowHtml(r, i) {
  const run = r.end == null, c = fmtCost(r);
  return `<button class="hs-row${run ? ' running' : ''}" data-hs-i="${i}" aria-label="${esc(`${r.name}, ${run ? 'running' : 'ended'}`)}">`
    + `<span class="hs-c hs-name"><b>${esc(r.name)}</b><span class="hs-badge ${run ? 'run' : 'end'}">${run ? 'running' : 'ended'}</span></span>`
    + `<span class="hs-c hs-model">${esc(fmtModel(r))}</span><span class="hs-c hs-by"><span class="hs-k">by</span> ${esc(r.started_by || 'unknown')}</span>`
    + `<span class="hs-c hs-start"><span class="hs-k">start</span> ${esc(fmtWhen(r.start))}</span><span class="hs-c hs-end"><span class="hs-k">end</span> ${run ? 'running' : esc(fmtWhen(r.end))}</span>`
    + `<span class="hs-c hs-el"><span class="hs-k">elapsed</span> ${esc(fmtDuration(r.elapsed_ms))}</span><span class="hs-c hs-act"><span class="hs-k">active</span> ${esc(fmtDuration(r.active_ms))}</span>`
    + `<span class="hs-c hs-turns"><span class="hs-k">turns</span> ${r.turns ?? 0}</span><span class="hs-c hs-tok">${esc(fmtTokens(r.tokens))}</span>`
    + `<span class="hs-c hs-cost ${c.cls}">${esc(c.text)}</span>`
    + `<span class="hs-c hs-refs">${refHtml('prompt', r.prompt_ref)}${refHtml('handover', r.handover_ref)}</span></button>`;
}

export function headHtml() {
  return '<div class="hs-head" aria-hidden="true"><span>session</span><span>model</span><span>by</span><span>start</span><span>end</span><span>elapsed</span><span>active</span><span>turns</span><span>tokens</span><span>cost</span></div>';
}

export function listHtml(rows, total) {
  if (!rows.length) return '<div class="sheet-empty">No sessions match.</div>';
  return `<div class="hs-list">${headHtml()}${rows.map(rowHtml).join('')}</div>`
    + `<div class="hs-more">${rows.length} of ${total}${rows.length < total ? ' <button class="sbtn" data-hs-more>load more</button>' : ''}</div>`;
}

export function detailHtml(r) {
  const run = r.end == null, c = fmtCost(r);
  const kv = (k, v) => `<div class="hs-kv"><span class="hs-k">${k}</span><span>${v}</span></div>`;
  const days = (r.days || []).length
    ? `<table class="hs-days"><thead><tr><th>day</th><th>turns</th><th>tokens</th><th>cost</th></tr></thead><tbody>${r.days.map((d) => `<tr><td>${esc(d.day)}</td><td>${d.turns}</td><td>${esc(fmtTok(d.tokens))}</td><td>${esc(fmtCost({ billing: r.billing, cost_usd: d.cost_usd }).text)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="sheet-empty">No usage recorded for this session.</div>';
  return `<div class="hs-detail"><div class="hs-dtitle"><b>${esc(r.name)}</b><span class="hs-badge ${run ? 'run' : 'end'}">${run ? 'running' : 'ended'}</span></div>`
    + kv('provider / model', esc(fmtModel(r))) + kv('started by', esc(r.started_by || 'unknown')) + kv('start', esc(fmtWhen(r.start))) + kv('end', run ? 'running' : esc(fmtWhen(r.end)))
    + kv('elapsed', esc(fmtDuration(r.elapsed_ms))) + kv('active', esc(fmtDuration(r.active_ms))) + kv('turns', String(r.turns ?? 0)) + kv('tokens', esc(fmtTokens(r.tokens)))
    + kv('cost', `<span class="hs-cost ${c.cls}">${esc(c.text)}</span>`) + (r.cwd ? kv('folder', `<code>${esc(r.cwd)}</code>`) : '')
    + (r.prompt_ref ? kv('prompt', `<code>${esc(r.prompt_ref)}</code>`) : '') + (r.handover_ref ? kv('handover', `<code>${esc(r.handover_ref)}</code>`) : '')
    + (r.remote_control_url ? kv('remote control', `<code>${esc(r.remote_control_url)}</code>`) : '')
    + `<h4 class="hs-h">${icon('history', 12)} usage per day</h4>${days}</div>`;
}
