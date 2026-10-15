// AI Manager (TASK-44): watches agent sessions that stop, classifies why (stall.js), asks Jev for
// the ambiguous ones, and logs what it would answer. With autoSend on (the default since round 8, OWNER_DECISIONS §15) it types the
// safe cases (continue / menu_recommended) after a delay the owner can cancel, decides merge / push / deploy questions itself when
// nothing argues against it (merge-policy.js, decide-policy.js); everything else is escalated to the owner.
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
//   router records {type:'router', id, rule_case, escalated, router:{case,caseConf,owner,wake,wakeConf,decision_id}} (TASK-47 shadow: Jev's 3 answers per stop; changes nothing)
//   decision-outcomes.json  outcomes not yet accepted by the server's decision log (retried every 5 min, dropped after 7 days)
//
// It never starts, kills or renames sessions.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { POLICY_DEFAULTS } from './public/policy.js';
import { classifyStall, applyJev, wouldSend, outcomeKind, setForbiddenExtra, forbiddenMatch, hardMatch, mergeMatch, pushMatch, deployMatch, topicSplit, deployHint, approvedAction } from './stall.js';
import { MERGE_DEFAULTS, evaluateMerge, journalRecord, composeReply, repoToplevel } from './merge-policy.js';
import { DECIDE_DEFAULTS, evaluatePush, evaluateDeploy, decisionRecord, menuRecord, parsePushAsk } from './decide-policy.js';
import { decidedItems, decidedSummary, failedCount } from './decided.js';
import { TIER_DEFAULTS, localMinutes } from './push.js';
import { splitAsk, lookupInfo, isAsk } from './info-lookup.js';
import { leaseAsk, answerLeaseAsk } from './lease-ask.js';
import { selfAsk, answerSelf } from './self-check.js';
import { mockupRule, WINDOW_DEFAULT_MIN } from './mockups.js';
import { supersedeOlder } from './owner-asks.js';
import { actorOf } from './api-extras.js';
import { jevAgreesOwner } from './public/ask-model.js';
import { AI_MODES, AI_NEVER_CASES, REVIEWER_SYSTEM, createBudget, callReviewer, reviewerUrl } from './triage.js';
import { createPromptSource } from './prompts.js';
import { reviewerOptions } from './public/buttons.js';
import { runShadow } from './router-shadow.js';
import { createJevBreaker } from './jev-breaker.js';
import { createJevSwitch, isDisabledReply, DISABLED } from './jev-switch.js';
import { createWakeAnnotator, dueOutcomes, OUTCOME_BY, CAP_MS } from './wake-shadow.js';
import { classifyKey, FILE_NAME as EVENTS_FILE } from './manager-events.js';
import { isHardwareAsk, readyReply } from './ready-window.js';
import { createFallbackDecider, FALLBACK_MODES, FALLBACK_SOURCE } from './minimax-fallback.js';
import { createRoundtrips, roundtripRecord, summarizeRoundtrips, FILE_NAME as ROUNDTRIPS_FILE } from './roundtrips.js';
import { createDecisionsClient, createOutcomeQueue, outcomeFromLabel, outcomeFromReplyKind, outcomeBody, jevRequestBody, effectiveLabels, effectiveAiVerdicts, tabData, decisionsPage, MANAGER_USAGE, FALLBACK_USAGE } from './decisions.js';

const STATE_DIR = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
const CONFIG_FILE = join(STATE_DIR, 'manager.json');
export const LOG_FILE = join(STATE_DIR, 'stalls.jsonl');
const BUDGET_FILE = join(STATE_DIR, 'jev-budget.json');
const LAST_STOPS_FILE = join(STATE_DIR, 'last-stops.json');   // session -> keys of the last 5 stops logged (survives a restart)
const AI_BUDGET_FILE = join(STATE_DIR, 'ai-budget.json');
const OUTCOME_QUEUE_FILE = join(STATE_DIR, 'decision-outcomes.json');
export const MERGE_FILE = join(STATE_DIR, 'merge-decisions.jsonl');   // round-7 journal, still read (kind merge)
export const DECISIONS_FILE = join(STATE_DIR, 'manager-decisions.jsonl');   // one journal record per merge / push / deploy / menu decision (decided or escalated)
const DIGEST_FILE = join(STATE_DIR, 'decided-digest.json');   // { day } the daily "decided for you" digest was recorded for

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
export const CASES = ['continue', 'menu_recommended', 'permission', 'owner_decision', 'done', 'error', 'stopped_short', 'waiting_deploy', 'owner_action', 'background_wait', 'own_job_wait'];
export const LABELS = ['no_reason', 'legit', 'wrong_case'];

setForbiddenExtra(process.env.GHOSTY_FORBIDDEN_EXTRA || '');

export const AUTO_CASES = ['continue', 'menu_recommended', 'stopped_short', 'ask_status'];   // the only cases that may ever auto-send
let config = { enabled: true, autoSend: true, routerShadow: true, wakeShadow: true, autoCases: ['continue', 'menu_recommended'], autonomyVersion: 1, decidedDigestHour: 18, minConfidence: 0.8, delayMs: 30000, maxPerSessionPerHour: 4, disabledSessions: [], deployRunner: false, leaseAnswers: true, selfChecks: true, mockupFirst: true, mockupWindowMin: WINDOW_DEFAULT_MIN,
  jevUsage: 'auto', aiFallback: 'minimax', aiFallbackDailyCalls: 300, aiTriage: 'simulate', aiMinConfidence: 0.85, aiDailyUsd: 1.0, aiDailyCalls: 300, aiAutoCases: [],   // the owner picks; owner_decision is never a default
  ...MERGE_DEFAULTS, ...DECIDE_DEFAULTS, ...POLICY_DEFAULTS };
let budget = { day: '', calls: 0, cost: 0 };
export const jevBreaker = createJevBreaker({ file: BUDGET_FILE });   // 3 errors in a row: rules only, one probe per 10 min (jev-breaker.js)
const saveBudget = () => { try { jevBreaker.saveCounters(budget); } catch {} };
const RECENT_STOPS = 5;
let lastStops = {};
let lastStopsWrite = Promise.resolve();
const saveLastStops = () => { lastStopsWrite = lastStopsWrite.then(() => writeFile(LAST_STOPS_FILE, JSON.stringify(lastStops))).catch(() => {}); };
const aiBudget = createBudget(AI_BUDGET_FILE);
const fallbackBudget = createBudget(join(STATE_DIR, 'ai-fallback-budget.json'));   // calls per day through the MiniMax fallback (cost is always 0)
const triages = new Map();   // stop id -> triage result (one reviewer call per stop)
let creditsPeek = () => null;   // injected by server.js: the cached OpenRouter credit ({ ok, balance }) or null
let triageContext = () => ({});   // injected by server.js: (session) -> { priority, quota, leases, deploys }
let reviewerFetch = (...a) => fetch(...a);
const watch = new Map();   // session -> { since, hash, stall, pending: {id, at, auto}, last, auto }
const sentLog = new Map(); // session -> [ms epoch of each auto answer] (hourly cap)
let notify = () => {};
let send = { key: null, keys: null };   // injected by server.js: the one tmux code path
let isPaused = () => false;             // injected by server.js: the owner's pause hold (session-meta.js)
let policyOf = () => ({ action: 'allow', reason: 'no policy' });   // injected: (session, agent) -> { action, reason } (public/policy.js + quota)
let held = { get: () => null, set: () => {} };                      // injected: the manager's own hold, kept apart from the owner's pause
let onMergeCancelled = () => {};                                    // injected: (session, { id, reason, merge_decision_id }) -> owner feed notice
let onMergeDecision = () => {};                                     // injected: (session, journal record) -> owner feed notice
let mergeJev = (body) => jevPost(body);                             // the merge evaluation's Jev call (tests inject a fake)
let decideContext = () => ({ deploys: null, leases: null, envs: [] });    // injected: () => { deploys: runner snapshot, leases: lease store value, envs: [env names] }
let onDigest = () => {};                                            // injected: ({ day, count, text }) -> feed item + push (digest tier)
let readyWindows = null;                                            // injected: ready-window.js store (round 9 item 8). Unset = no ready windows
let leaseViewOf = null;                                             // injected: async (session) => lease source view (lease-source.js) | null. Unset = lease questions are not answered here
let ownJobs = null;                                                 // injected: own-jobs.js watcher { watch, forget, progressOf } (round 9, item 11). Unset = jobs are not watched
let ownerAsksFile = join(STATE_DIR, 'manager-owner-asks.jsonl');    // the owner-asks ledger: a new ask of a session supersedes its older open ones (round 9, item 5)
let statusHook = () => {};                                          // injected: (session, status, text) for a logged stop whose STATUS is waiting / blocked
let notifyHold = () => {};                                          // injected: (session, 'hold'|'resume', reason) -> owner alert

const today = () => new Date().toISOString().slice(0, 10);
// Identity of a stop's text regardless of how the pane wraps it: a resized window re-wraps the same words
// (and the 16-line excerpt then starts elsewhere), so compare the tail with all whitespace removed.
export const stopKey = (text) => String(text || '').replace(/\s+/g, '').slice(-400);
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);

