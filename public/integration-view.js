// Integration view (round 13, brief B): pure HTML builders for GET /api/integration/requests. No DOM, no fetch (unit tested).
// Per repo: the queue (position, branch, session, requested deploy), the running request with its current step and live output tail, recent
// results (state, sha, deploy version, reason). A queued request can be cancelled; the button is armed by a first tap (second tap in app.js).
// request (lane): { id, repo, branch, target, session, deployScope, deployed { id, version, env, scope }, state, sha, reason,
//                    endedAt ISO (final), createdAt/startedAt/updatedAt ISO, live { step, tail } while running, tail (final) };
// the helpers below call `normRequest` so HTML builders see `deploy`, `version`, `env`, `finishedAt`, numeric timestamps and the live tail.
import { icon } from './icons.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const FINAL = ['merged', 'deployed', 'returned', 'merged_ci_red', 'merged_ci_superseded', 'deploy_failed', 'cancelled'];
export const LABEL = { queued: 'queued', running: 'running', merged: 'merged', deployed: 'deployed', returned: 'returned', merged_ci_red: 'merged, CI red', merged_ci_superseded: 'merged, CI superseded', deploy_failed: 'merged, deploy failed', cancelled: 'cancelled' };
const BAD = ['returned', 'merged_ci_red', 'deploy_failed'];   // a superseded run is not a failure: nothing to fix
const TAIL_LINES = 12;
const toMs = (s) => { const n = Date.parse(String(s || '')); return Number.isFinite(n) ? n : null; };

export function fmtMin(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  if (min < 1) return '<1m';
  if (min < 60) return `${Math.round(min)}m`;
  return `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}`;
}
export const fmtAgo = (ms, now) => (ms == null || !Number.isFinite(Number(ms)) ? '—' : `${fmtMin(Math.max(0, (now - Number(ms)) / 60000))} ago`);
const sha12 = (s) => String(s || '').slice(0, 12);
// Duplicated from integration-notify.js (the browser cannot import Node modules): keep in sync.
export function normRequest(r) {
  if (!r || typeof r !== 'object') return r;
  const out = { ...r };
  if (out.deploy == null) out.deploy = out.deployScope ?? null;
  if (out.version == null) out.version = out.deployed?.version ?? null;
  if (out.env == null) out.env = out.deployed?.env ?? null;
  // finishedAt: number (ms) when endedAt is set, otherwise null — the view / own-jobs read it as a number or null.
  out.finishedAt = out.finishedAt == null ? (out.endedAt ? toMs(out.endedAt) : null) : out.finishedAt;
  for (const k of ['createdAt', 'startedAt', 'updatedAt']) {
    if (typeof out[k] === 'string') out[k] = toMs(out[k]);
  }
  if (out.state === 'running' && out.live && typeof out.live.tail === 'string') out.tail = out.live.tail;
  return out;
}
export const deployScope = (r) => (r.deploy && typeof r.deploy === 'object' ? r.deploy.scope : r.deploy) || null;
export const rowsOf = (data) => (Array.isArray(data) ? data : Array.isArray(data?.requests) ? data.requests : []);

// the live output tail: the request's own, else the current (last) step's; the last lines only
export function tailOf(r) {
  const t = r.tail ?? [...(r.steps || [])].reverse().find((s) => s.tail)?.tail ?? '';
  return (Array.isArray(t) ? t.join('\n') : String(t)).split('\n').slice(-TAIL_LINES).join('\n').slice(-1500);
}
export function stepOf(r) {
  if (r.step) return typeof r.step === 'object' ? r.step.name : r.step;
  const open = (r.steps || []).filter((s) => s.startedAt != null && s.endedAt == null || s.start != null && s.end == null);
  return (open[open.length - 1] || (r.steps || [])[(r.steps || []).length - 1])?.name || null;
}

