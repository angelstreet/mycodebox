// Tiny markdown renderer used by the wake-brief surfaces (TASK-70 chat 2026-10-08).
// Covers: paragraphs, headings (#..######), unordered (-/*/+) and ordered (1.) lists,
// fenced code blocks (```), blockquotes (>), horizontal rules (---), tables (| col | col |),
// inline `code`, **bold**, *italic*, [text](url). All HTML-special chars are escaped first;
// this is safe to run on owner-provided text.
//
// Style: drop the output in <div class="mdbody">…</div> for the readable-prose look
// (paragraph spacing, code-block pill, inline-code tint).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function mdInline(t) {
  return esc(t)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function renderMd(src) {
  const lines = String(src).replace(/\t/g, '    ').split('\n');
  const out = [];
  let i = 0, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; } };
  const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      flush(); const code = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++; out.push(`<pre>${esc(code.join('\n'))}</pre>`); continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { flush(); out.push(`<div class="mdh h${Math.min(h[1].length, 4)}">${mdInline(h[2])}</div>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flush(); const head = row(l); i += 2; const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<div class="mdt"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>\s?/.test(l)) {
      flush(); const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${mdInline(q.join(' '))}</blockquote>`); continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) {
      flush();
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) { items.push({ d: Math.min(Math.floor(m[1].length / 2), 4), num: /\d/.test(m[2]), t: m[3] }); i++; }
        else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1].t += ' ' + lines[i].trim(); i++; }
        else break;
      }
      out.push(items.map((it) => `<li class="mdli d${it.d}${it.num ? ' num' : ''}">${mdInline(it.t)}</li>`).join(''));
      continue;
    }
    para.push(l);
    i++;
  }
  flush();
  return out.join('');
}