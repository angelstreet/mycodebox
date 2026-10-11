// OpenCode: `opencode run --format json --model <provider/model> [-s <session>]`. No `--auto`: workers keep the
// launch permission mode. Stream format verified against opencode 1.18.32 (docs/v2/RUNTIME_FORMATS.md).
import { makeCliAdapter, genericParse } from './common.js';

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// One step_finish per model step: usage is per step, so the adapter sums (usageMode 'sum').
// Like claude, total input counts cache tokens (input + cache.write + cache.read); output includes reasoning.
// A step missing tokens, input/output or cost is flagged incomplete: sum mode skips nulls, so a partial sum (or a
// missing cost next to a reported 0) would otherwise look like a complete known figure. Missing cache/reasoning = 0.
function stepUsage(p) {
  const t = p?.tokens && typeof p.tokens === 'object' ? p.tokens : null;
  const cost = n(p?.cost);
  const inp = n(t?.input);
  const outp = n(t?.output);
  const incomplete = !t || inp === null || outp === null || cost === null;
  const input_tokens = inp === null ? null : inp + (n(t.cache?.write) ?? 0) + (n(t.cache?.read) ?? 0);
  const output_tokens = outp === null ? null : outp + (n(t.reasoning) ?? 0);
  return { input_tokens, output_tokens, usd: cost, incomplete };
}

export function parse(o) {
  const sid = typeof o.sessionID === 'string' ? o.sessionID : null;
  const p = o.part && typeof o.part === 'object' ? o.part : {};
  switch (o.type) {
    case 'step_start': return { events: [{ type: 'started', session_id: sid }], session_id: sid };
    case 'text': return { events: [{ type: 'text', text: typeof p.text === 'string' ? p.text : '' }], session_id: sid };
    case 'tool_use': return { events: [{ type: 'tool_use', name: typeof p.tool === 'string' ? p.tool : null }], session_id: sid };
    case 'step_finish': {
      const usage = stepUsage(p);
      // 'tool-calls' only ends one step of a longer turn; any other reason is terminal ('stop' = ok, e.g. 'length' = not).
      if (p.reason === 'tool-calls') return { events: [{ type: 'event', kind: 'step_finish' }], usage, session_id: sid };
      const ok = p.reason === 'stop';
      const text = ok ? null : `step finished with reason: ${String(p.reason ?? 'unknown').slice(0, 64)}`;
      return { events: [{ type: 'result', ok, text }], usage, session_id: sid, error_text: ok ? null : text };
    }
    case 'error': {
      const e = o.error || {};
      // Name and status code stay in the text so normalizeError can class 429 -> rate_limit, 401 / ProviderAuthError -> auth.
      const sc = e.data?.statusCode ?? e.data?.status;
      const msg = [e.name, e.data?.message ?? e.message].filter((x) => typeof x === 'string' && x).join(': ') + (Number.isFinite(sc) ? ` status code: ${sc}` : '') || 'error';
      return { events: [{ type: 'error', text: msg }], error_text: msg, session_id: sid };
    }
    default: return genericParse(o);
  }
}

export const createAdapter = makeCliAdapter({
  id: 'opencode',
  provider_ids: ['multi'],
  defaultBin: 'opencode',
  efforts: null,
  envAllow: [/^OPENCODE_/, /^ANTHROPIC_/, /^OPENAI_/, /^MINIMAX_/],
  features: { resume: true, cancel: true, json_output: true, native_subagents: 'unknown', vision: 'unknown' },
  resume: true,
  noEffort: true, // no verified effort flag: reject instead of silently dropping
  usageMode: 'sum',
  parse,
  head(o) {
    const args = ['run', '--format', 'json'];
    if (o.model) args.push('--model', o.model);
    if (o.resume_id) args.push('--session', o.resume_id);
    return { args, session_id: null };
  },
});
export default createAdapter;
