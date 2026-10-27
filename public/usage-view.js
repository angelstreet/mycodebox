// Usage & cost page (owner request 2026-10-21): the usage sheet moved into a full-width tab so the numbers are readable in order.
//
// Why a new file instead of a wider sheet: the sheet was doing four jobs at once (range tabs, view tabs, three filters and every
// section at once) inside a modal, which is why "usage and cost is too small". This file is pure HTML builders over the SAME
// payloads the sheet reads (/api/usage, /api/jev-ai, /api/manager/scorecard) and reuses the helpers in usage.js. No DOM, no fetch,
// so it is unit tested like leases-view.js. The sheet stays untouched: /?usage=1 opens the page, the More menu keeps both.
//
// Cost is always API-equivalent (list prices), never money spent, and never 0 for an unpriced model (— instead).
import { icon } from './icons.js';
import { fmtTok, fmtUsd, costOrNull, summaryFresh } from './usage.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DAY_MS = 86400000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const lastDays = (n, now = Date.now()) => Array.from({ length: n }, (_, i) => dayOf(now - (n - 1 - i) * DAY_MS));

// The flat subscriptions behind the API-equivalent numbers, so a cost can be read against what it is actually paid for.
const SUBSCRIPTION = { manager: 'pay per call (Jev, AI reviewer)', claude: 'Claude Max 200 EUR/month', codex: 'ChatGPT Plus 20 EUR/month', minimax: 'MiniMax 40 EUR/month' };
const PROVIDER = { claude: 'Anthropic', codex: 'OpenAI', minimax: 'MiniMax', other: '' };
const PAL = ['#c678dd', '#f5b942', '#ef8a52', '#5aa9e6', '#6ed1c0'];
const OTHER_C = '#8a8d96';
export const OTHERS = '\u0000others';

export const modelAgent = (m) => (/^claude/i.test(m) ? 'claude' : /^gpt|codex|^o\d/i.test(m) ? 'codex' : /minimax|^m\d/i.test(m) ? 'minimax' : 'other');
const num = (x) => (Number.isFinite(x) ? x : 0);
const byTok = (x, y) => ((y.total ?? y.tokens ?? 0) - (x.total ?? x.tokens ?? 0));
const ioLine = (e) => `in ${fmtTok(e.input ?? e.in)} &middot; out ${fmtTok(e.output ?? e.out)}`;
const tokLine = (e) => `<span class="ut">in ${fmtTok(e.input ?? e.in)} &middot; out ${fmtTok(e.output ?? e.out)} &middot; cache r ${fmtTok(e.cache_read ?? e.cr)} &middot; cache w ${fmtTok(e.cache_creation ?? e.cw)}</span>`;
// A cost cell: — when the model has no list price (never $0), and a "lower bound" marker when only some turns were priced.
export const usdCell = (c, partial = false) => (c == null
  ? `<span class="dim" title="unpriced: no list price for this model">&mdash;</span>`
  : `${esc(fmtUsd(c))}${partial ? '<sup class="uvp" title="only some turns had a list price: lower bound">~</sup>' : ''}`);

const topEntries = (map, n = Infinity) => [...Object.entries(map || {})].map(([name, e]) => ({ name, ...e })).sort(byTok).slice(0, n);

// group session rows by one key, summing tokens and cost the same way the sheet does (null cost when every row is unpriced)
function groupRows(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const g = m.get(r[key]) || { name: r[key], list: [] };
    g.list.push(r);
    m.set(r[key], g);
  }
  return [...m.values()].map((g) => ({
    name: g.name,
    cost: g.list.length && g.list.every((r) => r.cost == null) ? null : g.list.reduce((s, r) => s + (r.cost || 0), 0),
    unpriced: g.list.reduce((s, r) => s + num(r.unpriced), 0),
    total: g.list.reduce((s, r) => s + r.tokens, 0),
    input: g.list.reduce((s, r) => s + r.in, 0),
    output: g.list.reduce((s, r) => s + r.out, 0),
    cache_read: g.list.reduce((s, r) => s + r.cr, 0),
    cache_creation: g.list.reduce((s, r) => s + r.cw, 0),
    turns: g.list.reduce((s, r) => s + num(r.turns), 0),
    models: [...new Set(g.list.flatMap((r) => r.models || []))],
  })).sort((x, y) => ((y.cost ?? -1) - (x.cost ?? -1)) || byTok(x, y));
}

