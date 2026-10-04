// AI Manager (TASK-44): watches agent sessions that stop, classifies why (stall.js), asks Jev for
// the ambiguous ones, and logs what it would answer. With autoSend on (off by default) it types the
// safe cases (continue / menu_recommended) after a delay the owner can cancel; everything else is
// escalated to the owner.
//
// State lives in $GHOSTY_STATE_DIR (default ~/.local/state/ghosty):
//   manager.json   { enabled, autoSend, autoCases, minConfidence, delayMs, maxPerSessionPerHour, disabledSessions,
//                    policyEnabled, p1MaxPct, p2MaxPct }  (policy: public/policy.js)
//   stalls.jsonl   {type:'stall'} per stall, {type:'answer'} / {type:'answer_cancelled'} / {type:'escalated'},
//                  {type:'hold'|'resume', by:'manager'|'owner'} for quota holds (phase 6),
//                  one {type:'outcome'} line when the session moves on after REAL work (a spinner, or a send),
//                  and {type:'label'} owner labels on a stall ("this stop bothered me", POST /api/manager/label),
//                  {type:'unlabel', id} withdraws the newest label of a stall (swipe page undo; the stop is unlabelled again)
//   jev-budget.json { day, calls, cost }
//   decision-outcomes.json  outcomes not yet accepted by the server's decision log (retried every 5 min, dropped after 7 days)
//
// It never starts, kills or renames sessions.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { POLICY_DEFAULTS } from './public/policy.js';
import { classifyStall, applyJev, wouldSend, outcomeKind, setForbiddenExtra, forbiddenMatch } from './stall.js';
import { actorOf } from './api-extras.js';
import { jevAgreesOwner } from './public/ask-model.js';
import { AI_MODES, AI_NEVER_CASES, REVIEWER_SYSTEM, createBudget, callReviewer, reviewerUrl } from './triage.js';
import { createPromptSource } from './prompts.js';
import { createDecisionsClient, createOutcomeQueue, outcomeFromLabel, outcomeFromReplyKind, outcomeBody, jevRequestBody, effectiveLabels, effectiveAiVerdicts, tabData, decisionsPage, MANAGER_USAGE, FALLBACK_USAGE } from './decisions.js';

const STATE_DIR = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
const CONFIG_FILE = join(STATE_DIR, 'manager.json');
export const LOG_FILE = join(STATE_DIR, 'stalls.jsonl');
const BUDGET_FILE = join(STATE_DIR, 'jev-budget.json');
const LAST_STOPS_FILE = join(STATE_DIR, 'last-stops.json');   // session -> keys of the last 5 stops logged (survives a restart)
const AI_BUDGET_FILE = join(STATE_DIR, 'ai-budget.json');
const OUTCOME_QUEUE_FILE = join(STATE_DIR, 'decision-outcomes.json');

const SETTLE_MS = Number(process.env.STALL_SETTLE_MS || 5000);       // pane unchanged this long = a stall
const JEV_URL = process.env.JEV_URL || '';                            // VPT server POST /server/ai/decide
const JEV_API_KEY = process.env.JEV_API_KEY || '';
const JEV_DAILY_USD = Number(process.env.JEV_DAILY_USD || 0.25);
const JEV_DAILY_CALLS = Number(process.env.JEV_DAILY_CALLS || 2000);
const AI_URL = process.env.AI_URL || reviewerUrl(JEV_URL);          // the reviewer: POST /server/ai/complete on the same server as Jev
const VPT_TEAM_ID = process.env.VPT_TEAM_ID || '';                    // team of the VPT server's decision log (see /server/health); unset = Jev calls are not logged
// The reviewer's system prompt comes from Langfuse prompts (`ghosty-ai-reviewer`, label production) when LANGFUSE_* is set; REVIEWER_SYSTEM is the fallback.
const reviewerPrompt = createPromptSource({ cfg: { langfuseUrl: process.env.LANGFUSE_URL || '', publicKey: process.env.LANGFUSE_PUBLIC_KEY || '', secretKey: process.env.LANGFUSE_SECRET_KEY || '' }, fallback: REVIEWER_SYSTEM });
const decisions = createDecisionsClient({ jevUrl: JEV_URL, apiKey: JEV_API_KEY, teamId: VPT_TEAM_ID });
const outcomeQueue = createOutcomeQueue({ file: OUTCOME_QUEUE_FILE, send: (id, outcome) => decisions.postOutcome(id, outcome) });
const decisionByStop = new Map();   // stop id -> the product's decision_id of its Jev call (outcome write-back)
const AGENTS = new Set(['claude', 'codex', 'minimax']);
export const CASES = ['continue', 'menu_recommended', 'permission', 'owner_decision', 'done', 'error', 'stopped_short', 'waiting_deploy', 'owner_action', 'background_wait'];
export const LABELS = ['no_reason', 'legit', 'wrong_case'];

setForbiddenExtra(process.env.GHOSTY_FORBIDDEN_EXTRA || '');

export const AUTO_CASES = ['continue', 'menu_recommended', 'stopped_short', 'ask_status'];   // the only cases that may ever auto-send
let config = { enabled: true, autoSend: false, autoCases: [], minConfidence: 0.8, delayMs: 30000, maxPerSessionPerHour: 4, disabledSessions: [], deployRunner: false,
  jevUsage: 'auto', aiTriage: 'simulate', aiMinConfidence: 0.85, aiDailyUsd: 1.0, aiDailyCalls: 300, aiAutoCases: [],   // the owner picks; owner_decision is never a default
  ...POLICY_DEFAULTS };
