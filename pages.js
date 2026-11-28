// Shared pages (owner 2026-11-28): a page, mockup or report an agent makes is published here instead of as a claude.ai
// Artifact, which is private to the Claude account that made it (three logins: the owner had to share each one by hand).
//   `page publish <file.html|file.md|folder> [--slug s] [--title t]`  (scripts/page) copies the page and the files it refers to
//   into <state>/pages/<slug>/site/ and writes <state>/pages/<slug>/meta.json; publishing the same slug again replaces it, so the
//   URL stays the same. Served by this dashboard (Tailscale only, as everything else):
//     GET /p/                 the list of pages, newest first (More menu > Pages)
//     GET /p/<slug>/<path>    the page and its files; HTML and SVG sandboxed (opaque origin) with connect-src / form-action 'none',
//                             so a page's script cannot call the dashboard API (which has no login)
//     GET /api/pages          { base, pages: [meta] }
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { FILE_TYPES } from './files-route.js';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const MAX_FILES = 200;
export const MAX_BYTES = 50 * 1024 * 1024;
const PAGE_TYPES = { ...FILE_TYPES, '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.ico': 'image/x-icon', '.woff': 'font/woff' };
const SANDBOXED = new Set(['.html', '.htm', '.svg']);
// Opaque origin (sandbox without allow-same-origin) and no fetch / XHR / websocket / beacon / form post anywhere: a page cannot
// read or change the dashboard. Images, styles, fonts and scripts may still load from the page's own folder or a CDN.
export const PAGE_CSP = "sandbox allow-scripts allow-popups allow-modals allow-downloads; default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; form-action 'none'; frame-src 'self' data: blob:; worker-src 'none'; base-uri 'none'";

export const pagesDir = (stateDir) => join(stateDir, 'pages');
export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'page';
}
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- Markdown -> HTML (no dependency): headings, paragraphs, lists, task boxes, code blocks, quotes, tables, rules, links, images,
// bold / italic / code / strike. Raw HTML in the Markdown is escaped (the page is sandboxed anyway).
function inline(t) {
  const codes = [];
  let s = String(t).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, a, u) => `<img alt="${a}" src="${safeUrl(u)}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, a, u) => `<a href="${safeUrl(u)}">${a}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}">${u}</a>`)
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)|(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, (_, p1, a, p2, b) => `${p1 ?? p2}<em>${a ?? b}</em>`)
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}
const safeUrl = (u) => (/^\s*(?:javascript|vbscript|data:text\/html)/i.test(u.replace(/&amp;/g, '&')) ? '#' : u);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function markdownToHtml(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = (l) => /^(#{1,6}\s|```|~~~|>\s?|\s*[-*+]\s|\s*\d+[.)]\s|\s*(?:[-*_]\s*){3,}$)/.test(l) || /^\|.*\|\s*$/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = /^(```|~~~)\s*([\w+-]*)/.exec(l))) {
      const fence = m[1], body = []; i++;
      while (i < lines.length && !lines[i].startsWith(fence)) body.push(lines[i++]);
      i++; out.push(`<pre><code${m[2] ? ` class="language-${esc(m[2])}"` : ''}>${esc(body.join('\n'))}</code></pre>`); continue;
    }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) { const n = m[1].length; out.push(`<h${n} id="${slugify(m[2])}">${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(l)) { const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, '')); out.push(`<blockquote>${markdownToHtml(q.join('\n'))}</blockquote>`); continue; }
    if (/^\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = cells(l), al = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
      const st = (k) => (al[k] ? ` style="text-align:${al[k]}"` : '');
      i += 2; const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="tw"><table><thead><tr>${head.map((c, k) => `<th${st(k)}>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, k) => `<td${st(k)}>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s/.exec(l))) {
      const ordered = /\d/.test(m[2]), items = [];
      while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s/.test(lines[i])) {
        let t = lines[i++].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
        while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(lines[i])) t += ' ' + lines[i++].trim();
        const box = /^\[( |x|X)\]\s+/.exec(t);
        items.push(box ? `<li class="task"><input type="checkbox" disabled${box[1] !== ' ' ? ' checked' : ''}> ${inline(t.slice(box[0].length))}</li>` : `<li>${inline(t)}</li>`);
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    const para = [l.trim()]; i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

const PAGE_STYLE = `:root{--bg:#fff;--fg:#1d1d1f;--mute:#6e6e73;--line:#e3e3e8;--card:#f6f6f8;--link:#0a64d8}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--mute:#a1a1aa;--line:#2c2c31;--card:#1c1c20;--link:#6aa8ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}a{color:var(--link)}img{max-width:100%;height:auto}
h1,h2,h3{line-height:1.25}h1{font-size:1.7rem}pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto}
code{font:0.9em ui-monospace,SFMono-Regular,Menlo,monospace}:not(pre)>code{background:var(--card);padding:1px 5px;border-radius:4px}
blockquote{margin:0;padding:2px 14px;border-left:3px solid var(--line);color:var(--mute)}.tw{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.95rem}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--card)}
li.task{list-style:none;margin-left:-1.2em}hr{border:0;border-top:1px solid var(--line);margin:24px 0}`;

export function markdownPage(md, title) {
  const t = title || (/^#\s+(.+)$/m.exec(md)?.[1] ?? 'Page');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t)}</title><style>${PAGE_STYLE}</style></head>\n<body><main>\n${markdownToHtml(md)}\n</main></body></html>\n`;
}

