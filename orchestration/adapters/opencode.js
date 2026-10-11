// OpenCode: `opencode run --format json --model <provider/model> [-s <session>]`. No `--auto`: workers keep the
// launch permission mode. Stream format verified against opencode 1.18.32 (docs/v2/RUNTIME_FORMATS.md).
import { makeCliAdapter, genericParse } from './common.js';

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// One step_finish per model step: usage is per step, so the adapter sums (usageMode 'sum').
// Like claude, total input counts cache tokens (input + cache.write + cache.read); output includes reasoning.
function stepUsage(p) {
  const t = p?.tokens;
  const cost = n(p?.cost);
  if (!t || typeof t !== 'object') return cost === null ? null : { input_tokens: null, output_tokens: null, usd: cost };
  const inp = [t.input, t.cache?.write, t.cache?.read].map(n);
  const out = [t.output, t.reasoning].map(n);
  const sum = (a) => (a.every((x) => x === null) ? null : a.reduce((s, x) => s + (x ?? 0), 0));
  return { input_tokens: sum(inp), output_tokens: sum(out), usd: cost };
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
      // reason 'stop' ends the run; 'tool-calls' only ends one step of a longer turn.
      const events = p.reason === 'stop' ? [{ type: 'result', ok: true, text: null }] : [{ type: 'event', kind: 'step_finish' }];
      return { events, usage, session_id: sid };
    }
    case 'error': {
      const e = o.error || {};
      const msg = String(e.data?.message ?? e.message ?? e.name ?? 'error');
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