let budget = { day: '', calls: 0, cost: 0 };
const RECENT_STOPS = 5;
let lastStops = {};
let lastStopsWrite = Promise.resolve();
const saveLastStops = () => { lastStopsWrite = lastStopsWrite.then(() => writeFile(LAST_STOPS_FILE, JSON.stringify(lastStops))).catch(() => {}); };
const aiBudget = createBudget(AI_BUDGET_FILE);
const triages = new Map();   // stop id -> triage result (one reviewer call per stop)
let triageContext = () => ({});   // injected by server.js: (session) -> { priority, quota, leases, deploys }
let reviewerFetch = (...a) => fetch(...a);
const watch = new Map();   // session -> { since, hash, stall, pending: {id, at, auto}, last, auto }
const sentLog = new Map(); // session -> [ms epoch of each auto answer] (hourly cap)
let notify = () => {};
let send = { key: null, keys: null };   // injected by server.js: the one tmux code path
let isPaused = () => false;             // injected by server.js: the owner's pause hold (session-meta.js)
let policyOf = () => ({ action: 'allow', reason: 'no policy' });   // injected: (session, agent) -> { action, reason } (public/policy.js + quota)
let held = { get: () => null, set: () => {} };                      // injected: the manager's own hold, kept apart from the owner's pause
let notifyHold = () => {};                                          // injected: (session, 'hold'|'resume', reason) -> owner alert

const today = () => new Date().toISOString().slice(0, 10);
// Identity of a stop's text regardless of how the pane wraps it: a resized window re-wraps the same words
// (and the 16-line excerpt then starts elsewhere), so compare the tail with all whitespace removed.
export const stopKey = (text) => String(text || '').replace(/\s+/g, '').slice(-400);
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);

export async function initManager({ onOwnerNeeded, sendKey, sendKeys, paused, policy, heldStore, onHold, context } = {}) {
  await mkdir(STATE_DIR, { recursive: true });
  try { config = { ...config, ...JSON.parse(await readFile(CONFIG_FILE, 'utf8')) }; } catch {}
  try { budget = JSON.parse(await readFile(BUDGET_FILE, 'utf8')); } catch {}
  try { lastStops = JSON.parse(await readFile(LAST_STOPS_FILE, 'utf8')) || {}; } catch { lastStops = {}; }
  await aiBudget.load();
  config.autoCases = (config.autoCases || []).filter((c) => AUTO_CASES.includes(c));
  config.aiAutoCases = (config.aiAutoCases || []).filter((c) => CASES.includes(c) && !AI_NEVER_CASES.includes(c));
  if (!AI_MODES.includes(config.aiTriage)) config.aiTriage = 'simulate';
  if (!/^(auto|text\.decision(\.[a-z0-9_]+)*)$/.test(String(config.jevUsage))) config.jevUsage = 'auto';
  if (decisions.configured) { outcomeQueue.flush().catch(() => {}); setInterval(() => outcomeQueue.flush().catch(() => {}), 5 * 60e3).unref(); }
  if (context) triageContext = context;
  if (onOwnerNeeded) notify = onOwnerNeeded;
  if (sendKey) send.key = sendKey;
  if (sendKeys) send.keys = sendKeys;
  if (paused) isPaused = paused;
  if (policy) policyOf = policy;
  if (heldStore) held = heldStore;
  if (onHold) notifyHold = onHold;
  console.log(`[manager] ${config.enabled ? 'on' : 'off'}, auto-send ${config.autoSend ? `ON (${config.autoCases.join(',') || 'no cases'})` : 'off'}, jev ${JEV_URL ? 'on' : 'off'}, ai triage ${config.aiTriage}${AI_URL ? '' : ' (no server)'}, log ${LOG_FILE}`);
}

export const deployRunnerOn = () => config.deployRunner === true;
export const policyConfig = () => ({ policyEnabled: config.policyEnabled, p1MaxPct: config.p1MaxPct, p2MaxPct: config.p2MaxPct });

