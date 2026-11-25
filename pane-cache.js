// Short-lived, single-flight reads and a concurrency cap for the dashboard's tmux / file reads (owner 2026-11-25: opening a session in reader mode took
// 3-5 s on a loaded box). Every child process the server starts costs it ~40 ms of its single thread (fork of a ~2.5 GB process), so ten clicks on the same
// session must make one capture, and a burst of captures must not all run at once.

// At most `max` calls of fn run at once; the rest wait their turn (FIFO).
export function createLimiter(max = 4) {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < max && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
    }
  };
  const run = (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
  run.stats = () => ({ active, queued: queue.length });
  return run;
}

// get(key, fn): the answer of a call that is still running or that finished less than ttlMs ago is shared (a failure is never kept).
// invalidate(prefix): forget `prefix` and every `prefix|...` key (a send changes the pane).
export function createCoalescer({ ttlMs = 1500, now = Date.now, maxEntries = 400 } = {}) {
  const m = new Map();
  const sweep = () => { const t = now(); for (const [k, e] of m) if (!e.pending && t - e.at >= ttlMs) m.delete(k); };
  return {
    get(key, fn) {
      const e = m.get(key);
      if (e && (e.pending || now() - e.at < ttlMs)) return e.p;
      if (m.size >= maxEntries) sweep();
      const ent = { at: now(), pending: true, p: null };
      ent.p = Promise.resolve().then(fn);
      m.set(key, ent);
      ent.p.then(() => { ent.at = now(); ent.pending = false; }, () => { if (m.get(key) === ent) m.delete(key); });
      return ent.p;
    },
    invalidate(prefix) { for (const k of [...m.keys()]) if (k === prefix || k.startsWith(`${prefix}|`)) m.delete(k); },
    size: () => m.size,
  };
}
