// Shared by the usage tailer, the eval sync and the experiment runner: ids that must stay identical between
// them (so a score lands on the generation the tailer sent) and thin Langfuse HTTP helpers.
import { createHash } from 'node:crypto';

export const hash = (s) => createHash('sha1').update(s).digest('hex');
export const traceIdOf = (agent, session) => hash(`trace:${agent}:${session}`).slice(0, 32);
export const genIdOf = (recordId) => hash(`gen:${recordId}`).slice(0, 32);

const auth = (cfg) => 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64');

// One Langfuse REST call. Returns the parsed JSON (null for an empty body); throws on a non-2xx status unless
// okStatuses lists it. err.status is set.
export async function lfRequest(cfg, method, path, body, { fetchFn = fetch, okStatuses = [], timeoutMs = 60000 } = {}) {
  const res = await fetchFn(`${cfg.langfuseUrl}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: auth(cfg) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok && !okStatuses.includes(res.status)) throw Object.assign(new Error(`langfuse ${method} ${path} ${res.status}: ${text.slice(0, 600)}`), { status: res.status });
  return json === null && !res.ok ? { status: res.status } : json;
}

// POST /api/public/ingestion; returns the rejected events (empty = all accepted).
export async function postBatch(cfg, batch, opts = {}) {
  const j = await lfRequest(cfg, 'POST', '/api/public/ingestion', { batch }, { ...opts, okStatuses: [207] });
  return (j && j.errors) || [];
}