// Links into the local Langfuse for the manager panel (scores, dataset, evaluator, prompt). Empty when LANGFUSE_PUBLIC_URL / LANGFUSE_URL is unset.
export function langfuseLinks(env = process.env) {
  const base = String(env.LANGFUSE_PUBLIC_URL || env.LANGFUSE_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  const p = `${base}/project/${encodeURIComponent(env.LANGFUSE_PROJECT || 'codebox-usage')}`;
  return { scores: `${p}/scores`, dataset: `${p}/datasets`, evaluator: `${p}/evals`, prompt: `${p}/prompts/ghosty-ai-reviewer`, promptName: 'ghosty-ai-reviewer' };
}

export function managerConfig() {
  return { ...config, langfuse: langfuseLinks(), validCases: AUTO_CASES, cases: CASES, jev: !!JEV_URL, jevLogged: decisions.configured, jevUsage: config.jevUsage, budget: { ...budget, dailyUsd: JEV_DAILY_USD, dailyCalls: JEV_DAILY_CALLS },
    ai: !!(AI_URL && JEV_API_KEY), aiModes: AI_MODES, aiBudget: { ...aiBudget.snapshot(), dailyUsd: config.aiDailyUsd, dailyCalls: config.aiDailyCalls } };
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const num = (v, lo, hi, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw bad(`${name} must be a number in ${lo}..${hi}`);
  return v;
};

export async function setManagerConfig(b = {}) {
  const { jevUsage, enabled, autoSend, autoCases, minConfidence, delayMs, maxPerSessionPerHour, session, sessionEnabled, policyEnabled, p1MaxPct, p2MaxPct, deployRunner, aiTriage, aiMinConfidence, aiDailyUsd, aiDailyCalls, aiAutoCases } = b;
  if (typeof enabled === 'boolean') config.enabled = enabled;
  if (typeof autoSend === 'boolean') config.autoSend = autoSend;
  if (autoCases !== undefined) {
    if (!Array.isArray(autoCases) || autoCases.some((c) => !AUTO_CASES.includes(c))) throw bad(`autoCases must be a list of: ${AUTO_CASES.join(', ')}`);
    config.autoCases = [...new Set(autoCases)];
  }
  if (minConfidence !== undefined) config.minConfidence = num(minConfidence, 0, 1, 'minConfidence');
  if (delayMs !== undefined) config.delayMs = Math.round(num(delayMs, 0, 600000, 'delayMs'));
  if (maxPerSessionPerHour !== undefined) config.maxPerSessionPerHour = Math.round(num(maxPerSessionPerHour, 0, 100, 'maxPerSessionPerHour'));
  if (jevUsage !== undefined) { if (!/^(auto|text\.decision(\.[a-z0-9_]+)*)$/.test(String(jevUsage))) throw bad('jevUsage must be "auto" or a text.decision usage key'); config.jevUsage = jevUsage; }
  if (aiTriage !== undefined) { if (!AI_MODES.includes(aiTriage)) throw bad(`aiTriage must be one of: ${AI_MODES.join(', ')}`); config.aiTriage = aiTriage; }
  if (aiMinConfidence !== undefined) config.aiMinConfidence = num(aiMinConfidence, 0, 1, 'aiMinConfidence');
  if (aiDailyUsd !== undefined) config.aiDailyUsd = num(aiDailyUsd, 0, 100, 'aiDailyUsd');
  if (aiDailyCalls !== undefined) config.aiDailyCalls = Math.round(num(aiDailyCalls, 0, 10000, 'aiDailyCalls'));
  if (aiAutoCases !== undefined) {
    if (!Array.isArray(aiAutoCases) || aiAutoCases.some((c) => !CASES.includes(c) || AI_NEVER_CASES.includes(c))) throw bad(`aiAutoCases must be a list of: ${CASES.filter((c) => !AI_NEVER_CASES.includes(c)).join(', ')}`);
    config.aiAutoCases = [...new Set(aiAutoCases)];
  }
  if (typeof policyEnabled === 'boolean') config.policyEnabled = policyEnabled;
  if (typeof deployRunner === 'boolean') config.deployRunner = deployRunner;
  if (p1MaxPct !== undefined) config.p1MaxPct = num(p1MaxPct, 1, 100, 'p1MaxPct');
  if (p2MaxPct !== undefined) config.p2MaxPct = num(p2MaxPct, 1, 100, 'p2MaxPct');
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
  if (final.case === 'waiting_deploy') return 'deploy waiting — queue it (Phase 7)';
  if (final.case === 'owner_action') return `needs you: ${final.action || 'a manual step'}`;
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
  const key = final.autoCase || final.case;
  if (!config.autoCases.includes(key)) return `${key} is not an auto-answer case`;
  if (confidence < config.minConfidence) return `confidence ${confidence.toFixed(2)} below ${config.minConfidence}`;
  if (hourCount(name) >= config.maxPerSessionPerHour) return `hourly cap reached (${config.maxPerSessionPerHour})`;
  return null;
}

// The AI's proposal as an automatic answer: its own switch (aiTriage 'auto') on top of autoSend, its own case list and threshold.
function aiBlock(name, kase, confidence) {
  if (isPaused(name)) return 'session paused by owner';
  if (config.aiTriage !== 'auto') return 'AI auto-answer is off';
  if (!config.autoSend) return 'auto-answer is off';
  if (!config.aiAutoCases.includes(kase)) return `${kase} is not an AI auto-answer case`;
  if (confidence < config.aiMinConfidence) return `AI confidence ${confidence.toFixed(2)} below ${config.aiMinConfidence}`;
  if (hourCount(name) >= config.maxPerSessionPerHour) return `hourly cap reached (${config.maxPerSessionPerHour})`;
  return null;
}

// A stall that is not auto-answered goes to the owner. A waiting session was already pushed by
// ghosty's own 'waiting' alert, so only a finished turn that asks something is pushed here.
function escalate(name, state, final, id, reason, aiLine = null) {
  logLater({ type: 'escalated', id, session: name, case: final.case, reason });
  if (isPaused(name)) return;   // the owner holds this session on purpose: no pings
  if (state === 'done' && final.case !== 'done') notify(name, aiLine ? { ...final, aiLine } : final, reason);
}

// ---- AI reviewer (phase 9) ----
// Stops that go to the owner: everything except background work and a plain finished turn without a question.
export const toOwnerCase = (final) => final.case !== 'background_wait' && (final.case !== 'done' || /\?/.test(final.question || ''));

const QUOTA_NAMES = { claude: 'Claude Max', codex: 'Codex', minimax: 'MiniMax' };
const oneLine = (rec) => (rec?.ai ? `${rec.ai.owner_needed ? 'needs you' : 'proposes'}${rec.ai.proposed_reply ? ` "${rec.ai.proposed_reply}"` : ''}` : null);

// One reviewer call per stop (cached by stop id). Returns the triage record, or null when AI triage is off.
export async function triageStop({ name, id, final, jevOut, state, agent, project, stall }) {
  if (config.aiTriage === 'off') return null;
  if (triages.has(id)) return triages.get(id);
  const rec = { type: 'triage', id, session: name, at: new Date().toISOString(), case: final.case, mode: config.aiTriage };
  const finish = async (extra, logIt = true) => { Object.assign(rec, extra); triages.set(id, rec); if (triages.size > 300) triages.delete(triages.keys().next().value); if (logIt) await log(rec); return rec; };
  if (!AI_URL || !JEV_API_KEY) return finish({ skipped: 'not configured' }, false);
  if (aiBudget.over(config.aiDailyUsd, config.aiDailyCalls)) return finish({ skipped: 'AI daily budget reached' });
  const ctx = (() => { try { return triageContext(name, final) || {}; } catch { return {}; } })();
  const deployish = final.case === 'waiting_deploy' || !!final.deployHint || /deploy/i.test(final.forbidden || '');   // lease + deploy-queue state only matters here
  const flags = [final.forbidden ? `forbidden topic: "${final.forbidden}"` : null, stall.draft ? 'the owner has an unsent draft in the input box' : null,
    final.no_status ? 'closing text gives no done / tested / left status' : null, final.deployHint ? 'mentions a deploy' : null].filter(Boolean);
  const facts = { session: name, agent, project, priority: ctx.priority, state, case: final.case, source: final.source, flags,
    jev: jevOut?.choice ? jevOut : null, quota: ctx.quota, ...(deployish ? { leases: ctx.leases, deploys: ctx.deploys } : {}), text: stall.excerpt || final.question || '' };
  const prompt = await reviewerPrompt.get();
  const r = await callReviewer({ url: AI_URL, apiKey: JEV_API_KEY, facts, system: prompt.text, fetchFn: reviewerFetch });
  aiBudget.add(r.cost || 0);
  // what the eval sync and the Langfuse generation show: the prompt version used and the facts' flags (no closing text)
  const ctxInfo = { ...(prompt.version != null ? { prompt: { name: prompt.name, version: prompt.version } } : {}), src: final.source, flags };
  return finish(r.ai ? { ...ctxInfo, ai: r.ai, cost: r.cost, costEstimated: r.costEstimated, ms: r.ms, model: r.model, tin: r.tin, tout: r.tout } : { ...ctxInfo, error: r.error, cost: r.cost || 0, ms: r.ms });
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

// Quota holds (phase 6). A hold only stops a stopped session from being continued; it never types
// and never interrupts. It lives in session-meta (apart from the owner's pause) and is released when
// the policy allows again, on the owner's Resume, or when the session moves on by itself.
const holdOf = (name) => held.get(name) || null;

function applyHold(name, w, pending, pol) {
  w.heldStall = pending;
  const prev = holdOf(name);
  if (prev && prev.reason === pol.reason) return;
  held.set(name, { by: 'manager', reason: pol.reason, at: new Date().toISOString() });
  if (prev) return;   // same hold, new numbers: no second alert
  logLater({ type: 'hold', session: name, by: 'manager', reason: pol.reason });
  notifyHold(name, 'hold', pol.reason);
}

function endHold(name, by, reason, push) {
  const w = watch.get(name);
  if (w) w.heldStall = null;
  held.set(name, null);
  logLater({ type: 'resume', session: name, by, reason });
  if (push) notifyHold(name, 'resume', reason);
}

// The owner's Resume clears a manager hold too. Returns true when there was one.
export function releaseHold(name) {
  if (!holdOf(name)) return false;
  endHold(name, 'owner', 'released by owner', false);
  return true;
}
export const heldOf = (name) => holdOf(name);

// Every quota poll: held sessions whose policy now allows are released, and a session still stopped at
// the same stall with an allowed answer is scheduled normally (usual countdown / cancel).
export function reevaluateHolds() {
  for (const [name, w] of watch) {
    if (!holdOf(name)) continue;
    const pol = policyOf(name, w.agent);
    if (pol.action === 'hold') { if (pol.reason !== holdOf(name).reason) held.set(name, { ...holdOf(name), reason: pol.reason }); continue; }
    const p = w.heldStall;
    endHold(name, 'manager', `quota recovered: ${pol.reason}`, true);
    const stopped = w.last && (w.last.state === 'waiting' || w.last.state === 'done');
    if (!p || !stopped || w.hash !== p.hash || !sessionOn(name)) continue;
    if (p.source === 'ai' ? aiBlock(name, p.case, p.confidence) : autoBlock(name, { case: p.case }, p.confidence)) continue;
    schedule(name, w, p);
  }
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
  const ai = auto.source === 'ai';   // the AI reviewer's proposal, auto mode: same gates, plus its own switch and a re-check of the reply itself
  const forb = (w.stall?.forbidden || w.cls?.forbidden) || (ai ? forbiddenMatch(auto.answer?.text || '') : null);
  const ws = ai ? (forb ? { send: null, why: `forbidden: ${forb}` } : w.cls?.draft ? { send: null, why: 'owner has a draft in the input box' } : { send: auto.answer, why: 'ai' })
    : w.stall && w.cls ? wouldSend({ ...w.stall, draft: w.cls.draft, forbidden: w.stall.forbidden || w.cls.forbidden }) : { send: null, why: 'owner' };
  let reason = null, esc = false;
  if (isPaused(name)) reason = 'session paused by owner';
  else if (!config.autoSend) reason = 'auto-answer turned off';
  else if (!sessionOn(name)) reason = 'manager disabled for this session';
  else if (ai && config.aiTriage !== 'auto') reason = 'AI auto-answer turned off';
  else if (ai && !config.aiAutoCases.includes(auto.case)) reason = `${auto.case} no longer an AI auto-answer case`;
  else if (!ai && !config.autoCases.includes(auto.case)) reason = `${auto.case} no longer an auto-answer case`;
  else if (auto.confidence < (ai ? config.aiMinConfidence : config.minConfidence)) reason = `confidence ${auto.confidence.toFixed(2)} below ${ai ? config.aiMinConfidence : config.minConfidence}`;
  else if (!last || (last.state !== 'waiting' && last.state !== 'done')) reason = 'session moved on';
  else if (w.hash !== auto.hash) reason = 'pane changed';
  else if (last.lastSendAt && w.pending && last.lastSendAt > w.pending.at) reason = 'owner sent something';
  else if (w.cls?.draft) reason = 'draft in the input box';
  else if (!ws.send) { reason = ws.why; esc = true; }
  else if (w.agent && policyOf(name, w.agent).action === 'hold') { const pol = policyOf(name, w.agent); applyHold(name, w, { id: auto.id, hash: auto.hash, answer: auto.answer, case: auto.case, source: auto.source, confidence: auto.confidence }, pol); reason = `held: ${pol.reason}`; }
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

// Owner label on a logged stall ("this stop bothered me"). Appended; the newest label of an id wins.
// correctCase (the manager chose the wrong case) may ride on any label; with label wrong_case it is the label itself.
export const AI_VERDICTS = ['right', 'wrong'];
export async function labelStall({ id, label, note, correctCase, aiVerdict, by } = {}) {
  const actor = actorOf({ by });
  if (typeof id !== 'string' || !id) throw bad('id required');
  if (aiVerdict != null && !AI_VERDICTS.includes(aiVerdict)) throw bad(`aiVerdict must be one of: ${AI_VERDICTS.join(', ')}`);
  // aiVerdict may ride on a normal label, or stand alone (no label): then the stop stays unlabelled for the swipe review.
  if (!(aiVerdict && label == null) && !LABELS.includes(label)) throw bad(`label must be one of: ${LABELS.join(', ')}`);
  if (note != null && (typeof note !== 'string' || note.length > 500)) throw bad('note must be a string of at most 500 characters');
  if (correctCase != null && !CASES.includes(correctCase)) throw bad(`correctCase must be one of: ${CASES.join(', ')}`);
  await requireKnown(id);
  const rec = { type: 'label', id, by: actor, ...(label != null ? { label, note: note || null, correctCase: correctCase || null } : {}), ...(aiVerdict ? { aiVerdict } : {}), at: new Date().toISOString() };
  await appendFile(LOG_FILE, JSON.stringify(rec) + '\n');
  if (label != null) {
    const stall = (await readRecs()).find((r) => r.type === 'stall' && r.id === id);
    writeBack(id, outcomeFromLabel({ label, correctCase }), 'owner', stall?.jev?.decision_id || decisionByStop.get(id));
  }
  return rec;
}

// Withdraw the newest label of a stall (Undo on the swipe page). The stop counts as unlabelled again.
export async function unlabelStall({ id } = {}) {
  if (typeof id !== 'string' || !id) throw bad('id required');
  await requireKnown(id);
  const rec = { type: 'unlabel', id, at: new Date().toISOString() };
  await appendFile(LOG_FILE, JSON.stringify(rec) + '\n');
  return rec;
}

// Owner answered a stop from the popup (TASK-44 phase 11). {id, session, kind:<yesno|menu|either|open>,
// owner:<button id|'reply'>, ownerText?, ai:<button id|null>, aiConfidence?, jev?:<choice>, jevProbabilities?}.
// agreeAi: owner===ai (null when no AI pick was highlighted). agreeJev (public/ask-model.js jevAgreesOwner):
// continue/take_recommended agree when the owner picked Yes or the highlighted option; ask_owner agrees when
// the owner picked anything other than the AI highlight, or replied; null when Jev made no call.
export async function logOwnerChoice({ id, session, kind, owner, ownerText, ai, aiConfidence, jev, jevProbabilities } = {}) {
  if (typeof id !== 'string' || !id) throw bad('id required');
  if (typeof session !== 'string' || !session) throw bad('session required');
  if (typeof owner !== 'string' || !owner) throw bad('owner required');
  const aiId = typeof ai === 'string' && ai ? ai : null;
  const jevChoice = typeof jev === 'string' && jev ? jev : null;
  const rec = {
    type: 'choice',
    at: new Date().toISOString(),
    id,
    session,
    kind: typeof kind === 'string' && kind ? kind.slice(0, 20) : null,
    owner: owner.slice(0, 80),
    ai: aiId,
    jev: jevChoice,
    agreeAi: aiId == null ? null : owner === aiId,
    agreeJev: jevAgreesOwner(jevChoice, owner, aiId),
  };
  if (owner === 'reply' && ownerText) rec.ownerText = String(ownerText).slice(0, 200);
  if (Number.isFinite(aiConfidence)) rec.aiConfidence = aiConfidence;
  if (jevProbabilities && typeof jevProbabilities === 'object') rec.jevProbabilities = jevProbabilities;
  await appendFile(LOG_FILE, JSON.stringify(rec) + '\n');
  return rec;
}

async function requireKnown(id) {
  let known = false;
  try { known = (await readFile(LOG_FILE, 'utf8')).includes(`"id":"${id.replace(/[^\w-]/g, '')}"`); } catch {}
  if (!known) throw Object.assign(new Error('unknown stall id'), { status: 404 });
}

// effectiveLabels / effectiveAiVerdicts live in decisions.js (pure; the Langfuse eval sync reads the same log)
export { effectiveLabels, effectiveAiVerdicts };

// Fire-and-forget: tell the product's decision log what really happened (queued and retried while the endpoint is missing).
// Nothing is sent for a stop whose Jev call was not logged (no decision id) or when the outcome says nothing.
export function writeBack(stallId, label, by, decisionId) {
  if (!decisionId || !label || !decisions.configured) return null;
  return outcomeQueue.add(decisionId, outcomeBody(label, by, stallId)).catch((e) => console.error('[manager] outcome', e.message));
}
export const flushOutcomes = () => outcomeQueue.flush();

// The "Jev & AI" usage tab.
export async function jevAiTab() {
  const remote = decisions.configured ? await decisions.summary() : { ok: false, error: VPT_TEAM_ID ? 'server not configured' : 'VPT_TEAM_ID not set' };
  return { ...tabData({ recs: await readRecs(), remote }), usageKey: await jevUsageNow(), logged: decisions.configured, queued: outcomeQueue.size() };
}
// The decisions page: f = { usage, ok, hasOutcome, minConf, limit, offset }
export async function decisionsView(f = {}) {
  return decisionsPage({ client: decisions, recs: await readRecs(), f, usageNow: await jevUsageNow() });
}

const readRecs = async () => { try { return (await readFile(LOG_FILE, 'utf8')).split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }); } catch { return []; } };

// For the manager panel and the report: how the AI reviewer is doing.
export async function aiSummary() {
  const recs = await readRecs();
  const tri = new Map(recs.filter((r) => r.type === 'triage' && r.ai).map((r) => [r.id, r]));
  const verdicts = effectiveAiVerdicts(recs);
  let right = 0, wrong = 0;
  for (const [id, v] of verdicts) if (tri.has(id)) { if (v === 'right') right++; else wrong++; }
  const since = new Date().setHours(0, 0, 0, 0);
  const today = recs.filter((r) => r.type === 'triage' && Date.parse(r.at) >= since);
  return { proposals: tri.size, right, wrong, unrated: tri.size - right - wrong, agreement: right + wrong ? right / (right + wrong) : null,
    today: { calls: today.filter((r) => r.ai || r.error).length, skipped: today.filter((r) => r.skipped).length, cost: today.reduce((a, r) => a + Number(r.cost || 0), 0) } };
}

// The swipe page's deck: unlabelled stops, newest first, with what the owner replied (outcome) and the counts.
export async function reviewDeck(limit = 50) {
  let recs = [];
  try { recs = (await readFile(LOG_FILE, 'utf8')).split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }); } catch {}
  const labels = effectiveLabels(recs);
  const outcomes = new Map(recs.filter((r) => r.type === 'outcome').map((r) => [r.id, r]));
  const triaged = new Map(recs.filter((r) => r.type === 'triage' && r.ai).map((r) => [r.id, r.ai]));
  const verdicts = effectiveAiVerdicts(recs);
  // One card per distinct stop: identical (session, closing text) records are the same stop logged again
  // (e.g. the pre-2b repaint bug). The newest stands for the group; a label on any member labels it.
  const groups = new Map();
  for (const r of recs) {
    if (r.type !== 'stall' || !r.id) continue;
    const k = `${r.session}\u0000${stopKey(r.excerpt || r.question)}`;
    const g = groups.get(k) || { last: null, labelled: false };
    g.last = r;
    if (labels.has(r.id)) g.labelled = true;
    groups.set(k, g);
  }
  const open = [...groups.values()].filter((g) => !g.labelled).map((g) => g.last).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const since = new Date().setHours(0, 0, 0, 0);
  const stopIds = new Set(recs.filter((r) => r.type === 'stall').map((r) => r.id));
  const labelledToday = [...labels.values()].filter((l) => stopIds.has(l.id) && Date.parse(l.at) >= since).length;
  const cards = open.slice().reverse().slice(0, Math.max(1, Math.min(200, Number(limit) || 50))).map((s) => {
    const o = outcomes.get(s.id);
    return {
      id: s.id, at: s.at, session: s.session, project: s.project || null, agent: s.agent || null, state: s.state || null,
      case: s.case, source: s.source || null, why: s.why || null, wouldSend: s.wouldSend || null, deployHint: s.deployHint || null,
      no_status: !!s.no_status, jev: s.jev?.choice ? { choice: s.jev.choice, confidence: s.jev.confidence ?? null } : null,
      excerpt: s.excerpt || s.question || '',
      ai: triaged.get(s.id) || null, aiVerdict: verdicts.get(s.id) || null,
      outcome: o ? { reply: o.reply || null, kind: o.kind || null, via: o.via || null, afterSec: o.afterSec ?? null } : null,
    };
  });
  return { cards, unlabelled: open.length, labelledToday, cases: CASES };
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

// The usage key the manager's Jev calls are logged under: the config, or with 'auto' the manager's own key once the
// server's decision log answers (it ships text.decision.manager together with the log), else the generic one.
export async function jevUsageNow() {
  if (config.jevUsage !== 'auto') return config.jevUsage;
  return (await decisions.available()) ? MANAGER_USAGE : FALLBACK_USAGE;
}

// What kind of failure an error text is, for the scorecard and for the credits cool-down.
export const jevErrorKind = (msg) => /\b402\b|insufficient credits/i.test(msg) ? 'credits' : /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(msg) ? 'network' : /timeout|aborted/i.test(msg) ? 'timeout' : /^http \d/i.test(msg) ? 'http' : 'other';
// OpenRouter credit is used up: every call fails with 402 until the owner tops up, so stop calling for a while
// (the rules decide meanwhile) instead of logging one error per stop. Probed again after the cool-down.
const CREDITS_COOLDOWN_MS = 5 * 60e3;
let creditsDownUntil = 0;
export const resetJevCooldown = () => { creditsDownUntil = 0; };   // tests, and an owner top-up

// ctx = { session, stallId, case }: what the product's log shows as "what this decision was about".
async function jev(stall, ctx = {}) {
  if (!JEV_URL || !JEV_API_KEY) return { skipped: 'not configured' };
  if (budget.day !== today()) budget = { day: today(), calls: 0, cost: 0 };
  if (budget.cost >= JEV_DAILY_USD || budget.calls >= JEV_DAILY_CALLS) return { skipped: 'daily budget reached' };
  if (Date.now() < creditsDownUntil) return { skipped: 'OpenRouter credit used up (402), retrying later' };
  const logged = decisions.configured;   // needs VPT_TEAM_ID: the server writes no log row without a team
  const body = jevRequestBody(stall, { usage: await jevUsageNow(), refs: logged ? { team_id: VPT_TEAM_ID, source: 'ghosty-manager', session: ctx.session, stall_id: ctx.stallId, case: ctx.case } : null });
  const started = Date.now();
  try {
    const post = async () => { const r = await fetch(JEV_URL, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': JEV_API_KEY },
      body: JSON.stringify(body), signal: AbortSignal.timeout(25000),
    }); return { r, j: await r.json() }; };
    let r, j;
    // The server restarting (deploy) refuses the connection for a moment: one more try, not an error.
    try { ({ r, j } = await post()); } catch (e) {
      if (jevErrorKind(e.message) !== 'network') throw e;
      await new Promise((res) => setTimeout(res, 2000));
      ({ r, j } = await post());
    }
    // An older server that does not know the manager usage: once more under the generic one.
    if (!j.success && body.usage !== FALLBACK_USAGE && /unknown usage/i.test(String(j.error || ''))) { body.usage = FALLBACK_USAGE; ({ r, j } = await post()); }
    budget.calls += 1;
    budget.cost += Number(j.cost || 0);
    writeFile(BUDGET_FILE, JSON.stringify(budget)).catch(() => {});
    const a = j.answers?.choice;
    if (!j.success || !a) {
      const error = String(j.error || `http ${r.status}`).slice(0, 200);
      const kind = jevErrorKind(error);
      if (kind === 'credits') creditsDownUntil = Date.now() + CREDITS_COOLDOWN_MS;
      return { error, kind, ms: Date.now() - started, ...(j.decision_id ? { decision_id: j.decision_id } : {}) };
    }
    return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, cost: j.cost, ms: j.ms ?? Date.now() - started, model: j.model, ...(j.decision_id ? { decision_id: j.decision_id } : {}) };
  } catch (e) {
    return { error: e.message, kind: jevErrorKind(e.message), ms: Date.now() - started };
  }
}

