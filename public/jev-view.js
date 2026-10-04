// Jev & AI usage tab and the decisions page (TASK-44): pure HTML builders, no DOM access (unit-tested in node).
// Data comes from GET /api/jev-ai and GET /api/decisions (decisions.js on the server).

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const cost = (c) => (c == null || !Number.isFinite(Number(c)) ? '&mdash;' : Number(c) === 0 ? '$0' : Number(c) < 0.01 ? `$${Number(c).toFixed(5)}` : `$${Number(c).toFixed(2)}`);
export const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 5)}`; };
export const pct = (c) => (c == null ? '' : `${Math.round(c * 100)} %`);
const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toTimeString().slice(0, 5); };

// ---- OpenRouter credit ----
const usd = (x) => (x == null ? '?' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
export function creditHtml(c) {
  if (!c || !c.ok) return `<section class="jsec"><div class="u1"><b>OpenRouter credit</b></div><div class="jbanner dim">not available until the server is updated${c?.error ? `<br><span class="dim">${esc(c.error)}</span>` : ''}</div></section>`;
  const rows = c.endpoints.filter((e) => e.has_key).map((e) => {
    const k = e.key, empty = e.balance != null && e.balance <= 0;
    return `<div class="urow"><div class="u1"><b>${esc(e.endpoint)}</b><span class="grow"></span><span class="jbal${empty ? ' bad' : e.balance != null && e.balance <= 2 ? ' low' : ''}">${usd(e.balance)}</span></div>
      <div class="u2">bought ${usd(e.total_credits)} &middot; used ${usd(e.total_usage)}</div>
      ${k ? `<div class="u2">key: ${k.limit == null ? 'no monthly limit' : `limit ${usd(k.limit)}, ${usd(k.limit_remaining)} left`} &middot; today ${usd(k.usage_daily)} &middot; this month ${usd(k.usage_monthly)}</div>` : ''}
      ${e.errors.map((m) => `<div class="u2 uo">${esc(m)}</div>`).join('')}</div>`;
  }).join('');
  const bad = c.balance != null && c.balance <= 0;
  return `<section class="jsec"><div class="u1"><b>OpenRouter credit</b><span class="grow"></span><span class="dim">${c.stale ? 'stale &middot; ' : ''}${c.at ? esc(when(c.at)) : ''}</span></div>
    ${bad ? '<div class="jbanner bad" role="alert"><b>Credit is used up</b><br>Jev and AI calls fail until credit is added.</div>' : ''}${rows || '<div class="jbanner dim">no endpoint with a key</div>'}</section>`;
}
// the short line for the quota row; '' without a reading
export function creditChip(c) {
  if (!c || !c.ok || c.balance == null) return '';
  return `<span class="qi ${c.balance <= 0 ? 'crit' : c.balance <= 2 ? 'warn' : 'ok'}" title="OpenRouter credit">openrouter ${usd(c.balance)}</span>`;
}

// ---- Jev inside the usage Overview (replaces the old third tab) ----
// One "agent" row next to claude / codex / minimax: calls and failures for the period, real spend ($, the only paid thing),
// expandable into its uses. Credit is a bar in the quota section.
const period = (s, tab, today) => (tab === 'today'
  ? (s.days.find((x) => x.day === today) || { calls: 0, failed: 0, cost: 0 })
  : s.total);
export function jevRowHtml(d, tab, open, chev, today = new Date().toISOString().slice(0, 10)) {
  if (!d) return '';
  const streams = [['Manager Jev', 'classifies ambiguous stops', d.manager], ['AI reviewer', 'proposes replies for stops that go to you', d.reviewer]];
  const per = streams.map(([title, sub, s]) => ({ title, sub, s, p: period(s, tab, today) }));
  const calls = per.reduce((n, x) => n + x.p.calls, 0), failed = per.reduce((n, x) => n + x.p.failed, 0), spend = per.reduce((n, x) => n + (x.p.cost || 0), 0);
  const failing = per.some((x) => x.s.health.state === 'failing');
  const chip = failed ? `<span class="jfchip ${failing || failed / Math.max(1, calls) > 0.25 ? 'crit' : 'warn'}">${failed} failed</span>` : '';
  const sub = failing ? 'failing right now' : calls ? `${calls} call${calls === 1 ? '' : 's'}` : 'no calls';
  const body = open ? `<div class="umodels">${per.map((x) => `<div class="urow sub"><div class="u1"><b>${esc(x.title)}</b><span class="grow"></span><b class="tk">${cost(x.p.cost)}</b></div>
      <div class="u2">${esc(x.sub)} &middot; ${x.p.calls} calls &middot; <span class="${x.p.failed ? 'jf' : ''}">${x.p.failed} failed</span></div>
      ${x.s.health.state === 'failing' ? banner(x.s.health, x.title) : ''}${tab === 'today' ? '' : dayRows(x.s.days, today)}</div>`).join('')}
      ${d.product?.available && d.product.usages?.length ? d.product.usages.map((u) => `<div class="urow sub"><div class="u1"><b>${esc(u.usage_key)}</b><span class="grow"></span><b class="tk">${cost(u.cost)}</b></div><div class="u2">${u.calls} calls &middot; <span class="${u.failed ? 'jf' : ''}">${u.failed} failed</span> &middot; last ${esc(when(u.last_at))}</div></div>`).join('') : `<div class="u2 dim">product uses (Sherlock, Test Prompt, ...): ${esc(d.product?.reason || 'not available')}</div>`}</div>` : '';
  return `<div class="urow ag jev"><div class="u1 tog" data-agent="jev">${chev(open)}<i class="adot jev"></i><b>Jev</b><span class="dim">${sub}</span>${chip}<span class="grow"></span><b class="tk jcost" title="real spend (OpenRouter), the only paid usage">${cost(spend)}</b></div>
    <div class="u2">${open ? '' : 'Manager Jev &middot; AI reviewer &middot; product uses'}</div>${body}</div>`;
}
export function creditRowHtml(c) {
  const head = (right, cls = '') => `<div class="u1"><i class="adot jev"></i><b>OpenRouter credit</b><span class="grow"></span><b class="tk ${cls}">${right}</b></div>`;
  if (!c || !c.ok) return `<div class="urow">${head('?')}<div class="u2 dim">no reading${c?.error ? ` (${esc(String(c.error).slice(0, 80))})` : ''}</div></div>`;
  const ep = (c.endpoints || []).find((e) => e.has_key && e.total_credits) || (c.endpoints || []).find((e) => e.has_key);
  const bal = c.balance != null ? c.balance : ep?.balance;
  const tot = ep?.total_credits, used = ep?.total_usage;
  const lvl = bal != null && bal <= 0 ? 'crit' : bal != null && bal <= 2 ? 'warn' : 'ok';
  const pctUsed = tot ? Math.min(100, Math.round(((used ?? 0) / tot) * 100)) : null;
  return `<div class="urow">${head(`${usd(bal)} left`, lvl)}${pctUsed == null ? '' : `<div class="qp"><span class="qn">used</span><span class="qb ${lvl}"><i style="width:${pctUsed}%"></i></span><span class="qv ${lvl}">${pctUsed}%</span></div>`}
    <div class="u2">${bal != null && bal <= 0 ? '<b class="jf">credit is used up: Jev and AI calls fail until credit is added</b>' : `${tot != null ? `bought ${usd(tot)} &middot; ` : ''}${used != null ? `used ${usd(used)}` : ''}`}${c.stale ? ' &middot; stale' : ''}</div></div>`;
}

// ---- the tab ----
function banner(h, what) {
  if (h.state === 'failing') return `<div class="jbanner bad" role="alert"><b>${esc(what)} is failing</b><br>${esc(h.error)}<br><span class="dim">${h.streak} call${h.streak === 1 ? '' : 's'} in a row, last ${esc(when(h.at))}</span></div>`;
  if (h.state === 'ok') return `<div class="jbanner ok">${esc(what)} works &middot; last call ${esc(when(h.at))}</div>`;
  return `<div class="jbanner dim">${esc(what)}: no calls in the last 14 days</div>`;
}
function dayRows(days, today) {
  const used = days.filter((d) => d.calls > 0 || d.day === today).reverse();   // newest first
  if (!used.some((d) => d.calls > 0)) return '';
  return `<div class="jdays">${used.map((d) => `<div class="jday${d.failed ? ' bad' : ''}"><span class="ud">${esc(d.day.slice(5))}</span><span>${d.calls} call${d.calls === 1 ? '' : 's'}</span><span class="${d.failed ? 'jf' : 'dim'}">${d.failed} failed</span><span class="grow"></span><span>${cost(d.cost)}</span></div>`).join('')}</div>`;
}
function stream(title, sub, s, today) {
  return `<section class="jsec"><div class="u1"><b>${esc(title)}</b><span class="grow"></span><span class="dim">${s.total.calls} calls &middot; ${s.total.failed} failed &middot; ${cost(s.total.cost)}</span></div>
    <div class="u2">${esc(sub)}</div>${banner(s.health, title)}${dayRows(s.days, today)}</section>`;
}
export function jevTabHtml(d, today = new Date().toISOString().slice(0, 10)) {
  if (!d) return '<div class="sheet-empty">loading&hellip;</div>';
  let product;
  if (!d.product.available) {
    product = `<div class="jbanner dim">not available until the server is updated<br><span class="dim">${esc(d.product.reason || '')}</span></div>`;
  } else if (!d.product.usages.length) {
    product = '<div class="jbanner dim">the server has logged no decisions yet</div>';
  } else {
    const max = (u) => Math.max(1, ...u.days.map((x) => x.calls));
    product = d.product.usages.map((u) => `<div class="urow"><div class="u1"><b>${esc(u.usage_key)}</b><span class="grow"></span>${cost(u.cost)}</div>
      <div class="u2">${u.calls} calls &middot; <span class="${u.failed ? 'jf' : ''}">${u.failed} failed</span> &middot; ${u.with_outcome} with outcome &middot; last ${esc(when(u.last_at))}</div>
      <div class="jbars" aria-label="calls per day, 14 days">${u.days.map((x) => `<i title="${esc(x.day)}: ${x.calls}" style="height:${Math.round((x.calls / max(u)) * 100)}%"></i>`).join('')}</div></div>`).join('')
      + (d.product.truncated ? '<div class="u2 dim">older rows not counted (the summary is capped)</div>' : '');
  }
  return creditHtml(d.credits) + `<div class="utot dim">UTC days &middot; manager logs as <span class="jkey">${esc(d.usageKey)}</span>${d.logged ? '' : ' (not logged: VPT_TEAM_ID is not set)'}${d.queued ? ` &middot; ${d.queued} outcome${d.queued === 1 ? '' : 's'} waiting for the server` : ''}</div>`
    + stream('Manager Jev', 'classifying ambiguous stops, from ghosty\'s own log', d.manager, today)
    + stream('AI reviewer', 'proposals for stops that go to the owner, from ghosty\'s own log', d.reviewer, today)
    + `<section class="jsec"><div class="u1"><b>Product uses of Jev</b></div><div class="u2">Sherlock, Test Prompt, &hellip; from the server's decision log</div>${product}</section>`;
}

