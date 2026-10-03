// AI Manager (TASK-44): watches agent sessions that stop, classifies why (stall.js), asks Jev for
// the ambiguous ones, and logs what it WOULD answer. Phase 2 is shadow mode: it never types.
//
// State lives in $GHOSTY_STATE_DIR (default ~/.local/state/ghosty):
//   manager.json   { enabled, autoSend, disabledSessions: [] }   (autoSend stays false in shadow mode)
//   stalls.jsonl   one {type:'stall'} line per stall, one {type:'outcome'} line when the session moves on
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

let config = { enabled: true, autoSend: false, disabledSessions: [] };
let budget = { day: '', calls: 0, cost: 0 };
const watch = new Map();   // session -> { since, hash, stall, pending: {id, at, sentBaseline} }
let notify = () => {};

const today = () => new Date().toISOString().slice(0, 10);
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);

export async function initManager({ onOwnerNeeded } = {}) {
  await mkdir(STATE_DIR, { recursive: true });
  try { config = { ...config, ...JSON.parse(await readFile(CONFIG_FILE, 'utf8')) }; } catch {}
  try { budget = JSON.parse(await readFile(BUDGET_FILE, 'utf8')); } catch {}
  config.autoSend = false;   // shadow mode (phase 2): never type, whatever the file says
  if (onOwnerNeeded) notify = onOwnerNeeded;
  console.log(`[manager] ${config.enabled ? 'on' : 'off'}, shadow mode, jev ${JEV_URL ? 'on' : 'off'}, log ${LOG_FILE}`);
}

export function managerConfig() {
  return { ...config, shadow: true, jev: !!JEV_URL, budget: { ...budget, dailyUsd: JEV_DAILY_USD, dailyCalls: JEV_DAILY_CALLS } };
}

export async function setManagerConfig({ enabled, session, sessionEnabled }) {
  if (typeof enabled === 'boolean') config.enabled = enabled;
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

  const stopped = s.state === 'waiting' || s.state === 'done';
  if (!stopped) {
    // The session moved on: settle the outcome of the last stall.
    if (w.pending && s.state === 'working') {
      const p = w.pending;
      const sent = s.lastSendAt && s.lastSendAt > p.at ? s.lastSendText : null;
      const reply = ownerReply(s.plain, sent);
      log({ type: 'outcome', id: p.id, session: s.name, at: new Date(s.now).toISOString(), afterSec: Math.round((s.now - p.at) / 1000),
        via: reply.via, reply: reply.text ? reply.text.slice(0, 300) : null, kind: reply.text ? outcomeKind(reply.text) : 'unknown' });
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
  const h = hash(`${stall.case}|${stall.excerpt}`);
  if (h !== w.hash) { w.hash = h; w.since = s.now; w.logged = false; w.stall = stall; }
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
    const ws = wouldSend(final);
    w.stall = { ...final, would: ws };
    await log({
      type: 'stall', id, session: s.name, project: s.project || null, agent: s.agent, state: s.state,
      at: new Date(s.now).toISOString(), case: final.case, source: final.source, question: final.question,
      forbidden: final.forbidden, draft: final.draft, suggestion: final.suggestion,
      jev: jevOut, wouldSend: ws.send, why: ws.why, excerpt: stall.excerpt,
    });
    // Shadow mode: nothing is typed, so every question waits on the owner. Ghosty already pushes
    // 'waiting'; a finished turn that asks something is pushed here.
    if (s.state === 'done' && final.case !== 'done') notify(s.name, final);
  })().catch((e) => console.error('[manager]', e.message));
  return w.stall;
}

export function forget(name) { watch.delete(name); }
export function prune(live) { for (const k of [...watch.keys()]) if (!live.has(k)) watch.delete(k); }

export function stallOf(name) {
  const w = watch.get(name);
  return w && w.stall ? { case: w.stall.case, source: w.stall.source, would: w.stall.would || null, question: w.stall.question } : null;
}