export function groupByRepo(requests) {
  const repos = new Map();
  for (const raw of requests) {
    const r = normRequest(raw);   // normalise once so the sort sees numeric timestamps and the row builders see deploy / version / env
    const k = r.repo || '(unknown repo)';
    if (!repos.has(k)) repos.set(k, { repo: k, queue: [], running: [], results: [] });
    const g = repos.get(k);
    if (r.state === 'queued') g.queue.push(r); else if (r.state === 'running') g.running.push(r); else if (FINAL.includes(r.state)) g.results.push(r);
  }
  for (const g of repos.values()) {
    g.queue.sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
    g.results.sort((a, b) => (b.finishedAt ?? b.updatedAt ?? 0) - (a.finishedAt ?? a.updatedAt ?? 0));
  }
  return [...repos.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

const sessionHtml = (s) => (s ? `<a href="/?s=${encodeURIComponent(s)}" data-iv-open="${esc(s)}">${esc(s)}</a>` : '<span class="lv-k">no session</span>');
const kv = (k, v) => `<span class="lv-c"><span class="lv-k">${k}</span> ${v}</span>`;
// The lane never sets `commitUrl` (the view used to render it as a link); keep the field but render only the label.
const shaHtml = (r) => r.sha ? `<code>${esc(sha12(r.sha))}</code>` : '';

// armed: the request id whose cancel button was tapped once
export function cancelHtml(r, armed) {
  if (r.state !== 'queued') return '';
  const on = armed === r.id;
  return `<span class="lv-acts"><button class="sbtn${on ? ' danger' : ''}" data-iv-cancel="${esc(r.id)}">${icon('x', 12)} ${on ? 'tap again to cancel' : 'cancel'}</button></span>`;
}

export function queueRowHtml(r, { armed = null } = {}) {
  const n = normRequest(r);
  return `<div class="lv-row ticket" data-iv-id="${esc(n.id)}"><span class="lv-c lv-res"><b>#${esc(n.position ?? '?')} ${icon('git-branch', 13)} ${esc(n.branch)}</b><span class="lv-badge">${esc(n.id)}</span></span>`
    + kv('session', sessionHtml(n.session)) + (deployScope(n) ? kv('deploy', esc(deployScope(n))) : '') + cancelHtml(n, armed) + '</div>';
}

export function runningRowHtml(r, now = Date.now()) {
  const n = normRequest(r);
  const step = stepOf(n), tail = tailOf(n);
  return `<div class="lv-row" data-iv-id="${esc(n.id)}"><span class="lv-c lv-res"><b>${icon('git-branch', 13)} ${esc(n.branch)} -> ${esc(n.target || '?')}</b><span class="lv-badge central">${esc(LABEL.running)}</span></span>`
    + kv('step', `<b>${esc(step || 'starting')}</b>`) + kv('session', sessionHtml(n.session)) + (deployScope(n) ? kv('deploy', esc(deployScope(n))) : '')
    + kv('started', esc(fmtAgo(n.startedAt ?? n.createdAt, now)))
    + (tail ? `<pre class="iv-tail">${esc(tail)}</pre>` : '') + '</div>';
}

export function resultRowHtml(r, now = Date.now()) {
  const n = normRequest(r);
  const bad = BAD.includes(n.state);
  return `<div class="lv-row${bad ? ' idle' : ''} iv-${esc(n.state)}" data-iv-id="${esc(n.id)}"><span class="lv-c lv-res"><b>${icon('git-branch', 13)} ${esc(n.branch)}</b><span class="lv-badge ${bad ? 'legacy' : 'central'}">${esc(LABEL[n.state] || n.state)}</span></span>`
    + kv('id', esc(n.id)) + kv('session', sessionHtml(n.session))
    + (n.sha ? kv('sha', shaHtml(n)) : '')
    + (n.version ? kv('deployed', `<a href="/?deploys=1">${esc(n.version)}</a>${n.env ? ` to ${esc(n.env)}` : ''}`) : '')
    + kv('when', esc(fmtAgo(n.finishedAt ?? n.updatedAt, now)))
    + (n.reason ? `<span class="lv-c lv-over">${bad ? icon('alert', 11) + ' ' : ''}${esc(n.reason)}</span>` : '') + '</div>';
}

export function viewHtml(data, { now = Date.now(), armed = null, limit = 8 } = {}) {
  if (data && data.ok === false) return `<div class="sheet-empty" role="alert">${esc(data.error || 'integration lane unavailable')}</div>`;
  const groups = groupByRepo(rowsOf(data));
  if (!groups.length) return '<div class="sheet-empty">No integration requests yet. A session hands off with <code>integrate request &lt;branch&gt;</code>.</div>';
  return groups.map((g) => `<section class="lv-env"><h3 class="lv-h">${icon('git-branch', 13)} ${esc(g.repo)}</h3>`
    + (g.running.length ? g.running.map((r) => runningRowHtml(r, now)).join('') : '<div class="sheet-empty">nothing running</div>')
    + (g.queue.length ? `<h4 class="lv-h">${icon('timer', 12)} queue (${g.queue.length})</h4>${g.queue.map((r) => queueRowHtml(r, { armed })).join('')}` : '')
    + (g.results.length ? `<h4 class="lv-h">recent results</h4>${g.results.slice(0, limit).map((r) => resultRowHtml(r, now)).join('')}` : '')
    + '</section>').join('');
}

// the two-tap rule: a tap arms the button, the same button tapped again fires. -> { arm, fire } (request id)
export function tap(armed, id) { return armed === id ? { arm: null, fire: id } : { arm: id, fire: null }; }
export function actionRequest(id) {
  return /^[\w.-]{1,64}$/.test(String(id || '')) ? { url: `/api/integration/requests/${encodeURIComponent(id)}/cancel`, body: {} } : null;
}
