// AI-proposal judge written by ghosty itself (TASK-44 phase 12). The Langfuse evaluator `ai_proposal_judge` (scripts/lf-setup.js)
// is the intended path, but observation-level evaluators need Langfuse v4's events tables; this v3 deployment cannot run them.
// So this does the same job: for each new AI-reviewer proposal it asks a cheap model (OpenRouter) the same question and writes the
// Langfuse score `ai_proposal_judge` (0..1, the reasoning as the comment) on the manager.ai-review generation.
// Opt-in: LFEVAL_JUDGE=1 and OPENROUTER_API_KEY. Capped per day; only proposals of the last 24 h; each stop judged once.
import { promises as fs } from 'node:fs';
import { hash, genIdOf, traceIdOf, postBatch } from './lf-common.js';
import { JUDGE_PROMPT, JUDGE_MODEL } from '../scripts/lf-setup.js';

export function judgeMessages(rec) {
  const context = JSON.stringify({ case: rec.case, source: rec.src || null, mode: rec.mode || null, flags: Array.isArray(rec.flags) ? rec.flags : [] });
  const a = rec.ai || {};
  const proposal = JSON.stringify({ proposed_reply: a.proposed_reply, reasoning: a.reasoning, owner_needed: a.owner_needed, owner_needed_why: a.owner_needed_why, confidence: a.confidence });
  const prompt = JUDGE_PROMPT.replace('{{context}}', context).replace('{{proposal}}', proposal);
  return [{ role: 'system', content: 'Answer with ONE JSON object and nothing else: {"reasoning": string, "score": number between 0 and 1}' }, { role: 'user', content: prompt }];
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

// cfg: { stallsFile, judgeStateFile, openrouterKey, judgeModel?, judgeMaxPerDay?, judgeSampling?, now() } ; returns { judged, skipped }
export function createJudge(cfg, { fetchFn = fetch, random = Math.random, log = console.log } = {}) {
  return async function judgePass() {
    if (!cfg.openrouterKey) return { skipped: 'no OPENROUTER_API_KEY' };
    const now = cfg.now ? cfg.now() : Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    let st = { day, calls: 0, done: {} };
    try { st = { ...st, ...JSON.parse(await fs.readFile(cfg.judgeStateFile, 'utf8')) }; } catch {}
    if (st.day !== day) { st.day = day; st.calls = 0; }
    const since = now - 24 * 3600e3;
    const recs = [];
    for (const l of (await fs.readFile(cfg.stallsFile, 'utf8').catch(() => '')).split('\n')) {
      if (!l.includes('"type":"triage"') || !l.includes('"ai"')) continue;
      try { const r = JSON.parse(l); if (r.type === 'triage' && r.ai && Date.parse(r.at) >= since && !st.done[r.id]) recs.push(r); } catch {}
    }
    const events = [];
    let judged = 0;
    for (const r of recs) {
      if (st.calls >= (cfg.judgeMaxPerDay ?? 400)) break;
      if (random() >= (cfg.judgeSampling ?? 1)) { st.done[r.id] = 'sampled-out'; continue; }
      st.calls++;
      try {
        const res = await fetchFn('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.openrouterKey}` },
          body: JSON.stringify({ model: cfg.judgeModel || JUDGE_MODEL, messages: judgeMessages(r), max_tokens: 300, temperature: 0, response_format: { type: 'json_object' } }), signal: AbortSignal.timeout(30000) });
        const j = await res.json();
        const p = parseJudge(j?.choices?.[0]?.message?.content);
        if (!p) { st.done[r.id] = 'unparsable'; continue; }
        events.push({ id: hash(`ev:judge:${r.id}`).slice(0, 36), type: 'score-create', timestamp: new Date(now).toISOString(), body: {
          id: hash(`score:ai_proposal_judge:${r.id}`).slice(0, 32), traceId: traceIdOf('manager', r.session), observationId: genIdOf(`manager:ai:${r.id}`),
          name: 'ai_proposal_judge', dataType: 'NUMERIC', value: p.score, comment: p.reasoning, metadata: { stop_id: r.id, judge_model: cfg.judgeModel || JUDGE_MODEL, cost: Number(j?.usage?.cost ?? 0) || null } } });
        st.done[r.id] = 'judged'; judged++;
      } catch (e) { log('[lfeval] judge call failed:', e.message); st.calls--; }   // retried next pass
    }
    if (events.length) await postBatch(cfg, events, { fetchFn });
    for (const k of Object.keys(st.done)) if (Object.keys(st.done).length > 2000) delete st.done[k];
    await fs.writeFile(cfg.judgeStateFile, JSON.stringify(st));
    return { judged, skipped: recs.length - judged };
  };
}
