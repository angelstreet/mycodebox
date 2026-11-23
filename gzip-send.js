// gzip for the dashboard's text responses (owner 2026-11-23: selecting a session showed an empty reader for 10+ s from a Mac reaching the
// codebox through a Tailscale relay at ~20 KB/s; a 205 KB conversation JSON is 52 KB gzipped, app.js 357 KB is ~90 KB). Pure helpers
// plus the one send function used by json() and serveStatic() in server.js.
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gz = promisify(gzip);
export const MIN_BYTES = 1024;   // under this the header and the CPU cost more than they save
const TEXTUAL = /^(?:text\/|application\/(?:json|javascript|manifest\+json|xml)|image\/svg\+xml)/i;

export const acceptsGzip = (headers) => /\bgzip\b/i.test(String(headers?.['accept-encoding'] || ''));
export const compressible = (type, bytes) => bytes >= MIN_BYTES && TEXTUAL.test(String(type || ''));

// -> { body, headers } : the gzipped body with its headers, or the original untouched
export async function maybeGzip(reqHeaders, type, body, level = 6) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  if (!acceptsGzip(reqHeaders) || !compressible(type, buf.length)) return { body: buf, headers: {} };
  const out = await gz(buf, { level });
  if (out.length >= buf.length) return { body: buf, headers: {} };
  return { body: out, headers: { 'content-encoding': 'gzip', vary: 'accept-encoding' } };
}
