// OpenCode: `opencode run --format json --model <provider/model>`. Not installed on the dev host: probe reports it.
// No resume flag is contracted, so resume() throws E_UNSUPPORTED rather than guessing one.
import { makeCliAdapter, genericParse } from './common.js';

export const createAdapter = makeCliAdapter({
  id: 'opencode',
  provider_ids: ['multi'],
  defaultBin: 'opencode',
  efforts: null,
  envAllow: [/^OPENCODE_/, /^ANTHROPIC_/, /^OPENAI_/, /^MINIMAX_/],
  features: { resume: false, cancel: true, json_output: true, native_subagents: 'unknown', vision: 'unknown' },
  resume: false,
  noEffort: true, // no verified effort flag: reject instead of silently dropping
  usageMode: 'last',
  parse: genericParse,
  head(o) {
    const args = ['run', '--format', 'json'];
    if (o.model) args.push('--model', o.model);
    return { args, session_id: null };
  },
});
export default createAdapter;
