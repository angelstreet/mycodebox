// Claude Code: `claude -p --output-format stream-json --permission-mode acceptEdits`. Never bypassPermissions.
import { makeCliAdapter, usageFrom } from './common.js';

const OK_STATUS = /^(?:allowed|allowed_warning|ok)$/i;

// Shapes follow docs/v2/RUNTIME_FORMATS.md (live capture). Unknown fields map to null, never to a guess.
function parse(o) {
  const events = [];
  let error_text = null;
  let retry_after_ms;
  if (o.type === 'system' && o.subtype === 'init') events.push({ type: 'started', session_id: o.session_id ?? null });
  else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    for (const b of o.message.content) {
      if (b?.type === 'text' && typeof b.text === 'string') events.push({ type: 'text', text: b.text });
      else if (b?.type === 'tool_use') events.push({ type: 'tool_use', name: typeof b.name === 'string' ? b.name : null });
    }
  } else if (o.type === 'rate_limit_event') {
    // Emitted even on success; only a non-allowed status is a quota signal. resetsAt is epoch seconds.
    const info = o.rate_limit_info || {};
    const status = typeof info.status === 'string' ? info.status : null;
    const resets = typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null;
    events.push({ type: 'rate_limit', status, resets_at: resets });
    if (status && !OK_STATUS.test(status)) {
      error_text = `rate limit ${status}`;
      if (resets) retry_after_ms = Math.max(0, resets - Date.now());
    }
  } else if (o.type === 'result') {
    events.push({ type: 'result', ok: o.is_error !== true, text: typeof o.result === 'string' ? o.result : null });
    if (o.is_error === true) error_text = typeof o.result === 'string' ? o.result : 'error';
  } else events.push({ type: 'event', kind: typeof o.type === 'string' ? o.type : null });
  return { events, usage: o.type === 'result' ? claudeUsage(o) : null, session_id: o.session_id ?? null, error_text, retry_after_ms };
}

// Only the final result carries run totals; per-message usage would double count. Total input includes cache tokens.
function claudeUsage(o) {
  const u = usageFrom(o);
  if (!u) return null;
  const c = o.usage || {};
  const parts = [c.input_tokens, c.cache_creation_input_tokens, c.cache_read_input_tokens].filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (parts.length) u.input_tokens = parts.reduce((x, y) => x + y, 0);
  return u;
}

export const createAdapter = makeCliAdapter({
  id: 'claude',
  provider_ids: ['anthropic'],
  defaultBin: 'claude',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  envAllow: [/^ANTHROPIC_/, /^CLAUDE_CODE_/, /^CLAUDE_CONFIG_DIR$/],
  features: { resume: true, cancel: true, json_output: true, native_subagents: 'unknown', vision: 'unknown' },
  ownSessionId: true,
  resume: true,
  usageMode: 'last',
  parse,
  head(o) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
    if (o.resume_id) args.push('--resume', o.resume_id);
    else if (o.session_id) args.push('--session-id', o.session_id);
    return { args, session_id: o.session_id };
  },
});
export default createAdapter;
