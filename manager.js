// AI Manager (TASK-44): watches agent sessions that stop, classifies why (stall.js), asks Jev for
// the ambiguous ones, and logs what it would answer. With autoSend on (off by default) it types the
// safe cases (continue / menu_recommended) after a delay the owner can cancel; everything else is
// escalated to the owner.
//
// State lives in $GHOSTY_STATE_DIR (default ~/.local/state/ghosty):
//   manager.json   { enabled, autoSend, autoCases, minConfidence, delayMs, maxPerSessionPerHour, disabledSessions }
//   stalls.jsonl   {type:'stall'} per stall, {type:'answer'} / {type:'answer_cancelled'} / {type:'escalated'},
//                  and one {type:'outcome'} line when the session moves on
//   jev-budget.json { day, calls, cost }
//
// It never starts, kills or renames sessions.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { classifyStall, applyJev, wouldSend, outcomeKind, setForbiddenExtra } from './stall.js';

const STATE_DIR = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
const CONFIG_FILE = join(STATE_DIR, 'manager.json');
export const LOG_FILE = join(STATE_DIR, 'stalls.jsonl');
const BUDGET_FILE = join(STATE_DIR, 'jev-budget.json');

const SETTLE_MS = Number(process.env.STALL_SETTLE_MS || 5000);       // pane unchanged this long = a stall
const JEV_URL = process.env.JEV_URL || '';                            // VPT server POST /server/ai/decide
const JEV_API_KEY = process.env.JEV_API_KEY || '';
const JEV_DAILY_USD = Number(process.env.JEV_DAILY_USD || 0.25);
const JEV_DAILY_CALLS = Number(process.env.JEV_DAILY_CALLS || 2000);
const AGENTS = new Set(['claude', 'codex', 'minimax']);

setForbiddenExtra(process.env.GHOSTY_FORBIDDEN_EXTRA || '');

export const AUTO_CASES = ['continue', 'menu_recommended'];   // the only cases that may ever auto-send
let config = { enabled: true, autoSend: false, autoCases: [], minConfidence: 0.8, delayMs: 30000, maxPerSessionPerHour: 4, disabledSessions: [] };
let budget = { day: '', calls: 0, cost: 0 };
const watch = new Map();   // session -> { since, hash, stall, pending: {id, at, auto}, last, auto }
const sentLog = new Map(); // session -> [ms epoch of each auto answer] (hourly cap)
let notify = () => {};
let send = { key: null, keys: null };   // injected by server.js: the one tmux code path
let isPaused = () => false;             // injected by server.js: the owner's pause hold (session-meta.js)

const today = () => new Date().toISOString().slice(0, 10);
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);

export async function initManager({ onOwnerNeeded, sendKey, sendKeys, paused } = {}) {
  await mkdir(STATE_DIR, { recursive: true });
  try { config = { ...config, ...JSON.parse(await readFile(CONFIG_FILE, 'utf8')) }; } catch {}
  try { budget = JSON.parse(await readFile(BUDGET_FILE, 'utf8')); } catch {}
  config.autoCases = (config.autoCases || []).filter((c) => AUTO_CASES.includes(c));
  if (onOwnerNeeded) notify = onOwnerNeeded;
  if (sendKey) send.key = sendKey;
  if (sendKeys) send.keys = sendKeys;
  if (paused) isPaused = paused;
  console.log(`[manager] ${config.enabled ? 'on' : 'off'}, auto-send ${config.autoSend ? `ON (${config.autoCases.join(',') || 'no cases'})` : 'off'}, jev ${JEV_URL ? 'on' : 'off'}, log ${LOG_FILE}`);
}

