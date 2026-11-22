// Pictures and mockups in the reader (owner 2026-11-22: "from codebox wherever I am I can see html mockups and images").
// A file an agent sent (SendUserFile -> a "![](path)" line, conversation.js) or an absolute path it wrote in its reply is served by
// the dashboard at /files/<path> (files-route.js): a picture shows inline (click: full size in a new tab), a page / PDF / video
// gets an "open" link that opens it in a new tab. Pure: shared by the reader and the tests.
export const MEDIA_LINE = /^!\[[^\]]*\]\(([^)\s]+)\)$/;
const EXT = /\.(png|jpe?g|gif|webp|svg|html?|pdf|mp4|webm)$/i;
const PATH_RE = /(?:^|[\s`'"(@])((?:~|\/(?:home|tmp))\/[^\s`'"()<>]+?\.(?:png|jpe?g|gif|webp|svg|html?|pdf|mp4|webm))(?=$|[\s`'"),;:]|\.(?:\s|$))/gi;

export function kindOf(path) {
  const m = EXT.exec(String(path || '')); if (!m) return null;
  const e = m[1].toLowerCase();
  return /^(png|jpe?g|gif|webp|svg)$/.test(e) ? 'image' : /^html?$/.test(e) ? 'page' : e === 'pdf' ? 'pdf' : 'video';
}
export function fileUrl(path) {
  let p = String(path || '');
  try { p = decodeURIComponent(p); } catch {}
  if (p.startsWith('~/')) p = '/~' + p.slice(1);
  return '/files' + p.split('/').map(encodeURIComponent).join('/');
}
// the absolute paths of media files in a line of text, in order
export function mediaPathsIn(text) {
  const out = []; let m; PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(String(text || '')))) out.push(m[1]);
  return out;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function mediaHtml(path) {
  const k = kindOf(path); if (!k) return '';
  let name = String(path).split('/').pop(); try { name = decodeURIComponent(name); } catch {}
  const u = esc(fileUrl(path)), n = esc(name);
  if (k === 'image') return `<a class="rd-media" href="${u}" target="_blank" rel="noopener" title="${n} · open full size"><img src="${u}" alt="${n}" loading="lazy"><span>${n}</span></a>`;
  const what = k === 'page' ? 'page' : k === 'pdf' ? 'PDF' : 'video';
  return `<a class="rd-file" href="${u}" target="_blank" rel="noopener" title="open in a new tab">${n} <em>· open ${what} ↗</em></a>`;
}
// several files side by side; the same file is shown once per reply (seen: a Set the caller keeps)
export function mediaRowHtml(paths, seen = new Set()) {
  const items = paths.filter((p) => kindOf(p) && !seen.has(p) && seen.add(p)).map(mediaHtml);
  return items.length ? `<div class="rd-media-row">${items.join('')}</div>` : '';
}
