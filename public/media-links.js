// Pictures and mockups in the reader (owner 2026-11-22: "from codebox wherever I am I can see html mockups and images").
// A file an agent sent (SendUserFile -> a "![](path)" line, conversation.js) or an absolute path it wrote in its reply is served by
// the dashboard at /files/<path> (files-route.js): a picture shows inline (click: full size in a new tab), a page / PDF / video
// gets an "open" link that opens it in a new tab. Pure: shared by the reader and the tests.
export const MEDIA_LINE = /^!\[[^\]]*\]\(([^)\s]+)\)$/;
const EXT = /\.(png|jpe?g|gif|webp|svg|html?|pdf|mp4|webm)$/i;
const PATH_RE = /(?:^|[\s`'"(@\]│])((?:~|\/(?:home|tmp))\/[^\s`'"()<>│]+?\.(?:png|jpe?g|gif|webp|svg|html?|pdf|mp4|webm))(?=$|[\s`'"),;:│]|\.(?:\s|$))/gi;
// a relative path with at least one folder ("out/ep01.mp4", "scripts/video/x.png"): the agent names it from its own folder, so the
// server resolves it inside the session's folder (/files-in/<session>/<path>, files-route.js findInFolder). A bare name is too vague.
const REL_RE = /(?:^|[\s`'"(@\]│])((?:\.\/)?[\w][\w.@+-]*\/[^\s`'"()<>│]*?\.(?:png|jpe?g|gif|webp|svg|html?|pdf|mp4|webm))(?=$|[\s`'"),;:│]|\.(?:\s|$))/gi;

export function kindOf(path) {
  const m = EXT.exec(String(path || '')); if (!m) return null;
  const e = m[1].toLowerCase();
  return /^(png|jpe?g|gif|webp|svg)$/.test(e) ? 'image' : /^html?$/.test(e) ? 'page' : e === 'pdf' ? 'pdf' : 'video';
}
export const isAbsPath = (p) => /^(?:~\/|\/)/.test(String(p || ''));
// session: the tmux session a relative path belongs to
export function fileUrl(path, session = '') {
  let p = String(path || '');
  if (!isAbsPath(p)) {
    if (!session) return '';
    return '/files-in/' + encodeURIComponent(session) + '/' + p.replace(/^\.\//, '').split('/').map(encodeURIComponent).join('/');
  }
  try { p = decodeURIComponent(p); } catch {}
  if (p.startsWith('~/')) p = '/~' + p.slice(1);
  return '/files' + p.split('/').map(encodeURIComponent).join('/');
}
// the media paths in a line of text, in order: absolute ones, plus relative ones when { relative: true }
export function mediaPathsIn(text, { relative = false } = {}) {
  return mediaSpansIn(text, { relative }).map((x) => x.path);
}
// [{ path, start, end }] (end exclusive), for links over a terminal row
export function mediaSpansIn(text, { relative = false } = {}) {
  const t = String(text || ''), out = [];
  for (const re of relative ? [PATH_RE, REL_RE] : [PATH_RE]) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(t))) {
      const start = m.index + m[0].length - m[1].length, end = start + m[1].length;
      re.lastIndex = Math.max(re.lastIndex, end);
      if (/[*?{}[\]]/.test(m[1])) continue;   // a glob ("raw/*.webm", "{a,b}.mp4") names no one file
      if (!out.some((o) => start < o.end && end > o.start)) out.push({ path: m[1], start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function mediaHtml(path, session = '') {
  const k = kindOf(path); if (!k) return '';
  const url = fileUrl(path, session); if (!url) return '';
  let name = String(path).split('/').pop(); try { name = decodeURIComponent(name); } catch {}
  const u = esc(url), n = esc(name);
  // a relative path the server cannot find (moved, or named before it was made) hides its tile instead of a broken picture
  if (k === 'image') return `<a class="rd-media" href="${u}" target="_blank" rel="noopener" title="${n} · open full size"><img src="${u}" alt="${n}" loading="lazy" onerror="this.parentNode.classList.add('rd-gone')"><span>${n}</span></a>`;
  const what = k === 'page' ? 'page' : k === 'pdf' ? 'PDF' : 'video';
  return `<a class="rd-file" href="${u}" target="_blank" rel="noopener" title="open in a new tab">${n} <em>· open ${what} ↗</em></a>`;
}
// several files side by side; the same file is shown once per reply (seen: a Set the caller keeps)
export function mediaRowHtml(paths, seen = new Set(), session = '') {
  const items = paths.filter((p) => kindOf(p) && !seen.has(p) && seen.add(p)).map((p) => mediaHtml(p, session)).filter(Boolean);
  return items.length ? `<div class="rd-media-row">${items.join('')}</div>` : '';
}