export function managerConfig() {
  return { ...config, validCases: AUTO_CASES, jev: !!JEV_URL, budget: { ...budget, dailyUsd: JEV_DAILY_USD, dailyCalls: JEV_DAILY_CALLS } };
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const num = (v, lo, hi, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw bad(`${name} must be a number in ${lo}..${hi}`);
  return v;
};

export async function setManagerConfig(b = {}) {
  const { enabled, autoSend, autoCases, minConfidence, delayMs, maxPerSessionPerHour, session, sessionEnabled } = b;
  if (typeof enabled === 'boolean') config.enabled = enabled;
  if (typeof autoSend === 'boolean') config.autoSend = autoSend;
  if (autoCases !== undefined) {
    if (!Array.isArray(autoCases) || autoCases.some((c) => !AUTO_CASES.includes(c))) throw bad(`autoCases must be a list of: ${AUTO_CASES.join(', ')}`);
    config.autoCases = [...new Set(autoCases)];
  }
  if (minConfidence !== undefined) config.minConfidence = num(minConfidence, 0, 1, 'minConfidence');
  if (delayMs !== undefined) config.delayMs = Math.round(num(delayMs, 0, 600000, 'delayMs'));
  if (maxPerSessionPerHour !== undefined) config.maxPerSessionPerHour = Math.round(num(maxPerSessionPerHour, 0, 100, 'maxPerSessionPerHour'));
  if (session && typeof sessionEnabled === 'boolean') {
    const set = new Set(config.disabledSessions);
    if (sessionEnabled) set.delete(session); else set.add(session);
    config.disabledSessions = [...set];
  }
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  return managerConfig();
}

const sessionOn = (name) => config.enabled && !config.disabledSessions.includes(name);

async function log(rec) {
  try { await appendFile(LOG_FILE, JSON.stringify(rec) + '\n'); } catch (e) { console.error('[manager] log', e.message); }
}

const logLater = (rec) => log({ at: new Date().toISOString(), ...rec });
// Owner actions that are not stalls ({type:'pause'|'resume', session, by:'owner'}).
export const logEvent = logLater;

const answerText = (a) => (a.text != null ? a.text : `option ${a.key}`);
const hourCount = (name) => {
  const cutoff = Date.now() - 3600e3;
  const a = (sentLog.get(name) || []).filter((t) => t > cutoff);
  sentLog.set(name, a);
  return a.length;
};

// Owner-facing reason a stall is not auto-answered.
function humanWhy(final, ws) {
  const w = String(ws.why || '');
  if (w.startsWith('forbidden: ')) return `${w.slice(11)} question — needs you`;
  if (w.includes('draft')) return 'you have a draft in the input box';
  if (final.case === 'error') return 'agent hit an error or limit — needs you';
  if (final.case === 'permission') return 'permission prompt — needs you';
  if (final.case === 'owner_decision') return 'decision for you — needs you';
  return w || 'needs you';
}

// Why an otherwise-sendable answer must not go out automatically, or null.
function autoBlock(name, final, confidence) {
  if (isPaused(name)) return 'session paused by owner';
  if (!config.autoSend) return 'auto-answer is off';
  if (!config.autoCases.includes(final.case)) return `${final.case} is not an auto-answer case`;
  if (confidence < config.minConfidence) return `confidence ${confidence.toFixed(2)} below ${config.minConfidence}`;
  if (hourCount(name) >= config.maxPerSessionPerHour) return `hourly cap reached (${config.maxPerSessionPerHour})`;
  return null;
}

// A stall that is not auto-answered goes to the owner. A waiting session was already pushed by
// ghosty's own 'waiting' alert, so only a finished turn that asks something is pushed here.
function escalate(name, state, final, id, reason) {
  logLater({ type: 'escalated', id, session: name, case: final.case, reason });
  if (isPaused(name)) return;   // the owner holds this session on purpose: no pings
  if (state === 'done' && final.case !== 'done') notify(name, final, reason);
}

export function cancelAuto(name, reason = 'cancelled by owner', quiet = false) {
  const w = watch.get(name);
  if (!w || !w.auto) return false;
  const a = w.auto;
  clearTimeout(a.timer);
  w.auto = null;
  if (!quiet) logLater({ type: 'answer_cancelled', id: a.id, session: name, case: a.case, answer: a.answer, reason });
  return true;
}

function schedule(name, w, a) {
  cancelAuto(name, 'superseded', true);
  const auto = { ...a, sendAt: Date.now() + config.delayMs };
  auto.timer = setTimeout(() => fire(name, auto).catch((e) => console.error('[manager] fire', e.message)), config.delayMs);
  w.auto = auto;
}

// Fire time: everything is checked again against the latest pane before a single key is typed.
async function fire(name, auto) {
  const w = watch.get(name);
  if (!w || w.auto !== auto) return;
  const last = w.last;
  const ws = w.stall && w.cls ? wouldSend({ ...w.stall, draft: w.cls.draft, forbidden: w.stall.forbidden || w.cls.forbidden }) : { send: null, why: 'owner' };
  let reason = null, esc = false;
  if (isPaused(name)) reason = 'session paused by owner';
  else if (!config.autoSend) reason = 'auto-answer turned off';
  else if (!sessionOn(name)) reason = 'manager disabled for this session';
  else if (!config.autoCases.includes(auto.case)) reason = `${auto.case} no longer an auto-answer case`;
  else if (auto.confidence < config.minConfidence) reason = `confidence ${auto.confidence.toFixed(2)} below ${config.minConfidence}`;
  else if (!last || (last.state !== 'waiting' && last.state !== 'done')) reason = 'session moved on';
  else if (w.hash !== auto.hash) reason = 'pane changed';
  else if (last.lastSendAt && w.pending && last.lastSendAt > w.pending.at) reason = 'owner sent something';
  else if (w.cls?.draft) reason = 'draft in the input box';
  else if (!ws.send) { reason = ws.why; esc = true; }
  else if (!send.key || !send.keys) reason = 'no send function';
  else if (hourCount(name) >= config.maxPerSessionPerHour) { reason = 'hourly cap reached'; esc = true; }
  if (reason) {
    cancelAuto(name, reason);
    if (esc) escalate(name, last?.state, w.stall || { case: auto.case }, auto.id, reason.startsWith('forbidden') ? humanWhy(w.stall || {}, ws) : reason);
    return;
  }
  w.auto = null;
  const a = auto.answer;
  try {
    if (a.key != null) await send.key(name, String(a.key));
    else await send.keys(name, a.text, true);
  } catch (e) {
    logLater({ type: 'answer_cancelled', id: auto.id, session: name, case: auto.case, answer: a, reason: `send failed: ${e.message}` });
    return;
  }
  sentLog.set(name, [...(sentLog.get(name) || []), Date.now()]);
  if (w.pending && w.pending.id === auto.id) w.pending.auto = true;
  logLater({ type: 'answer', id: auto.id, session: name, answer: a, case: auto.case, source: auto.source, confidence: auto.confidence });
}

// Counts since local midnight, for the UI panel.
export async function todayCounts() {
  const since = new Date().setHours(0, 0, 0, 0);
  const c = { answered: 0, cancelled: 0, escalated: 0 };
  try {
    for (const l of (await readFile(LOG_FILE, 'utf8')).split('\n')) {
      if (!l) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (!r.at || Date.parse(r.at) < since) continue;
      if (r.type === 'answer') c.answered++; else if (r.type === 'answer_cancelled') c.cancelled++; else if (r.type === 'escalated') c.escalated++;
    }
  } catch {}
  return c;
}

async function jev(stall) {
  if (!JEV_URL || !JEV_API_KEY) return { skipped: 'not configured' };
  if (budget.day !== today()) budget = { day: today(), calls: 0, cost: 0 };
  if (budget.cost >= JEV_DAILY_USD || budget.calls >= JEV_DAILY_CALLS) return { skipped: 'daily budget reached' };
  const facts = [
    'A coding agent (Claude Code / Codex) running in a terminal has stopped and is waiting. Its closing text:',
    stall.excerpt,
  ];
  if (stall.suggestion) facts.push(`(The agent's own guess at the owner's next prompt: "${stall.suggestion}")`);
  const body = {
    usage: 'text.decision', profile: 'jev', log: false, timeout_s: 20,
    state: facts.join('\n\n'),
    questions: { choice: { type: 'choice',
      instructions: 'What should happen next so the work keeps moving without a wrong decision being made for the owner?',
      criteria: {
        continue: 'The agent finished a step of work it already planned and only asks, or would only ask, whether to carry on. Saying "yes, continue" cannot make a choice the owner should make.',
        take_recommended: 'The agent offers options and clearly marks one as its recommendation; taking it is a safe default.',
        ask_owner: 'The agent needs information, a preference, an approval, or a choice between different directions that only the owner can give; or it is genuinely finished.',
      } } },
  };
  const started = Date.now();
  try {
    const r = await fetch(JEV_URL, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': JEV_API_KEY },
      body: JSON.stringify(body), signal: AbortSignal.timeout(25000),
    });
    const j = await r.json();
    budget.calls += 1;
    budget.cost += Number(j.cost || 0);
    writeFile(BUDGET_FILE, JSON.stringify(budget)).catch(() => {});
    const a = j.answers?.choice;
    if (!j.success || !a) return { error: String(j.error || `http ${r.status}`).slice(0, 200), ms: Date.now() - started };
    return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, cost: j.cost, ms: j.ms ?? Date.now() - started, model: j.model };
  } catch (e) {
    return { error: e.message, ms: Date.now() - started };
  }
}

