// Per-wake log of the AI manager agent, built from its Claude Code transcript (the only complete record of what
// the agent did: manager-actions.jsonl is hand-written and misses most wakes).
//
// A wake starts at each `user` record that is a real prompt (owner), a task-notification (Monitor event / expiry,
// background task, subagent done), a scheduled wakeup prompt (sweep) or a cross-session message (peer), and ends
// before the next one. Tool results, sidechain records, meta records and unknown record types never start a wake.
//
// Pure functions + a small file reader. Priced like usage/ingest.js (same price table, same cost function).

import { join } from 'node:path';
import { readFile, readdir, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { priceFor, costOf } from './usage/ingest.js';

export const WAKES_FILE = 'manager-wakes.jsonl';
export const TRIGGERS = ['owner', 'monitor_event', 'monitor_expired', 'sweep', 'task_done', 'subagent_done', 'peer_message', 'other'];
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PRICES_FILE = join(HERE, 'usage', 'prices.json');

const num = (x) => (Number.isFinite(x) ? x : 0);
const squash = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const ts = (o) => { const t = Date.parse(o && o.timestamp); return Number.isFinite(t) ? t : null; };

export function parseJsonl(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) {
    if (!l) continue;
    try { const o = JSON.parse(l); if (o && typeof o === 'object') out.push(o); } catch { /* bad line */ }
  }
  return out;
}

// Text of a user message (string, or the text blocks of an array). '' when it only holds tool results.
function userText(o) {
  const c = o?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}
const isToolResult = (o) => Array.isArray(o?.message?.content) && o.message.content.some((b) => b && b.type === 'tool_result');

// Pure: the trigger of a user record, or null when it does not start a wake. `agentToolIds` = ids of Agent tool_use blocks
// seen so far (a task-notification that answers one of them is a subagent finishing).
export function classifyTrigger(o, agentToolIds = new Set()) {
  if (!o || o.type !== 'user' || o.isSidechain || isToolResult(o)) return null;
  const text = userText(o);
  const kind = o.origin && typeof o.origin === 'object' ? o.origin.kind : null;
  if (kind === 'task-notification' || /^\s*<task-notification>/.test(text)) {
    if (/<event>/.test(text) || (!/<tool-use-id>/.test(text) && /Monitor expired/.test(text))) return /Monitor expired/.test(text) ? 'monitor_expired' : 'monitor_event';
    const tu = (text.match(/<tool-use-id>\s*([^<\s]+)\s*</) || [])[1];
    if (tu && agentToolIds.has(tu)) return 'subagent_done';
    const tid = (text.match(/<task-id>\s*([^<\s]+)\s*</) || [])[1] || '';
    if (/^a[0-9a-f]{16}$/.test(tid)) return 'subagent_done';
    return 'task_done';
  }
  if (o.promptSource === 'scheduled' || /^\s*(Manager hourly sweep|Scheduled wakeup)/i.test(text)) return text.trim() ? 'sweep' : null;
  if (kind === 'peer') return 'peer_message';
  if (kind === 'human') return text.trim() ? 'owner' : null;
  if (o.isMeta) return null;
  if (kind && text.trim()) return 'other';
  return null;
}

// What a task-notification / peer / prompt says, in one short line (the notification's summary or event body, else the text).
export function summarize(o) {
  const text = userText(o);
  const kind = o?.origin?.kind;
  if (kind === 'peer' && o.origin && typeof o.origin.body === 'string') return squash(o.origin.body, 160);
  const m = text.match(/<event>([\s\S]*?)<\/event>/) || text.match(/<summary>([\s\S]*?)<\/summary>/);
  return squash(m ? m[1] : text, 160);
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
const ACTIONS_LOG = /manager-actions\.jsonl/;
// A Bash command that writes a file (redirect or tee), apart from the agent's own action log and /dev/null.
function bashWritesFile(cmd) {
  const c = String(cmd || '').split('\n').filter((l) => !ACTIONS_LOG.test(l)).join('\n');
  if (/\btee\b/.test(c)) return true;
  for (const m of c.matchAll(/(^|[^0-9&>\\])>>?\s*([^\s&|;)]+)/g)) if (m[2] !== '/dev/null' && !m[2].startsWith('&')) return true;
  return false;
}

function firstLine(text) {
  for (const l of String(text || '').split('\n')) { const s = l.trim(); if (s) return squash(s, 160); }
  return '';
}

