// /files/<absolute path>: a picture, video, PDF or HTML mockup an agent made, shown in the reader or opened in a tab from any device
// on the tailnet (owner 2026-11-22). The path is in the URL (not a query) so a mockup's relative CSS / JS / images resolve beside it.
// Only media and page types, only under the home folder or this user's Claude scratchpads, never through a dot folder (keys, .env,
// state) except the dashboard's own uploads. HTML and SVG are served sandboxed (opaque origin): a mockup's script cannot call the
// dashboard's API.
import { realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

export const FILE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
const SANDBOXED = new Set(['.html', '.htm', '.svg']);

// urlPath: the part after /files (decoded or not) -> { file, type, sandbox, size } or { status, error }
export function resolveServedFile(urlPath, { home, uid = process.getuid?.() ?? 0, real = realpathSync, stat = statSync } = {}) {
  let p; try { p = decodeURIComponent(String(urlPath || '')); } catch { return { status: 400, error: 'bad path' }; }
  if (p.startsWith('/~/')) p = join(home, p.slice(3));
  if (!p.startsWith('/') || p.includes('\0')) return { status: 400, error: 'absolute path only' };
  const ext = extname(p).toLowerCase();
  if (!FILE_TYPES[ext]) return { status: 403, error: 'not a picture, video, PDF or page' };
  let file; try { file = real(resolve(p)); } catch { return { status: 404, error: 'no such file' }; }
  const uploads = join(home, '.ghosty', 'uploads') + sep, scratch = `/tmp/claude-${uid}${sep}`;
  const inHome = file.startsWith(home + sep), inScratch = file.startsWith(scratch);
  if (!inHome && !inScratch) return { status: 403, error: 'outside the home folder and the scratchpads' };
  const rest = file.startsWith(uploads) ? '' : file.slice(inHome ? home.length : scratch.length);
  if (rest.split(sep).some((s) => s.startsWith('.'))) return { status: 403, error: 'hidden folder' };
  let st; try { st = stat(file); } catch { return { status: 404, error: 'no such file' }; }
  if (!st.isFile()) return { status: 404, error: 'not a file' };
  return { file, type: FILE_TYPES[ext], sandbox: SANDBOXED.has(ext), size: st.size };
}