export async function initManager({ managerSessions, credits, onOwnerNeeded, sendKey, sendKeys, paused, policy, heldStore, onHold, context, onHandoff = () => {}, onMergeDecision: mergeHook, onMergeCancelled: cancelHook, mergeJev: mergeJevFn, decideContext: decideCtx, onDigest: digestHook, onNotice, leaseView, onStatus, ownJobs: ownJobsDep, ownerAsksFile: asksFile, readyStore } = {}) {
  await mkdir(STATE_DIR, { recursive: true });
  try {
    const saved = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    config = { ...config, ...saved };
    // One-time autonomy migration (OWNER_DECISIONS §15): menu_recommended joins the auto cases and push / deploy decisions switch on, once.
    // The owner can switch them off afterwards; autonomyVersion 1 keeps them from coming back. A saved autoSend:false stays false.
    if (!(Number(saved.autonomyVersion) >= 1)) {
      config.autoCases = [...new Set([...(Array.isArray(saved.autoCases) ? saved.autoCases : []), 'menu_recommended'])];
      if (saved.pushDecisions === undefined) config.pushDecisions = true;
      if (saved.deployDecisions === undefined) config.deployDecisions = true;
      config.autonomyVersion = 1;
      try { await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) { console.error('[manager] migrate', e.message); }
      // one feed notice, once: the owner learns what switched on and where the switches are
      try { onNotice?.('Autonomy on (round 8): auto-answer, recommended option, merge/push/deploy decisions; switches in the manager sheet'); } catch (e) { console.error('[manager] notice', e.message); }
    }
  } catch (e) {
    // no file = a fresh install (the defaults). A file that cannot be read or parsed fails closed: nothing is auto-answered in this run.
    if (e?.code !== 'ENOENT') { config.autoSend = false; console.error(`[manager] manager.json unreadable (${e.message}): auto-answer is off for this run`); }
  }
  try { const b = JSON.parse(await readFile(BUDGET_FILE, 'utf8')); budget = { day: b.day || '', calls: b.calls || 0, cost: b.cost || 0 }; } catch {}
  try { lastStops = JSON.parse(await readFile(LAST_STOPS_FILE, 'utf8')) || {}; } catch { lastStops = {}; }
  await aiBudget.load();
  await fallbackBudget.load();
  if (!FALLBACK_MODES.includes(config.aiFallback)) config.aiFallback = 'minimax';
  config.autoCases = (config.autoCases || []).filter((c) => AUTO_CASES.includes(c));
  config.aiAutoCases = (config.aiAutoCases || []).filter((c) => CASES.includes(c) && !AI_NEVER_CASES.includes(c));
  if (!AI_MODES.includes(config.aiTriage)) config.aiTriage = 'simulate';
  if (!/^(auto|text\.decision(\.[a-z0-9_]+)*)$/.test(String(config.jevUsage))) config.jevUsage = 'auto';
  if (decisions.configured) { outcomeQueue.flush().catch(() => {}); setInterval(() => outcomeQueue.flush().catch(() => {}), 5 * 60e3).unref(); }
  if (context) triageContext = context;
  if (managerSessions) managerSessionsOf = managerSessions;
  if (credits) creditsPeek = credits;
  if (onOwnerNeeded) notify = onOwnerNeeded;
  if (sendKey) send.key = sendKey;
  if (sendKeys) send.keys = sendKeys;
  if (paused) isPaused = paused;
  if (policy) policyOf = policy;
  if (heldStore) held = heldStore;
  if (onHold) notifyHold = onHold;
  if (mergeHook) onMergeDecision = mergeHook;
  if (cancelHook) onMergeCancelled = cancelHook;
  if (mergeJevFn) mergeJev = mergeJevFn;
  if (decideCtx) decideContext = decideCtx;
  if (digestHook) onDigest = digestHook;
  if (leaseView) leaseViewOf = leaseView;
  if (readyStore) readyWindows = readyStore;
  if (onStatus) statusHook = onStatus;
  if (ownJobsDep) ownJobs = ownJobsDep;
  if (asksFile) ownerAsksFile = asksFile;
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
  return { ...config, langfuse: langfuseLinks(), validCases: AUTO_CASES, validAiCases: CASES.filter((c) => !AI_NEVER_CASES.includes(c)), cases: CASES, jev: !!JEV_URL, jevLogged: decisions.configured, jevUsage: config.jevUsage, budget: { ...jevBreaker.state(), ...budget, dailyUsd: JEV_DAILY_USD, dailyCalls: JEV_DAILY_CALLS },
    ai: !!(AI_URL && JEV_API_KEY), aiFallbackModes: FALLBACK_MODES, aiFallbackBudget: { ...fallbackBudget.snapshot(), dailyCalls: config.aiFallbackDailyCalls }, aiModes: AI_MODES, aiBudget: { ...aiBudget.snapshot(), dailyUsd: config.aiDailyUsd, dailyCalls: config.aiDailyCalls } };
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const num = (v, lo, hi, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw bad(`${name} must be a number in ${lo}..${hi}`);
  return v;
};

export async function setManagerConfig(b = {}) {
  const { aiFallback, aiFallbackDailyCalls, jevUsage, enabled, autoSend, autoCases, minConfidence, delayMs, maxPerSessionPerHour, session, sessionEnabled, policyEnabled, p1MaxPct, p2MaxPct, deployRunner, aiTriage, aiMinConfidence, aiDailyUsd, aiDailyCalls, aiAutoCases, routerShadow, wakeShadow, mergeDecisions, mergeMinConfidence, mergeOptOut, mergeConventionFiles, infoAnswers, infoRoots, pushDecisions, deployDecisions, pushMinConfidence, deployMinConfidence, pushOptOut, deployOptOut, decidedDigestHour, labEnvs, migrationProcedure } = b;
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
  if (aiFallback !== undefined) { if (!FALLBACK_MODES.includes(aiFallback)) throw bad(`aiFallback must be one of: ${FALLBACK_MODES.join(', ')}`); config.aiFallback = aiFallback; }
  if (aiFallbackDailyCalls !== undefined) config.aiFallbackDailyCalls = Math.round(num(aiFallbackDailyCalls, 0, 10000, 'aiFallbackDailyCalls'));
  if (aiTriage !== undefined) { if (!AI_MODES.includes(aiTriage)) throw bad(`aiTriage must be one of: ${AI_MODES.join(', ')}`); config.aiTriage = aiTriage; }
  if (aiMinConfidence !== undefined) config.aiMinConfidence = num(aiMinConfidence, 0, 1, 'aiMinConfidence');
  if (aiDailyUsd !== undefined) config.aiDailyUsd = num(aiDailyUsd, 0, 100, 'aiDailyUsd');
  if (aiDailyCalls !== undefined) config.aiDailyCalls = Math.round(num(aiDailyCalls, 0, 10000, 'aiDailyCalls'));
  if (aiAutoCases !== undefined) {
    if (!Array.isArray(aiAutoCases) || aiAutoCases.some((c) => !CASES.includes(c) || AI_NEVER_CASES.includes(c))) throw bad(`aiAutoCases must be a list of: ${CASES.filter((c) => !AI_NEVER_CASES.includes(c)).join(', ')}`);
    config.aiAutoCases = [...new Set(aiAutoCases)];
  }
  if (typeof mergeDecisions === 'boolean') config.mergeDecisions = mergeDecisions;
  if (typeof infoAnswers === 'boolean') config.infoAnswers = infoAnswers;
  if (typeof b.leaseAnswers === 'boolean') config.leaseAnswers = b.leaseAnswers;
  if (typeof b.selfChecks === 'boolean') config.selfChecks = b.selfChecks;
  if (typeof b.mockupFirst === 'boolean') config.mockupFirst = b.mockupFirst;
  if (b.mockupWindowMin !== undefined) config.mockupWindowMin = Math.round(num(b.mockupWindowMin, 0, 1440, 'mockupWindowMin'));   // minutes the owner has to object to a mockup; 0 = the rule is off
  if (typeof pushDecisions === 'boolean') config.pushDecisions = pushDecisions;
  if (typeof deployDecisions === 'boolean') config.deployDecisions = deployDecisions;
  if (pushMinConfidence !== undefined) config.pushMinConfidence = num(pushMinConfidence, 0, 1, 'pushMinConfidence');
  if (deployMinConfidence !== undefined) config.deployMinConfidence = num(deployMinConfidence, 0, 1, 'deployMinConfidence');
  if (decidedDigestHour !== undefined) config.decidedDigestHour = Math.round(num(decidedDigestHour, 0, 23, 'decidedDigestHour'));
  for (const [key, val] of [['pushOptOut', pushOptOut], ['deployOptOut', deployOptOut]]) {
    if (val === undefined) continue;
    if (!Array.isArray(val) || val.length > 50 || val.some((x) => typeof x !== 'string' || !x.trim())) throw bad(`${key} must be a list of up to 50 non-empty strings`);
    config[key] = [...new Set(val.map((x) => x.trim()))];
  }
  if (labEnvs !== undefined) {
    if (!Array.isArray(labEnvs) || labEnvs.length > 50 || labEnvs.some((x) => typeof x !== 'string' || !x.trim())) throw bad('labEnvs must be a list of up to 50 environment names');
    config.labEnvs = [...new Set(labEnvs.map((x) => x.trim()))];
  }
  if (migrationProcedure !== undefined) {
    if (!migrationProcedure || typeof migrationProcedure !== 'object' || Array.isArray(migrationProcedure) || Object.keys(migrationProcedure).length > 50
        || Object.entries(migrationProcedure).some(([k, v]) => !k.trim() || typeof v !== 'string' || !v.trim() || v.length > 200)) throw bad('migrationProcedure must map a repo name to a short text (the documented procedure)');
    config.migrationProcedure = { ...migrationProcedure };
  }
  if (mergeMinConfidence !== undefined) config.mergeMinConfidence = num(mergeMinConfidence, 0, 1, 'mergeMinConfidence');
  if (mergeOptOut !== undefined) {
    if (!Array.isArray(mergeOptOut) || mergeOptOut.length > 50 || mergeOptOut.some((x) => typeof x !== 'string' || !x.trim())) throw bad('mergeOptOut must be a list of up to 50 non-empty strings');
    config.mergeOptOut = [...new Set(mergeOptOut.map((x) => x.trim()))];
  }
  if (mergeConventionFiles !== undefined) {
    if (!Array.isArray(mergeConventionFiles) || mergeConventionFiles.length > 50 || mergeConventionFiles.some((x) => typeof x !== 'string' || !x.trim())) throw bad('mergeConventionFiles must be a list of file names');
    config.mergeConventionFiles = [...new Set(mergeConventionFiles.map((x) => x.trim()))];
  }
  if (infoRoots !== undefined) {
    if (!Array.isArray(infoRoots) || infoRoots.length > 20 || infoRoots.some((x) => typeof x !== 'string' || !x.startsWith('/'))) throw bad('infoRoots must be a list of absolute paths');
    config.infoRoots = [...new Set(infoRoots)];
  }
  if (typeof policyEnabled === 'boolean') config.policyEnabled = policyEnabled;
  if (typeof deployRunner === 'boolean') config.deployRunner = deployRunner;
  if (typeof routerShadow === 'boolean') config.routerShadow = routerShadow;
  if (typeof wakeShadow === 'boolean') config.wakeShadow = wakeShadow;
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

export const sessionOn = (name) => config.enabled && !config.disabledSessions.includes(name);

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

// The manager's own decision (a merge it decided, an information answer): not an auto-answer case, but the same switches
// (autoSend, pause, cap, draft) plus, for a merge, its own switch and confidence floor. Checked at schedule and again in fire().
// kinds = { merge?: confidence, push?: confidence, deploy?: confidence }: the decisions the reply carries.
const DECISION_KINDS = ['merge', 'push', 'deploy'];
const kindIds = (a) => Object.fromEntries(Object.keys(a?.kinds || {}).map((k) => [k, `${k}-${a.id}`]));
function decisionBlock(name, kinds = {}) {
  if (isPaused(name)) return 'session paused by owner';
  if (!config.autoSend) return 'auto-answer is off';
  if (hourCount(name) >= config.maxPerSessionPerHour) return `hourly cap reached (${config.maxPerSessionPerHour})`;
  if (watch.get(name)?.cls?.draft) return 'owner has a draft in the input box';
  for (const k of DECISION_KINDS) {
    if (!(k in kinds)) continue;
    if (!config[`${k}Decisions`]) return `${k} decisions are off`;
    const min = config[`${k}MinConfidence`];
    if (kinds[k] < min) return `${k} confidence ${kinds[k].toFixed(2)} below ${min}`;
  }
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

// ---- remote stops hook point (round 9 item 1; remote-stops.js; one block, keep it together) ----
// Stops posted by other machines (the Mac Stop hook) enter observe() as sessions named `mac:<name>` (s.remote = true: they arrive settled, no
// tmux). The remote layer needs to know when the manager is DONE with a stop (settled), answered it (send -> deliver), dropped the countdown
// (cancelled) or escalated it; none of this changes what the manager decides.
export const REMOTE_PREFIX = 'mac:';
export const isRemoteSession = (name) => String(name).startsWith(REMOTE_PREFIX);
let remoteHooks = { settled() {}, cancelled() {}, escalated() {}, noAnswer: () => false, maxDelayMs: () => null };
// The manager's pending id of a session's current stop: the remote layer ties every hook call to its stop by this id.
export const pendingIdOf = (name) => watch.get(name)?.pending?.id || null;
// The Mac hook stopped waiting (poll closed, deadline passed, deliver found nobody): a pending answer is dropped and the owner gets the stop. Never quiet.
export function hookLost(name, id, reason) {
  const w = watch.get(name);
  if (!w || !id || w.pending?.id !== id) return false;
  if (w.auto && w.auto.id === id) cancelAuto(name, reason);   // logged (answer_cancelled), then the owner is told
  if (w.stall) escalate(name, w.last?.state || 'done', w.stall, id, reason);
  return true;
}
// Merge and push are evaluated for local sessions only: a Mac session's branch is not visible here (docs/MAC-HOOK.md). Deploy reads origin and stays.
export const REMOTE_GIT_WHY = "evaluated only for local sessions: the Mac's branch is not visible here";
const remoteEscalation = (kind, s) => ({ verdict: 'escalate', reasons: [REMOTE_GIT_WHY], rationale: REMOTE_GIT_WHY, question: `${kind[0].toUpperCase()}${kind.slice(1)}?`, facts: { ok: false, error: REMOTE_GIT_WHY, repoName: s.project || null, files: [] }, tests: { state: 'unknown' }, decision: { source: 'floor', choice: 'escalate', confidence: 1, decision_id: null } });
export function setRemoteHooks(h = {}) { remoteHooks = { ...remoteHooks, ...h }; }
const hookSafe = (fn, ...a) => { try { fn(...a); } catch (e) { console.error('[manager] remote hook', e.message); } };

// ---- ready window (round 9 item 8; keep this block together) ----
// "ready for N minutes" (voice / tap, ready-window.js): while a window covers the session, a stop that asks the owner for a hardware step on the
// device (pair, press, plug, power-cycle) is answered "retry the step yourself; stop after 2 failures". The third ask in the window goes to the owner.
// Same gates as every manager decision (autoSend, pause, hourly cap, draft, hard floor on the reply). -> true when it scheduled an answer or escalated.
function readyDecision({ s, w, id, h, final, stall }) {
  if (!readyWindows || isManagerSession(s.name) || stall.draft) return false;
  if (s.state !== 'done' || (final.options?.length || 0) >= 1 || (stall.options?.length || 0) >= 1) return false;   // never type free text into a live menu (as partialDecision)
  if (!isHardwareAsk({ kase: final.case, action: final.action, question: final.question, excerpt: stall.excerpt })) return false;
  const win = readyWindows.match({ session: s.name, text: `${final.action || ''}\n${final.question || ''}\n${stall.excerpt || ''}` });
  if (!win) return false;
  const { n, answer } = readyWindows.peekAsk(win, s.name, id);
  if (!answer) { escalate(s.name, s.state, final, id, `ready window: ask number ${n} in the window (the step already failed twice) - needs you`); return true; }
  if (decisionBlock(s.name)) return false;   // blocked (auto-answer off, paused, capped, draft): not counted as an answer
  readyWindows.commitAsk(win, s.name, id);
  const reply = readyReply(readyWindows.view(win));
  const pending = { id, hash: h, answer: { text: reply }, case: final.case, source: 'manager_decision', confidence: 1, kinds: {}, ready: { until: win.until, target: win.target || null, n } };
  const pol = policyOf(s.name, s.agent);
  if (pol.action === 'hold') applyHold(s.name, w, pending, pol);
  else { if (holdOf(s.name)) endHold(s.name, 'manager', `quota ok: ${pol.reason}`, false); schedule(s.name, w, pending); }
  return true;
}

// A stall that is not auto-answered goes to the owner. A waiting session was already pushed by
// ghosty's own 'waiting' alert, so only a finished turn that asks something is pushed here.
// manager.json managerSessions (default ["manager"]): the manager agent's own session is never escalated or pushed (TASK-44-MANAGER.md section 0).
let managerSessionsOf = () => ['manager'];
export const isManagerSession = (name) => { try { return (managerSessionsOf() || []).includes(name); } catch { return false; } };
const stopWall = new Map();   // stop id -> wall-clock ms of the stop (the owner-asks ledger is wall-clock; observe()'s `now` may not be)
const escalatedStops = new Set();   // stop ids the rules escalated to the owner (the wake shadow's `escalated` fact)
function escalate(name, state, final, id, reason, aiLine = null) {
  if (isManagerSession(name)) return;   // never an owner stop, never pushed
  const firstEscalation = !escalatedStops.has(id);
  if (isRemoteSession(name)) hookSafe(remoteHooks.escalated, name, id, reason, final);
  escalatedStops.add(id); if (escalatedStops.size > 500) escalatedStops.delete(escalatedStops.values().next().value);
  logLater({ type: 'escalated', id, session: name, case: final.case, reason });
  // one open ask per session: this one supersedes the session's older open asks in the owner-asks ledger (round 9, item 5)
  // only asks written before this stop, and never again on a re-escalation of the same stop
  if (firstEscalation) supersedeOlder(ownerAsksFile, name, id, { before: stopWall.get(id) ?? Date.now() }).then((ids) => { if (ids.length) logLater({ type: 'asks_superseded', session: name, by: id, ids }); }).catch((e) => console.error('[manager] supersede', e.message));
  if (isPaused(name)) return;   // the owner holds this session on purpose: no pings
  if (state === 'done' && final.case !== 'done') notify(name, aiLine ? { ...final, aiLine } : final, reason, state);
  // a live menu was already announced as "waiting" before it settled (no stop id yet, so no buttons): once settled and escalated, the "asks" alert
  // carries the stop id, the voice item and the notification actions. The alert's own debounce keeps it to one extra per stop.
  else if (state === 'waiting' && (final.options?.length || 0) >= 1) notify(name, aiLine ? { ...final, aiLine } : final, reason, state);
}

// ---- owner round-trip ledger (round 9 item 9, roundtrips.js) ----
// One record in owner-roundtrips.jsonl when a stop that reached the owner (or was answered for them) resolves: the owner replied or the
// manager answered (outcome), a newer stop superseded it, or the session was removed. Local tmux and remote (Mac hook) sessions alike.
const roundtrips = createRoundtrips({ file: join(STATE_DIR, ROUNDTRIPS_FILE) });
const answerers = new Map();   // session -> { by, via, at }: who sent the owner's last text (server.js logSend -> noteAnswerer)
// Every actor is recorded; only a real owner send counts as `by: owner`. manager-agent, own-job wakes and other automation are `manager`.
export function noteAnswerer(name, by, via = null) {
  const actor = String(by || 'owner');
  const rec = actor === 'owner' ? { by: 'owner', via: via || 'dashboard' } : actor === 'owner-voice' ? { by: 'owner-voice', via: 'voice' }
    : actor === 'manager-agent' ? { by: 'manager', via: 'agent' } : actor === 'own-job' ? { by: 'manager', via: 'own-job' } : { by: 'manager', via: actor.slice(0, 30) };
  answerers.set(name, { ...rec, at: Date.now() });
}
function settleRoundtrip(name, p, resolution, answeredAt, machine = 'local') {
  if (!p || p.settled || !p.id) return;
  p.settled = true;
  const reached = escalatedStops.has(p.id) || p.auto === true;
  const a = answerers.get(name), answeredByOwner = resolution === 'answered' && !p.auto;
  const ownerSent = a && a.at >= p.at - 1000;
  const by = p.auto ? (p.remote ? 'remote-hook' : 'manager') : answeredByOwner && ownerSent ? a.by : 'owner';
  const via = p.auto ? (p.remote ? 'hook' : 'tmux') : answeredByOwner ? (ownerSent ? a.via : p.remote ? 'mac' : 'pane') : 'none';
  roundtrips.record(roundtripRecord({ id: p.id, session: name, machine: p.machine || machine, at: p.at, answeredAt, cls: p.cls, by, via, resolution, reachedOwner: reached })).catch(() => {});
}
export const roundtripsView = async ({ hours = 24, now = Date.now() } = {}) => {
  const h = Math.max(1, Math.min(24 * 90, Number(hours) || 24));
  const recs = await roundtrips.read({ sinceMs: now - h * 3600e3 });
  return { hours: h, summary: summarizeRoundtrips(recs, { hours: h }), records: recs.slice(-500) };
};

// ---- AI reviewer (phase 9) ----
// Stops that go to the owner: everything except background work and a plain finished turn without a question.
export const toOwnerCase = (final) => final.case !== 'background_wait' && final.case !== 'own_job_wait' && (final.case !== 'done' || /\?/.test(final.question || ''));

const QUOTA_NAMES = { claude: 'Claude Max', codex: 'Codex', minimax: 'MiniMax' };
const oneLine = (rec) => (rec?.ai ? `${rec.ai.owner_needed ? 'needs you' : 'proposes'}${rec.ai.proposed_reply ? ` "${rec.ai.proposed_reply}"` : ''}` : null);

// One reviewer call per stop (cached by stop id). Returns the triage record, or null when AI triage is off.
export async function triageStop({ name, id, final, jevOut, state, agent, project, stall }) {
  if (config.aiTriage === 'off') return null;
  if (triages.has(id)) return triages.get(id);
  const rec = { type: 'triage', id, session: name, at: new Date().toISOString(), case: final.case, mode: config.aiTriage };
  const finish = async (extra, logIt = true) => { Object.assign(rec, extra); triages.set(id, rec); if (triages.size > 300) triages.delete(triages.keys().next().value); if (logIt) await log(rec); return rec; };
  if (!AI_URL || !JEV_API_KEY) return finish({ skipped: 'not configured' }, false);
  const viaFallback = fallbackOn() && (creditsOut() || jevBreaker.isOpen());   // OpenRouter has no credit / Jev is down: MiniMax M3 reads the stop instead
  if (!viaFallback && aiBudget.over(config.aiDailyUsd, config.aiDailyCalls)) return finish({ skipped: 'AI daily budget reached' });
  const ctx = (() => { try { return triageContext(name, final) || {}; } catch { return {}; } })();
  const deployish = final.case === 'waiting_deploy' || !!final.deployHint || /deploy/i.test(final.forbidden || '');   // lease + deploy-queue state only matters here
  const flags = [final.forbidden ? `forbidden topic: "${final.forbidden}"` : null, stall.draft ? 'the owner has an unsent draft in the input box' : null,
    final.no_status ? 'closing text gives no done / tested / left status' : null, final.deployHint ? 'mentions a deploy' : null].filter(Boolean);
  const facts = { session: name, agent, project, priority: ctx.priority, state, case: final.case, source: final.source, flags,
    jev: jevOut?.choice ? jevOut : null, quota: ctx.quota, ...(deployish ? { leases: ctx.leases, deploys: ctx.deploys } : {}), options: (() => { try { return reviewerOptions({ state, stall: { question: final.question || stall.question, excerpt: stall.excerpt, options: stall.options || final.options || null } }); } catch { return []; } })(), text: stall.excerpt || final.question || '' };
  const prompt = await reviewerPrompt.get();
  let r, fb = null;
  if (viaFallback) {
    fb = 'credits or Jev down';
    r = await fallbackRun('triage', name, (d) => d.reviewer({ facts, system: prompt.text }), fb);
    if (r.gated) return finish({ skipped: r.error });
  } else {
    r = await callReviewer({ url: AI_URL, apiKey: JEV_API_KEY, facts, system: prompt.text, fetchFn: reviewerFetch });
    aiBudget.add(r.cost || 0);
    if (r.error && jevErrorKind(r.error) === 'credits') {   // the reviewer found out first: same cool-down as Jev, and this stop still gets read
      creditsDownUntil = Date.now() + CREDITS_COOLDOWN_MS;
      if (fallbackOn()) { const f = await fallbackRun('triage', name, (d) => d.reviewer({ facts, system: prompt.text }), 'OpenRouter answered 402'); if (!f.gated) { r = f; fb = 'OpenRouter answered 402'; } }
    }
  }
  // what the eval sync and the Langfuse generation show: the prompt version used and the facts' flags (no closing text)
  const ctxInfo = { ...(fb ? { source: FALLBACK_SOURCE, fallback: fb } : {}), ...(prompt.version != null ? { prompt: { name: prompt.name, version: prompt.version } } : {}), src: final.source, flags };
  return finish(r.ai ? { ...ctxInfo, ai: r.ai, cost: r.cost, costEstimated: r.costEstimated, ms: r.ms, model: r.model, tin: r.tin, tout: r.tout } : { ...ctxInfo, error: r.error, cost: r.cost || 0, ms: r.ms });
}

export function cancelAuto(name, reason = 'cancelled by owner', quiet = false) {
  const w = watch.get(name);
  if (!w || !w.auto) return false;
  const a = w.auto;
  clearTimeout(a.timer);
  w.auto = null;
  if (isRemoteSession(name) && !(quiet && reason === 'superseded')) hookSafe(remoteHooks.cancelled, name, reason, a.id);
  const ids = kindIds(a), decided = Object.values(ids);
  if (!quiet && decided.length) { try { onMergeCancelled(name, { id: a.id, reason, ...(ids.merge ? { merge_decision_id: ids.merge } : {}), decision_ids: decided }); } catch {} }
  if (!quiet) logLater({ type: 'answer_cancelled', id: a.id, session: name, case: a.case, answer: a.answer, reason, ...(ids.merge ? { merge_decision_id: ids.merge } : {}), ...(decided.length ? { decision_ids: decided } : {}) });
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
    if (p.source === 'manager_decision') {
      const why = decisionBlock(name, p.kinds || {});
      if (why) { if (!p.escalated) escalate(name, w.last.state, w.stall || { case: p.case }, p.id, `${why} (held reply not sent)`); continue; }
    } else if (p.source === 'ai' ? aiBlock(name, p.case, p.confidence) : autoBlock(name, { case: p.case }, p.confidence)) continue;
    schedule(name, w, p);
  }
}

function schedule(name, w, a) {
  cancelAuto(name, 'superseded', true);
  // remote (Mac hook) stop: the hook gave the stop a loop-guard flag -> never answered, the owner gets it; the countdown must end before the hook stops waiting
  if (isRemoteSession(name) && remoteHooks.noAnswer(name)) { escalate(name, w.last?.state, w.stall || { case: a.case }, a.id, 'the Stop hook was already continuing (loop guard): not answered automatically'); hookSafe(remoteHooks.cancelled, name, 'loop guard', a.id); return; }
  // the countdown must end (with a margin) before the hook gives up, counted from NOW (the decision is ready); no time left = the owner gets it
  const cap = isRemoteSession(name) ? remoteHooks.maxDelayMs(name, a.id) : null;
  if (cap != null && cap <= 0) { escalate(name, w.last?.state, w.stall || { case: a.case }, a.id, 'the Mac hook stopped waiting before the answer'); hookSafe(remoteHooks.cancelled, name, 'the Mac hook stopped waiting before the answer', a.id); return; }
  const delayMs = cap != null ? Math.min(config.delayMs, cap) : config.delayMs;
  const auto = { ...a, sendAt: Date.now() + delayMs };
  auto.timer = setTimeout(() => fire(name, auto).catch((e) => console.error('[manager] fire', e.message)), delayMs);
  w.auto = auto;
}

// Fire time: everything is checked again against the latest pane before a single key is typed.
async function fire(name, auto) {
  const w = watch.get(name);
  if (!w || w.auto !== auto) return;
  const last = w.last;
  const md = auto.source === 'manager_decision';   // the manager's own merge / push / deploy / information answer: gated by decisionBlock, not by autoCases
  const kinds = auto.kinds || {};
  const ai = auto.source === 'ai';   // the AI reviewer's proposal, auto mode: same gates, plus its own switch and a re-check of the reply itself
  const forb = (w.stall?.forbidden || w.cls?.forbidden) || (ai ? forbiddenMatch(auto.answer?.text || '') : null);
  const hardOpts = { mergePresent: 'merge' in kinds, pushPresent: 'push' in kinds, deployPresent: 'deploy' in kinds, migrationsOk: !!auto.migrationsOk && 'deploy' in kinds };
  const ws = md ? (hardMatch(auto.answer?.text || '', hardOpts) ? { send: null, why: `forbidden: ${hardMatch(auto.answer?.text || '', hardOpts)}` } : w.cls?.draft ? { send: null, why: 'owner has a draft in the input box' } : { send: auto.answer, why: 'manager_decision' })
    : ai ? (forb ? { send: null, why: `forbidden: ${forb}` } : w.cls?.draft ? { send: null, why: 'owner has a draft in the input box' } : { send: auto.answer, why: 'ai' })
    : auto.override ? (menuUnsafe(auto.recText, kinds) ? { send: null, why: `forbidden: ${menuUnsafe(auto.recText, kinds)}` } : w.cls?.draft ? { send: null, why: 'owner has a draft in the input box' } : { send: auto.answer, why: auto.case })   // a menu whose recommended option was decided by the manager (menuDecision)
    : w.stall && w.cls ? wouldSend({ ...w.stall, draft: w.cls.draft, forbidden: w.stall.forbidden || w.cls.forbidden }) : { send: null, why: 'owner' };
  const mdBlock = md || auto.override ? decisionBlock(name, kinds) : null;   // a decided menu pick is gated by the same switches and confidence floors
  let reason = null, esc = false;
  if (isPaused(name)) reason = 'session paused by owner';
  else if (!config.autoSend) reason = 'auto-answer turned off';
  else if (!sessionOn(name)) reason = 'manager disabled for this session';
  else if (mdBlock) { reason = mdBlock; esc = mdBlock.startsWith('hourly'); }
  else if (ai && config.aiTriage !== 'auto') reason = 'AI auto-answer turned off';
  else if (ai && !config.aiAutoCases.includes(auto.case)) reason = `${auto.case} no longer an AI auto-answer case`;
  else if (!ai && !md && !config.autoCases.includes(auto.case)) reason = `${auto.case} no longer an auto-answer case`;
  else if (!md && auto.confidence < (ai ? config.aiMinConfidence : config.minConfidence)) reason = `confidence ${auto.confidence.toFixed(2)} below ${ai ? config.aiMinConfidence : config.minConfidence}`;
  else if (!last || (last.state !== 'waiting' && last.state !== 'done')) reason = 'session moved on';
  else if (w.hash !== auto.hash) reason = 'pane changed';
  else if (last.lastSendAt && w.pending && last.lastSendAt > w.pending.at) reason = 'owner sent something';
  else if (w.cls?.draft) reason = 'draft in the input box';
  else if (!ws.send) { reason = ws.why; esc = true; }
  else if (w.agent && policyOf(name, w.agent).action === 'hold') { const pol = policyOf(name, w.agent); applyHold(name, w, { id: auto.id, hash: auto.hash, answer: auto.answer, case: auto.case, source: auto.source, confidence: auto.confidence, kinds: auto.kinds, override: auto.override, recText: auto.recText, menu: auto.menu, escalated: auto.escalated, remaining: auto.remaining, migrationsOk: auto.migrationsOk }, pol); reason = `held: ${pol.reason}`; }
  else if (!send.key || !send.keys) reason = 'no send function';
  else if (hourCount(name) >= config.maxPerSessionPerHour) { reason = 'hourly cap reached'; esc = true; }
  if (md && reason && !auto.escalated && !/^(?:session moved on|pane changed|owner sent|session paused|manager disabled)/.test(reason)) esc = true;   // nothing else tells the owner this stop is still open
  if (reason) {
    cancelAuto(name, reason);
    if (esc) escalate(name, last?.state, w.stall || { case: auto.case }, auto.id, reason.startsWith('forbidden') ? humanWhy(w.stall || {}, ws) : reason);
    return;
  }
  w.auto = null;
  const a = auto.answer;
  try {
    if (a.key != null) await send.key(name, String(a.key), auto.id);
    else await send.keys(name, a.text, true, auto.id);
  } catch (e) {
    const ids = kindIds(auto), decided = Object.values(ids);
    if (decided.length) { try { onMergeCancelled(name, { id: auto.id, reason: `send failed: ${e.message}`, ...(ids.merge ? { merge_decision_id: ids.merge } : {}), decision_ids: decided }); } catch {} }
    logLater({ type: 'answer_cancelled', id: auto.id, session: name, case: auto.case, answer: a, reason: `send failed: ${e.message}`, ...(ids.merge ? { merge_decision_id: ids.merge } : {}), ...(decided.length ? { decision_ids: decided } : {}) });
    return;
  }
  sentLog.set(name, [...(sentLog.get(name) || []), Date.now()]);
  if (w.pending && w.pending.id === auto.id) { w.pending.auto = true; w.pending.autoAt = Date.now(); }
  logLater({ type: 'answer', id: auto.id, session: name, answer: a, case: auto.case, source: auto.source, confidence: auto.confidence, ...(auto.ready ? { ready: auto.ready } : {}), ...(kindIds(auto).merge ? { merge_decision_id: kindIds(auto).merge } : {}),
    ...(Object.keys(kinds).length || auto.menu ? { decision_ids: [...Object.values(kindIds(auto)), ...(auto.menu ? [`menu-${auto.id}`] : [])], ...(Object.keys(kinds).length ? { decided: Object.keys(kinds) } : {}) } : {}) });
  if (auto.menu) await appendJournal(menuRecord({ id: auto.id, session: name, at: new Date(), answer: a, ...auto.menu }));
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
// kind 'multi' (the popup's multi-question form): owner = { "1": "2", ... } (one pick per question number), ai = the AI
// reviewer's per-question picks in the same shape or null. agreeAi stays "all AI-covered questions agree" (null without AI
// picks); the scorecard uses the per-question counts aiQs / agreeQs (one vote per AI-covered question) plus agreeAiQ.
const pickMap = (o) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, 30)) if (v != null && v !== '') out[String(k).slice(0, 8)] = String(v).slice(0, 40);
  return Object.keys(out).length ? out : null;
};
export async function logOwnerChoice({ id, session, kind, owner, ownerText, ai, aiConfidence, jev, jevProbabilities } = {}) {
  if (typeof id !== 'string' || !id) throw bad('id required');
  if (typeof session !== 'string' || !session) throw bad('session required');
  const multi = kind === 'multi';
  const ownerPicks = multi ? pickMap(owner) : null;
  if (multi ? !ownerPicks : (typeof owner !== 'string' || !owner)) throw bad('owner required');
  const aiPicks = multi ? pickMap(ai) : null;
  const aiId = multi ? null : (typeof ai === 'string' && ai ? ai : null);
  const jevChoice = typeof jev === 'string' && jev ? jev : null;
  const rec = {
    type: 'choice',
    at: new Date().toISOString(),
    id,
    session,
    kind: typeof kind === 'string' && kind ? kind.slice(0, 20) : null,
    owner: multi ? ownerPicks : owner.slice(0, 80),
    ai: multi ? aiPicks : aiId,
    jev: jevChoice,
    agreeAi: multi ? null : aiId == null ? null : owner === aiId,
    agreeJev: multi ? null : jevAgreesOwner(jevChoice, owner, aiId),
  };
  if (multi && aiPicks) {
    const covered = Object.keys(aiPicks).filter((k) => ownerPicks[k] != null);
    rec.agreeAiQ = Object.fromEntries(covered.map((k) => [k, ownerPicks[k] === aiPicks[k]]));
    rec.aiQs = covered.length;
    rec.agreeQs = covered.filter((k) => rec.agreeAiQ[k]).length;
    rec.agreeAi = covered.length ? rec.agreeQs === covered.length : null;
  }
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
const jevSwitch = createJevSwitch();   // the server's JEV_ENABLED=false: one probe per 5 min, never an error
let creditsDownUntil = 0;
export const resetJevCooldown = () => { creditsDownUntil = 0; };   // tests, and an owner top-up

// ---- MiniMax fallback (round 9 item 10, minimax-fallback.js) ----
// OpenRouter has no credit (402 cool-down, or the cached balance is 0) or the Jev breaker is open: triage and the Jev-style choices go to
// MiniMax M3 through headless mcode instead of being skipped. Every call is logged ({type:'fallback', source:'minimax-fallback'}) and counted.
let fallbackDecider = null;
export const setFallbackDecider = (d) => { fallbackDecider = d; };   // tests inject a fake-mcode decider
const getFallback = () => (fallbackDecider ||= createFallbackDecider());
const creditsOut = () => { if (Date.now() < creditsDownUntil) return true; try { const cr = creditsPeek(); return !!(cr?.ok && cr.balance != null && cr.balance <= 0); } catch { return false; } };
const fallbackOn = () => config.aiFallback !== 'off';
const fallbackGate = () => (!fallbackOn() ? 'MiniMax fallback is off' : fallbackBudget.over(Infinity, config.aiFallbackDailyCalls) ? `MiniMax fallback daily cap reached (${config.aiFallbackDailyCalls})` : null);
async function fallbackRun(kind, session, fn, why) {
  const gate = fallbackGate();
  if (gate) return { error: gate, source: FALLBACK_SOURCE, gated: true };
  const r = await fn(getFallback());
  if (r.skipped) return { error: r.skipped, skipped: r.skipped, source: FALLBACK_SOURCE, gated: true };   // 'fallback busy': nothing ran, nothing counted
  fallbackBudget.add(0);
  logLater({ type: 'fallback', source: FALLBACK_SOURCE, for: kind, session: session || null, why, ok: !r.error, ...(r.error ? { error: String(r.error).slice(0, 200) } : {}), ms: r.ms ?? null, model: r.model || null, cost: 0, calls: fallbackBudget.snapshot().calls, cap: config.aiFallbackDailyCalls });
  return r;
}
// a Jev-shaped choice ({ choice, confidence, probabilities, ... }) from the fallback, or null when it cannot answer (the caller then skips as before)
async function fallbackChoice(body, session, why) {
  const r = await fallbackRun('jev', session, (f) => f.choice(body), why);
  if (r.error || !r.answers?.choice) return null;
  const a = r.answers.choice;
  return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, cost: 0, ms: r.ms, model: r.model, source: FALLBACK_SOURCE };
}