// day -> key -> {total, cost}, for the chosen split. perDayModel is tailer-owned; project/agent come from the session rows.
function dimData(u, dim, rows) {
  if (dim === 'model') return u.perDayModel || null;
  const out = {};
  for (const r of rows || []) {
    const key = dim === 'project' ? r.project : r.agent;
    for (const [d, v] of Object.entries(r.days || {})) {
      const e = ((out[d] ||= {})[key] ||= { total: 0, cost: 0 });
      e.total += num(v.total);
      e.cost += num(v.cost);
    }
  }
  return out;
}

const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};

function sparkSvg(vals, color) {
  const w = 120, h = 30, max = Math.max(...vals, 0) || 1;
  const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/></svg>`;
}

// ---------- headline tiles: the four numbers you check first, at full width ----------

// delta vs the previous equal-length window, so "is this normal?" is answerable without opening anything
function deltaPill(cur, prev, what) {
  if (!prev && !cur) return '';
  if (!prev) return `<span class="uv-d">new ${esc(what)}</span>`;
  const d = ((cur - prev) / prev) * 100;
  const cls = d >= 0 ? 'up' : 'dn';
  return `<span class="uv-d ${cls}">${d >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(d))}% <span class="dim">vs prev</span></span>`;
}

export function tilesHtml(u, tab, score, rows = []) {
  const today = tab === 'today';
  const days = lastDays(14);
  const tk = (d) => num(u.perDay?.[d]?.total);
  const win = today ? [days[13]] : days.slice(7);
  const prevWin = today ? [days[12]] : days.slice(0, 7);
  const cur = win.reduce((s, d) => s + tk(d), 0);
  const prev = prevWin.reduce((s, d) => s + tk(d), 0);

  const src = today ? u.today : u;
  const total = src?.total || {};
  const cost = costOrNull(total);
  const unpriced = num(total.unpriced);

  // `today` carries no perSession (only perAgent/perModel/perProject/total), so the session count comes from the
  // rows the page was given — which also makes the tile follow the active filters instead of ignoring them.
  const sessionCount = new Set((rows || []).map((r) => r.session)).size;

  // cost-per-million-in is the number that makes the flat subscriptions comparable, so it is a tile of its own
  const perM = cost != null && cur > 0 ? (cost / (cur / 1e6)) : null;

  const tile = (label, value, sub, cls = '') =>
    `<div class="uv-t ${cls}"><span class="uv-l">${esc(label)}</span><b class="uv-v">${value}</b>${sub ? `<span class="uv-s">${sub}</span>` : ''}</div>`;

  return `<div class="uv-tiles">
    ${tile('Tokens', esc(fmtTok(cur)), `${deltaPill(cur, prev, today ? 'today' : 'this week')}<span class="dim">${today ? 'today (UTC)' : 'last 7 days'}</span>`)}
    ${tile('API-equivalent cost', usdCell(cost, unpriced > 0 && cost !== 0), unpriced > 0 ? '<span class="dim">lower bound: some models have no list price</span>' : '<span class="dim">list prices, not money spent</span>')}
    ${tile('Cache hit', esc(fmtTok(total.cache_read)), `<span class="dim">read ${esc(fmtTok(total.cache_read))} &middot; write ${esc(fmtTok(total.cache_creation))}</span>`)}
    ${tile('Sessions', esc(String(sessionCount)), `<span class="dim">${num(total.turns)} turns &middot; ${perM == null ? 'cost/M unpriced' : `$${perM.toFixed(2)} per M tokens`}</span>`)}
  </div>`;
}

// ---------- quality: promoted out of the cramped /100 block into its own row ----------

export function qualityHtml(score) {
  const c = score?.components;
  if (!c) return '';
  const pct = (p) => (p == null ? '&mdash;' : `${Math.round(p * 100)}%`);
  const cell = (label, v, note) => `<div class="uv-q"><span class="dim">${esc(label)}</span><b>${v}</b>${note ? `<span class="uv-s">${note}</span>` : ''}</div>`;
  const n = score.score == null ? '&mdash;' : `${Math.round(score.score)}`;
  const bars = (Array.isArray(score.days) ? score.days : []).slice(-14).map((d, i, arr) => {
    const h = d && Number.isFinite(d.score) ? Math.max(3, Math.round((d.score / 100) * 34)) : 3;
    return `<span class="uv-qb${i === arr.length - 1 ? ' last' : ''}" style="height:${h}px" title="${esc(`${(d?.day || (d?.to || '').slice(0, 10))}: ${d?.score == null ? '—' : Math.round(d.score)}`)}"></span>`;
  }).join('');
  return `<section class="uv-sec"><h2>Quality <span class="dim">manager score, last 14 days</span></h2>
    <div class="uv-quality">
      <div class="uv-qscore"><b>${n}</b><span class="dim">/ 100</span>${bars ? `<div class="uv-qbars" aria-label="last 14 days">${bars}</div>` : ''}</div>
      ${cell('Quality', pct(c.quality))}
      ${cell('Coverage', pct(c.coverage))}
      ${cell('Efficiency', pct(c.efficiency))}
    </div>
    ${planLine(score)}
  </section>`;
}

function planLine(score) {
  const budgetPct = score?.budget?.claudeWeeklyPct ?? 10;
  const w = score?.claude_weekly_pct, t = score?.claude_today_pct;
  if (w == null) return `<div class="uv-note dim">Claude plan: quota unknown &middot; budget ${budgetPct} %</div>`;
  return `<div class="uv-note dim">Claude plan: manager ${w.toFixed(1)} % of the week (${(t || 0).toFixed(1)} % today) &middot; budget ${budgetPct} %</div>`;
}

// ---------- spend by agent: a table with real columns, so in/out/cr/cw stop hiding behind a toggle ----------

export function agentsHtml(u, tab, rows, ui) {
  const src = tab === 'today' ? u.today : u;
  const narrowed = !!(ui.f.project || ui.f.q);
  const agents = (narrowed ? groupRows(rows, 'agent') : topEntries(src?.perAgent).filter((a) => !ui.f.agent || a.name === ui.f.agent)).sort(byTok);
  const modelsOf = (a) => (narrowed
    ? a.models.map((m) => ({ name: m, nocost: true }))
    : topEntries(src?.perModel).filter((m) => (m.agent || modelAgent(m.name)) === a.name).sort(byTok));

  const head = `<div class="uv-th"><span>Agent</span><span class="uv-c">Tokens</span><span class="uv-c">in</span><span class="uv-c">out</span><span class="uv-c">cache r</span><span class="uv-c">cache w</span><span class="uv-c">API-equiv.</span></div>`;
  const body = agents.map((a) => {
    const on = ui.openAgents.has(a.name);
    const cost = costOrNull({ cost: a.cost, unpriced: a.unpriced });
    return `<div class="uv-tr${on ? ' open' : ''}" data-agent="${esc(a.name)}" role="button" tabindex="0">
      <div class="uv-td uv-name"><i class="adot ${esc(a.name)}"></i><b>${esc(a.name)}</b><span class="dim">${esc((SUBSCRIPTION[a.name] || 'subscription ?').replace(/\s*\d+\s*EUR\/month/i, ''))}</span></div>
      <div class="uv-td uv-c" data-l="tokens"><b class="tk">${esc(fmtTok(a.total))}</b></div>
      <div class="uv-td uv-c dim" data-l="in">${esc(fmtTok(a.input))}</div>
      <div class="uv-td uv-c dim" data-l="out">${esc(fmtTok(a.output))}</div>
      <div class="uv-td uv-c dim" data-l="cache r">${esc(fmtTok(a.cache_read))}</div>
      <div class="uv-td uv-c dim" data-l="cache w">${esc(fmtTok(a.cache_creation))}</div>
      <div class="uv-td uv-c" data-l="api-equiv.">${usdCell(cost, a.unpriced > 0 && cost !== 0)}</div>
      ${on ? `<div class="uv-models">${modelsOf(a).map((m) => `<div class="uv-tr sub"><div class="uv-td uv-name"><b>${esc(m.name)}</b><span class="dim">${esc(PROVIDER[m.agent || modelAgent(m.name)] || '')}</span></div><div class="uv-td uv-c">${m.nocost ? '' : `<b class="tk">${esc(fmtTok(m.total))}</b>`}</div><div class="uv-td uv-c dim" data-l="in">${m.nocost ? '' : esc(fmtTok(m.input))}</div><div class="uv-td uv-c dim" data-l="out">${m.nocost ? '' : esc(fmtTok(m.output))}</div><div class="uv-td uv-c dim" data-l="cache r">${m.nocost ? '' : esc(fmtTok(m.cache_read))}</div><div class="uv-td uv-c dim" data-l="cache w">${m.nocost ? '' : esc(fmtTok(m.cache_creation))}</div><div class="uv-td uv-c" data-l="api-equiv.">${m.nocost ? '' : usdCell(costOrNull(m))}</div></div>`).join('') || '<div class="uv-note dim">no models</div>'}</div>` : ''}
    </div>`;
  }).join('') || '<div class="uv-note dim">no agent matches</div>';

  return `<section class="uv-sec"><h2>Where it goes <span class="dim">by agent, then model</span></h2>${head}${body}</section>`;
}

// ---------- charts: over time (stacked, click a day) ----------

export function overTimeHtml(u, tab, ui, rows) {
  const dm = dimData(u, ui.dim, rows);
  if (!dm) return '<section class="uv-sec"><h2>Over time</h2><div class="uv-note">model split needs the updated ghosty-usage tailer (restart the unit)</div></section>';
  const today = tab === 'today';
  const days = today ? lastDays(1) : lastDays(ui.range);
  const val = (e) => num(e?.total);

  const totals = new Map();
  for (const d of days) for (const [k, e] of Object.entries(dm[d] || {})) totals.set(k, (totals.get(k) || 0) + val(e));
  const ranked = [...totals].filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([k]) => k);
  const top = ranked.slice(0, 5);
  const colorOf = (k) => (k === OTHERS ? OTHER_C : PAL[top.indexOf(k)] || OTHER_C);
  const nameOf = (k) => (k === OTHERS ? 'others' : k);

  const max = niceMax(Math.max(...days.map((d) => [...Object.values(dm[d] || {})].reduce((s, e) => s + val(e), 0)), 0));
  const grand = days.reduce((s, d) => s + [...Object.values(dm[d] || {})].reduce((a, e) => a + val(e), 0), 0);

  const bars = days.map((d) => {
    const dayTotal = [...Object.values(dm[d] || {})].reduce((s, e) => s + val(e), 0);
    const segs = [...new Set(Object.keys(dm[d] || {}))].map((k) => ({ k: top.includes(k) ? k : OTHERS, v: val(dm[d][k]) })).filter((s) => s.v > 0);
    const pct = (v) => (dayTotal ? (v / dayTotal) * 100 : 0);
    return `<button class="uv-col${d === ui.selDay ? ' sel' : ''}" data-cday="${esc(d)}" title="${esc(`${d}: ${fmtTok(dayTotal)}`)}"><span class="uv-stack" style="height:${dayTotal ? Math.max(1, (dayTotal / max) * 100) : 0}%">${segs.map((s) => `<i style="height:${pct(s.v)}%;background:${colorOf(s.k)}"></i>`).join('')}</span><span class="uv-x">${days.length > 8 ? d.slice(8) : d.slice(5)}</span></button>`;
  }).join('');

  const sel = ui.selDay || days[days.length - 1];
  const selTotal = [...Object.values(dm[sel] || {})].reduce((s, e) => s + val(e), 0);
  const selSegs = [...Object.entries(dm[sel] || {})].map(([k, e]) => ({ k, v: val(e) })).filter((s) => s.v > 0).sort((a, b) => b.v - a.v);
  const panel = `<div class="uv-panel"><div class="uv-ph"><b>${esc(new Date(`${sel}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }))}</b><span class="grow"></span><b>${esc(fmtTok(selTotal))}</b></div>${selSegs.map((s) => `<div class="uv-leg"><i style="background:${colorOf(s.k)}"></i><span>${esc(nameOf(s.k))}</span><span class="grow"></span><span class="dim">${selTotal ? Math.round((s.v / selTotal) * 100) : 0}%</span><b>${esc(fmtTok(s.v))}</b></div>`).join('') || '<div class="uv-note dim">no usage that day</div>'}</div>`;

  const ctrl = `<div class="uv-ctrl">${['model', 'project', 'agent'].map((x) => `<button class="uv-chip${ui.dim === x ? ' on' : ''}" data-dim="${x}">${x}</button>`).join('')}${today ? '' : `<span class="grow"></span>${[7, 14].map((n) => `<button class="uv-chip${ui.range === n ? ' on' : ''}" data-range="${n}">${n}d</button>`).join('')}`}</div>`;
  const legend = [...top, ...(ranked.length > top.length ? [OTHERS] : [])].map((k) => `<span class="uv-lg"><i style="background:${colorOf(k)}"></i>${esc(nameOf(k))}</span>`).join('');

  return `<section class="uv-sec"><h2>Over time <span class="dim">${esc(fmtTok(grand))} &middot; ${today ? 'today (UTC)' : `last ${days.length} days`}</span></h2>
    ${ctrl}
    <div class="uv-plot"><div class="uv-grid">${[1, 0.5, 0].map((f) => `<span style="bottom:${f * 100}%">${f ? esc(fmtTok(max * f)) : '0'}</span>`).join('')}</div><div class="uv-bars">${bars}</div></div>
    ${legend ? `<div class="uv-legend">${legend}</div>` : ''}
    ${panel}</section>`;
}

// ---------- trending: 7 days against the 7 before, per model ----------

export function trendHtml(u) {
  const dm = u.perDayModel;
  if (!dm) return '<section class="uv-sec"><h2>Trending</h2><div class="uv-note">needs the updated ghosty-usage tailer (restart the unit)</div></section>';
  const days = lastDays(14);
  const models = new Set();
  for (const d of days) for (const m of Object.keys(dm[d] || {})) models.add(m);
  const sum = (a) => a.reduce((s, v) => s + v, 0);

  const rows = [...models].map((m) => {
    const series = days.map((d) => num((dm[d] || {})[m]?.total));
    const cur = sum(series.slice(7)), prev = sum(series.slice(0, 7));
    const agent = modelAgent(m);
    return { m, agent, series, total: sum(series), cur, prev, delta: prev > 0 ? ((cur - prev) / prev) * 100 : null };
  }).filter((r) => r.total > 0).sort((x, y) => y.total - x.total);

  const body = rows.map((r) => `<div class="uv-trow"><i class="adot ${esc(r.agent)}"></i><div class="uv-tn"><b>${esc(r.m)}</b><span class="dim">${esc(PROVIDER[r.agent] || '')}</span></div>${sparkSvg(r.series, r.delta != null && r.delta < 0 ? OTHER_C : '#6ed1c0')}<div class="uv-tv"><b>${esc(fmtTok(r.total))}</b><span class="${r.delta == null ? 'dim' : r.delta >= 0 ? 'up' : 'dn'}">${r.delta == null ? (r.cur > 0 ? 'new' : '') : `${r.delta >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(r.delta))}%`}</span></div></div>`).join('') || '<div class="uv-note dim">no usage</div>';

  return `<section class="uv-sec"><h2>Trending <span class="dim">tokens &middot; last 7 days vs the 7 before</span></h2>${body}</section>`;
}

// ---------- projects and sessions: one row per thing, expandable, clickable to the live session ----------

export function projectsHtml(u, tab, rows, ui) {
  const src = tab === 'today' ? u.today : u;
  const list = (ui.f.agent || ui.f.q ? groupRows(rows, 'project') : topEntries(src?.perProject)).filter((p) => !ui.f.project || p.name === ui.f.project).sort(byTok).slice(0, 25);
  const grand = list.reduce((s, p) => s + num(p.total), 0);
  const body = list.map((p) => {
    const pct = grand ? (num(p.total) / grand) * 100 : 0;
    return `<div class="uv-pr"><div class="uv-prl"><b>${esc(p.name)}</b><span class="grow"></span><b class="tk">${esc(fmtTok(p.total))}</b><span class="dim">${Math.round(pct)}%</span></div>
      <div class="uv-bar"><i style="width:${pct.toFixed(1)}%;background:${PAL[Math.min(PAL.length - 1, Math.floor(pct / 20))]}"></i></div>
      <div class="uv-prs">${tokLine(p)}</div></div>`;
  }).join('') || '<div class="uv-note dim">no project matches</div>';
  return `<section class="uv-sec"><h2>Projects <span class="dim">${esc(fmtTok(grand))} across ${list.length}</span></h2>${body}</section>`;
}

export function sessionsHtml(rows, ui, live) {
  const shown = rows.slice(0, 60);
  // this table has 4 columns, so it gets its own widths (the agent table's 7-column grid squeezes "in / out")
  const head = `<div class="uv-th uv-th-s"><span>Session</span><span class="uv-c">Project</span><span class="uv-c">Tokens</span><span class="uv-c">in / out</span></div>`;
  const body = shown.map((r) => {
    const on = !!live(r.session);
    return `<div class="uv-tr uv-tr-s${on ? ' go' : ''}${r.outlier ? ' out' : ''}" ${on ? `data-open="${esc(r.session)}"` : ''}>
      <div class="uv-td uv-name">${r.outlier ? `<span class="uw" title="outlier">${icon('alert', 12)}</span>` : ''}<i class="adot ${esc(r.agent)}"></i><b>${esc(r.session)}</b></div>
      <div class="uv-td uv-c dim" data-l="project">${esc(r.project || '')}</div>
      <div class="uv-td uv-c" data-l="tokens"><b class="tk">${esc(fmtTok(r.tokens))}</b></div>
      <div class="uv-td uv-c dim" data-l="io">${ioLine(r)}</div>
      ${r.outlier ? `<div class="uv-td uv-out">outlier: ${esc(String(r.outlier).split(':')[0])}</div>` : ''}</div>`;
  }).join('') || '<div class="uv-note dim">no session matches</div>';
  return `<section class="uv-sec"><h2>Sessions <span class="dim">${rows.length}${shown.length < rows.length ? ` &middot; showing ${shown.length}` : ''}</span></h2>${head}${body}</section>`;
}

// ---------- quota: kept, but full width instead of a collapsed strip ----------

export function quotaHtml(quota, jev) {
  const plans = quota?.plans || [];
  const body = plans.map((p) => {
    const head = `<div class="uv-qh"><i class="adot ${esc(p.plan)}"></i><b>${esc(p.label || p.plan)}</b><span class="grow"></span><span class="dim">${esc((SUBSCRIPTION[p.plan] || '').replace(/\s*\d+\s*EUR\/month/i, ''))}</span></div>`;
    if (!p.windows?.length) return `<div class="uv-plan">${head}<div class="uv-note dim">${esc(/login|expired/i.test(p.error || '') ? 'login expired, open mcode once to refresh' : (p.error || 'no reading yet'))}</div></div>`;
    const rows = p.windows.map((w) => {
      if (w.usedPercent == null) return `<div class="uv-qrow"><span class="dim">${esc(w.name)}</span><span class="grow"></span><span class="dim">${w.unlimited ? 'unlimited' : 'unknown'}</span></div>`;
      const lvl = w.usedPercent >= 90 ? 'crit' : w.usedPercent >= 70 ? 'warn' : 'ok';
      const reset = w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
      const left = w.resetsAt ? Math.max(0, (w.resetsAt * 1000 - Date.now()) / 60000) : null;
      return `<div class="uv-qrow"><span>${esc(w.name)}</span><span class="uv-qbar"><i class="${lvl}" style="width:${Math.min(100, w.usedPercent)}%"></i></span><b>${Math.round(w.usedPercent)}%</b><span class="dim">resets ${esc(reset)}${left != null ? ` &middot; ${Math.round(left)}m left` : ''}</span></div>`;
    }).join('');
    return `<div class="uv-plan">${head}${rows}</div>`;
  }).join('') || '<div class="uv-note dim">no quota reading yet</div>';

  const credits = jev?.credits;
  const creditRow = credits == null ? '' : `<div class="uv-plan"><div class="uv-qh"><b>Jev credits</b><span class="grow"></span><b>${esc(String(credits))}</b></div><div class="uv-note dim">OpenRouter budget behind the manager's Jev calls</div></div>`;
  return `<section class="uv-sec"><h2>Quota &amp; pace</h2>${body}${creditRow}</section>`;
}


// ---------- MiniMax usage (owner 2026-10-27): who is eating the 5h window ----------
const callsFmt = (n) => String(Math.round(num(n)));
const modelLine = (e) => `M3 ${callsFmt(e.byModel.m3.calls)} &middot; Flash ${callsFmt(e.byModel.flash.calls)}${e.byModel.other.calls ? ` &middot; other ${callsFmt(e.byModel.other.calls)}` : ''}`;
// mm = /api/usage `minimax` (minimax-meter.js snapshot). Sessions are ranked by calls this window: the plan appears to count calls, not tokens.
export function minimaxHtml(mm) {
  if (!mm) return '<div class="uv-empty">no MiniMax meter yet</div>';
  const w = mm.window, pct = mm.plan?.usedPercent;
  const bar = pct == null ? '<div class="uv-note dim">plan 5h reading unavailable</div>'
    : `<div class="uv-qh"><b>Plan 5h window</b><span class="grow"></span><b>${Math.round(pct)}%</b></div><div class="uv-bar"><i style="width:${Math.min(100, Math.max(0, pct))}%"></i></div>`;
  const reset = mm.plan?.resetsAt ? `resets ${esc(new Date(mm.plan.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }))}` : '';
  const rows = (mm.sessions || []).filter((s) => s.window.calls || s.h24.calls).map((s) => `<div class="urow${s.top ? ' out' : ''}">
      <div class="u1">${s.top ? `<span class="uw" title="top consumer this window">${icon('alert', 12)}</span>` : ''}<b>${esc(s.name)}</b>${s.manager ? ' <span class="dim" title="manager session">manager</span>' : ''}${s.pollLoop ? ' <span class="chip-m late" title="many calls with almost no new tokens: a tight status-poll loop">possible poll loop</span>' : ''}<span class="grow"></span><b class="tk">${callsFmt(s.window.calls)} calls &middot; ${s.share}%</b></div>
      <div class="uv-bar sm"><i style="width:${Math.min(100, s.share)}%"></i></div>
      <div class="u2">${modelLine(s.window)} &middot; new ${fmtTok(s.window.newTokens)} &middot; cache r ${fmtTok(s.window.cacheRead)} &middot; 24h ${callsFmt(s.h24.calls)} calls (${modelLine(s.h24)})</div></div>`).join('');
  return `<section class="uv-sec"><h2>MiniMax usage</h2>${bar}<div class="uv-note dim">${callsFmt(w.calls)} calls this window ${reset ? `&middot; ${reset} ` : ''}&middot; ${callsFmt(mm.h24.calls)} in 24 h</div>
    ${rows || '<div class="dim">no MiniMax calls in the last 24 h</div>'}
    <div class="uv-note dim">${esc(mm.note || '')}</div></section>`;
}

// ---------- the page ----------

// ui = { tab, view, dim, range, selDay, f: {agent, project, q}, openAgents: Set, langfuse }
export function pageHtml({ usage, tab = 'today', score = null, jev = null, quota = null, ui = {}, rows = [], live = () => false, links = {} }) {
  const today = tab === 'today' && (ui.view || 'overview') !== 'minimax';
  if (today && !usage) return '<div class="uv-empty">loading…</div>';
  if (today && usage && !summaryFresh(usage, Date.now())) return '<div class="uv-empty">no usage today yet — the summary is from an earlier day</div>';
  if (today && usage && !usage.today) return '<div class="uv-empty">today needs the updated ghosty-usage tailer (restart the unit)</div>';

  const view = ui.view || 'overview';
  const head = `<div class="uv-head">
    <div class="uv-tabs">${[['today', 'Today'], ['14d', '14 days']].map(([k, l]) => `<button class="uv-tab${tab === k ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="uv-nav">${[['overview', 'Overview'], ['time', 'Over time'], ['trend', 'Trending'], ['sessions', 'Sessions'], ['minimax', 'MiniMax']].map(([k, l]) => `<button class="uv-navb${view === k ? ' on' : ''}" data-view="${k}">${l}</button>`).join('')}</div>
    <span class="grow"></span>
    ${links.langfuse ? `<a class="uv-lf" href="${esc(links.langfuse)}" target="_blank" rel="noopener">Langfuse ↗</a>` : ''}
  </div>`;

  const filters = ['overview', 'sessions'].includes(view) ? `<div class="uv-filters">
    <select data-f="agent" aria-label="Filter by agent"><option value="">all agents</option></select>
    <select data-f="project" aria-label="Filter by project"><option value="">all projects</option></select>
    <select data-f="q" aria-label="Filter by session"><option value="">all sessions</option></select>
  </div>` : '';

  let bodyHtml;
  if (view === 'minimax') bodyHtml = minimaxHtml(usage?.minimax);
  else if (view === 'time') bodyHtml = overTimeHtml(usage, tab, ui, rows);
  else if (view === 'trend') bodyHtml = trendHtml(usage);
  else if (view === 'sessions') bodyHtml = projectsHtml(usage, tab, rows, ui) + sessionsHtml(rows, ui, live);
  else bodyHtml = tilesHtml(usage, tab, score, rows)
    + (tab === 'today' && score ? qualityHtml(score) : '')
    + agentsHtml(usage, tab, rows, ui)
    + projectsHtml(usage, tab, rows, ui)
    + quotaHtml(quota, jev);

  return `<div class="uv-root">${head}${filters}<div class="uv-body">${bodyHtml}</div></div>`;
}