// Split transcript records into wakes. opts.prices = the usage price table ({models}); without it usd is null.
export function splitWakes(records, { prices = null } = {}) {
  const wakes = [];
  const agentToolIds = new Set();
  let cur = null;
  const finish = () => { if (cur) wakes.push(cur); cur = null; };
  const msgs = new Map();   // message id -> latest {model, usage}, per wake (a message is written as several lines)

  const close = () => {
    if (!cur) return;
    const tok = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    let usd = 0, priced = false, unpriced = false;
    for (const m of msgs.values()) {
      tok.input += m.usage.input; tok.output += m.usage.output; tok.cache_read += m.usage.cache_read; tok.cache_write += m.usage.cache_write_5m + m.usage.cache_write_1h;
      const c = prices ? costOf(priceFor(prices, m.model), m.usage) : null;
      if (c) { usd += c.total; priced = true; } else unpriced = true;
    }
    msgs.clear();
    const w = cur;
    w.durationSec = Math.max(0, Math.round((w._end - w._start) / 1000));
    w.start = new Date(w._start).toISOString();
    w.end = new Date(w._end).toISOString();
    w.tokens = tok;
    w.usd = priced || !unpriced ? Math.round(usd * 1e6) / 1e6 : null;
    w.nothing = !w.alertsSent && !w.sendsToSessions && !w.workersStarted && !w.fileWrites;
    delete w._start; delete w._end;
    finish();
  };

  for (const o of records) {
    if (!o || typeof o !== 'object') continue;
    const t = ts(o);
    if (o.type === 'user') {
      const trig = classifyTrigger(o, agentToolIds);
      if (trig && t !== null) {
        close();
        cur = { _start: t, _end: t, trigger: trig, triggerSummary: summarize(o), tools: {}, alertsSent: 0, sendsToSessions: 0, workersStarted: 0, fileWrites: 0, decision: '' };
        continue;
      }
    }
    if (!cur) continue;
    if (t !== null && t > cur._end) cur._end = t;
    if (o.type !== 'assistant' || o.isSidechain || !o.message || typeof o.message !== 'object') continue;
    const m = o.message;
    if (m.id && m.usage && m.model && m.model !== '<synthetic>') {
      const u = m.usage, cc = u.cache_creation || {};
      const w5 = num(cc.ephemeral_5m_input_tokens), w1 = num(cc.ephemeral_1h_input_tokens), created = num(u.cache_creation_input_tokens);
      msgs.set(m.id, { model: m.model, usage: { input: num(u.input_tokens), output: num(u.output_tokens), cache_read: num(u.cache_read_input_tokens), cache_write_5m: w5 + w1 ? w5 : created, cache_write_1h: w5 + w1 ? w1 : 0 } });
    }
    if (!Array.isArray(m.content)) continue;
    let text = '';
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      if (b.id && cur._seen?.has(b.id)) continue;
      (cur._seen ||= new Set()).add(b.id);
      cur.tools[b.name] = (cur.tools[b.name] || 0) + 1;
      const input = b.input && typeof b.input === 'object' ? b.input : {};
      if (b.name === 'Agent') { cur.workersStarted++; if (b.id) agentToolIds.add(b.id); }
      if (FILE_TOOLS.has(b.name)) cur.fileWrites++;
      if (b.name === 'Bash') {
        const cmd = String(input.command || '');
        if (cmd.includes('/api/alert')) cur.alertsSent++;
        if (cmd.includes('/api/send/') || cmd.includes('/api/send-many')) cur.sendsToSessions++;
        if (/\bmcode\s+exec\b/.test(cmd)) cur.workersStarted++;
        if (bashWritesFile(cmd)) cur.fileWrites++;
      }
    }
    if (text.trim()) cur.decision = firstLine(text);
  }
  close();
  for (const w of wakes) delete w._seen;
  return wakes.map(order);
}
function order(w) {
  return { start: w.start, end: w.end, durationSec: w.durationSec, trigger: w.trigger, triggerSummary: w.triggerSummary, tools: w.tools, alertsSent: w.alertsSent, sendsToSessions: w.sendsToSessions, workersStarted: w.workersStarted, fileWrites: w.fileWrites, decision: w.decision, tokens: w.tokens, usd: w.usd, nothing: w.nothing };
}

const dayOf = (iso) => String(iso || '').slice(0, 10);   // UTC day, like the usage ledger
export function wakesOfDay(wakes, day) { return day ? wakes.filter((w) => dayOf(w.start) === day) : wakes; }

