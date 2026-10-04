// AI-proposal judge written by ghosty itself (TASK-44 phase 12). The Langfuse evaluator `ai_proposal_judge` (scripts/lf-setup.js)
// is the intended path, but observation-level evaluators need Langfuse v4's events tables; this v3 deployment cannot run them.
// So this does the same job: for each new AI-reviewer proposal it asks the VPT server (same /server/ai/complete the AI reviewer uses)
// to judge it and writes the Langfuse score `ai_proposal_judge` (0..1, the reasoning as the comment) on the manager.ai-review generation.
// Opt-in: LFEVAL_JUDGE=1 and JEV_URL + JEV_API_KEY. Capped per day; only proposals of the last 24 h; each stop judged once.
//
// Every call yields one usage row (agent 'manager', name 'manager.judge', with the manager trace id), the shape
// usage/manager-parse.js gives the AI reviewer (cost.total on success, 0 on error, usage tokens, ms, error, model);
// a failed call yields a row too (tokens 0, error set). The rows go to commit(rows) (the ingester's commitRows:
// generation in Langfuse + ledger append), never straight into the ledger file. The scorecard counts them under cost.judge.
// Every call, failed or not, counts against the daily cap; a record whose call failed is retried at most once an hour
// (st.failed[stopId] = ms of the last failure, kept in the same state file).
import { promises as fs } from 'node:fs';
import { hash, genIdOf, traceIdOf, postBatch } from './lf-common.js';
import { callComplete, reviewerUrl, REVIEWER_USAGE } from '../triage.js';
import { JUDGE_PROMPT, JUDGE_MODEL } from '../scripts/lf-setup.js';

const JUDGE_MAX_TOKENS = 300;
const JUDGE_TIMEOUT_S = 30;
const RETRY_AFTER_MS = 3600e3;

const judgeSystem = 'Answer with ONE JSON object and nothing else: {"reasoning": string, "score": number between 0 and 1}';

function buildJudgePrompt(rec) {
  const context = JSON.stringify({ case: rec.case, source: rec.src || null, mode: rec.mode || null, flags: Array.isArray(rec.flags) ? rec.flags : [] });
  const a = rec.ai || {};
  const proposal = JSON.stringify({ proposed_reply: a.proposed_reply, reasoning: a.reasoning, owner_needed: a.owner_needed, owner_needed_why: a.owner_needed_why, confidence: a.confidence });
  return JUDGE_PROMPT.replace('{{context}}', context).replace('{{proposal}}', proposal);
}

// Public: kept for the test suite (used to assert the system + user prompt sent to the model).
export function judgeMessages(rec) {
  return [{ role: 'system', content: judgeSystem }, { role: 'user', content: buildJudgePrompt(rec) }];
}

export function parseJudge(text) {
  try {
    const t = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const o = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    const score = Number(o.score);
    if (!Number.isFinite(score) || score < 0 || score > 1) return null;
    return { score, reasoning: String(o.reasoning || '').slice(0, 500) };
  } catch { return null; }
}

// One ledger row per judge call. res.error (failed call) -> tokens 0, cost 0, error set.
function ledgerRow(r, res, p, at) {
  const now = at ?? res.at ?? Date.now();   // the pass's clock (cfg.now), so injected time and the row agree
  const u = res.usage || {};
  const usage = { input: Number(u.prompt_tokens) || 0, output: Number(u.completion_tokens) || 0, cache_read: Number(u.cache_read_input_tokens) || 0, cache_write_5m: 0, cache_write_1h: 0 };
  const cost = res.error ? { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 }
    : Number.isFinite(Number(res.cost)) && Number(res.cost) >= 0 ? { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: Number(res.cost) } : null;
  return { id: `manager:judge:${r.id}`, agent: 'manager', session: r.session, cwd: null, label: r.session, ts: now, trace: traceIdOf('manager', r.session), model: res.model || JUDGE_MODEL, usage,
    name: 'manager.judge', subagent: false,
    cost, costEstimated: !!res.costEstimated, ms: res.ms ?? null, error: res.error ? res.error : (p ? null : 'unparsable'), extra: { stop_id: r.id, score: p ? p.score : null } };
}

