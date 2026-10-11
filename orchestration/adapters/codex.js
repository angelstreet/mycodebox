// Codex CLI: `codex exec --json -s workspace-write -C <cwd>`. Never danger-full-access / approval bypass.
import { makeCliAdapter, usageFrom, genericParse } from './common.js';

function parse(o) {
  const t = o.type;
  if (t === 'thread.started') return { events: [{ type: 'started', session_id: o.thread_id ?? null }], session_id: o.thread_id ?? null };
  if (t === 'item.completed' && o.item) {
    const it = o.item;
    if (it.type === 'agent_message') return { events: [{ type: 'text', text: typeof it.text === 'string' ? it.text : '' }] };
    if (it.type === 'command_execution' || it.type === 'file_change') return { events: [{ type: 'tool_use', name: it.type }] };
    return { events: [{ type: 'event', kind: `item.${it.type ?? 'unknown'}` }] };
  }
  if (t === 'turn.completed') return { events: [{ type: 'result', ok: true, text: null }], usage: usageFrom(o) };
  if (t === 'turn.failed' || t === 'error') {
    // Quota exhaustion arrives here on stdout ("usage limit ... try again at <time>"), not on stderr.
    const msg = o.error?.message ?? o.message ?? 'error';
    return { events: [{ type: 'error', text: String(msg) }], error_text: String(msg) };
  }
  return genericParse(o);
}

export const createAdapter = makeCliAdapter({
  id: 'codex',
  provider_ids: ['openai'],
  defaultBin: 'codex',
  efforts: null,
  envAllow: [/^OPENAI_/, /^CODEX_/],
  features: { resume: true, cancel: true, json_output: true, native_subagents: 'unknown', vision: 'unknown' },
  resume: true,
  usageMode: 'sum', // one turn.completed per turn
  parse,
  head(o) {
    const args = ['exec', '--json', '-s', 'workspace-write', '-C', o.cwd];
    if (o.model) args.push('-m', o.model);
    if (o.effort) args.push('-c', `model_reasoning_effort="${o.effort}"`);
    if (o.resume_id) args.push('resume', o.resume_id);
    return { args, session_id: null };
  },
});
export default createAdapter;
