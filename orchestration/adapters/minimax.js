// MiniMax Code (`mcode`): `mcode exec --cwd <dir> --output-format stream-json --permission smart`. Never --permission off/full.
import path from 'node:path';
import { makeCliAdapter, genericParse, coded } from './common.js';

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Shapes follow docs/v2/RUNTIME_FORMATS.md: envelope {sessionId,...} + camelCase usage on turn.completed; no USD cost.
function parse(o) {
  const sid = typeof o.sessionId === 'string' ? o.sessionId : null;
  switch (o.type) {
    case 'exec.started': case 'session.started': return { events: [{ type: 'started', session_id: sid }], session_id: sid };
    case 'turn.completed': {
      const u = o.usage || {};
      const inp = n(u.inputTokens);
      const out = n(u.outputTokens);
      const cache = n(u.cacheReadTokens);
      const total = n(u.totalTokens);
      // inputTokens may or may not include cache reads: add them only when totalTokens proves they are separate.
      const input = inp !== null && cache !== null && total === (inp + (out ?? 0) + cache) ? inp + cache : inp;
      const usage = o.usage ? { input_tokens: input, output_tokens: out, usd: null, incomplete: o.usageIncomplete === true } : null;
      return { events: [{ type: 'result', ok: true, text: null }], usage, session_id: sid };
    }
    case 'exec.completed': return { events: [{ type: 'result', ok: true, text: typeof o.result === 'string' ? o.result : null }], session_id: sid };
    case 'item.completed': {
      const it = o.item || {};
      if (typeof it.text === 'string' && /message|text/i.test(it.type || '')) return { events: [{ type: 'text', text: it.text }], session_id: sid };
      if (/tool|command|file/i.test(it.type || '')) return { events: [{ type: 'tool_use', name: it.type }], session_id: sid };
      return { events: [{ type: 'event', kind: `item.${it.type ?? 'unknown'}` }], session_id: sid };
    }
    default: {
      const g = genericParse(o);
      return { ...g, session_id: g.session_id ?? sid };
    }
  }
}

const createCli = makeCliAdapter({
  id: 'minimax',
  provider_ids: ['minimax'],
  defaultBin: 'mcode',
  efforts: null,
  envAllow: [/^MINIMAX_/, /^MCODE_/],
  features: { resume: true, cancel: true, json_output: true, native_subagents: 'unknown', vision: 'unknown' },
  resume: true,
  usageMode: 'sum', // one turn.completed per turn
  parse,
  head(o) {
    const args = ['exec', '--cwd', o.cwd, '--output-format', 'stream-json', '--permission', 'smart'];
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
    if (o.timeout_ms) args.push('--timeout', `${Math.max(1, Math.ceil(o.timeout_ms / 1000))}s`);
    if (o.resume_id) args.push('--session', o.resume_id);
    return { args, session_id: null };
  },
});
// mcode 0.6.3 runs on Node 22.19+/24/25/26 and refuses Node 23 (its `#!/usr/bin/env node` takes the first node on
// PATH). `nodeDir` (or MCODE_NODE_DIR in the adapter env) names a directory with a supported `node`; it is put first
// on the child's PATH for runs and probes. Absent: PATH is used as is and an unsupported node shows up as a failed run.
export function createAdapter(opts = {}) {
  const env = opts.env ?? process.env;
  const nodeDir = opts.nodeDir ?? env.MCODE_NODE_DIR ?? null;
  if (nodeDir == null || nodeDir === '') return createCli(opts);
  if (typeof nodeDir !== 'string' || !path.isAbsolute(nodeDir) || nodeDir.includes('\0') || nodeDir.includes(path.delimiter)) throw coded('E_INVALID', 'nodeDir must be an absolute directory path');
  return createCli({ ...opts, env: { ...env, PATH: [nodeDir, env.PATH].filter(Boolean).join(path.delimiter) } });
}
export default createAdapter;