// Daily summary: wakes by trigger, usd, usd per trigger, top 5 most expensive, share of wakes that did nothing.
export function summarizeWakes(wakes) {
  const byTrigger = {}, usdByTrigger = {};
  let usd = 0, nothing = 0;
  for (const w of wakes) {
    byTrigger[w.trigger] = (byTrigger[w.trigger] || 0) + 1;
    usdByTrigger[w.trigger] = Math.round(((usdByTrigger[w.trigger] || 0) + (w.usd || 0)) * 1e6) / 1e6;
    usd += w.usd || 0;
    if (w.nothing) nothing++;
  }
  const top = wakes.slice().sort((a, b) => (b.usd || 0) - (a.usd || 0)).slice(0, 5);
  return {
    count: wakes.length, usd: Math.round(usd * 1e6) / 1e6, byTrigger, usdByTrigger,
    nothing, nothingShare: wakes.length ? Math.round((nothing / wakes.length) * 1000) / 1000 : 0, top,
  };
}

// ---- file side -------------------------------------------------------------------------------------------------

export function stateDirDefault(env = process.env) { return env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty'); }
export function claudeDirDefault(env = process.env) { return env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects'); }

export async function loadPrices(file = DEFAULT_PRICES_FILE) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

export async function managerSessionLabels(stateDir) {
  try {
    const j = JSON.parse(await readFile(join(stateDir, 'manager.json'), 'utf8'));
    if (Array.isArray(j?.managerSessions) && j.managerSessions.length) return j.managerSessions;
  } catch { /* default */ }
  return ['manager'];
}

// The manager's transcripts: the usage ledger labels every row with its tmux session name, so the Claude session ids whose
// (non-subagent) rows carry a label from managerSessions are the manager's; each is `<claudeDir>/<project dir>/<id>.jsonl`.
// Fallback (no ledger): none. Returns [{ session, file }].
export async function findManagerTranscripts({ stateDir = stateDirDefault(), claudeDir = claudeDirDefault(), labels = null } = {}) {
  const want = new Set(labels || await managerSessionLabels(stateDir));
  const ids = new Set();
  let text = '';
  try { text = await readFile(join(stateDir, 'usage-ledger.jsonl'), 'utf8'); } catch { return []; }
  for (const l of text.split('\n')) {
    if (!l.includes('"label"') || !l.includes('"claude"')) continue;
    try { const r = JSON.parse(l); if (r.agent === 'claude' && !r.subagent && want.has(r.label) && /^[0-9a-f-]{36}$/.test(r.session || '')) ids.add(r.session); } catch { /* bad line */ }
  }
  const out = [];
  let dirs = [];
  try { dirs = await readdir(claudeDir); } catch { return []; }
  for (const id of ids) {
    for (const d of dirs) {
      const file = join(claudeDir, d, `${id}.jsonl`);
      try { await stat(file); out.push({ session: id, file }); break; } catch { /* not in this project dir */ }
    }
  }
  return out;
}

// All wakes of the manager transcript(s), oldest first. `day` (YYYY-MM-DD, UTC) keeps one day.
export async function computeWakes({ stateDir = stateDirDefault(), claudeDir = claudeDirDefault(), day = null, pricesFile = DEFAULT_PRICES_FILE, labels = null } = {}) {
  const prices = await loadPrices(pricesFile);
  const files = await findManagerTranscripts({ stateDir, claudeDir, labels });
  let all = [];
  for (const f of files) {
    let text = '';
    try { text = await readFile(f.file, 'utf8'); } catch { continue; }
    all = all.concat(splitWakes(parseJsonl(text), { prices }).map((w) => ({ ...w, session: f.session })));
  }
  all.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { wakes: wakesOfDay(all, day), transcripts: files.length };
}

// Rewrite <stateDir>/manager-wakes.jsonl with the given day's wakes (idempotent: same input, same file).
export async function writeWakesFile(stateDir, wakes) {
  await mkdir(stateDir, { recursive: true });
  const f = join(stateDir, WAKES_FILE), tmp = `${f}.tmp`;
  await writeFile(tmp, wakes.map((w) => JSON.stringify(w)).join('\n') + (wakes.length ? '\n' : ''));
  await rename(tmp, f);
  return f;
}

// Cached on-demand view for the HTTP route: { day, summary, wakes, transcripts }.
export function createWakesView({ stateDir, claudeDir, ttlMs = 60000, now = Date.now, pricesFile } = {}) {
  const cache = new Map();   // day -> { at, value }
  return async function view(day) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : new Date(now()).toISOString().slice(0, 10);
    const hit = cache.get(d);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const { wakes, transcripts } = await computeWakes({ stateDir, claudeDir, day: d, pricesFile });
    const value = { day: d, transcripts, summary: summarizeWakes(wakes), wakes };
    cache.set(d, { at: now(), value });
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    return value;
  };
}
