// Runs a classifier over the `ghosty-stops` dataset and records a Langfuse dataset run: per item one trace (the
// classifier's answer) linked to the dataset item, with scores case_match / verdict_match, plus run-level accuracies.
// Compare runs (versions of the rules, Jev, the AI prompt) in the Langfuse UI: Datasets -> ghosty-stops -> Runs.
//
// classifier:  rules (free, the current stall.js)   jev (one Jev call per item)   ai (one reviewer call per item)
// Verdict mapping: the manager would have answered (continue / take recommended / owner_needed=false) -> no_reason,
// anything that goes to the owner -> legit.
import { classifyStall, wouldSend, applyJev } from '../stall.js';
import { jevRequestBody, MANAGER_USAGE, FALLBACK_USAGE } from '../decisions.js';
import { callReviewer } from '../triage.js';
import { hash, lfRequest, postBatch } from './lf-common.js';
import { DATASET } from './lfeval.js';

export const CLASSIFIERS = ['rules', 'jev', 'ai'];

const rulesOf = (text, state) => classifyStall({ plain: String(text || '').split('\n'), state: state || 'done', fromReport: true });

// -> { case, verdict, detail } for one dataset item input
export const classifiers = {
  async rules(input) {
    const st = rulesOf(input.closing_text, input.state);
    const ws = wouldSend(st);
    return { case: st.case, verdict: ws.send ? 'no_reason' : 'legit', detail: { source: st.source, would_send: !!ws.send } };
  },
  async jev(input, { env }) {
    const st = rulesOf(input.closing_text, input.state);
    const post = async (usage) => { const r = await env.fetchFn(env.jevUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': env.apiKey }, body: JSON.stringify(jevRequestBody(st, { usage })), signal: AbortSignal.timeout(25000) }); return r.json(); };
    let j = await post(env.usage || MANAGER_USAGE);
    if (!j.success && /unknown usage/i.test(String(j.error || ''))) j = await post(FALLBACK_USAGE);
    const choice = j.answers?.choice?.choice;
    if (!choice) return { error: String(j.error || 'no answer').slice(0, 200), cost: Number(j.cost || 0) };
    const fin = applyJev(st, choice), ws = wouldSend(fin);
    return { case: fin.case, verdict: ws.send ? 'no_reason' : 'legit', detail: { jev: choice }, cost: Number(j.cost || 0) };
  },
  async ai(input, { env }) {
    const st = rulesOf(input.closing_text, input.state);
    const r = await callReviewer({ url: env.aiUrl, apiKey: env.apiKey, facts: { session: 'dataset-item', agent: input.agent, state: input.state, case: st.case, source: st.source, flags: [], text: input.closing_text }, system: env.system, fetchFn: env.fetchFn });
    if (!r.ai) return { error: r.error || 'no answer', cost: r.cost || 0 };
    return { case: st.case, verdict: r.ai.owner_needed || !r.ai.proposed_reply ? 'legit' : 'no_reason', detail: { owner_needed: r.ai.owner_needed }, cost: r.cost || 0 };
  },
};

// The case the owner says is right; null when the label does not say.
export function expectedCase(item) {
  const e = item.expectedOutput || {}, c = item.input || {};
  if (e.correct_case) return e.correct_case;
  return e.verdict === 'wrong_case' ? null : c.case_by_rules || null;
}

export async function listItems(cfg, dataset, opt) {
  const out = [];
  for (let page = 1; ; page++) {
    const j = await lfRequest(cfg, 'GET', `/api/public/dataset-items?datasetName=${encodeURIComponent(dataset)}&page=${page}&limit=100`, undefined, opt);
    out.push(...(j.data || []).filter((i) => i.status !== 'ARCHIVED'));
    if (page >= (j.meta?.totalPages || 0)) break;
  }
  return out;
}

export async function runExperiment({ cfg, runName, classifier = 'rules', dataset = DATASET, env = {}, fetchFn = fetch, now = () => Date.now(), log = () => {} }) {
  if (!runName) throw new Error('--run-name required');
  if (!CLASSIFIERS.includes(classifier)) throw new Error(`classifier must be one of: ${CLASSIFIERS.join(', ')}`);
  const opt = { fetchFn };
  const items = await listItems(cfg, dataset, opt);
  const stamp = new Date(now()).toISOString();
  const rows = [];
  for (const item of items) {
    const res = await classifiers[classifier](item.input || {}, { env: { ...env, fetchFn } }).catch((e) => ({ error: e.message }));
    const want = item.expectedOutput || {}, wantCase = expectedCase(item);
    const caseMatch = res.error || !wantCase ? null : res.case === wantCase;
    const verdictMatch = res.error || !['legit', 'no_reason'].includes(want.verdict) ? null : res.verdict === want.verdict;
    rows.push({ item, res, caseMatch, verdictMatch, traceId: hash(`experiment:${runName}:${item.id}`).slice(0, 32) });
  }
  // traces first (the run item points at them), then the run items, then the scores
  const ev = (type, key, body) => ({ id: hash(`ev:${type}:${key}`).slice(0, 36), type, timestamp: stamp, body });
  const traceEvents = rows.map((r) => ev('trace-create', r.traceId, {
    id: r.traceId, name: `stops-experiment:${runName}`, timestamp: stamp, tags: ['stops-experiment', `classifier:${classifier}`, `run:${runName}`],
    input: r.item.input, output: r.res.error ? { error: r.res.error } : { case: r.res.case, verdict: r.res.verdict, ...r.res.detail },
    metadata: { run: runName, classifier, dataset, stop_id: r.item.id, ...(r.res.cost ? { cost: r.res.cost } : {}) },
  }));
  for (let i = 0; i < traceEvents.length; i += 100) await postBatch(cfg, traceEvents.slice(i, i + 100), opt);
  let runId = null;
  for (const r of rows) {
    const j = await lfRequest(cfg, 'POST', '/api/public/dataset-run-items', { runName, runDescription: `${classifier} classifier over ${dataset}`, metadata: { classifier }, datasetItemId: r.item.id, traceId: r.traceId }, opt);
    runId = runId || j?.datasetRunId || null;
  }
  const score = (name, traceId, value, extra = {}) => ev('score-create', `${runName}:${name}:${traceId || extra.datasetRunId}`, { id: hash(`score:${runName}:${name}:${traceId || extra.datasetRunId}`).slice(0, 32), name, value, ...(traceId ? { traceId } : {}), ...extra });
  const scoreEvents = [];
  for (const r of rows) {
    if (r.caseMatch !== null) scoreEvents.push(score('case_match', r.traceId, r.caseMatch ? 1 : 0, { dataType: 'BOOLEAN' }));
    if (r.verdictMatch !== null) scoreEvents.push(score('verdict_match', r.traceId, r.verdictMatch ? 1 : 0, { dataType: 'BOOLEAN' }));
  }
  const acc = (k) => { const xs = rows.map((r) => r[k]).filter((v) => v !== null); return xs.length ? { value: xs.filter(Boolean).length / xs.length, n: xs.length } : null; };
  const summary = { run: runName, classifier, dataset, items: rows.length, errors: rows.filter((r) => r.res.error).length, case_accuracy: acc('caseMatch'), verdict_accuracy: acc('verdictMatch'), cost: rows.reduce((a, r) => a + (r.res.cost || 0), 0), datasetRunId: runId };
  if (runId) for (const [name, a] of [['case_accuracy', summary.case_accuracy], ['verdict_accuracy', summary.verdict_accuracy]]) if (a) scoreEvents.push(score(name, null, Math.round(a.value * 1e4) / 1e4, { datasetRunId: runId, dataType: 'NUMERIC', comment: `${a.n} items` }));
  for (let i = 0; i < scoreEvents.length; i += 100) await postBatch(cfg, scoreEvents.slice(i, i + 100), opt);
  log(JSON.stringify(summary));
  return summary;
}
