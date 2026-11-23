// /files/<absolute path>: a picture, video, PDF or HTML mockup an agent made, shown in the reader or opened in a tab from any device
// on the tailnet (owner 2026-11-22). The path is in the URL (not a query) so a mockup's relative CSS / JS / images resolve beside it.
// Only media and page types, only under the home folder or this user's Claude scratchpads, never through a dot folder (keys, .env,
// state) except the dashboard's own uploads. HTML and SVG are served sandboxed (opaque origin): a mockup's script cannot call the
// dashboard's API.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

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

// A relative path an agent printed ("out/ep01.mp4" in a terminal, owner 2026-11-23: the phone shows the terminal, where only URLs
// were links) -> the absolute file inside the session's folder, or null. The agent names a path from wherever its shell stood, so
// when <cwd>/<rel> does not exist the folder is searched for a file ending in /<rel>: breadth first, dot folders and node_modules
// skipped, bounded (depth, entries) so a big tree cannot stall the server. The caller redirects to /files/<abs>, whose checks apply.
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv']);
export function findInFolder(cwd, rel, { maxDepth = 6, maxEntries = 20000, readdir = readdirSync, stat = statSync } = {}) {
  if (!cwd || !isAbsolute(cwd) || !rel || isAbsolute(rel) || rel.includes('\0')) return null;
  const r = normalize(rel).replace(/^\.\//, '');
  if (r.split(sep).includes('..') || !FILE_TYPES[extname(r).toLowerCase()]) return null;
  const isFile = (p) => { try { return stat(p).isFile(); } catch { return false; } };
  const direct = join(cwd, r);
  if (isFile(direct)) return direct;
  const tail = sep + r;
  let level = [cwd], seen = 0;
  for (let d = 0; d < maxDepth && level.length; d++) {
    const next = [];
    for (const dir of level) {
      let ents; try { ents = readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (++seen > maxEntries) return null;
        if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        const sub = join(dir, e.name);
        if (isFile(sub + tail)) return sub + tail;
        next.push(sub);
      }
    }
    level = next;
  }
  return null;
}