// Index of the pane line where the stop's closing text ends (the text is compared without whitespace, so
// a re-wrapped pane still matches), or -1 when it is not on screen.
function closingLine(plain, key) {
  const tail = String(key || '').slice(-80);
  if (tail.length < 8) return -1;
  let acc = '';
  const ends = plain.map((l) => (acc += String(l).replace(/\s+/g, ''), acc.length));
  const at = acc.lastIndexOf(tail);
  if (at < 0) return -1;
  const end = at + tail.length;
  return ends.findIndex((e) => e >= end);
}

// What the owner typed to move the session on: a ghosty send, else the newest prompt line in the body that
// sits BELOW the stall's closing text. A prompt above it is an older reply and never this stop's outcome.
function ownerReply(plain, sentText, closingKey) {
  if (sentText) return { via: 'ghosty', text: sentText };
  const floor = closingLine(plain, closingKey);
  if (floor < 0) return { via: 'unknown', text: null };
  for (let i = plain.length - 1, rules = 0; i > floor && i >= plain.length - 400; i--) {
    const l = plain[i];
    if (/^\s*[─━]{4,}/.test(l)) { rules++; continue; }
    if (rules < 2) continue;   // skip the input box at the bottom
    const m = l.match(/^\s*[❯›>]\s+(\S.*)$/);
    if (m && !/^\d+[.)]\s/.test(m[1])) return { via: 'terminal', text: m[1].trim() };
  }
  return { via: 'unknown', text: null };
}

