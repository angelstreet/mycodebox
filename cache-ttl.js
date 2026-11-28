// 1-hour prompt cache TTL for selected Claude sessions (token audit 2026-11-28, saving #5; manager decision: DEFAULT OFF until measured).
// A session whose turns are more than 5 minutes apart re-writes its whole context at every turn on the 5-minute TTL; on the 1-hour
// TTL it re-reads it (1-hour writes cost more, so it only pays for sessions with such idle gaps).
//
// The Claude Code switches (verified in the installed Claude Code 2.1.332 binary, 2026-11-28):
//   CLAUDE_CODE_PROMPT_CACHE_TTL=1h  main conversation ("5m" | "1h"; unset = automatic: 1 h on a subscription within its limits, 5 min on an API key)
//   ENABLE_PROMPT_CACHING_1H=1       subagents / helpers default to 1 h (CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL wins)
//
// Selection (any one turns it on for a session; nothing set = behaviour unchanged):
//   env CBSESSION_CACHE_1H=1 at launch (cbsession, or the ghosty service env for every V2 claude run)
//   <GHOSTY_STATE_DIR>/cache-1h.json  { "sessions": ["<tmux session or V2 task id>", ...] }  ("all": true = every Claude session)
// CLI: `node cache-ttl.js <name>` prints the `export` lines for a cbsession launch file (nothing when off).

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const CACHE_1H_ENV = Object.freeze({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', ENABLE_PROMPT_CACHING_1H: '1' });
export const CONFIG_FILE = 'cache-1h.json';

export const stateDirOf = (env = process.env) => env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');

export function readCacheConfig(stateDir, read = (p) => readFileSync(p, 'utf8')) {
  try { const j = JSON.parse(read(join(stateDir, CONFIG_FILE))); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

// Pure: is the 1-hour TTL on for this session?
export function cache1hOn(name, { env = process.env, config = {} } = {}) {
  if (/^(?:1|true|yes|on)$/i.test(String(env.CBSESSION_CACHE_1H || ''))) return true;
  if (config.all === true) return true;
  return !!name && Array.isArray(config.sessions) && config.sessions.includes(name);
}

// The env to add for this session: the two switches, or {} when off.
export function cacheEnvFor(name, { env = process.env, stateDir = stateDirOf(env), read } = {}) {
  return cache1hOn(name, { env, config: readCacheConfig(stateDir, read) }) ? { ...CACHE_1H_ENV } : {};
}

const isMain = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isMain()) {
  const e = cacheEnvFor(process.argv[2] || '');
  for (const [k, v] of Object.entries(e)) process.stdout.write(`export ${k}=${v}\n`);
}
