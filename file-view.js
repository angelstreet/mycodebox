// A file an agent names in its reply ("docs/X.md", `server.js:120`, ~/notes/a.txt) opens in the dashboard's file panel
// (owner 2026-11-23: "in Cursor or Claude Code I can click a file to read it; in codebox we don't"). GET /api/file?s=<session>&p=<path>
// (&b=<folder>: a link inside an open document, resolved beside it first) -> { path, name, text, size, truncated }. Text files only (an extension or name allowlist, no NUL byte), at most 1 MB, under the
// home folder or the scratchpads and never through a dot folder (files-route.js placeError), never a name that reads like a secret.
// A relative path resolves in the session's folder (files-route.js findInFolder: direct, else a bounded search).
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { findInFolder, placeError } from './files-route.js';

export const TEXT_EXT = new Set(('md markdown txt rst js mjs cjs ts tsx jsx py json jsonl yaml yml sh bash zsh css scss less toml sql go rs java kt '
  + 'c h cc cpp hpp rb ini cfg conf csv tsv log xml vue svelte lua php swift r tex diff patch service').split(' ').map((e) => '.' + e));
export const TEXT_NAMES = new Set(['Makefile', 'Dockerfile', 'README', 'LICENSE', 'Procfile', 'Caddyfile', 'Justfile']);
const SECRET_NAME = /secret|credential|token|passw|keystore|private[-_]?key|api[-_]?key|\.env(\.|$)|\.pem$|\.key$/i;
export const isTextName = (p) => TEXT_EXT.has(extname(p).toLowerCase()) || TEXT_NAMES.has(basename(p));
export const MAX_BYTES = 1 << 20;
// dot-folder files an agent often names and that hold no secret: Claude's skills, agents, memory notes and CLAUDE.md (read only).
// Transcripts (~/.claude/projects/*/*.jsonl), ~/.local, ~/.config stay closed: they can hold tokens.
const READABLE_DOT = /^\.claude\/(?:skills\/[^/]+\/.+|agents\/[^/]+|projects\/[^/]+\/memory\/[^/]+\.md|CLAUDE\.md)$/;

// path: absolute, ~/..., or relative to cwd (the session's folder) -> { path, name, text, size, truncated } or { status, error }
export function readViewFile(path, { home, cwd = '', base = '', uid, maxBytes = MAX_BYTES, real = realpathSync, stat = statSync, find = findInFolder, read } = {}) {
  let p = String(path || '').trim().replace(/^\.\//, '');
  if (!p || p.includes('\0')) return { status: 400, error: 'no path' };
  if (p.startsWith('~/')) p = join(home, p.slice(2));
  if (!isTextName(p)) return { status: 415, error: 'not a text file this panel shows' };
  if (SECRET_NAME.test(basename(p))) return { status: 403, error: 'the name reads like a secret: not shown' };
  if (!isAbsolute(p)) {
    // base: the folder of the document the link is in (a link inside an open file); then the session's folder
    const near = base && isAbsolute(base) ? join(base, p) : '';
    let hit = null;
    if (near) { try { if (stat(near).isFile()) hit = near; } catch { /* not beside it */ } }
    if (!hit && cwd) hit = find(cwd, p, { accept: isTextName });
    if (!hit) return { status: 404, error: cwd || base ? `no ${p} in ${base || cwd}` : 'a relative path needs a session' };
    p = hit;
  }
  let file; try { file = real(resolve(p)); } catch { return { status: 404, error: 'no such file' }; }
  const bad = placeError(file, { home, uid });
  if (bad && !(bad.error === 'hidden folder' && file.startsWith(home + '/') && READABLE_DOT.test(file.slice(home.length + 1)))) return bad;
  if (SECRET_NAME.test(basename(file))) return { status: 403, error: 'the name reads like a secret: not shown' };
  let st; try { st = stat(file); } catch { return { status: 404, error: 'no such file' }; }
  if (!st.isFile()) return { status: 404, error: 'not a file' };
  const buf = (read || readHead)(file, Math.min(st.size, maxBytes));
  if (buf.includes(0)) return { status: 415, error: 'binary file' };
  return { path: file, name: basename(file), text: buf.toString('utf8'), size: st.size, truncated: st.size > maxBytes };
}
function readHead(file, n) {
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(n); const got = readSync(fd, b, 0, n, 0); return b.subarray(0, got); } finally { closeSync(fd); }
}