// Called every tick for every session, after ghosty computed its state.
//   s = { name, state, agent, plain, raw, changed, project, lastSendAt, lastSendText, now,
//         rep? }   rep = the session's reporter (reporter.js) as { turnForStop(since), promptSince(since) }; Claude only
export function observe(s) {
  if (!AGENTS.has(s.agent)) { watch.delete(s.name); return null; }
  let w = watch.get(s.name);
  if (!w) { w = { since: s.now, hash: null, stall: null, pending: null, seen: false }; watch.set(s.name, w); }

  w.agent = s.agent;
  const rep = s.agent === 'claude' ? s.rep || null : null;   // Codex / MiniMax have no reporter: panes only
  w.last = { state: s.state, lastSendAt: s.lastSendAt || null, now: s.now };
  const stopped = s.state === 'waiting' || s.state === 'done';
  // The session only counts as moved on when real work was seen (the spinner signal ghosty computes) or
  // somebody sent it something since the stall. A TUI that merely repaints flips ghosty's state to
  // 'working' for a few seconds without doing anything: that must not reset the stall.
  const sentSince = !!(w.pending && s.lastSendAt && s.lastSendAt > w.pending.at);
  // A prompt the reporter saw submitted after the stall is movement too (the spinner can be missed on a short turn).
  const prompted = !!(w.pending && rep && rep.promptSince(w.pending.at));
  const moved = !!s.realWork || sentSince || prompted;
  if (moved) w.moved = true;
  if (!stopped) {
    const flicker = s.state === 'working' && !moved;
    if (flicker) { w.seen = true; return w.stall; }
    if (w.auto) cancelAuto(s.name, 'session moved on');
    // The session really moved on: settle the outcome of the last stall.
    if (w.pending && s.state === 'working' && moved) {
      const p = w.pending;
      const sent = sentSince ? s.lastSendText : null;
      const said = !sent && rep ? rep.promptSince(p.at) : null;   // the prompt text the reporter saw the owner submit
      const reply = said ? { via: 'reporter', text: said.text } : ownerReply(s.plain, sent, p.key);
      log({ type: 'outcome', id: p.id, session: s.name, at: new Date(s.now).toISOString(), afterSec: Math.round((s.now - p.at) / 1000),
        via: p.auto ? 'manager' : reply.via, reply: reply.text ? reply.text.slice(0, 300) : null, kind: reply.text ? outcomeKind(reply.text) : 'unknown' });
      writeBack(p.id, outcomeFromReplyKind(reply.text ? outcomeKind(reply.text) : 'unknown'), 'owner-reply', p.auto ? null : decisionByStop.get(p.id));
      w.pending = null;
    }
    if (holdOf(s.name)) endHold(s.name, 'manager', 'session moved on', false);
    w.stopSince = null;
    w.heldStall = null;
    w.hash = null; w.stall = null; w.since = s.now;
    w.seen = true;
    return null;
  }

  if (!w.stopSince) w.stopSince = s.now;
  // A finished turn of a Claude session with a fresh report: the reported final answer text is the
  // closing text (exact, no pane scraping). A waiting prompt is a pane thing (menus, permission dialogs).
  const turn = s.state === 'done' && rep ? rep.turnForStop(w.stopSince) : null;
  const useReport = !!(turn && turn.text && turn.reason !== 'aborted');
  const bgWait = !!(turn && turn.backgroundWork > 0);
  // Classify only when the pane changed (or the state did, or a report arrived); a still pane gives the same answer.
  const key = `${s.state}|${useReport ? turn.at : ''}|${bgWait}`;
  if (s.changed || !w.cls || w.clsKey !== key) {
    w.cls = classifyStall({ plain: useReport ? turn.text.split('\n') : s.plain, raw: s.raw, state: s.state, fromReport: useReport });
    w.cls.textSource = useReport ? 'reporter' : 'pane';
    if (bgWait) Object.assign(w.cls, { case: 'background_wait', answer: null, autoCase: undefined, forbidden: null, no_status: false, source: 'rule', backgroundWork: turn.backgroundWork });
    w.clsKey = key;
  }
  const stall = w.cls;
  if (w.auto && stall.draft) cancelAuto(s.name, 'draft in the input box');
  const h = hash(`${stall.case}|${stopKey(stall.excerpt)}`);
  if (h !== w.hash) { if (w.auto) cancelAuto(s.name, 'pane changed'); w.hash = h; w.since = s.now; w.logged = false; w.stall = stall; }
  // First sight after a restart: don't log stalls that were already sitting there.
  if (!w.seen) { w.logged = true; w.seen = true; return w.stall; }
  if (w.logged || s.now - w.since < SETTLE_MS || !sessionOn(s.name)) return w.stall;
  w.logged = true;
  // The very same stop as the last one logged, with no real work or send in between: not a new stop.
  // The last RECENT_STOPS logged stops are remembered per session on disk, so a restart, a repaint or an
  // A, B, A flip does not log a stop again; real work, a send or a reporter prompt since resets the list.
  const stopId = hash(stopKey(stall.excerpt));
  const recent = w.recent ?? (w.recent = Array.isArray(lastStops[s.name]) ? [...lastStops[s.name]] : []);
  if (w.moved) recent.length = 0;
  if (recent.includes(stopId)) return w.stall;
  recent.push(stopId); if (recent.length > RECENT_STOPS) recent.shift();
  w.moved = false;
  lastStops[s.name] = [...recent]; saveLastStops();

  const id = randomUUID();
  w.pending = { id, at: s.now, key: stopKey(stall.excerpt) };
  (async () => {
    let final = stall, jevOut = null;
    if (stall.source === 'ambiguous') {
      jevOut = await jev(stall, { session: s.name, stallId: id, case: stall.case });
      if (jevOut.decision_id) { decisionByStop.set(id, jevOut.decision_id); if (decisionByStop.size > 500) decisionByStop.delete(decisionByStop.keys().next().value); }
      if (jevOut.choice) final = applyJev(stall, jevOut.choice);
    }
    if (w.hash !== h) return;   // the pane moved on while Jev was thinking: that stall is gone
    const ws = wouldSend(final);
    const confidence = final.source === 'jev' ? Number(jevOut?.probabilities?.[jevOut.choice] ?? jevOut?.confidence ?? 0) : 1;
    w.stall = { ...final, would: ws, jev: jevOut?.choice ? { choice: jevOut.choice, probabilities: jevOut.probabilities || null } : null };
    await log({
      type: 'stall', id, session: s.name, project: s.project || null, agent: s.agent, state: s.state,
      at: new Date(s.now).toISOString(), case: final.case, source: final.source, textSource: stall.textSource || 'pane', question: final.question,
      ...(final.case === 'background_wait' ? { backgroundWork: final.backgroundWork } : {}),
      forbidden: final.forbidden, draft: final.draft, suggestion: final.suggestion,
      no_status: !!final.no_status, ...(final.deployHint ? { deployHint: final.deployHint } : {}), ...(final.action ? { action: final.action } : {}),
      jev: jevOut, wouldSend: ws.send, why: ws.why, confidence, excerpt: stall.excerpt,
    });
    const block = ws.send ? autoBlock(s.name, final, confidence) : null;
    if (ws.send && !block) {   // the existing auto-answer handles this one
      const pending = { id, hash: h, answer: ws.send, case: final.autoCase || final.case, source: final.source, confidence };
      const pol = policyOf(s.name, s.agent);
      if (pol.action === 'hold') { applyHold(s.name, w, pending, pol); return; }
      if (holdOf(s.name)) endHold(s.name, 'manager', `quota ok: ${pol.reason}`, false);
      schedule(s.name, w, pending);
      return;
    }
    const why = ws.send ? block : humanWhy(final, ws);
    // To the owner. With AI triage on, the reviewer reads the stop first (rules and Jev already did) so the push carries its proposal.
    let tri = null;
    if (config.aiTriage !== 'off' && toOwnerCase(final)) {
      w.triage = { id, hash: h, state: 'pending' };
      tri = await triageStop({ name: s.name, id, final, jevOut, state: s.state, agent: s.agent, project: s.project, stall }).catch((e) => { console.error('[manager] triage', e.message); return null; });
      if (w.hash !== h) return;   // the pane moved on while the reviewer was thinking
      w.triage = tri ? { id, hash: h, state: tri.ai ? 'done' : tri.skipped ? 'skipped' : 'error', ai: tri.ai || null, skipped: tri.skipped || null, error: tri.error || null, cost: tri.cost ?? null, ms: tri.ms ?? null, mode: tri.mode, case: final.case,
        jev: jevOut?.choice ? `${jevOut.choice} ${Math.round(Number(jevOut.probabilities?.[jevOut.choice] ?? jevOut.confidence ?? 0) * 100)} %` : null } : null;
      // auto mode: an owner-free, confident, non-forbidden proposal goes through the same countdown / cap / fire-time gates.
      const a = tri?.ai;
      if (config.aiTriage === 'auto' && a && !a.owner_needed && a.proposed_reply && !a.forbidden && !final.forbidden && !stall.draft
          && !forbiddenMatch(a.proposed_reply) && !AI_NEVER_CASES.includes(final.case) && !aiBlock(s.name, final.case, a.confidence)) {
        const pending = { id, hash: h, answer: { text: a.proposed_reply }, case: final.case, source: 'ai', confidence: a.confidence };
        const pol = policyOf(s.name, s.agent);
        if (pol.action === 'hold') { applyHold(s.name, w, pending, pol); return; }
        if (holdOf(s.name)) endHold(s.name, 'manager', `quota ok: ${pol.reason}`, false);
        schedule(s.name, w, pending);
        return;
      }
    }
    if (final.case !== 'done' && final.case !== 'background_wait') escalate(s.name, s.state, final, id, why, oneLine(tri));
    return;
  })().catch((e) => console.error('[manager]', e.message));
  return w.stall;
}

