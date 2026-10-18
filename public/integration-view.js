// Integration view (round 13, brief B): pure HTML builders for GET /api/integration/requests. No DOM, no fetch (unit tested).
// Per repo: the queue (position, branch, session, requested deploy), the running request with its current step and live output tail, recent
// results (state, sha, deploy version, reason). A queued request can be cancelled; the button is armed by a first tap (second tap in app.js).
// request: { id, repo, branch, target, session, deploy, state, step, steps[{name,tail}], tail, sha, commitUrl, version, env, reason, position, createdAt, finishedAt }
import { icon } from './icons.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const FINAL = ['merged', 'deployed', 'returned', 'merged_ci_red', 'deploy_failed', 'cancelled'];
export const LABEL = { queued: 'queued', running: 'running', merged: 'merged', deployed: 'deployed', returned: 'returned', merged_ci_red: 'merged, CI red', deploy_failed: 'merged, deploy failed', cancelled: 'cancelled' };
const BAD = ['returned', 'merged_ci_red', 'deploy_failed'];
const TAIL_LINES = 12;

export function fmtMin(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  if (min < 1) return '<1m';
  if (min < 60) return `${Math.round(min)}m`;
  return `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}`;
}
export const fmtAgo = (ms, now) => (ms == null || !Number.isFinite(Number(ms)) ? '—' : `${fmtMin(Math.max(0, (now - Number(ms)) / 60000))} ago`);
const sha12 = (s) => String(s || '').slice(0, 12);
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
  for (const r of requests) {
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
const shaHtml = (r) => {
  if (!r.sha) return '';
  const label = `<code>${esc(sha12(r.sha))}</code>`;
  return /^https?:\/\//.test(r.commitUrl || '') ? `<a href="${esc(r.commitUrl)}" target="_blank" rel="noopener">${label}</a>` : label;
};

// armed: the request id whose cancel button was tapped once
export function cancelHtml(r, armed) {
  if (r.state !== 'queued') return '';
  const on = armed === r.id;
  return `<span class="lv-acts"><button class="sbtn${on ? ' danger' : ''}" data-iv-cancel="${esc(r.id)}">${icon('x', 12)} ${on ? 'tap again to cancel' : 'cancel'}</button></span>`;
}

export function queueRowHtml(r, { armed = null } = {}) {
  return `<div class="lv-row ticket" data-iv-id="${esc(r.id)}"><span class="lv-c lv-res"><b>#${esc(r.position ?? '?')} ${icon('git-branch', 13)} ${esc(r.branch)}</b><span class="lv-badge">${esc(r.id)}</span></span>`
    + kv('session', sessionHtml(r.session)) + (deployScope(r) ? kv('deploy', esc(deployScope(r))) : '') + cancelHtml(r, armed) + '</div>';
}

export function runningRowHtml(r, now = Date.now()) {
  const step = stepOf(r), tail = tailOf(r);
  return `<div class="lv-row" data-iv-id="${esc(r.id)}"><span class="lv-c lv-res"><b>${icon('git-branch', 13)} ${esc(r.branch)} -> ${esc(r.target || '?')}</b><span class="lv-badge central">${esc(LABEL.running)}</span></span>`
    + kv('step', `<b>${esc(step || 'starting')}</b>`) + kv('session', sessionHtml(r.session)) + (deployScope(r) ? kv('deploy', esc(deployScope(r))) : '')
    + kv('started', esc(fmtAgo(r.startedAt ?? r.createdAt, now)))
    + (tail ? `<pre class="iv-tail">${esc(tail)}</pre>` : '') + '</div>';
}

export function resultRowHtml(r, now = Date.now()) {
  const bad = BAD.includes(r.state);
  return `<div class="lv-row${bad ? ' idle' : ''} iv-${esc(r.state)}" data-iv-id="${esc(r.id)}"><span class="lv-c lv-res"><b>${icon('git-branch', 13)} ${esc(r.branch)}</b><span class="lv-badge ${bad ? 'legacy' : 'central'}">${esc(LABEL[r.state] || r.state)}</span></span>`
    + kv('id', esc(r.id)) + kv('session', sessionHtml(r.session))
    + (r.sha ? kv('sha', shaHtml(r)) : '')
    + (r.version ? kv('deployed', `<a href="/?deploys=1">${esc(r.version)}</a>${r.env ? ` to ${esc(r.env)}` : ''}`) : '')
    + kv('when', esc(fmtAgo(r.finishedAt ?? r.updatedAt, now)))
    + (r.reason ? `<span class="lv-c lv-over">${bad ? icon('alert', 11) + ' ' : ''}${esc(r.reason)}</span>` : '') + '</div>';
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