// ---- the decisions page ----
export function filtersHtml(usages = [], f = {}) {
  const sel = (key, label, opts) => `<select data-df="${key}" aria-label="${esc(label)}">${opts.map(([v, t]) => `<option value="${esc(v)}"${String(f[key] ?? '') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  return `<div class="ufilters dfilters">${sel('usage', 'Filter by use', [['', 'all uses'], ...usages.map((u) => [u, u])])}
    ${sel('ok', 'Filter by result', [['', 'ok + failed'], ['true', 'ok only'], ['false', 'failed only']])}
    ${sel('hasOutcome', 'Filter by outcome', [['', 'any outcome'], ['true', 'with outcome'], ['false', 'no outcome yet']])}
    ${sel('minConf', 'Minimum confidence', [['', 'any confidence'], ['0.5', '≥ 50 %'], ['0.7', '≥ 70 %'], ['0.8', '≥ 80 %'], ['0.9', '≥ 90 %']])}</div>`;
}
export function decRowHtml(r, { live = false, open = false } = {}) {
  const outcome = r.outcome
    ? `<div class="u2 jout ${r.agree === true ? 'yes' : r.agree === false ? 'no' : ''}">outcome <b>${esc(r.outcome.label)}</b>${r.outcome.by ? ` (${esc(r.outcome.by)})` : ''}${r.agree === true ? ' &#10003; agrees' : r.agree === false ? ' &#10007; differs from Jev' : ''}</div>`
    : '<div class="u2 dim">no outcome yet</div>';
  const pick = r.pick != null ? `<b>${esc(r.pick)}</b>${r.confidence != null ? ` ${esc(pct(r.confidence))}` : ''}` : '<span class="dim">no pick</span>';
  const stop = open && r.stop ? `<pre class="jstop">${esc(r.stop.excerpt)}</pre>` : '';
  return `<div class="urow drow${r.manager ? ' go' : ''}${r.ok ? '' : ' out'}" data-did="${esc(r.id)}"${r.manager ? ` data-dsession="${esc(r.session || '')}"` : ''}>
    <div class="u1"><b>${esc(r.usage)}</b><span class="dim">${esc(when(r.at))}</span><span class="grow"></span>${r.ok ? '<span class="jok">ok</span>' : '<span class="jf">failed</span>'}</div>
    <div class="u2">${esc(r.about)}</div>
    <div class="u2">${pick} &middot; ${r.ms != null ? `${r.ms} ms &middot; ` : ''}${cost(r.cost)}${r.model ? ` &middot; ${esc(r.model)}` : ''}</div>
    ${r.error ? `<div class="u2 uo">${esc(r.error)}</div>` : ''}${outcome}${stop}
    ${r.manager && !live ? '<div class="u2 dim">session not running</div>' : ''}</div>`;
}
export function decisionsHtml(d, { live = () => false, openId = null } = {}) {
  const head = `<div class="jbanner ${d.source === 'server' ? 'ok' : 'dim'}">${d.source === 'server' ? 'source: the server\'s decision log (all uses)' : `source: ghosty's local log (manager only)<br><span class="dim">${esc(d.note || '')}</span>`}</div>`;
  const rows = d.rows.map((r) => decRowHtml(r, { live: r.manager && live(r.session), open: r.id === openId })).join('') || '<div class="sheet-empty">no decision matches</div>';
  return head + rows + (d.more ? '<button class="sbtn" data-dmore="1">more</button>' : '');
}