export function forget(name) { cancelAuto(name, 'session removed'); watch.delete(name); }
export function prune(live) { for (const k of [...watch.keys()]) if (!live.has(k)) forget(k); }

export function stallOf(name) {
  const w = watch.get(name);
  if (!w || !w.stall) return null;
  const st = w.stall;
  return { case: st.case, source: st.source, would: st.would || null, question: st.question, id: w.pending?.id || null,
    options: st.options || null, suggestion: st.suggestion || null, suggestionForbidden: st.suggestion ? forbiddenMatch(st.suggestion) : null,
    forbidden: st.forbidden || w.cls?.forbidden || null, draft: !!(w.cls?.draft), jev: st.jev || null };
}

// The AI reviewer's view for the UI: { id, state: pending|done|skipped|error, ai?, skipped?, error?, ... } for the current stop, or null.
export function triageOf(name) {
  const w = watch.get(name);
  if (!w || !w.triage || w.triage.hash !== w.hash || dismissed.has(w.triage.id)) return null;
  const { hash, ...t } = w.triage;
  return t;
}

const dismissed = new Set();
const TRIAGE_ACTIONS = ['sent', 'edited', 'dismissed'];
// The owner acted on the AI's proposal from the card (sent it, edited it, dismissed it). Logged for the measure; dismiss hides it.
export async function triageAction({ id, action, session } = {}) {
  if (typeof id !== 'string' || !id) throw bad('id required');
  if (!TRIAGE_ACTIONS.includes(action)) throw bad(`action must be one of: ${TRIAGE_ACTIONS.join(', ')}`);
  await requireKnown(id);
  if (action === 'dismissed') { dismissed.add(id); if (dismissed.size > 300) dismissed.delete(dismissed.values().next().value); }
  const rec = { type: 'triage_action', id, session: session || null, action, at: new Date().toISOString() };
  await appendFile(LOG_FILE, JSON.stringify(rec) + '\n');
  return rec;
}

// The pending automatic answer for the UI countdown: { sendAt, answer, case, id } or null.
export function autoOf(name) {
  const a = watch.get(name)?.auto;
  return a ? { sendAt: a.sendAt, answer: answerText(a.answer), case: a.case, id: a.id } : null;
}