// ctx = { session, stallId, case }: what the product's log shows as "what this decision was about".
async function jev(stall, ctx = {}) {
  if (!JEV_URL || !JEV_API_KEY) return { skipped: 'not configured' };
  if (jevSwitch.off()) return { skipped: DISABLED };
  if (budget.day !== today()) budget = { day: today(), calls: 0, cost: 0 };
  if (budget.cost >= JEV_DAILY_USD || budget.calls >= JEV_DAILY_CALLS) return { skipped: 'daily budget reached' };
  if (creditsOut()) return (fallbackOn() && await fallbackChoice(jevRequestBody(stall, { usage: FALLBACK_USAGE }), ctx.session, 'OpenRouter credit used up')) || { skipped: 'OpenRouter credit used up (402), retrying later' };
  if (!jevBreaker.allow()) return (fallbackOn() && await fallbackChoice(jevRequestBody(stall, { usage: FALLBACK_USAGE }), ctx.session, 'Jev down (breaker open)')) || { skipped: 'Jev down (3 errors in a row), rules decide' };
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
    if (jevSwitch.seen(j)) return { skipped: DISABLED };   // Jev off on the server: not an error, not counted
    budget.calls += 1;
    budget.cost += Number(j.cost || 0);
    saveBudget();
    const a = j.answers?.choice;
    if (!j.success || !a) {
      const error = String(j.error || `http ${r.status}`).slice(0, 200);
      const kind = jevErrorKind(error);
      if (kind === 'credits') creditsDownUntil = Date.now() + CREDITS_COOLDOWN_MS;
      if (!j.success) jevBreaker.failure(error); else jevBreaker.success();
      if (kind === 'credits' && fallbackOn()) { const f = await fallbackChoice(jevRequestBody(stall, { usage: FALLBACK_USAGE }), ctx.session, 'OpenRouter answered 402'); if (f) return f; }
      return { error, kind, ms: Date.now() - started, ...(j.decision_id ? { decision_id: j.decision_id } : {}) };
    }
    jevBreaker.success();
    return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, cost: j.cost, ms: j.ms ?? Date.now() - started, model: j.model, ...(j.decision_id ? { decision_id: j.decision_id } : {}) };
  } catch (e) {
    jevBreaker.failure(e.message);
    return { error: e.message, kind: jevErrorKind(e.message), ms: Date.now() - started };
  }
}

