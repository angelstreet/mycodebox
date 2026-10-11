// OpenCode: `opencode run --format json --model <provider/model>`.
// No resume flag is contracted, so resume() throws E_UNSUPPORTED rather than guessing one.
import { makeCliAdapter, genericParse } from './common.js';

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// opencode 1.18 (live capture, docs/v2/RUNTIME_FORMATS.md): every line is { type, sessionID, part }; the text sits in
// part.text and each step_finish carries that step's part.tokens and part.cost. A cost of 0 is not proof of a free run
// (unpriced providers report 0 too): only a positive cost is USD, otherwise the run's USD is unknown (incomplete).
// Errors come as { type:'error', error } without a part. Other shapes: generic fallback.
function parse(o) {
  const p = o.part && typeof o.part === 'object' ? o.part : null;
  const sid = typeof o.sessionID === 'string' ? o.sessionID : null;
  if (!p && o.type === 'error') {
    // { type:'error', error:{ name, data:{ message } } }: the message feeds error classification (rate limit, auth...).
    const e = o.error && typeof o.error === 'object' ? o.error : {};
    const text = [e.name, e.data?.message ?? e.message].filter((x) => typeof x === 'string' && x).join(': ') || (typeof o.error === 'string' ? o.error : 'error');
    return { events: [{ type: 'error', text }], error_text: text, session_id: sid };
  }
  if (!p) return genericParse(o);
  if (o.type === 'text' && typeof p.text === 'string') return { events: [{ type: 'text', text: p.text }], session_id: sid };
  if (o.type === 'step_start') return { events: [{ type: 'started', session_id: sid }], session_id: sid };
  if (o.type === 'tool_use' || /tool/.test(String(p.type))) return { events: [{ type: 'tool_use', name: typeof p.tool === 'string' ? p.tool : null }], session_id: sid };
  if (o.type === 'step_finish') {
    const t = p.tokens && typeof p.tokens === 'object' ? p.tokens : null;
    const sum = (...xs) => (xs.some((x) => x !== null) ? xs.reduce((a, x) => a + (x ?? 0), 0) : null);
    const usage = t || n(p.cost) !== null ? {
      input_tokens: t ? sum(n(t.input), n(t.cache?.read), n(t.cache?.write)) : null,
      output_tokens: t ? sum(n(t.output), n(t.reasoning)) : null,
      usd: n(p.cost) > 0 ? p.cost : null,
      // Tokens without a positive cost: this step's USD is unknown, so the run's USD sum must not pass as complete.
      ...(t && !(n(p.cost) > 0) ? { incomplete: true } : {}),
    } : null;
    return { events: [{ type: 'event', kind: 'step_finish' }], usage, session_id: sid };
  }
  if (/error/i.test(String(o.type))) {
    const text = typeof p.message === 'string' ? p.message : typeof o.error?.message === 'string' ? o.error.message : 'error';
    return { events: [{ type: 'error', text }], error_text: text, session_id: sid };
  }
  return { events: [{ type: 'event', kind: typeof o.type === 'string' ? o.type : null }], session_id: sid };
}

export const createAdapter = makeCliAdapter({
  id: 'opencode',
  provider_ids: ['multi'],
  defaultBin: 'opencode',
  efforts: null,
  envAllow: [/^OPENCODE_/, /^ANTHROPIC_/, /^OPENAI_/, /^MINIMAX_/],
  features: { resume: false, cancel: true, json_output: true, native_subagents: 'unknown', vision: 'unknown' },
  resume: false,
  noEffort: true, // no verified effort flag: reject instead of silently dropping
  usageMode: 'sum', // one step_finish per step
  parse,
  head(o) {
    const args = ['run', '--format', 'json'];
    if (o.model) args.push('--model', o.model);
    return { args, session_id: null };
  },
});
export { parse as parseOpencodeEvent };
export default createAdapter;
