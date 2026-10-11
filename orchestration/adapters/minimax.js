// MiniMax Code (`mcode`): `mcode exec --cwd <dir> --output-format stream-json --permission smart`. Never --permission off/full.
import { makeCliAdapter, genericParse } from './common.js';

export const createAdapter = makeCliAdapter({
  id: 'minimax',
  provider_ids: ['minimax'],
  defaultBin: 'mcode',
  efforts: null,
  envAllow: [/^MINIMAX_/, /^MCODE_/],
  features: { resume: true, cancel: true, json_output: true, native_subagents: 'unknown', vision: 'unknown' },
  resume: true,
  usageMode: 'last',
  parse: genericParse, // stream-json schema not verified on this host: parse defensively
  head(o) {
    const args = ['exec', '--cwd', o.cwd, '--output-format', 'stream-json', '--permission', 'smart'];
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
    if (o.timeout_ms) args.push('--timeout', `${Math.max(1, Math.ceil(o.timeout_ms / 1000))}s`);
    if (o.resume_id) args.push('--session', o.resume_id);
    return { args, session_id: null };
  },
});
export default createAdapter;