// cfg: { stallsFile, judgeStateFile, jevUrl, jevApiKey, judgeMaxPerDay?, judgeSampling?, now() } ; opts.commit(rows) takes the usage rows ; returns { judged, skipped, rows }
export function createJudge(cfg, { fetchFn = fetch, random = Math.random, log = console.log, commit = null } = {}) {
  return async function judgePass() {
    if (!cfg.jevUrl || !cfg.jevApiKey) return { skipped: 'no JEV_URL / JEV_API_KEY' };
    const url = reviewerUrl(cfg.jevUrl);
    if (!url) return { skipped: 'invalid JEV_URL' };
    const now = cfg.now ? cfg.now() : Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    let st = { day, calls: 0, done: {}, failed: {} };
    try { st = { ...st, ...JSON.parse(await fs.readFile(cfg.judgeStateFile, 'utf8')) }; } catch {}
    if (st.day !== day) { st.day = day; st.calls = 0; }
    if (!st.failed || typeof st.failed !== 'object') st.failed = {};
    for (const k of Object.keys(st.failed)) if (now - st.failed[k] >= RETRY_AFTER_MS * 24) delete st.failed[k];
    const since = now - 24 * 3600e3;
    const recs = [];
    for (const l of (await fs.readFile(cfg.stallsFile, 'utf8').catch(() => '')).split('\n')) {
      if (!l.includes('"type":"triage"') || !l.includes('"ai"')) continue;
      try { const r = JSON.parse(l); if (r.type === 'triage' && r.ai && Date.parse(r.at) >= since && !st.done[r.id] && !(now - (st.failed[r.id] || -Infinity) < RETRY_AFTER_MS)) recs.push(r); } catch {}
    }
    const events = [];
    const ledgerRows = [];
    let judged = 0;
    for (const r of recs) {
      if (st.calls >= (cfg.judgeMaxPerDay ?? 400)) break;
      if (random() >= (cfg.judgeSampling ?? 1)) { st.done[r.id] = 'sampled-out'; continue; }
      st.calls++;
      try {
        const body = { usage: REVIEWER_USAGE, prompt: buildJudgePrompt(r), system: judgeSystem, max_tokens: JUDGE_MAX_TOKENS, temperature: 0, timeout_s: JUDGE_TIMEOUT_S };
        const res = await callComplete({ url, apiKey: cfg.jevApiKey, body, fetchFn, timeoutMs: JUDGE_TIMEOUT_S * 1000 });
        if (res.error) {
          log('[lfeval] judge call failed:', res.error);
          st.failed[r.id] = now;          // counted against the cap; retried after RETRY_AFTER_MS
          ledgerRows.push(ledgerRow(r, { usage: {}, cost: 0, ms: res.ms, model: res.model, error: res.error, costEstimated: false }, null, now));
          continue;
        }
        const p = parseJudge(res.content);
        // one usage-ledger row per call (success, unparsable or failed): the scorecard counts these under cost.judge
        ledgerRows.push(ledgerRow(r, res, p, now));
        delete st.failed[r.id];
        if (!p) { st.done[r.id] = 'unparsable'; continue; }
        events.push({ id: hash(`ev:judge:${r.id}`).slice(0, 36), type: 'score-create', timestamp: new Date(now).toISOString(), body: {
          id: hash(`score:ai_proposal_judge:${r.id}`).slice(0, 32), traceId: traceIdOf('manager', r.session), observationId: genIdOf(`manager:ai:${r.id}`),
          name: 'ai_proposal_judge', dataType: 'NUMERIC', value: p.score, comment: p.reasoning, metadata: { stop_id: r.id, judge_model: res.model || JUDGE_MODEL, cost: res.cost ?? null } } });
        st.done[r.id] = 'judged'; judged++;
      } catch (e) {
        log('[lfeval] judge call failed:', e.message);
        st.failed[r.id] = now;
        ledgerRows.push(ledgerRow(r, { usage: {}, cost: 0, error: e.message }, null, now));
      }
    }
    if (events.length) await postBatch(cfg, events, { fetchFn });
    if (ledgerRows.length && commit) {
      try { await commit(ledgerRows); }
      catch (e) { log('[lfeval] judge usage rows not recorded:', e.message); }
    }
    for (const k of Object.keys(st.done)) if (Object.keys(st.done).length > 2000) delete st.done[k];
    await fs.writeFile(cfg.judgeStateFile, JSON.stringify(st));
    return { judged, skipped: recs.length - judged, rows: ledgerRows };
  };
}
