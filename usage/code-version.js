// Which code wrote the usage summary (token audit 2026-11-28): the tailer (usage/ingest.js) is its own unit, and two merged loop
// fixes stayed dormant for hours because only the dashboard restarted. The tailer stamps every summary with `writer`
// ({ pid, startedAt, sha }); /api/usage adds `writer.behind`: true when the tailer's code changed between its commit and the live
// checkout's HEAD, so the usage page can say the numbers come from older code.
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

// The paths the tailer runs: usage/ and the repo modules ingest.js imports. A change elsewhere does not make its numbers stale.
export const WRITER_PATHS = ['usage/', 'scorecard.js', 'session-history.js', 'claude-accounts.js'];
const SHA = /^[0-9a-f]{7,40}$/;

// Sync, once at tailer start: the commit checked out then (null outside a repo) and when the process started.
export function writerStamp({ cwd, pid = process.pid, now = Date.now(), uptimeS = process.uptime(),
  git = (args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }) } = {}) {
  let sha = null;
  try { const s = git(['rev-parse', 'HEAD']).trim(); sha = SHA.test(s) ? s : null; } catch { /* not a repo */ }
  return { pid, startedAt: new Date(now - uptimeS * 1000).toISOString(), sha };
}

// behind(writerSha) -> true (tailer code changed since), false (same code), null (unknown: no sha, no repo, unknown commit).
// Cached per sha for ttlMs, so the 30 s usage polls cost at most two git calls a ttl.
export function createBehindCheck({ cwd, exec = (args) => pexec('git', ['-C', cwd, ...args], { timeout: 5000 }), ttlMs = 30e3, now = Date.now } = {}) {
  let cache = { sha: '', at: 0, val: null };
  return async function behind(writerSha) {
    if (typeof writerSha !== 'string' || !SHA.test(writerSha)) return null;
    if (cache.sha === writerSha && now() - cache.at < ttlMs) return cache.val;
    let val = null;
    try {
      const head = (await exec(['rev-parse', 'HEAD'])).stdout.trim();
      if (head === writerSha) val = false;
      else {
        try { await exec(['diff', '--quiet', writerSha, head, '--', ...WRITER_PATHS]); val = false; }
        catch (e) { val = e?.code === 1 ? true : null; }   // 1 = differs; anything else (unknown commit) = unknown
      }
    } catch { val = null; }
    cache = { sha: writerSha, at: now(), val };
    return val;
  };
}