// --- relative files a page refers to (src / href / url(...) / Markdown links), copied beside it ------------------------------------
export function localRefs(text) {
  const refs = new Set();
  const add = (u) => {
    u = String(u || '').trim().replace(/^['"]|['"]$/g, '').replace(/[?#].*$/, '');
    if (!u || /^(?:[a-z][\w+.-]*:|\/\/|\/|#)/i.test(u)) return;
    try { u = decodeURIComponent(u); } catch { return; }
    const n = normalize(u);
    if (n.startsWith('..') || isAbsolute(n) || n.split(sep).some((s) => s.startsWith('.') && s !== '.')) return;
    refs.add(n);
  };
  for (const m of text.matchAll(/\b(?:src|href|poster|data-src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) add(m[1]);
  for (const m of text.matchAll(/\bsrcset\s*=\s*("[^"]*"|'[^']*')/gi)) for (const part of m[1].slice(1, -1).split(',')) add(part.trim().split(/\s+/)[0]);
  for (const m of text.matchAll(/url\(\s*("[^"]*"|'[^']*'|[^)]*)\s*\)/gi)) add(m[1]);
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g)) add(m[1]);
  return [...refs];
}

// --- the store ------------------------------------------------------------------------------------------------------------------
export function readMeta(stateDir, slug) {
  try { return JSON.parse(readFileSync(join(pagesDir(stateDir), slug, 'meta.json'), 'utf8')); } catch { return null; }
}
export function listPages(stateDir) {
  let names = []; try { names = readdirSync(pagesDir(stateDir)); } catch { return []; }
  return names.filter((n) => SLUG_RE.test(n)).map((n) => readMeta(stateDir, n)).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// src: a .html / .htm / .md file, or a folder with index.html (or index.md). -> { slug, created, files, meta }. Throws a plain Error.
// The Claude login a page came from: team1 / team2 from CLAUDE_CONFIG_DIR; a Claude Code session without one is on the personal login.
export const accountOf = (env) => (env.CLAUDE_CONFIG_DIR ? basename(env.CLAUDE_CONFIG_DIR.replace(/\/+$/, '')).replace(/^\.claude$/, 'personal') : env.CLAUDECODE ? 'personal' : '');

export function publishPage(stateDir, src, { slug, title, session = '', account = '', assets = [], now = Date.now() } = {}) {
  const abs = resolve(src);
  let st; try { st = statSync(abs); } catch { throw new Error(`no such file: ${src}`); }
  const isDir = st.isDirectory();
  let entry = abs;
  if (isDir) {
    entry = ['index.html', 'index.htm', 'index.md'].map((f) => join(abs, f)).find((f) => existsSync(f));
    if (!entry) throw new Error(`${src}: a folder needs an index.html or index.md`);
  }
  const ext = extname(entry).toLowerCase();
  if (!['.html', '.htm', '.md', '.markdown'].includes(ext)) throw new Error(`${src}: publish an .html or .md file (or a folder with index.html)`);
  const s = slug ? String(slug) : slugify(isDir ? basename(abs) : basename(entry, extname(entry)));
  if (!SLUG_RE.test(s)) throw new Error(`bad slug "${s}": lower-case letters, digits and dashes, 60 at most`);
  const raw = readFileSync(entry, 'utf8');
  const isMd = ext === '.md' || ext === '.markdown';
  const pageTitle = String(title || (isMd ? /^#\s+(.+)$/m.exec(raw)?.[1] : /<title[^>]*>([^<]*)<\/title>/i.exec(raw)?.[1]) || s).trim().slice(0, 120);
  const html = isMd ? markdownPage(raw, pageTitle) : raw;

  const root = pagesDir(stateDir), dir = join(root, s), tmp = join(root, `.tmp-${s}-${process.pid}-${now}`);
  mkdirSync(join(tmp, 'site'), { recursive: true });
  let files = 0, bytes = 0;
  const copyOne = (from, rel) => {
    const e = extname(from).toLowerCase();
    if (!PAGE_TYPES[e]) return;
    const fst = statSync(from); if (!fst.isFile()) return;
    if (++files > MAX_FILES) throw new Error(`more than ${MAX_FILES} files`);
    if ((bytes += fst.size) > MAX_BYTES) throw new Error(`more than ${MAX_BYTES / 1048576} MB`);
    mkdirSync(dirname(join(tmp, 'site', rel)), { recursive: true });
    cpSync(from, join(tmp, 'site', rel));
  };
  try {
    writeFileSync(join(tmp, 'site', 'index.html'), html);
    const base = dirname(entry);
    if (isDir) {
      const walk = (d) => {
        for (const ent of readdirSync(d, { withFileTypes: true })) {
          if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
          const f = join(d, ent.name), rel = relative(abs, f);
          if (ent.isDirectory()) walk(f); else if (f !== entry && !ent.isSymbolicLink()) copyOne(f, rel);
        }
      };
      walk(abs);
    } else {
      for (const rel of localRefs(raw)) { const f = join(base, rel); if (existsSync(f)) copyOne(realpathSync(f), rel); }
    }
    for (const a of assets) {
      const f = resolve(a); if (!existsSync(f)) throw new Error(`no such asset: ${a}`);
      const rel = relative(base, f); copyOne(f, rel.startsWith('..') || isAbsolute(rel) ? basename(f) : rel);
    }
    const prev = readMeta(stateDir, s);
    const meta = { slug: s, title: pageTitle, session: session || prev?.session || '', account: account || '', source: entry, kind: isMd ? 'markdown' : 'html',
      createdAt: prev?.createdAt || now, updatedAt: now, version: (prev?.version || 0) + 1, files: files + 1 };
    writeFileSync(join(tmp, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
    const old = join(root, `.old-${s}-${process.pid}-${now}`);
    if (existsSync(dir)) renameSync(dir, old);
    renameSync(tmp, dir);
    rmSync(old, { recursive: true, force: true });
    return { slug: s, created: !prev, files: files + 1, meta };
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
}

// A published page named by its stored file (<state>/pages/<slug>/site/...) -> its dashboard URL path, '' for anything else.
// The stored path is under a dot folder, so a /files/ link to it answers "hidden folder" (owner 2026-11-28: a broken index.html link).
export function pagePathOf(stateDir, file) {
  const root = pagesDir(stateDir) + sep, f = normalize(String(file || ''));
  if (!f.startsWith(root)) return '';
  const [slug, site, ...rel] = f.slice(root.length).split(sep);
  if (!SLUG_RE.test(slug) || site !== 'site' || !rel.length) return '';
  const tail = rel.join('/') === 'index.html' ? '' : rel.map(encodeURIComponent).join('/');
  return `/p/${slug}/${tail}`;
}

// urlPath after /p/ ("<slug>/<path>") -> { file, type, sandbox, size } | { redirect } | { status, error }
export function resolvePageFile(stateDir, rest) {
  let p; try { p = decodeURIComponent(String(rest || '')); } catch { return { status: 400, error: 'bad path' }; }
  if (p.includes('\0')) return { status: 400, error: 'bad path' };
  const i = p.indexOf('/');
  const slug = i < 0 ? p : p.slice(0, i);
  if (!SLUG_RE.test(slug)) return { status: 404, error: 'no such page' };
  if (i < 0) return { redirect: `/p/${slug}/` };
  let rel = p.slice(i + 1) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const n = normalize(rel);
  if (n.startsWith('..') || isAbsolute(n) || n.split(sep).some((s) => s.startsWith('.'))) return { status: 403, error: 'bad path' };
  const site = join(pagesDir(stateDir), slug, 'site');
  let file; try { file = realpathSync(join(site, n)); } catch { return { status: 404, error: 'no such file' }; }
  let siteReal; try { siteReal = realpathSync(site); } catch { return { status: 404, error: 'no such page' }; }
  if (!file.startsWith(siteReal + sep)) return { status: 403, error: 'outside the page' };
  const ext = extname(file).toLowerCase();
  if (!PAGE_TYPES[ext]) return { status: 403, error: 'not a page file type' };
  const st = statSync(file); if (!st.isFile()) return { status: 404, error: 'not a file' };
  return { file, type: PAGE_TYPES[ext], sandbox: SANDBOXED.has(ext), size: st.size };
}

const ago = (ms, now) => { const m = Math.round((now - ms) / 60e3); return m < 1 ? 'now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
// The list at /p/: server-made, titles escaped, no script.
export function indexHtml(pages, { now = Date.now() } = {}) {
  const rows = pages.map((m) => `<li><a href="/p/${esc(m.slug)}/"><span class="t">${esc(m.title || m.slug)}</span><span class="m">${esc([m.session, m.account, ago(m.updatedAt, now), m.version > 1 ? `v${m.version}` : ''].filter(Boolean).join(' · '))}</span></a></li>`).join('\n');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages</title>
<style>${PAGE_STYLE}
ul{list-style:none;padding:0;margin:0}li a{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;text-decoration:none;color:var(--fg);background:var(--card)}
li a:hover{border-color:var(--link)}.t{font-weight:600;overflow-wrap:anywhere}.m{color:var(--mute);font-size:.85rem}.top{display:flex;justify-content:space-between;align-items:baseline}.top a{font-size:.9rem}</style></head>
<body><main><div class="top"><h1>Pages</h1><a href="/">Dashboard</a></div>
${pages.length ? `<ul>\n${rows}\n</ul>` : '<p>No pages yet. Agents publish with <code>page publish &lt;file&gt;</code>.</p>'}
</main></body></html>\n`;
}
