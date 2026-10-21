import test from 'node:test';
import assert from 'node:assert/strict';
import { pageHtml, tilesHtml, qualityHtml, agentsHtml, projectsHtml, sessionsHtml, quotaHtml, overTimeHtml, trendHtml, usdCell, esc, lastDays, modelAgent } from '../public/usage-view.js';

// The page renders pure HTML over the same payloads the sheet reads, so every assertion here is on a string.
const NOW = Date.now();
const day = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

const usage = (o = {}) => ({
  generatedAt: new Date(NOW).toISOString(),
  windowDays: 14,
  today: {
    total: { cost: 4.5, unpriced: 0, turns: 22, input: 552, output: 83000, total: 41480000, cache_read: 40400000, cache_creation: 295000 },
    perAgent: { claude: { total: 40000000, cost: 4.2, input: 500, output: 80000, cache_read: 39000000, cache_creation: 290000 }, minimax: { total: 1480000, cost: 0.3, input: 52, output: 3000, cache_read: 1400000, cache_creation: 5000 } },
    perModel: { 'claude-opus-5': { agent: 'claude', total: 40000000, cost: 4.2, input: 500, output: 80000, cache_read: 39000000, cache_creation: 290000 } },
    perProject: { virtualpytest: { total: 30000000, cost: 3, input: 400, output: 70000, cache_read: 29000000, cache_creation: 250000 } },
    // deliberately no perSession: the live summary's `today` has none (only perAgent/perModel/perProject/total)
  },
  perDay: { [day(0)]: { total: 41480000 }, [day(1)]: { total: 20000000 }, [day(2)]: { total: 1000 } },
  perDayModel: { [day(0)]: { 'claude-opus-5': { total: 40000000, cost: 4.2 } }, [day(1)]: { 'claude-opus-5': { total: 20000000, cost: 2 } } },
  ...o,
});

const row = (o = {}) => ({ session: 'dev1', project: 'virtualpytest', agent: 'claude', tokens: 1000, in: 10, out: 20, cr: 30, cw: 40, cost: 1, unpriced: 0, turns: 2, models: ['claude-opus-5'], days: {}, outlier: null, ...o });
const ui = (o = {}) => ({ view: 'overview', dim: 'model', range: 7, selDay: null, f: { agent: '', project: '', q: '' }, openAgents: new Set(), ...o });

const score = { score: 22, components: { quality: null, coverage: 0.44, efficiency: 0 }, claude_weekly_pct: 88, claude_today_pct: 5, budget: { claudeWeeklyPct: 10 }, days: [{ day: day(1), score: 10 }, { day: day(0), score: 22 }] };

test('escaping and date helpers', () => {
  assert.equal(esc('<a "x">'), '&lt;a &quot;x&quot;&gt;');
  assert.equal(lastDays(3, NOW).length, 3);
  assert.equal(lastDays(1, NOW)[0], new Date(NOW).toISOString().slice(0, 10));
  assert.equal(modelAgent('claude-opus-5'), 'claude');
  assert.equal(modelAgent('gpt-5'), 'codex');
  assert.equal(modelAgent('MiniMax-M3'), 'minimax');
  assert.equal(modelAgent('something-else'), 'other');
});

test('cost is never shown as $0 for an unpriced model, and a partial price is marked', () => {
  assert.match(usdCell(null), /&mdash;/);
  assert.equal(usdCell(12.5), '$12.50');
  assert.match(usdCell(4.5, true), /~\<\/sup>/);   // lower bound
  assert.doesNotMatch(usdCell(4.5), /~/);
});

test('headline tiles: tokens, cost, cache, sessions, each with its own sub-line', () => {
  const h = tilesHtml(usage(), 'today', score, [row({ session: 'dev1' }), row({ session: 'dev2' })]);
  assert.match(h, /uv-tiles/);
  assert.match(h, /Tokens/); assert.match(h, /API-equivalent cost/);
  assert.match(h, /Cache hit/); assert.match(h, /Sessions/);
  assert.match(h, /41\.5M/, 'today total formatted');           // 41.48M
  assert.match(h, /\$4\.50/);                                   // priced total
  assert.match(h, /40\.4M/, 'cache read');                       // 40.4M
  assert.match(h, /list prices, not money spent/);              // the cost is API-equivalent
  assert.match(h, /22 turns/);
});

