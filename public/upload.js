// Image upload to /api/upload with transient-error retry (TASK-70 quickfix).
// Lives in its own module so the retry / timeout logic is testable from
// node:test without a DOM. The body is a Blob (File), so it's safe to reuse
// across attempts — the buffer isn't drained by the first fetch.
//
// Contract:
//   uploadOne(file, { signal, fetchImpl, timeoutMs, attempts, backoffMs }?)
//     -> Promise<{ok, path}>
//   - retries on TypeError('Failed to fetch') up to 3 attempts with 400ms /
//     800ms backoff (transient network blips: Tailscale reconnect, WiFi
//     handoff, brief offline)
//   - throws an HttpError on HTTP 4xx/5xx immediately (real server error)
//   - throws 'upload timed out' on the 30s timeout (default; pass 0 to disable)
//   - the optional signal aborts the current attempt; subsequent attempts
//     are not started after an external abort
//   - the optional fetchImpl lets tests inject a fake fetch

export class HttpError extends Error {
  constructor(message, status) { super(message); this.name = 'HttpError'; this.status = status; }
}

const DEFAULTS = { attempts: 3, backoffMs: 400, timeoutMs: 30000 };

export async function uploadOne(file, opts = {}) {
  const { attempts = DEFAULTS.attempts, backoffMs = DEFAULTS.backoffMs, timeoutMs = DEFAULTS.timeoutMs } = opts;
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new Error('no fetch implementation available');
  const signal = opts.signal;

  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw new Error('upload aborted');
    const ac = new AbortController();
    const onAbort = () => ac.abort('aborted');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs) : null;
    try {
      const r = await fetchImpl('/api/upload', { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file, signal: ac.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new HttpError(j.error || `HTTP ${r.status}`, r.status);
      return j;
    } catch (err) {
      lastErr = err;
      // Real server errors: no retry, won't fix itself.
      if (err instanceof HttpError) throw err;
      // Internal timeout fired: surface as a clear, retryable-on-next-click message.
      if (timedOut) throw new Error('upload timed out');
      // External signal cancelled: don't keep retrying.
      if (signal?.aborted) throw new Error('upload aborted');
      // 'Failed to fetch' (TypeError on offline / DNS / CORS) and other
      // transient network errors: retry up to attempts-1 times.
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr || new Error('upload failed');
}
