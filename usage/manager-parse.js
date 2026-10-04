// The manager's stalls.jsonl -> usage records (pure). Shared by the usage tailer and the Langfuse eval sync.

const n = (x) => (Number.isFinite(x) ? x : 0);

// One line of the manager's stalls.jsonl -> record | null. Jev results sit on {type:'stall'} records (jev.choice or
// jev.error; a skipped call never reached the server), reviewer calls are {type:'triage'} records (ai or error).
// No closing text and no prompt are kept: ids, model, tokens, cost, the error message of a failure. The one exception is
// the AI reviewer's own proposal (short, written by the reviewer, not the session): it rides as the generation's output
// (+ the facts' flags as input, the prompt name/version as the prompt link) so a Langfuse evaluator can judge it.
// Opt-in: only with LFEVAL_SEND_AI_OUTPUT=1 (generations then carry metadata.judgeable=yes, which the evaluator rule filters on).
export function parseManagerLine(o, { sendAiOutput = process.env.LFEVAL_SEND_AI_OUTPUT === '1' } = {}) {
  if (!o || !o.id || !o.session) return null;
  const ts = Date.parse(o.at);
  if (!Number.isFinite(ts)) return null;
  const base = { agent: 'manager', session: o.session, cwd: null, project: o.project || null, ts, subagent: false, label: o.session };
  if (o.type === 'stall' && o.jev && (o.jev.choice || o.jev.error)) {
    const j = o.jev;
    return { ...base, id: `manager:jev:${o.id}`, name: 'manager.jev', model: j.model || 'typesafe/jev-1.13', usage: zeroUsage(), ms: j.ms ?? null,
      cost: costFrom(j.cost, j.error), costEstimated: false, error: j.error || null, extra: { case: o.case, decision: j.choice || null, decisionId: j.decision_id || null } };
  }
  if (o.type === 'triage' && (o.ai || o.error)) {
    return { ...base, id: `manager:ai:${o.id}`, name: 'manager.ai-review', model: o.model || 'unknown', ms: o.ms ?? null,
      usage: { input: n(o.tin), output: n(o.tout), cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 },
      cost: costFrom(o.cost, o.error), costEstimated: !!o.costEstimated, error: o.error || null, extra: { case: o.case, mode: o.mode || null, ...(o.ai && sendAiOutput ? { judgeable: 'yes' } : {}) },
      ...(o.prompt?.name && Number.isInteger(o.prompt.version) ? { prompt: { name: o.prompt.name, version: o.prompt.version } } : {}),
      ...(o.ai && sendAiOutput ? { input: { case: o.case, source: o.src || null, mode: o.mode || null, flags: Array.isArray(o.flags) ? o.flags : [] },
        output: { proposed_reply: o.ai.proposed_reply, reasoning: o.ai.reasoning, owner_needed: o.ai.owner_needed, owner_needed_why: o.ai.owner_needed_why, confidence: o.ai.confidence } } : {}) };
  }
  return null;
}
const zeroUsage = () => ({ input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 });
// a failed call costs 0 (priced); a call that succeeded but reported no cost stays unpriced (null)
const costFrom = (c, error) => (Number.isFinite(Number(c)) && c !== null ? { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: Number(c) } : error ? { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 } : null);