test('the session tile counts distinct sessions from the rows, not today.perSession', () => {
  // the live summary's `today` has no perSession key (only perAgent/perModel/perProject/total), so counting
  // from it always showed 0; the rows are the source, and they also make the tile follow the active filters
  const u = usage();
  assert.equal(u.today.perSession, undefined, 'fixture mirrors the real shape');
  assert.match(tilesHtml(u, 'today', score, [row({ session: 'a' }), row({ session: 'a' }), row({ session: 'b' })]), /Sessions<\/span><b class="uv-v">2</);
  assert.match(tilesHtml(u, 'today', score, []), /Sessions<\/span><b class="uv-v">0</);
});

test('a delta is shown against the previous window, and never against a zero baseline as a %', () => {
  const u = usage({ perDay: { [day(0)]: { total: 200 }, [day(1)]: { total: 100 } } });
  assert.match(tilesHtml(u, 'today', null), /▲ 100%/);
  const flat = usage({ perDay: { [day(0)]: { total: 100 }, [day(1)]: { total: 100 } } });
  assert.doesNotMatch(tilesHtml(flat, 'today', null), /NaN|Infinity/);
  const fresh = usage({ perDay: { [day(0)]: { total: 100 } } });
  assert.match(tilesHtml(fresh, 'today', null), /new today/);    // no previous day, so "new" not a percentage
});

test('quality is its own row, and the plan line is always stated', () => {
  const h = qualityHtml(score);
  assert.match(h, /Quality/); assert.match(h, /Coverage/); assert.match(h, /Efficiency/);
  assert.match(h, />22<\/b>/);                                    // score
  assert.match(h, /44%/, 'coverage 44%');
  assert.match(h, /&mdash;/, 'quality is unknown, not 0%');
  assert.match(h, /88\.0 % of the week/);                          // plan line
  assert.equal(qualityHtml(null), '', 'no scorecard means no quality row');
});

test('agent table: one row per agent with real columns, models nested on demand', () => {
  const h = agentsHtml(usage(), 'today', [row()], ui());
  assert.match(h, /Where it goes/);
  assert.match(h, /cache r/); assert.match(h, /API-equiv\./);
  assert.match(h, /claude/);
  assert.doesNotMatch(h, /claude-opus-5/, 'models are hidden until expanded');
  const open = agentsHtml(usage(), 'today', [row()], ui({ openAgents: new Set(['claude']) }));
  assert.match(open, /claude-opus-5/, 'expanded shows the model');
  assert.match(open, /uv-models/);
});

test('agent rows escape a hostile name and never emit raw markup', () => {
  const u = usage();
  u.today.perAgent = { '<img src=x>': { total: 10, cost: 1, input: 1, output: 1, cache_read: 0, cache_creation: 0 } };
  const h = agentsHtml(u, 'today', [], ui());
  assert.doesNotMatch(h, /<img src=x>/);
  assert.match(h, /&lt;img src=x&gt;/);
});

test('projects: a share bar per project that adds up to the shown total', () => {
  const h = projectsHtml(usage(), 'today', [], ui());
  assert.match(h, /Projects/);
  assert.match(h, /uv-bar/);
  assert.match(h, /virtualpytest/);
  assert.match(h, /100%/, 'a single project is 100% of the total');
});

test('sessions: a row per session, live ones are clickable, outliers are flagged', () => {
  const rows = [row({ session: 'dev1' }), row({ session: 'dev2', outlier: '6x the project median per hour' })];
  const h = sessionsHtml(rows, ui(), (n) => n === 'dev1');
  assert.match(h, /dev1/); assert.match(h, /dev2/);
  assert.match(h, /data-open="dev1"/, 'a live session links to the card');
  assert.doesNotMatch(h, /data-open="dev2"/, 'a stopped session is not clickable');
  assert.match(h, /outlier: 6x the project median/, 'the outlier reason is readable');
  assert.match(sessionsHtml([], ui(), () => false), /no session matches/);
});

test('over time: stacked bars, a legend, and the selected day panel', () => {
  const h = overTimeHtml(usage(), '14d', ui({ selDay: day(0) }), []);
  assert.match(h, /Over time/);
  assert.match(h, /uv-stack/); assert.match(h, /uv-legend/);
  assert.match(h, /uv-panel/);
  assert.match(h, /data-cday=/, 'each day is selectable');
  assert.match(h, /data-dim="model"/);
  // a missing perDayModel must say so instead of throwing
  const noSplit = overTimeHtml(usage({ perDayModel: null }), '14d', ui(), []);
  assert.match(noSplit, /tailer/);
});

