// Cloud view (⋮ menu > Cloud, /?cloud=1): read-only list of the Claude Code cloud sessions started with scripts/cloud-start
// (docs/CLOUD.md). Pure HTML builders for GET /api/cloud-sessions; no DOM, no fetch (unit tested). One row per session: label,
// repo and base branch, who started it, when, the task's first line, the link to the session on claude.ai, and the hand-off
// (the integration request queued with --mac cloud-<label>) when there is one.
import { icon } from './icons.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BAD = ['returned', 'returned_after_deploy', 'merged_ci_red', 'deploy_failed', 'cancelled'];

export function fmtAgo(iso, now) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return '—';
  const m = Math.max(0, (now - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')} ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export function handoffHtml(h) {
  if (!h) return '<span class="lv-c cv-meta" title="No integrate request with --mac cloud-&lt;label&gt; yet">not handed back yet</span>';
  const bad = BAD.includes(h.state);
  return `<span class="lv-c${bad ? ' lv-amber' : ''}" title="${esc(h.branch || '')}">${esc(h.id)} · ${esc(String(h.state || '').replace(/_/g, ' '))}</span>`;
}

export function rowHtml(c, { now = Date.now() } = {}) {
  const link = c.url ? `<a class="sbtn cv-open" href="${esc(c.url)}" target="_blank" rel="noopener">${icon('external', 13)} open</a>` : '';
  return `<div class="lv-row cv-row" data-cv="${esc(c.id)}">`
    + `<div class="lv-res"><b class="lv-c">${esc(c.label)}</b><span class="lv-badge">${esc(c.repo || '?')}</span><span class="grow"></span>${link}</div>`
    + `<div class="lv-c">${esc(c.task || '')}</div>`
    + `<div class="lv-c cv-meta">${esc(fmtAgo(c.at, now))} · by ${esc(c.by || '?')} · from ${esc(c.base || '?')}</div>`
    + `<div class="lv-res"><span class="lv-k">hand-off</span>${handoffHtml(c.handoff)}</div>`
    + '</div>';
}

export function viewHtml(data, { now = Date.now() } = {}) {
  if (!data || data.ok === false) return `<div class="sheet-empty">${esc(data?.error || 'cloud sessions unavailable')}</div>`;
  const items = data.sessions || [];
  const head = '<div class="lv-auth cv-meta">Claude Code sessions on Anthropic VMs, started with cloud-start. Read-only: they run on claude.ai, not in tmux.</div>';
  if (!items.length) return `${head}<div class="sheet-empty">No cloud session started yet.</div>`;
  return head + items.map((c) => rowHtml(c, { now })).join('');
}
