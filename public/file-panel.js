// The file panel: a text file an agent named (file-links.js) opens beside the session, like Cursor / Claude Code (owner 2026-11-23).
// Desktop: a right-hand panel over the grid, expandable to full screen; phone: full screen. Buttons: copy the content, copy the path,
// full screen, open in a new tab (/view.html, same renderer), close. Markdown is rendered (md.js), anything else is shown as code
// with line numbers; "file:12-30" highlights and scrolls to those lines. Content from GET /api/file (file-view.js).
import { renderMd } from './md.js';
import { icon } from './icons.js';
import { copyText } from './copy-prompt.js';
import { linkFilePaths, linkMdFileLinks, viewUrl } from './file-links.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MD = /\.(md|markdown)$/i;
const fmtSize = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

// j: /api/file answer. line..line2: the lines to mark (0: none). Markdown with a line asked for is shown as code, so the line shows.
// paths inside the file link on to other files, resolved beside it first (base); "/home/u/x" is shown as "~/x"
export const shortPath = (p) => String(p || '').replace(/^\/home\/[^/]+\//, '~/');
const dirOf = (p) => String(p || '').replace(/\/[^/]*$/, '');
export function linkedBodyHtml(j, session, line = 0, line2 = 0) {
  return linkFilePaths(linkMdFileLinks(fileBodyHtml(j, line, line2), session, dirOf(j.path)), session, dirOf(j.path));
}
export function fileBodyHtml(j, line = 0, line2 = 0) {
  const cut = j.truncated ? `<div class="fv-note">first ${fmtSize(j.text.length)} of ${fmtSize(j.size)}</div>` : '';
  if (MD.test(j.name) && !line) return `${cut}<div class="mdbody fv-md">${renderMd(j.text)}</div>`;
  const last = line2 || line;
  const rows = j.text.replace(/\n$/, '').split('\n').map((l, i) => {
    const n = i + 1, on = line && n >= line && n <= last;
    return `<div class="fv-row${on ? ' on' : ''}" data-n="${n}"><span class="fv-ln">${n}</span><span class="fv-tx">${esc(l) || ' '}</span></div>`;
  }).join('');
  return `${cut}<div class="fv-code">${rows}</div>`;
}
export async function fetchFile(session, path, base = '') {
  const r = await fetch(`/api/file?s=${encodeURIComponent(session || '')}&p=${encodeURIComponent(path)}${base ? `&b=${encodeURIComponent(base)}` : ''}`);
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
export function headHtml({ name, path, standalone = false, full = false, tabUrl = '' }) {
  const b = (cls, ico, label) => `<button type="button" class="fv-btn ${cls}" aria-label="${label}" title="${label}">${icon(ico, 16)}</button>`;
  return `<div class="fv-head"><span class="fv-ico">${icon('file', 16)}</span><div class="fv-title"><b>${esc(name)}</b><span class="fv-path">${esc(shortPath(path))}</span></div>`
    + b('fv-copy', 'clipboard', 'Copy the content') + b('fv-copypath', 'link', 'Copy the path')
    + (standalone ? '' : b('fv-full', full ? 'shrink' : 'expand', full ? 'Back to the side panel' : 'Full screen')
      + `<a class="fv-btn fv-tab" href="${esc(tabUrl)}" target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab">${icon('external', 16)}</a>`
      + b('fv-close', 'x', 'Close'))
    + '</div>';
}
// copy buttons flash a check
export async function flashCopy(btn, text) {
  if (!(await copyText(text))) return;
  btn.innerHTML = icon('check', 16); btn.classList.add('done');
  setTimeout(() => { btn.innerHTML = icon(btn.classList.contains('fv-copy') ? 'clipboard' : 'link', 16); btn.classList.remove('done'); }, 1400);
}
export function scrollToLine(root, line) {
  const row = line && root.querySelector(`.fv-row[data-n="${line}"]`);
  if (row) row.scrollIntoView({ block: 'center' });
}

let panel = null, cur = null;
const isPhone = () => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 720px)').matches;
export const filePanelOpen = () => !!panel && !panel.hidden;
export function closeFilePanel() {
  if (!filePanelOpen()) return false;
  panel.hidden = true; document.body.classList.remove('fv-open'); cur = null;
  return true;
}
export async function openFilePanel({ session = '', path, line = 0, line2 = 0, base = '' }) {
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = 'filePanel'; panel.className = 'fv-panel'; panel.setAttribute('aria-label', 'File');
    document.body.appendChild(panel);
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('.fv-btn'); if (!btn || !cur) return;
      if (btn.classList.contains('fv-close')) closeFilePanel();
      else if (btn.classList.contains('fv-full')) { panel.classList.toggle('full'); paintHead(); }
      else if (btn.classList.contains('fv-copy') && cur.j) flashCopy(btn, cur.j.text);
      else if (btn.classList.contains('fv-copypath')) flashCopy(btn, cur.j?.path || cur.path);
    });
  }
  if (isPhone()) panel.classList.add('full');
  cur = { session, path, line, line2, base, j: null };
  panel.hidden = false; document.body.classList.add('fv-open');
  const me = cur;
  paintHead();
  panel.querySelector('.fv-body').innerHTML = '<div class="fv-note">loading…</div>';
  try {
    const j = await fetchFile(session, path, base);
    if (cur !== me) return;
    me.j = j; paintHead();
    const body = panel.querySelector('.fv-body');
    body.innerHTML = linkedBodyHtml(j, session, line, line2); body.scrollTop = 0;
    scrollToLine(body, line);
  } catch (err) {
    if (cur === me) panel.querySelector('.fv-body').innerHTML = `<div class="fv-note fv-err">${esc(err.message)}</div>`;
  }
}
function paintHead() {
  const c = cur; if (!c) return;
  const html = headHtml({ name: c.j?.name || c.path.split('/').pop(), path: c.j?.path || c.path, full: panel.classList.contains('full'), tabUrl: viewUrl(c.session, c.j?.path || c.path, c.line) });
  let head = panel.querySelector('.fv-head');
  if (!head) { panel.innerHTML = html + '<div class="fv-body"></div>'; return; }
  head.outerHTML = html;
}
