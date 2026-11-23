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

// The content type to send for a picked / dropped file, or '' when /api/upload does not take it (upload-kind.js on the server).
// A Mac browser often gives a .md or .txt no type at all (owner 2026-11-23: "I cannot share .md and .txt"): name it by extension.
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
const TEXT_BY_EXT = { md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', log: 'text/plain', csv: 'text/csv', tsv: 'text/plain',
  json: 'text/plain', jsonl: 'text/plain', yaml: 'text/plain', yml: 'text/plain' };
export const UPLOAD_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,.md,.markdown,.txt,.log,.csv,.tsv,.json,.jsonl,.yaml,.yml,text/markdown,text/plain';
export const UPLOAD_HINT = 'images (png, jpeg, gif, webp) or text files (.md, .txt, .csv, .json, .yaml, .log) only';
export function uploadType(file) {
  const t = String(file?.type || '').toLowerCase();
  if (IMAGE_TYPES.test(t)) return t;
  const ext = (/\.([A-Za-z0-9]+)$/.exec(String(file?.name || '')) || [])[1]?.toLowerCase();
  if (ext && TEXT_BY_EXT[ext]) return TEXT_BY_EXT[ext];
  return /^text\/(markdown|x-markdown|plain)$/.test(t) ? t : '';
}

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
      const headers = { 'content-type': uploadType(file) || file.type || 'application/octet-stream' };
      if (file.name) headers['x-upload-name'] = encodeURIComponent(file.name);   // the saved copy keeps the name (upload-kind.js)
      const r = await fetchImpl('/api/upload', { method: 'POST', headers, body: file, signal: ac.signal });
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