// What the owner typed to move the session on: a ghosty send, else the newest prompt line in the body.
function ownerReply(plain, sentText) {
  if (sentText) return { via: 'ghosty', text: sentText };
  for (let i = plain.length - 1, rules = 0; i >= 0 && i >= plain.length - 400; i--) {
    const l = plain[i];
    if (/^\s*[─━]{4,}/.test(l)) { rules++; continue; }
    if (rules < 2) continue;   // skip the input box at the bottom
    const m = l.match(/^\s*[❯›>]\s+(\S.*)$/);
    if (m && !/^\d+[.)]\s/.test(m[1])) return { via: 'terminal', text: m[1].trim() };
  }
  return { via: 'unknown', text: null };
}

// Called every tick for every session, after ghosty computed its state.
//   s = { name, state, agent, plain, raw, changed, project, lastSendAt, lastSendText, now }
export function observe(s) {
  if (!AGENTS.has(s.agent)) { watch.delete(s.name); return null; }
  let w = watch.get(s.name);
  if (!w) { w = { since: s.now, hash: null, stall: null, pending: null, seen: false }; watch.set(s.name, w); }

  w.last = { state: s.state, lastSendAt: s.lastSendAt || null, now: s.now };
  const stopped = s.state === 'waiting' || s.state === 'done';
  if (!stopped) {
    if (w.auto) cancelAuto(s.name, 'session moved on');
    // The session moved on: settle the outcome of the last stall.
    if (w.pending && s.state === 'working') {
      const p = w.pending;
      const sent = s.lastSendAt && s.lastSendAt > p.at ? s.lastSendText : null;
      const reply = ownerReply(s.plain, sent);
      log({ type: 'outcome', id: p.id, session: s.name, at: new Date(s.now).toISOString(), afterSec: Math.round((s.now - p.at) / 1000),
        via: p.auto ? 'manager' : reply.via, reply: reply.text ? reply.text.slice(0, 300) : null, kind: reply.text ? outcomeKind(reply.text) : 'unknown' });
      w.pending = null;
    }
    w.hash = null; w.stall = null; w.since = s.now;
    w.seen = true;
    return null;
  }

  // Classify only when the pane changed (or the state did); a still pane gives the same answer.
  const key = `${s.state}`;
  if (s.changed || !w.cls || w.clsKey !== key) { w.cls = classifyStall({ plain: s.plain, raw: s.raw, state: s.state }); w.clsKey = key; }
  const stall = w.cls;
  if (w.auto && stall.draft) cancelAuto(s.name, 'draft in the input box');
  const h = hash(`${stall.case}|${stall.excerpt}`);
  if (h !== w.hash) { if (w.auto) cancelAuto(s.name, 'pane changed'); w.hash = h; w.since = s.now; w.logged = false; w.stall = stall; }
  // First sight after a restart: don't log stalls that were already sitting there.
  if (!w.seen) { w.logged = true; w.seen = true; return w.stall; }
  if (w.logged || s.now - w.since < SETTLE_MS || !sessionOn(s.name)) return w.stall;
  w.logged = true;

  const id = randomUUID();
  w.pending = { id, at: s.now };
  (async () => {
    let final = stall, jevOut = null;
    if (stall.source === 'ambiguous') {
      jevOut = await jev(stall);
      if (jevOut.choice) final = applyJev(stall, jevOut.choice);
    }
    if (w.hash !== h) return;   // the pane moved on while Jev was thinking: that stall is gone
    const ws = wouldSend(final);
    const confidence = final.source === 'jev' ? Number(jevOut?.probabilities?.[jevOut.choice] ?? jevOut?.confidence ?? 0) : 1;
    w.stall = { ...final, would: ws };
    await log({
      type: 'stall', id, session: s.name, project: s.project || null, agent: s.agent, state: s.state,
      at: new Date(s.now).toISOString(), case: final.case, source: final.source, question: final.question,
      forbidden: final.forbidden, draft: final.draft, suggestion: final.suggestion,
      jev: jevOut, wouldSend: ws.send, why: ws.why, confidence, excerpt: stall.excerpt,
    });
    if (!ws.send) {
      if (final.case !== 'done') escalate(s.name, s.state, final, id, humanWhy(final, ws));
      return;
    }
    const block = autoBlock(s.name, final, confidence);
    if (block) { escalate(s.name, s.state, final, id, block); return; }
    schedule(s.name, w, { id, hash: h, answer: ws.send, case: final.case, source: final.source, confidence });
  })().catch((e) => console.error('[manager]', e.message));
  return w.stall;
}

export function forget(name) { cancelAuto(name, 'session removed'); watch.delete(name); }
export function prune(live) { for (const k of [...watch.keys()]) if (!live.has(k)) forget(k); }

export function stallOf(name) {
  const w = watch.get(name);
  return w && w.stall ? { case: w.stall.case, source: w.stall.source, would: w.stall.would || null, question: w.stall.question } : null;
}

// The pending automatic answer for the UI countdown: { sendAt, answer, case, id } or null.
export function autoOf(name) {
  const a = watch.get(name)?.auto;
  return a ? { sendAt: a.sendAt, answer: answerText(a.answer), case: a.case, id: a.id } : null;
}