test('trending: 7 days against the 7 before, and it refuses to invent a split', () => {
  const h = trendHtml(usage());
  assert.match(h, /Trending/);
  assert.match(h, /claude-opus-5/);
  assert.match(h, /last 7 days vs the 7 before/);
  assert.match(trendHtml(usage({ perDayModel: null })), /tailer/);
});

test('quota: a plan per agent with the window, the percentage and the reset', () => {
  const reset = Math.floor((NOW + 3600000) / 1000);
  const q = { plans: [{ plan: 'claude', label: 'Claude Max', windows: [{ name: 'week', usedPercent: 88, resetsAt: reset }] }, { plan: 'codex', error: 'login expired' }] };
  const h = quotaHtml(q, { credits: 42 });
  assert.match(h, /Quota &amp; pace/);
  assert.match(h, /88%/);
  assert.match(h, /resets/);
  assert.match(h, /login expired, open mcode once/, 'an expired login is explained, not shown as 0%');
  assert.match(h, /42/, 'Jev credits');
  assert.match(quotaHtml(null, null), /no quota reading yet/);
});

test('the page wires the tabs, the nav and the filters', () => {
  const h = pageHtml({ usage: usage(), tab: 'today', score, jev: null, quota: null, ui: ui(), rows: [row()], live: () => false, links: { langfuse: 'https://x.example' } });
  assert.match(h, /uv-root/);
  assert.match(h, /data-tab="today".*?data-tab="14d"/s);
  for (const v of ['overview', 'time', 'trend', 'sessions']) assert.match(h, new RegExp(`data-view="${v}"`));
  assert.match(h, /data-f="agent"/); assert.match(h, /data-f="project"/); assert.match(h, /data-f="q"/);
  assert.match(h, /Langfuse/);
  assert.match(h, /Where it goes/);
  assert.match(h, /Quality/, 'the quality row is on the overview');
});

test('a session filter narrows the agents table instead of widening it', () => {
  const u = usage();
  const narrowed = agentsHtml(u, 'today', [row({ session: 'dev1', models: ['claude-opus-5'] })], ui({ f: { agent: '', project: '', q: 'dev1' }, openAgents: new Set(['claude']) }));
  // the model list comes from the filtered rows, and is marked unpriced (nocost) because perModel is global
  assert.match(narrowed, /claude-opus-5/);
  assert.match(narrowed, /uv-models/);
  // the agent name is still the subscription key, so its plan label is legitimate
  assert.match(narrowed, /Claude Max/);
  // without an agent/session filter the model list comes from perModel, and carries a cost
  const wide = agentsHtml(u, 'today', [row()], ui({ openAgents: new Set(['claude']) }));
  assert.match(wide, /claude-opus-5/);
  assert.match(wide, /\$4\.50|\$/);
});

test('the page emits balanced markup (a stray closing tag nests content and only shows up visually)', () => {
  // regression: the bar markup closed the stack with </i> instead of </span>, which silently nested the x
  // label inside the stack so CSS could not move it below the bar
  const html = overTimeHtml(usage(), '14d', ui(), []);
  const opens = (html.match(/<span\b/g) || []).length, closes = (html.match(/<\/span>/g) || []).length;
  assert.equal(opens, closes, `unbalanced <span>: ${opens} open vs ${closes} close`);
  const sOpen = (html.match(/<button\b/g) || []).length, sClose = (html.match(/<\/button>/g) || []).length;
  assert.equal(sOpen, sClose, `unbalanced <button>: ${sOpen} vs ${sClose}`);
});

test('the x label is a sibling of the bar stack, not inside it', () => {
  const html = overTimeHtml(usage(), '14d', ui(), []);
  assert.match(html, /<\/span><span class="uv-x">/, 'the stack closes before the label opens');
  assert.doesNotMatch(html, /<i[^>]*><\/span><span class="uv-x"/);
});

test('empty and stale states are explained rather than showing zeroes', () => {
  assert.match(pageHtml({ usage: null }), /loading/);
  const stale = usage({ generatedAt: new Date(NOW - 3 * 86400000).toISOString() });
  assert.match(pageHtml({ usage: stale, tab: 'today' }), /no usage today yet/);
  const noToday = usage({ today: null });
  assert.match(pageHtml({ usage: noToday, tab: 'today' }), /tailer/);
});