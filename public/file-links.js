// File paths an agent names become links that open the file panel (owner 2026-11-23: "in Cursor or Claude Code I can click a file
// to read it"). Pure: used by the reader (linkFilePaths over its HTML), the terminal (term-links.js) and the tests.
// A path with a folder ("docs/X.md", "~/a/b.py", "/home/u/x.txt") is a link anywhere; a bare name ("server.js") inside a code span,
// and in prose too unless its extension is also a word or a library name ("Node.js", "Vue.js"): INVENTORY.md, notes.txt are links. ":12" / ":12-30" after it is the line, "#anchor" is dropped.
// Pictures, videos and pages keep their own tiles (media-links.js); this is the text side.
const EXT = 'md|markdown|txt|rst|js|mjs|cjs|ts|tsx|jsx|py|json|jsonl|ya?ml|sh|bash|zsh|css|scss|less|toml|sql|go|rs|java|kt|c|h|cc|cpp|hpp|rb|ini|cfg|conf|csv|tsv|log|xml|vue|svelte|lua|php|swift|r|tex|diff|patch|service';
const NAMES = 'Makefile|Dockerfile|README|LICENSE|Procfile|Caddyfile|Justfile';
const TAIL = `(?:\\.(?:${EXT})|(?<=/)(?:${NAMES}))(?::(\\d+)(?:-(\\d+))?)?(?:#[\\w-]+)?(?=$|[\\s\`'"),;:│&<]|\\.(?:\\s|$|&|<))`;
// before: start, space, quote, bracket, backtick, a table border, or the ";" that ends an escaped quote (&quot;)
const PRE = `(?:^|(?<=[\\s\`'"(\\[│;>]))`;
const WITH_DIR = new RegExp(`${PRE}((?:~|\\.{1,2})?/?(?:[\\w@+.-]+/)+[\\w@+.-]*?)${TAIL}`, 'g');
const BARE = new RegExp(`${PRE}([\\w@+-][\\w@+.-]*?)${TAIL}`, 'g');
// a bare name in prose: not the extensions that are also words or library names ("Node.js", "Vue.js", "R", "C")
const PROSE_EXT = EXT.split('|').filter((e) => !/^(js|mjs|cjs|ts|tsx|jsx|r|c|h|cc|go|conf|cfg|log|diff|patch)$/.test(e)).join('|');
const BARE_PROSE = new RegExp(`${PRE}([\\w@+-][\\w@+.-]*?)${TAIL.replace(EXT, PROSE_EXT)}`, 'g');
const ABS_OK = /^(?:~\/|\/(?:home|tmp)\/)/;

// [{ path, line, end2, start, end }]: path without :line / #anchor; start..end covers the whole match (for the link's extent)
export function filePathSpans(text, { bare = false } = {}) {
  const t = String(text || ''), out = [];
  for (const re of [WITH_DIR, bare ? BARE : BARE_PROSE]) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(t))) {
      const whole = m[0], start = m.index, end = start + whole.length;
      if (!whole) { re.lastIndex++; continue; }
      const path = whole.replace(/#[\w-]+$/, '').replace(/:\d+(?:-\d+)?$/, '');
      if (path.startsWith('/') && !ABS_OK.test(path)) continue;   // /etc, /usr: not served, no dead link
      if (/^\.?\/|\/\//.test(path) && !path.startsWith('./') && !path.startsWith('/')) continue;
      if (/^\d+(?:\.\d+)+$/.test(path.replace(/\.[a-z]+$/i, ''))) continue;   // "1.2.3.md"-like versions
      if (!out.some((o) => start < o.end && end > o.start)) out.push({ path, line: m[2] ? Number(m[2]) : 0, line2: m[3] ? Number(m[3]) : 0, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const attr = (s) => String(s).replace(/&(?!(?:amp|lt|gt|quot|#39);)/g, '&amp;').replace(/"/g, '&quot;');
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
export function viewUrl(session, path, line = 0, base = '') {
  return `/view.html?s=${encodeURIComponent(session || '')}&p=${encodeURIComponent(path)}${line ? `&l=${line}` : ''}${base ? `&b=${encodeURIComponent(base)}` : ''}`;
}
const pathAttrs = (session, p, line, line2, base) => `class="rd-path" href="${attr(viewUrl(session, p, line, base))}" target="_blank" rel="noopener" data-p="${attr(p)}"`
  + `${line ? ` data-l="${line}"${line2 ? ` data-l2="${line2}"` : ''}` : ''}${base ? ` data-b="${attr(base)}"` : ''} title="open ${attr(p)}"`;
// markdown links to files ("[GAPS.md](GAPS.md)", "[x](../a/b.py#L3)") in rendered markdown text (md.js links only http)
export function linkMdFileLinks(html, session = '', base = '') {
  return String(html || '').replace(/\[([^\]<]+)\]\(((?!https?:|mailto:|#)[^)\s<]+)\)/g, (all, text, target) => {
    const t = target.replace(/#.*$/, ''), [, p, l] = /^(.*?)(?::(\d+))?$/.exec(t);
    return p && filePathSpans(p, { bare: true }).length ? `<a ${pathAttrs(session, unesc(p), Number(l) || 0, 0, base)}>${text}</a>` : all;
  });
}
// html: already-escaped reader HTML. Wraps file paths in text (not inside <a>, <button> or a tag) in <a class="rd-path">.
export function linkFilePaths(html, session = '', base = '') {
  const parts = String(html || '').split(/(<[^>]*>)/);
  let inA = 0, inCode = 0;
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (i % 2) {   // a tag
      const m = /^<(\/?)(a|button|code|select|textarea)\b/i.exec(s);
      if (m) { const d = m[1] ? -1 : 1; if (/code/i.test(m[2])) inCode = Math.max(0, inCode + d); else inA = Math.max(0, inA + d); }
      continue;
    }
    if (inA || !s) continue;
    const spans = filePathSpans(s, { bare: inCode > 0 });
    if (!spans.length) continue;
    let out = '', at = 0;
    for (const x of spans) {
      const p = unesc(x.path);
      out += s.slice(at, x.start) + `<a ${pathAttrs(session, p, x.line, x.line2, base)}>${s.slice(x.start, x.end)}</a>`;
      at = x.end;
    }
    parts[i] = out + s.slice(at);
  }
  return parts.join('');
}

// Plain http(s) URLs in the reader (owner 2026-11-23: on the phone the reader is the view, and its links were plain text; the
// terminal links them in term-links.js). html is escaped: the URL stops at a tag, a space or an escaped quote / bracket, and
// closing punctuation of the sentence ("see https://x/.", "(https://x/)") stays outside the link.
const URL_RE = /https?:\/\/(?:(?!&(?:quot|#39|lt|gt);)[^\s<>"'`│|])+/g;
export function linkUrls(html) {
  const parts = String(html || '').split(/(<[^>]*>)/);
  let inA = 0;
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (i % 2) { const m = /^<(\/?)(a|button|select|textarea)\b/i.exec(s); if (m) inA = Math.max(0, inA + (m[1] ? -1 : 1)); continue; }
    if (inA || !s || !s.includes('http')) continue;
    parts[i] = s.replace(URL_RE, (u) => {
      let url = u.replace(/[.,;:!?*]+$/, '');
      while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
      while (/&amp;$/.test(url)) url = url.slice(0, -5);
      return `<a class="rd-url" href="${attr(url)}" target="_blank" rel="noopener">${url}</a>${u.slice(url.length)}`;
    });
  }
  return parts.join('');
}
