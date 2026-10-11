// Android app-link statement (/.well-known/assetlinks.json) and the public links the UI needs, all from configuration
// so the repo carries no tailnet identifiers. Pure: no I/O except the optional file read in loadAssetlinks.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const FP_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

// -> { json: string } | { error: string } | null (not configured)
export function buildAssetlinks(env = process.env) {
  const pkg = String(env.ANDROID_APP_PACKAGE || '').trim();
  const raw = String(env.ANDROID_APP_SHA256 || '').trim();
  if (!pkg && !raw) return null;
  if (!pkg || !raw) return { error: 'ANDROID_APP_PACKAGE and ANDROID_APP_SHA256 must be set together' };
  if (!PKG_RE.test(pkg)) return { error: 'ANDROID_APP_PACKAGE is not a valid Android package name' };
  const fps = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!fps.length || !fps.every((f) => FP_RE.test(f))) return { error: 'ANDROID_APP_SHA256 must be comma-separated XX:XX:... fingerprints (32 hex pairs)' };
  return { json: JSON.stringify([{ relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps } }]) };
}

// env wins; else $stateDir/assetlinks.json verbatim (must parse as JSON); else null. { error } is for a startup warning.
export async function loadAssetlinks(env = process.env, stateDir) {
  const built = buildAssetlinks(env);
  if (built) return built;
  if (!stateDir) return null;
  let text;
  try { text = await readFile(join(stateDir, 'assetlinks.json'), 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? null : { error: `${join(stateDir, 'assetlinks.json')} is unreadable (${e.code || 'error'})` }; }
  try { JSON.parse(text); } catch { return { error: `${join(stateDir, 'assetlinks.json')} is not valid JSON` }; }
  return { json: text };
}

const isLoopback = (h) => /^(localhost\.?|.+\.localhost\.?|\[?::1?\]?|\[?::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]?|127(\.\d+){3}|0\.0\.0\.0)$/i.test(h);
function cleanUrl(v, { httpsOnly = false } = {}) {
  const s = String(v || '').trim();
  if (!s) return '';
  let u; try { u = new URL(s); } catch { return ''; }
  if (u.protocol !== 'https:' && (httpsOnly || u.protocol !== 'http:')) return '';
  return u.href.replace(/\/+$/, '');
}

// Links the browser may show. langfuse: LANGFUSE_PUBLIC_URL, else LANGFUSE_URL when it is not a loopback address.
// publicUrl: PUBLIC_URL when https (named in the "needs the HTTPS address" hints).
export function publicLinks(env = process.env) {
  let langfuse = cleanUrl(env.LANGFUSE_PUBLIC_URL);
  if (!langfuse) {
    const u = cleanUrl(env.LANGFUSE_URL);
    if (u && !isLoopback(new URL(u).hostname)) langfuse = u;
  }
  return { langfuse: langfuse || null, publicUrl: cleanUrl(env.PUBLIC_URL, { httpsOnly: true }) || null };
}
