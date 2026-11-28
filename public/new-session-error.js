// Why a "new session" was refused, as toast text; null when it was not. 409 is not only a taken name: the disk guard
// (disk-guard.js, reason `disk_low`) answers 409 too, and was shown as "already exists" (owner, 2026-11-28).
export function createRefusal(status, body, name) {
  if (status >= 200 && status < 300 && body?.ok !== false) return null;
  const error = String(body?.error || '');
  if (status === 409 && (body?.reason === 'disk_low' || !error)) return body?.reason ? error || 'the disk is almost full: new sessions are paused' : `create refused (HTTP 409)`;
  if (status === 409 && /already exists|duplicate session/.test(error)) return `"${name}" already exists`;
  return `create failed: ${error || `HTTP ${status}`}`;
}