// ---- router shadow (TASK-47 G2) ----
// One Jev call per new distinct stop (3 questions), after the rules classified it. SHADOW ONLY: the answers are logged
// ({type:'router'}) and graded later; nothing here is awaited by, or feeds into, the reply / escalation / push / hold flow.
const routerStops = new Map();   // stop id -> { decision_id, done, outcome, posted }
function shadowRoute({ id, session, agent, final, stall, escalated }) {
  try {
    if (config.routerShadow === false || routerStops.has(id) || !JEV_URL || !JEV_API_KEY) return;
    const st = { decision_id: null, done: false, outcome: null, posted: false };
    routerStops.set(id, st); if (routerStops.size > 500) routerStops.delete(routerStops.keys().next().value);
    (async () => {
      const rec = { type: 'router', id, session, rule_case: final.case, escalated };
      const skip = (why) => { st.done = true; return logLater({ ...rec, router: { skipped: why } }); };
      if (jevSwitch.off()) return skip(DISABLED);
      if (budget.day !== today()) budget = { day: today(), calls: 0, cost: 0 };
      if (budget.cost >= JEV_DAILY_USD || budget.calls >= JEV_DAILY_CALLS) return skip('daily budget reached');
      const cr = (() => { try { return creditsPeek(); } catch { return null; } })();
      if (cr?.ok && cr.balance != null && cr.balance <= 0) return skip('no OpenRouter credit');
      if (!jevBreaker.allow()) return skip('Jev down (3 errors in a row)');
      const post = async (body) => { const r = await fetch(JEV_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': JEV_API_KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) }); return { r, j: await r.json() }; };
      const router = await runShadow({ usage: MANAGER_USAGE, teamId: decisions.configured ? VPT_TEAM_ID : '', post,
        facts: { session, agent, forbidden: final.forbidden, no_status: final.no_status, excerpt: stall.excerpt, stallId: id, ruleCase: final.case, escalated },
        kindOf: jevErrorKind });
      if (router.skipped === DISABLED) { jevSwitch.markOff(); st.done = true; return logLater({ ...rec, router }); }
      if (router.error && !/^http 2\d\d$/.test(router.error)) jevBreaker.failure(router.error); else jevBreaker.success();   // an answer the shadow could not parse (http 200) is not an outage
      budget.calls += 1; budget.cost += Number(router.cost || 0);
      saveBudget();
      st.decision_id = router.decision_id || null; st.done = true;
      await logLater({ ...rec, router });
      flushRouterOutcome(id);
    })().catch((e) => { console.error('[manager] router shadow', e.message); });
  } catch (e) { console.error('[manager] router shadow', e.message); }
}
// The stop's outcome, once known: posted to the shadow decision once (after the call answered, whichever comes first).
function routerOutcome(id, kind) {
  const st = routerStops.get(id);
  if (!st || !kind || kind === 'unknown') return;
  st.outcome = kind; flushRouterOutcome(id);
}
function flushRouterOutcome(id) {
  const st = routerStops.get(id);
  if (!st || !st.done || !st.decision_id || !st.outcome || st.posted || !decisions.configured) return;
  st.posted = true;
  outcomeQueue.add(st.decision_id, outcomeBody(st.outcome, 'owner-reply', id)).catch((e) => console.error('[manager] router outcome', e.message));
}

// ---- wake shadow (TASK-47 G10) ----
// Every manager-events line gets Jev's opinion on whether the event needed waking the manager agent (`jev`), asked
// BEFORE the line is appended and capped at CAP_MS, and 15 min later what really happened (a `wake_outcome` record in
// stalls.jsonl, posted once to the decision log). SHADOW ONLY: the rules decide; nothing here changes an alert or a send.
// Same guards as the stop shadow: JEV configured, daily budget, no OpenRouter credit, the 402 cool-down.
const wakeAnnotator = createWakeAnnotator({
  enabled: () => config.wakeShadow !== false,
  teamId: decisions.configured ? VPT_TEAM_ID : '',
  kindOf: jevErrorKind,
  guard: () => {
    if (!JEV_URL || !JEV_API_KEY) return 'not configured';
    if (jevSwitch.off()) return DISABLED;
    if (budget.day !== today()) budget = { day: today(), calls: 0, cost: 0 };
    if (budget.cost >= JEV_DAILY_USD || budget.calls >= JEV_DAILY_CALLS) return 'daily budget reached';
    const cr = (() => { try { return creditsPeek(); } catch { return null; } })();
    if (cr?.ok && cr.balance != null && cr.balance <= 0) return 'no OpenRouter credit';
    if (Date.now() < creditsDownUntil) return 'OpenRouter credit used up (402), retrying later';
    if (!jevBreaker.allow()) return 'Jev down (3 errors in a row)';
    return null;
  },
  onError: (kind) => { if (kind === 'credits') creditsDownUntil = Date.now() + CREDITS_COOLDOWN_MS; },
  call: async (body) => {
    let r, j;
    try {
      r = await fetch(JEV_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': JEV_API_KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(CAP_MS) });
      j = await r.json();
    } catch (e) { jevBreaker.failure(e.message); throw e; }
    if (jevSwitch.seen(j)) return j;   // Jev off on the server: not counted against the budget
    if (budget.day !== today()) budget = { day: today(), calls: 0, cost: 0 };
    budget.calls += 1; budget.cost += Number(j?.cost || 0);
    saveBudget();
    if (j && j.success === false && !j.error) j.error = `http ${r.status}`;
    if (j && j.success === false) jevBreaker.failure(j.error); else if (j) jevBreaker.success();
    return j;
  },
});
// facts (wake-shadow.js wakeFacts) -> the `jev` value for the event line, or undefined when the switch is off.
export const wakeAnnotate = (facts) => wakeAnnotator(facts);

// Label the events whose 15 min window is over (derived from the files on every call: restart-safe, nothing in memory).
// Writes {type:'wake_outcome', event_key, label} to stalls.jsonl once per event and posts it to the Jev decision when
// the event carried a decision_id. Returns how many events were labelled.
export async function wakeOutcomeTick({ now = Date.now() } = {}) {
  const readLines = async (f) => { try { return (await readFile(f, 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const events = await readLines(join(STATE_DIR, EVENTS_FILE));
  if (!events.length) return 0;
  const recs = await readLines(LOG_FILE);
  const due = dueOutcomes({ events, recs, classify: classifyKey, now });
  for (const { event, key, label } of due) {
    await appendFile(LOG_FILE, JSON.stringify({ type: 'wake_outcome', at: new Date(now).toISOString(), event_key: key, kind: event.kind, session: event.session || null, label }) + '\n');
    const id = event.jev?.decision_id;
    if (id && decisions.configured) outcomeQueue.add(id, { label, by: OUTCOME_BY, event_key: key }).catch((e) => console.error('[manager] wake outcome', e.message));
  }
  return due.length;
}

// ---- merge decisions and information answers (round 7, OWNER_DECISIONS §14) ----
// The merge evaluation's Jev call: the router's `merge` point, same guards as the other Jev callers. -> reply | { skipped } | { error }.
async function jevPost(body) {
  if (!JEV_URL || !JEV_API_KEY) return { skipped: 'not configured' };
  if (jevSwitch.off()) return { skipped: DISABLED };
  if (budget.day !== today()) budget = { day: today(), calls: 0, cost: 0 };
  if (budget.cost >= JEV_DAILY_USD || budget.calls >= JEV_DAILY_CALLS) return { skipped: 'daily budget reached' };
  // merge / push / deploy evaluations never use the MiniMax fallback: when Jev is unavailable they keep the round-7 path (the manager's own reasoning)
  if (Date.now() < creditsDownUntil) return { skipped: 'OpenRouter credit used up (402), retrying later' };
  if (!jevBreaker.allow()) return { skipped: 'Jev down (3 errors in a row), rules decide' };
  body = { ...body, usage: await jevUsageNow(), ...(decisions.configured ? { team_id: VPT_TEAM_ID } : {}) };
  try {
    const r = await fetch(JEV_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': JEV_API_KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    const j = await r.json();
    if (jevSwitch.seen(j)) return { skipped: DISABLED };
    budget.calls += 1; budget.cost += Number(j.cost || 0); saveBudget();
    if (!j.success) { const error = String(j.error || `http ${r.status}`).slice(0, 200); jevBreaker.failure(error); return { error }; }
    jevBreaker.success();
    return j;
  } catch (e) { jevBreaker.failure(e.message); return { error: e.message }; }
}

// Parts of the ask that are already covered by the decisions the reply carries: a part about only decided topics, with no hard topic of
// its own, and whose branch / environment is the one that was evaluated (a part naming another one stays open).
const topicCovered = (part, ok, evs = {}, envs = []) => {
  const t = topicSplit(part.text);
  const mine = DECISION_KINDS.filter((k) => t[k]);
  if (!mine.length || !mine.every((k) => ok[k])) return false;
  if (hardMatch(part.text, { mergePresent: !!ok.merge, pushPresent: !!ok.push, deployPresent: !!ok.deploy })) return false;
  const word = (w) => new RegExp(String.raw`(?<![\w-])${String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\w-])`, 'i');
  const bare = (verb) => new RegExp(String.raw`\b${verb}(?:\s+(?:it|this|that|now|again))*\s*(?:[?.!,;)]|$|\b(?:and|then)\b)`, 'i').test(part.text);
  // a part is covered only if it names what was evaluated (the branch, the environment or the ref) or is a bare "push (it)?" / "deploy (it, now)?"
  if (t.push && evs.push) {
    const pa = parsePushAsk(part.text);
    if (pa.branches.some((b) => b !== evs.push.facts.branch) || pa.unparsed) return false;
    if (!word(evs.push.facts.branch).test(part.text) && !bare('push')) return false;
  }
  if (t.deploy && evs.deploy && !envs.some((n) => n === evs.deploy.facts.env && word(n).test(part.text)) && !word(evs.deploy.facts.ref).test(part.text) && !bare('deploy')) return false;
  if (t.deploy && evs.deploy) {
    const named = envs.filter((n) => new RegExp(String.raw`(?<![\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\w-])`, 'i').test(part.text));
    if (named.some((n) => n !== evs.deploy.facts.env)) return false;
  }
  return true;
};
const CASES_NOT_PARTIAL = ['permission', 'owner_action', 'waiting_deploy', 'error', 'background_wait', 'own_job_wait'];
const CASES_NOT_LEASE = ['permission', 'owner_action', 'error', 'background_wait', 'own_job_wait'];   // a lease question may come as waiting_deploy ("can I deploy, the lease ...")
// A recommended option that is irreversible-looking is hard whatever the topic split says. `kinds`: the merge / push / deploy topics the
// manager decided, exempt from the hard floor.
const IRREVERSIBLE_RE = /\b(?:delet(?:e|es|ed|ing|ion)|drop(?:s|ped|ping)?|wip(?:e|es|ed|ing)|publish(?:es|ed|ing)?|pay(?:s|ment|ing)?|send(?:ing)?\s+(?:an?\s+|the\s+)?e-?mails?|rm\s+-rf?)\b/i;
const menuUnsafe = (text, kinds = {}) => hardMatch(String(text || ''), { mergePresent: 'merge' in kinds, pushPresent: 'push' in kinds, deployPresent: 'deploy' in kinds }) || (IRREVERSIBLE_RE.exec(String(text || '')) || [])[0] || null;
const OPTION_LINE_RE = /^\s*(?:[❯›>]\s*)?\d+[.)]\s+/;
// The WHOLE closing text around a menu (the reporter's turn text when the stop was classified from it, else the pane's closing lines), minus the
// option run that holds the recommended option, plus the parsed question. The other options of that run are left out on purpose; numbered
// lines elsewhere (a plan's steps) stay in. No line window: a hard sentence far above the menu still counts.
const stemOf = (final, stall, rec) => {
  const lines = String(stall.fullText || stall.closing || stall.excerpt || '').split('\n');
  const at = rec ? lines.findIndex((l) => OPTION_LINE_RE.test(l) && l.includes(String(rec.text).slice(0, 40))) : -1;
  let from = at, to = at;
  if (at >= 0) { while (from > 0 && OPTION_LINE_RE.test(lines[from - 1])) from--; while (to < lines.length - 1 && OPTION_LINE_RE.test(lines[to + 1])) to++; }
  return [...(at >= 0 ? [...lines.slice(0, from), ...lines.slice(to + 1)] : lines), final.question || ''].join('\n');
};

const appendJournal = async (record) => { try { await appendFile(DECISIONS_FILE, JSON.stringify(record) + '\n'); } catch (e) { console.error('[manager] journal', e.message); } };

// Evaluate the merge / push / deploy topics present in `text` (in that order), journal each evaluation, tell the feed.
// -> { evs: { merge?, push?, deploy? }, ok: { merge: bool, ... }, why: { kind: reason }, kinds: { kind: confidence } for the passing ones }
async function decideTopics({ s, id, h, w, text, askText = text, evidenceText, topics, wanted }) {
  const name = s.name;
  const out = { evs: {}, ok: {}, why: {}, kinds: {}, stale: false };
  const ctxNow = () => { try { return decideContext() || {}; } catch { return {}; } };
  const jevFn = (b) => mergeJev(b);
  const note = (kind, ev, record) => {
    logLater({ type: `${kind}_decision`, id, session: name, verdict: ev.verdict, reasons: ev.reasons, repo: ev.facts.repoName || null, branch: ev.facts.branch || null, confidence: ev.decision.confidence, source: ev.decision.source,
      ...(kind === 'merge' ? { target: ev.facts.target || null, branch_sha: ev.facts.branchSha || null } : kind === 'push' ? { dest: ev.facts.dest || null, branch_sha: ev.facts.branchSha || null } : { env: ev.facts.env || null, scope: ev.facts.scope || null, ref: ev.facts.ref || null, sha: ev.facts.sha || null }) });
    try { onMergeDecision(name, record); } catch (e) { console.error('[manager] onMergeDecision', e.message); }
  };
  const at = new Date(s.now);
  const record = async (kind, ev) => {
    const rec = kind === 'merge' ? journalRecord(ev, { id, session: name, at }) : decisionRecord(kind, ev, { id, session: name, at });
    await appendJournal(rec);
    note(kind, ev, rec);
    out.evs[kind] = ev;
    out.ok[kind] = ev.verdict === kind;
    if (!out.ok[kind]) out.why[kind] = `${kind} not decided: ${ev.reasons.join('; ')}`;
    else out.kinds[kind] = ev.decision.confidence;
  };
  const stale = () => { if (w.hash !== h) { out.stale = true; return true; } return false; };
  if (wanted.merge) {
    const ev = s.remote ? remoteEscalation('merge', s) : await evaluateMerge({ cwd: s.cwd, text, evidenceText, session: name, config, jev: jevFn });
    if (stale()) return out;
    await record('merge', ev);
  }
  if (wanted.push) {
    const mergeEv = out.evs.merge;
    const pa = parsePushAsk(askText);
    let ev;
    if (s.remote) ev = remoteEscalation('push', s);   // round 9 remote block: no merge / push evaluation for a Mac session
    else if (mergeEv && !out.ok.merge && !pa.branch) {
      ev = { verdict: 'escalate', reasons: ['the push lands a merge that was not decided'], rationale: 'the push lands a merge that was not decided', question: 'Push?', facts: { ok: false, repoName: mergeEv.facts.repoName, branch: mergeEv.facts.branch, dest: mergeEv.facts.target, files: [] }, tests: mergeEv.tests, decision: { source: 'floor', choice: 'escalate', confidence: 1, decision_id: null } };
    } else {
      const after = out.ok.merge && (!pa.branch || pa.branch === mergeEv.facts.target) ? { branch: mergeEv.facts.branch, target: mergeEv.facts.target, tests: mergeEv.tests, decision: mergeEv.decision, facts: mergeEv.facts } : null;
      ev = await evaluatePush({ cwd: s.cwd, text: askText, evidenceText, session: name, config, jev: jevFn, afterMerge: after });
    }
    if (stale()) return out;
    await record('push', ev);
  }
  if (wanted.deploy) {
    const mergeEv = out.evs.merge;
    const hint = deployHint(askText);
    let ev;
    if (mergeEv && !out.ok.merge && !hint.ref) {
      ev = { verdict: 'escalate', reasons: ['the deploy ships a merge that was not decided'], rationale: 'the deploy ships a merge that was not decided', question: 'Deploy?', facts: { ok: false, repoName: mergeEv.facts.repoName, env: null, scope: hint.scope || 'full', ref: null, previous: [] }, tests: mergeEv.tests, decision: { source: 'floor', choice: 'escalate', confidence: 1, decision_id: null } };
    } else {
      const c = ctxNow();
      const after = out.ok.merge && (!hint.ref || hint.ref === mergeEv.facts.target) ? { branch: mergeEv.facts.branch, target: mergeEv.facts.target } : null;
      ev = await evaluateDeploy({ session: name, text: askText, cwd: s.cwd, config, deploys: c.deploys || null, leases: c.leases || null, envs: c.envs || [], jev: jevFn, evidenceText, afterMerge: after });
    }
    if (stale()) return out;
    await record('deploy', ev);
  }
  return out;
}

const topicsWanted = (topics, parts = null) => ({
  merge: !!topics?.merge && config.mergeDecisions && (!parts || parts.some((p) => p.kind !== 'info' && mergeMatch(p.text))),
  push: !!topics?.push && config.pushDecisions && (!parts || parts.some((p) => p.kind !== 'info' && pushMatch(p.text))),
  deploy: !!topics?.deploy && config.deployDecisions && (!parts || parts.some((p) => p.kind !== 'info' && deployMatch(p.text))),
});
const argsOf = (out) => ({
  merge: out.ok.merge ? { repo: out.evs.merge.facts.repoName, branch: out.evs.merge.facts.branch, target: out.evs.merge.facts.target, rationale: out.evs.merge.rationale } : null,
  push: out.ok.push ? { repo: out.evs.push.facts.repoName, branch: out.evs.push.facts.branch, dest: out.evs.push.facts.dest, rationale: out.evs.push.rationale } : null,
  deploy: out.ok.deploy ? { migrations: out.evs.deploy.facts.migrations || null, env: out.evs.deploy.facts.env, scope: out.evs.deploy.facts.scope, ref: out.evs.deploy.facts.ref, sha: out.evs.deploy.facts.sha, rationale: out.evs.deploy.rationale, rollback: out.evs.deploy.rollback } : null,
});

// An owner-bound stop that asks for information and / or a merge, push or deploy: answer what the manager can (the information when it is
// in the docs, each topic when its policy says so), one reply, and escalate only the rest. -> { handled, mergeWhy } (mergeWhy: the
// reasons a decided topic was escalated; handled: a reply is scheduled).
async function partialDecision({ s, w, id, h, final, stall }) {
  const out = { handled: false, mergeWhy: null };
  const name = s.name;
  // A question about a lease is never an owner question (design sections 4 and 7): it is answered from the lease source.
  // Only a PURE lease part is answered: the hard floor runs on it with no exemptions (a deploy or restart word in it makes it an owner / deploy
  // question). The deploy / hard topics of the whole question stay in force below: they escalate, only the pure lease part is answered.
  const markLease = (p) => (config.leaseAnswers && leaseAsk(p.text).lease && !hardMatch(p.text, {}) ? { ...p, kind: 'info', lease: true } : p);
  let all = leaseViewOf ? splitAsk(final.question || '').map(markLease) : splitAsk(final.question || '');
  if (leaseViewOf && !all.some((p) => p.lease)) { const whole = markLease({ text: String(final.question || '').trim(), kind: 'other' }); if (whole.lease) all = [whole]; }   // the ask only reads as a lease question as a whole
  // Self-check (round 9, item 5): version / progress / "does this file exist" are settled from the registry and the hosts. Same floor as the lease part:
  // a deploy word is the subject of a version question, not a deploy request; every other hard word keeps the part with the owner.
  const markSelf = (p) => { let k = config.selfChecks !== false && !p.lease && p.kind !== 'merge' && !hardMatch(p.text, { deployPresent: true }) ? selfAsk(p.text) : null; if (k && k.kind !== 'version' && isRemoteSession(name)) k = null; /* a remote (Mac) session's jobs and files are not on this host */ return k ? { ...p, kind: 'info', self: k.kind } : p; };
  all = all.map(markSelf);
  if (!all.some((p) => p.self) && config.selfChecks !== false) { const whole = markSelf({ text: String(final.question || '').trim(), kind: 'other' }); if (whole.self) all = [whole]; }
  const selfHit = all.some((p) => p.self);
  const leaseHit = all.some((p) => p.lease);
  if (isManagerSession(name) || !toOwnerCase(final) || (leaseHit || selfHit ? CASES_NOT_LEASE : CASES_NOT_PARTIAL).includes(final.case) || stall.draft) return out;
  // Only a finished turn: free text typed into a live menu (waiting) would select the highlighted option, and any menu option means the
  // owner picks from it. Those stops go the existing way (menu_recommended: menuDecision).
  if (s.state !== 'done' || (final.options?.length || 0) >= 1 || (stall.options?.length || 0) >= 1) return out;
  const wantedAny = topicsWanted(final.topics);
  if (!config.infoAnswers && !leaseHit && !selfHit && !(wantedAny.merge || wantedAny.push || wantedAny.deploy)) return out;
  if (decisionBlock(name)) return out;   // auto-answer off, paused, capped: nothing is typed, the owner gets the whole stop as before
  const topics = final.topics;   // the whole question's: a deploy / restart / hard topic anywhere in the stop is escalated, never swallowed by the lease answer
  const parts = all.filter((p) => p.kind !== 'other' || isAsk(p.text));   // a statement that rode along is not part of the ask
  // ...unless it carries a question or a choice ("A or B"): that is open too
  const hiddenAsk = all.filter((p) => !parts.includes(p) && /\?|\bor\b/i.test(p.text));
  if (!parts.length) return out;
  const roots = [await repoToplevel(s.cwd), ...(config.infoRoots || [])].filter(Boolean);
  const info = [];
  if (leaseHit) {
    let lv = null; try { lv = await leaseViewOf(name); } catch { lv = { ok: false }; }   // unreachable source = busy, never free
    for (const p of parts.filter((x) => x.lease)) {
      const a = answerLeaseAsk({ ask: p.text, view: lv || { ok: false }, session: name, now: s.now });
      if (a) info.push({ part: p.text, label: 'Lease', answer: a.text, source: '' });
    }
  }
  if (selfHit) {
    const dctx = (() => { try { return decideContext() || {}; } catch { return {}; } })();
    let progress = null; try { progress = ownJobs ? await ownJobs.progressOf(name) : null; } catch { progress = null; }
    for (const p of parts.filter((x) => x.self)) {
      let a = null; try { a = await answerSelf(p, { deployed: dctx.deploys?.deployed || {}, envs: dctx.envs || [], roots, progress, now: s.now }); } catch { a = null; }
      if (a) info.push({ part: p.text, ...a });
    }
  }
  if (config.infoAnswers && roots.length) {
    for (const p of parts) {
      if (p.kind !== 'info' || p.lease || p.self) continue;
      let hit = null; try { hit = await lookupInfo(p, { roots }); } catch { hit = null; }
      if (hit) info.push({ part: p.text, ...hit });
    }
  }
  if (w.hash !== h) return out;   // a slow lookup must not supersede a newer stop's pending answer
  const wanted = s.cwd ? topicsWanted(topics, parts) : { merge: false, push: false, deploy: false };
  const evidenceText = stall.closing || stall.excerpt || '';
  let dec = { evs: {}, ok: {}, why: {}, kinds: {}, stale: false };
  if (wanted.merge || wanted.push || wanted.deploy) {
    dec = await decideTopics({ s, id, h, w, text: `${final.question || ''}\n${evidenceText}`, askText: final.question || '', evidenceText, topics, wanted });
    if (dec.stale || w.hash !== h) return out;   // the pane moved on while Jev was thinking
    const whys = DECISION_KINDS.map((k) => dec.why[k]).filter(Boolean);
    if (whys.length) out.mergeWhy = whys.join('; ');
  }
  // a topic present in the text but not decided (switch off, no repo) is left to the owner
  const offTopics = DECISION_KINDS.filter((k) => topics?.[k] && !(k in dec.evs));
  let hard = topics?.hard || null;
  // a deploy the manager decided that ships additive lab migrations covers the noun "migration(s)" in the ask (round 9, item 4); "migrate" the verb and every other hard word stay
  const migOk = !!(dec.ok.deploy && dec.evs.deploy?.facts?.migrations?.length);
  if (hard && migOk) hard = hardMatch(stall.topicsText ?? final.question ?? '', { mergePresent: !!topics.merge, pushPresent: !!topics.push, deployPresent: !!topics.deploy, migrationsOk: true });
  // the hard word of an answered self-check part ("what version is deployed on env-a?") is the subject of the question, not a request: read the rest
  const selfDone = info.filter((i) => i.kind).map((i) => i.part);
  if (hard && selfDone.length) {
    let rest = String(stall.topicsText ?? final.question ?? '');
    for (const p of selfDone) rest = rest.split(p).join(' ');
    hard = hardMatch(rest, { mergePresent: !!topics.merge, pushPresent: !!topics.push, deployPresent: !!topics.deploy, migrationsOk: migOk });
  }
  const args = argsOf(dec);
  let reply = composeReply({ info, ...args, remaining: true });
  if (!reply) return out;
  // what the reply really carries (a line the hard floor dropped is not answered)
  const answered = { merge: reply.merge, push: reply.push, deploy: reply.deploy };
  const answeredInfo = reply.info.map((n) => info[n]);
  const envNames = (() => { try { return decideContext()?.envs || []; } catch { return []; } })();
  const stillOpen = parts.filter((p) => !answeredInfo.some((i) => i.part === p.text) && !topicCovered(p, answered, dec.evs, envNames));
  const decidedNotAnswered = DECISION_KINDS.some((k) => k in dec.evs && !answered[k]);
  const open = !!hard || stillOpen.length > 0 || hiddenAsk.length > 0 || decidedNotAnswered || offTopics.length > 0;
  if (!open) reply = composeReply({ info, ...args, remaining: false });   // same kept lines, without the pointer to the owner
  const kinds = Object.fromEntries(DECISION_KINDS.filter((k) => answered[k]).map((k) => [k, dec.kinds[k]]));
  if (decisionBlock(name, kinds)) return out;
  const pending = { id, hash: h, answer: { text: reply.text }, case: final.case, source: 'manager_decision', confidence: 1, kinds, escalated: open, remaining: open, ...(migOk && answered.deploy ? { migrationsOk: true } : {}) };
  const pol = policyOf(name, s.agent);
  shadowRoute({ id, session: name, agent: s.agent, final, stall, escalated: open });
  if (pol.action === 'hold') { applyHold(name, w, pending, pol); }
  else { if (holdOf(name)) endHold(name, 'manager', `quota ok: ${pol.reason}`, false); schedule(name, w, pending); }
  if (open) {
    const left = [];
    if (hard) left.push(`${hard} question`);
    for (const k of DECISION_KINDS) if (k in dec.evs && !answered[k]) left.push(dec.why[k] || `${k} not answered`);
    for (const k of offTopics) left.push(`${k} question (${k} decisions are off or not possible here)`);
    const coveredByAnswer = (p) => topicCovered(p, answered, dec.evs, envNames);
    for (const p of [...stillOpen, ...hiddenAsk]) if (!coveredByAnswer(p)) left.push(`"${p.text.slice(0, 60)}"`);
    const done = [...DECISION_KINDS.filter((k) => answered[k]).map((k) => `${k} answered by the manager`), answeredInfo.length ? `${answeredInfo.length === 1 ? 'information' : 'information x' + answeredInfo.length} answered` : null].filter(Boolean);
    escalate(name, s.state, final, id, `${[...new Set(left)].join(', ') || 'the rest'} - needs you (${done.join('; ')})`);
  }
  return { handled: true };
}

// A menu whose recommended option the manager may take (round 8, OWNER_DECISIONS §15). The hard floor is read over the question stem plus the
// recommended option (a generic "Yes" / "Proceed" inherits the question's topic); only the topics the manager actually decides are exempt,
// and anything left over is escalated. Options other than the recommended one may carry any topic.
// -> null (the usual flow), { ok: true, recText, kinds } (take it: the stall is no longer "forbidden") or { ok: false, why } (escalate with the reason).
async function menuDecision({ s, w, id, h, final, stall }) {
  const name = s.name;
  if (isManagerSession(name) || final.case !== 'menu_recommended' || !final.options?.length || stall.draft) return null;
  const rec = final.options.find((o) => o.recommended);
  if (!rec) return null;
  const stem = stemOf(final, stall, rec);
  // the hard floor reads the approved action (the option, or the question for a generic one, and the commands it runs), not every word of the ask
  const act = approvedAction({ ...stall, options: final.options, question: final.question });
  const combined = [act.text, ...act.commands].join('\n');
  const topics = topicSplit(combined);
  const present = DECISION_KINDS.filter((k) => topics[k]);
  const irreversible = (IRREVERSIBLE_RE.exec(combined) || [])[0] || null;
  if (!final.forbidden && !present.length && !topics.hard && !irreversible) return null;   // nothing in the way: the existing auto-answer path
  if (autoBlockFor(name, final)) return null;       // nothing would be typed anyway: the owner gets the stop as before
  const hardLeft = hardMatch(combined, { mergePresent: !!topics.merge, pushPresent: !!topics.push, deployPresent: !!topics.deploy });
  const bad = hardLeft || irreversible || (final.forbidden && !present.length ? forbiddenMatch(combined) : null);   // belt: a forbidden stop that no decided topic explains and that is not just another option's text
  if (bad) return { ok: false, why: `the question or the recommended option is a ${bad} question - needs you` };
  if (!present.length) return { ok: true, recText: combined, kinds: {}, menu: menuInfo(final, rec) };
  const wanted = s.cwd ? topicsWanted(topics) : { merge: false, push: false, deploy: false };
  const off = present.filter((k) => !wanted[k]);
  if (off.length) return { ok: false, why: `the recommended option is a ${off.join('/')} question - ${off.join('/')} decisions are off or not possible here` };
  const evidenceText = stall.closing || stall.excerpt || '';
  const dec = await decideTopics({ s, id, h, w, text: `${rec.text}\n${stem}`, askText: combined, evidenceText, topics, wanted });
  if (dec.stale || w.hash !== h) return { stale: true };
  const whys = DECISION_KINDS.map((k) => dec.why[k]).filter(Boolean);
  if (whys.length) return { ok: false, why: whys.join('; ') };
  return { ok: true, recText: combined, kinds: dec.kinds, evs: dec.evs, menu: menuInfo(final, rec) };
}
const menuInfo = (final, rec) => ({ question: String(final.question || '').slice(0, 200), option: rec.text.slice(0, 200), key: rec.n, options: final.options.length, ...(rec.unmarked ? { unmarked: true } : {}) });
// the recommended option of a menu_recommended stop, for the decision journal ("menu" kind)
const menuPick = (final) => { const rec = final.case === 'menu_recommended' && final.options?.find((o) => o.recommended); return rec ? menuInfo(final, rec) : null; };
const autoBlockFor = (name, final) => autoBlock(name, { case: 'menu_recommended', autoCase: final.autoCase }, 1);

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
  if (s.remote) w.seen = true;   // remote stops arrive settled (REMOTE hook block above)
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
      if (!p.auto) routerOutcome(p.id, reply.text ? outcomeKind(reply.text) : 'unknown');
      settleRoundtrip(s.name, p, 'answered', p.auto ? p.autoAt || s.now : s.answeredAt ?? (sentSince ? s.lastSendAt : said?.at ?? s.now), s.machine);
      w.pending = null;
    }
    if (holdOf(s.name)) endHold(s.name, 'manager', 'session moved on', false);
    w.stopSince = null;
    try { ownJobs?.forget(s.name); } catch {}
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
    if (useReport) w.cls.fullText = turn.text;   // the whole reported turn: the menu decision reads every line of it
    if (bgWait) Object.assign(w.cls, { case: 'background_wait', answer: null, autoCase: undefined, forbidden: null, no_status: false, source: 'rule', backgroundWork: turn.backgroundWork });
    w.clsKey = key;
  }
  const stall = w.cls;
  if (w.auto && stall.draft) cancelAuto(s.name, 'draft in the input box');
  const h = hash(`${stall.case}|${stopKey(stall.excerpt)}`);
  if (h !== w.hash) { if (w.auto) cancelAuto(s.name, 'pane changed'); w.hash = h; w.since = s.now; w.logged = false; w.stall = stall; }
  // First sight after a restart: don't log stalls that were already sitting there.
  if (!w.seen) { w.logged = true; w.seen = true; return w.stall; }
  if (w.logged || (!s.remote && s.now - w.since < SETTLE_MS) || !sessionOn(s.name)) return w.stall;
  w.logged = true;
  // The very same stop as the last one logged, with no real work or send in between: not a new stop.
  // The last RECENT_STOPS logged stops are remembered per session on disk, so a restart, a repaint or an
  // A, B, A flip does not log a stop again; real work, a send or a reporter prompt since resets the list.
  const stopId = hash(stopKey(stall.excerpt));
  const recent = w.recent ?? (w.recent = Array.isArray(lastStops[s.name]) ? [...lastStops[s.name]] : []);
  if (w.moved) recent.length = 0;
  if (recent.includes(stopId) && !s.remote) return w.stall;
  recent.push(stopId); if (recent.length > RECENT_STOPS) recent.shift();
  w.moved = false;
  lastStops[s.name] = [...recent]; saveLastStops();

  const id = randomUUID();
  if (w.pending) settleRoundtrip(s.name, w.pending, 'superseded', s.now, s.machine);
  w.pending = { id, at: s.now, key: stopKey(stall.excerpt), ...(s.remote ? { remote: true, machine: s.machine } : {}) };
  stopWall.set(id, Date.now()); if (stopWall.size > 500) stopWall.delete(stopWall.keys().next().value);
  (async () => {
    let final = stall, jevOut = null;
    if (stall.source === 'ambiguous') {
      jevOut = await jev(stall, { session: s.name, stallId: id, case: stall.case });
      if (jevOut.decision_id) { decisionByStop.set(id, jevOut.decision_id); if (decisionByStop.size > 500) decisionByStop.delete(decisionByStop.keys().next().value); }
      if (jevOut.choice) final = applyJev(stall, jevOut.choice);
    }
    if (w.hash !== h) return;   // the pane moved on while Jev was thinking: that stall is gone
    // mockup-first (round 9, item 7): "may I show you the mockup before I build?" is answered "post it to the feed and build"; the hard floor still applies to the ask
    const mock = !isManagerSession(s.name) && !isRemoteSession(s.name) && !stall.draft ?   /* /api/mockups is loopback-only: a remote (Mac) session cannot post */ mockupRule(final, { windowMin: config.mockupWindowMin, enabled: config.mockupFirst !== false }) : null;
    if (mock) final = { ...final, case: 'continue', source: 'mockup-first', answer: { text: mock }, autoCase: undefined, no_status: false };
    let ws = wouldSend(final);
    const confidence = final.source === 'jev' ? Number(jevOut?.probabilities?.[jevOut.choice] ?? jevOut?.confidence ?? 0) : 1;
    if (w.pending?.id === id) w.pending.cls = final.case;
    w.stall = { ...final, would: ws, jev: jevOut?.choice ? { choice: jevOut.choice, probabilities: jevOut.probabilities || null } : null };
    await log({
      type: 'stall', id, session: s.name, project: s.project || null, agent: s.agent, state: s.state,
      at: new Date(s.now).toISOString(), case: final.case, source: final.source, textSource: stall.textSource || 'pane', question: final.question,
      ...(final.case === 'background_wait' ? { backgroundWork: final.backgroundWork } : {}),
      forbidden: final.forbidden, draft: final.draft, suggestion: final.suggestion,
      no_status: !!final.no_status, ...(final.status ? { status: final.status } : {}), ...(final.deployHint ? { deployHint: final.deployHint } : {}), ...(final.action ? { action: final.action } : {}),
      jev: jevOut, wouldSend: ws.send, why: ws.why, confidence, excerpt: stall.excerpt,
      ...(final.handoff ? { handoff: final.handoff } : {}),
    });
    if (/^(?:waiting|blocked)$/i.test(final.status || '')) { try { statusHook(s.name, String(final.status).toLowerCase(), String(final.question || '').slice(0, 300)); } catch (e) { console.error('[manager] onStatus', e.message); } }
    // a session that waits on a job of its own is woken when the job ends (own-jobs.js); a deploy it queued is followed the same way
    // a blocked STATUS that names a job in words only: it is the session's own when the agent has a live child process at the stop
    if (ownJobs?.hasLiveChild && final.jobNoun && final.case === 'owner_decision' && !isRemoteSession(s.name) && !isManagerSession(s.name)) {
      try { if (await ownJobs.hasLiveChild(s.name, { text: String(final.question || ''), turnStart: s.rep?.turnStart?.() ?? null })) final = { ...final, case: 'own_job_wait', answer: null, autoCase: undefined, ownJob: {} }; } catch (e) { console.error('[manager] live child', e.message); }
    }
    if (ownJobs && !isManagerSession(s.name) && !isRemoteSession(s.name) && (final.case === 'own_job_wait' || (final.case === 'waiting_deploy' && final.deployHint?.id && /^waiting$/i.test(final.status || '')))) {
      try { const r = await ownJobs.watch(s.name, { text: final.case === 'waiting_deploy' ? `deploy ${final.deployHint.id}` : String(final.question || ''), cwd: s.cwd || null, stopAt: id, paneText: stall.excerpt || '' }); logLater({ type: 'own_job', id, session: s.name, job: r.kind || 'unknown', label: r.label || null, detached: !!r.detached });
        // a pid that is not running on this host cannot be watched: the owner hears about it instead of the session waiting for ever
        if (r.unseen && final.case === 'own_job_wait') { final = { ...final, case: 'owner_decision' }; escalate(s.name, s.state, final, id, `pid ${r.pid} is not running on this host`); return; } } catch (e) { console.error('[manager] own job', e.message); }
    }
    if (final.handoff) { try { await onHandoff(s.name, final.handoff, s.now); } catch (e) { console.error('[manager] onHandoff', e.message); } }
    const partial = await partialDecision({ s, w, id, h, final, stall }).catch((e) => { console.error('[manager] partial decision', e.message); return { handled: false }; });
    if (partial.handled) return;
    if (w.hash !== h) return;
    // a recommended menu option the manager may take (or must escalate with a reason): its own text decides, not the whole question
    const menu = await menuDecision({ s, w, id, h, final, stall }).catch((e) => { console.error('[manager] menu decision', e.message); return null; });
    if (menu?.stale || w.hash !== h) return;
    if (readyDecision({ s, w, id, h, final, stall })) return;   // ready window (round 9 item 8)
    if (menu?.ok) { ws = wouldSend({ ...final, forbidden: null }); w.stall = { ...w.stall, forbidden: null, would: ws }; }
    else if (menu) partial.mergeWhy = menu.why;
    // a decided topic that was escalated (merge / push / deploy) must not ride on an automatic "Yes, continue."
    if (partial.mergeWhy && ws.send && !menu?.ok) ws = { send: null, why: 'owner' };
    const block = ws.send ? autoBlock(s.name, final, confidence) : null;
    shadowRoute({ id, session: s.name, agent: s.agent, final, stall, escalated: !isManagerSession(s.name) && !(ws.send && !block) && final.case !== 'done' && final.case !== 'background_wait' && final.case !== 'own_job_wait' });   // shadow: fire and forget, never awaited
    if (ws.send && !block) {   // the existing auto-answer handles this one
      const pending = { id, hash: h, answer: ws.send, case: final.autoCase || final.case, source: final.source, confidence, ...(menu?.ok ? { override: true, recText: menu.recText, kinds: menu.kinds } : {}), ...(menuPick(final) ? { menu: menuPick(final) } : {}) };
      const pol = policyOf(s.name, s.agent);
      if (pol.action === 'hold') { applyHold(s.name, w, pending, pol); return; }
      if (holdOf(s.name)) endHold(s.name, 'manager', `quota ok: ${pol.reason}`, false);
      schedule(s.name, w, pending);
      return;
    }
    const baseWhy = ws.send ? block : humanWhy(final, ws);
    const hardWhy = final.topics?.hard && !String(baseWhy).includes(final.topics.hard) ? ` [hard: ${final.topics.hard}]` : '';   // name the hard hit even when the first forbidden word was a decidable one
    const why = (partial.mergeWhy ? (final.topics?.hard ? `${baseWhy} (${partial.mergeWhy})` : partial.mergeWhy) : baseWhy) + hardWhy;
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
    if (final.case !== 'done' && final.case !== 'background_wait' && final.case !== 'own_job_wait') escalate(s.name, s.state, final, id, why, oneLine(tri));
    return;
  })().catch((e) => console.error('[manager]', e.message)).finally(() => { if (s.remote) hookSafe(remoteHooks.settled, s.name, id, !!watch.get(s.name)?.auto); });
  return w.stall;
}

export function forget(name) { cancelAuto(name, 'session removed'); const p = watch.get(name)?.pending; if (p) settleRoundtrip(name, p, 'removed', Date.now()); watch.delete(name); try { ownJobs?.forget(name); } catch {} }
// For the own-jobs watcher: is `session` still stopped at the stop `stopId` (so a wake is still wanted), and may text be typed into it now?
export const stillStopped = (session, stopId) => { const w = watch.get(session); return !!(w && w.pending?.id === stopId && w.last && (w.last.state === 'done' || w.last.state === 'waiting')); };
// The same gates as a decided reply (decisionBlock: pause, autoSend, hourly cap, draft) plus enabled / sessionOn; a wake counts in the hourly cap (countSent).
export const canType = (session) => { const w = watch.get(session); return !!w && w.last?.state === 'done' && config.enabled && sessionOn(session) && !decisionBlock(session, {}); };
export const countSent = (session) => { sentLog.set(session, [...(sentLog.get(session) || []), Date.now()]); };
export function prune(live) { for (const k of [...watch.keys()]) if (!live.has(k)) forget(k); }

export function stallOf(name) {
  const w = watch.get(name);
  if (!w || !w.stall) return null;
  const st = w.stall;
  return { case: st.case, no_status: !!st.no_status, source: st.source, would: st.would || null, question: st.question, excerpt: st.excerpt || st.question || null, closing: st.closing && st.closing !== st.excerpt ? st.closing : null,
    id: w.pending && w.pending.key === stopKey(st.excerpt) ? w.pending.id : null,   // the previous stop's id never rides on a new stop's content
    options: st.options || null, suggestion: st.suggestion || null, suggestionForbidden: st.suggestion ? forbiddenMatch(st.suggestion) : null,
    forbidden: st.forbidden || w.cls?.forbidden || null, escalated: escalatedStops.has(w.pending && w.pending.key === stopKey(st.excerpt) ? w.pending.id : null), draft: !!(w.cls?.draft), jev: st.jev || null };
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

// ---- "Decided for you" (round 8): what the manager typed on the owner's behalf, see decided.js ----
const readJsonl = async (f) => { try { return (await readFile(f, 'utf8')).split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }); } catch { return []; } };
// The decision journal: manager-decisions.jsonl plus the round-7 merge-decisions.jsonl (kind merge), oldest first.
export async function readJournal() {
  const seen = new Set(), out = [];
  for (const r of [...await readJsonl(MERGE_FILE), ...await readJsonl(DECISIONS_FILE)]) { if (r.decision_id && seen.has(r.decision_id)) continue; if (r.decision_id) seen.add(r.decision_id); out.push(r); }
  return out;
}
// { items, summary } for the last `hours` (default 24) or since an ISO time; newest first, at most `limit` items.
export async function decidedView({ hours = 24, since = null, limit = 100, now = Date.now() } = {}) {
  const sinceMs = since ? Date.parse(since) : now - Math.max(1, Number(hours) || 24) * 3600e3;
  if (!Number.isFinite(sinceMs)) throw bad('since must be an ISO time');
  const win = since ? Math.max(1, Math.ceil((now - sinceMs) / 3600e3)) : Math.max(1, Number(hours) || 24);
  const recs = await readRecs();
  const all = decidedItems({ recs, journal: await readJournal(), since: sinceMs });
  const summary = decidedSummary(all, { hours: win, failed: failedCount(recs, { since: sinceMs }) });
  // round 9: how long the owner kept sessions waiting in the same window (owner-roundtrips.jsonl); the digest carries it as one more sentence
  const waits = summarizeRoundtrips(await roundtrips.read({ sinceMs }), { hours: win });
  if (waits.text) { summary.waits = waits; const t = `${summary.text} ${waits.text[0].toUpperCase()}${waits.text.slice(1)}.`; summary.text = t.length > 700 ? `${t.slice(0, 697)}...` : t; }
  return { items: all.slice(0, Math.max(1, Math.min(500, Number(limit) || 100))), summary };
}
// One item by id (any age), or null.
export async function decidedItem(id) {
  const items = decidedItems({ recs: await readRecs(), journal: await readJournal() });
  return items.find((i) => i.id === id) || null;
}
export const logRevert = ({ id, session, by }) => logLater({ type: 'revert', id, session, by: by || 'owner' });

// Once a day at decidedDigestHour (pushTimezone), when something was decided in the last 24 h: hand the summary to the digest hook.
// Returns true when it fired. Restart-safe through decided-digest.json.
export async function decidedDigestTick({ now = Date.now() } = {}) {
  const tz = config.pushTimezone || TIER_DEFAULTS.timezone;
  let day, hour;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
    day = `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}-${parts.find((p) => p.type === 'day').value}`;
    hour = Math.floor(localMinutes(now, tz) / 60);
  } catch { return false; }
  if (hour < (Number.isInteger(config.decidedDigestHour) ? config.decidedDigestHour : 18)) return false;
  let last = null; try { last = JSON.parse(await readFile(DIGEST_FILE, 'utf8')).day; } catch {}
  if (last === day) return false;
  let v;
  try { v = await decidedView({ hours: 24, limit: 1, now }); } catch (e) { console.error('[manager] digest view', e.message); return false; }   // the day is only marked once the view was read: a failure retries next minute
  try { await writeFile(DIGEST_FILE, JSON.stringify({ day })); } catch (e) { console.error('[manager] digest state', e.message); return false; }
  if (!v.summary.count) return false;
  try { onDigest({ day, count: v.summary.count, text: v.summary.text }); } catch (e) { console.error('[manager] onDigest', e.message); }
  return true;
}
// Ids of decided items the owner already reverted (a second revert of the same item is refused).
export async function revertedIds() { return new Set((await readRecs()).filter((r) => r.type === 'revert' && r.id).map((r) => r.id)); }
