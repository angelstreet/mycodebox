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
export const uploadTimeoutMs = (bytes) => Math.min(180000, Math.max(DEFAULTS.timeoutMs, 20000 + Math.round((Number(bytes) || 0) / 8)));   // ~8 KB/s floor

// A big picture (a Retina screenshot is 400 KB to 2 MB) is made smaller before it goes: at most 1600 px on the long side, PNG when that
// is small enough, else JPEG. Agents read a 1600 px screenshot as well as a 2880 px one, and over a slow link the upload is 3 to 6 times
// shorter. Anything that does not get clearly smaller, or cannot be decoded here, is sent as it is.
const SHRINK_OVER = 250 * 1024, SHRINK_PX = 1600;
export async function shrinkImage(file) {
  if (!/^image\/(png|jpeg)$/.test(file?.type || '') || file.size < SHRINK_OVER || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  let bmp;
  try {
    bmp = await createImageBitmap(file);
    const k = Math.min(1, SHRINK_PX / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.drawImage(bmp, 0, 0, w, h);
    const blob = (type, q) => new Promise((ok) => cv.toBlob(ok, type, q));
    let best = file.type === 'image/png' ? await blob('image/png') : null;
    if (!best || best.size > SHRINK_OVER) {   // a photo: JPEG, on white (a PNG's transparent pixels are black in a JPEG)
      g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      const j = await blob('image/jpeg', 0.85); if (j && (!best || j.size < best.size)) best = j;
    }
    if (!best || best.size > file.size * 0.8) return file;
    const ext = best.type === 'image/jpeg' ? 'jpg' : 'png';
    return new File([best], String(file.name || 'image').replace(/\.[A-Za-z0-9]+$/, '') + '.' + ext, { type: best.type, lastModified: file.lastModified });
  } catch { return file; }
  finally { try { bmp?.close?.(); } catch { /* none */ } }
}

// A failed upload is reported to the server (/api/upload-report -> uploads.jsonl, shown in /upload-debug.html): a request that never
// arrived (offline, a VPN blip, a timeout) leaves no server line. A report that cannot be sent waits in localStorage for the next page load.
const QUEUE_KEY = 'ghosty.uploadReports';
const lsq = (fn) => { try { return fn(globalThis.localStorage); } catch { return undefined; } };
const post = (rec) => fetch('/api/upload-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) }).then((r) => { if (!r.ok) throw new Error(String(r.status)); });
export async function flushUploadReports() {
  const q = lsq((l) => JSON.parse(l.getItem(QUEUE_KEY) || '[]')) || [];
  if (!q.length) return;
  lsq((l) => l.removeItem(QUEUE_KEY));
  for (const rec of q) { try { await post(rec); } catch { saveReport(rec); } }
}
function saveReport(rec) { lsq((l) => { const q = JSON.parse(l.getItem(QUEUE_KEY) || '[]'); q.push(rec); l.setItem(QUEUE_KEY, JSON.stringify(q.slice(-20))); }); }
export function reportUploadFailure(file, err, info = {}) {
  const c = globalThis.navigator?.connection;
  const rec = { name: file?.name || '', type: file?.type || '', sent: uploadType(file), bytes: file?.size, error: String(err?.message || err), status: err?.status,
    attempts: info.attempts, ms: info.ms, online: globalThis.navigator?.onLine, net: c ? `${c.effectiveType || ''} ${c.rtt ?? ''}ms ${c.downlink ?? ''}Mb/s`.trim() : '', page: globalThis.location?.pathname };
  post(rec).catch(() => saveReport(rec));
}
if (typeof window !== 'undefined') setTimeout(() => flushUploadReports().catch(() => {}), 3000);

export async function uploadOne(file, opts = {}) {
  const t0 = Date.now();
  if (!opts.fetchImpl && opts.shrink !== false) file = await shrinkImage(file);
  try { return await uploadAttempts(file, opts); }
  catch (err) {
    if (!opts.fetchImpl && opts.report !== false && err?.message !== 'upload aborted') reportUploadFailure(file, err, { attempts: err.attempts, ms: Date.now() - t0 });
    throw err;
  }
}
async function uploadAttempts(file, opts = {}) {
  // a slow link (a Mac reaching the codebox through a Tailscale relay moved 20 KB/s, owner 2026-11-23): the time allowed grows with the file
  const { attempts = DEFAULTS.attempts, backoffMs = DEFAULTS.backoffMs, timeoutMs = uploadTimeoutMs(file?.size) } = opts;
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
      err.attempts = attempt + 1;
      if (err instanceof HttpError) throw err;
      // Internal timeout fired: surface as a clear, retryable-on-next-click message.
      if (timedOut) throw Object.assign(new Error('upload timed out'), { attempts: attempt + 1 });
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
