// Git facts for a session's working directory: is the tree clean enough that a worker session may be closed?
// Pure: the exec function is injected, so the module can be tested without a git repository.
//
// Why this module exists (2026-10-26): the same helper lived inside server.js and read
// `await exec(...).stdout` — the property of the PROMISE, not of the resolved value. `st` was
// therefore always undefined and `st.trim()` threw out of the helper, which killed the whole
// worker-auto-close candidate scan every 5 min (146 crashes on 2026-10-26): no session was ever
// auto-closed. The three calls inside the try/catch were equally broken but silent: they threw,
// the catch swallowed them and the helper returned "clean" — so the "ahead of origin/main" check
// never ran either. Always await the call first: `(await exec(...)).stdout`.

// -> true when the directory is clean enough to close a worker session that holds it.
//    true  = clean (or unknown: never block a close on a fact we could not read)
//    false = uncommitted work, or commits that are not on origin/main yet.
export async function gitCleanOf(cwd, { exec, timeoutMs = 30000 } = {}) {
  if (!cwd || typeof exec !== 'function') return true;
  const run = async (args) => {
    const r = await exec('git', ['-C', cwd, ...args], { timeout: timeoutMs });
    return String(r?.stdout ?? '');          // (await exec(...)).stdout: the promise has no stdout
  };
  try {
    const st = await run(['status', '--porcelain', '--untracked-files=no']);
    if (st.trim()) return false;              // uncommitted in a worktree: blame it
  } catch { return true; }
  try {
    const head = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (!head || head === 'HEAD') return true;   // detached / no branch: don't block
    const base = (await run(['rev-parse', '-q', '--verify', 'origin/main'])).trim();
    if (!base) return true;
    const ahead = (await run(['log', '--format=%h', '--no-merges', '--cherry-pick', '--right-only', 'origin/main...HEAD'])).trim();
    if (ahead) return false;
    return true;
  } catch { return true; }
}
