// The last STATUS line of an agent's text and its claim part. Pure: the server (status-honesty.js re-exports both) and the reader
// (public/app.js: the play button speaks the STATUS, never the whole reply, owner 2026-11-28) share one parser.
export const unmark = (s) => String(s || '').replace(/[*`]+|(?<!\w)_+|_+(?!\w)/g, '');   // markdown marks out, snake_case ids kept

// pane-wrapped continuation rows joined -> { kind, text, line } or null
export function lastStatus(text) {
  const lines = String(text || '').split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (/^\W*STATUS:/i.test(l.trim())) at = i; });
  if (at < 0) return null;
  let line = lines[at].trim();
  for (let j = at + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]) && !/^\W*STATUS:/i.test(lines[j].trim()); j++) line += ' ' + lines[j].trim();
  const m = /^\W*STATUS:[*_`]*\s*([a-z][\w-]*(?: fully confirmed)?)\b[*_`]*\s*[:.—–-]*\s*(.*)$/i.exec(line);
  return m ? { kind: m[1].toLowerCase(), text: m[2].trim(), line } : null;
}
// The claim part of a done line: before the closing review / bugs / unverified segments (those list what was filed or not checked, by design).
export function headlineOf(statusText) {
  return unmark(statusText).split(/\s[·|;]\s*(?=closing[ -]review|bugs?\s*[:=]|unverified|leftovers?\b)|\bclosing[ -]review\s*[:=]|\bbugs?\s*[:=]/i)[0].trim();
}
// What the reader's play button reads: "Status: <word>. <first segment of the claim>", at most 300 characters; '' when there is no STATUS line.
export function spokenStatusOf(text) {
  const st = lastStatus(text);
  if (!st) return '';
  const head = headlineOf(st.text).split(/\s[·|]\s/)[0].replace(/\s+/g, ' ').trim().slice(0, 300);
  return `Status: ${st.kind}.${head ? ' ' + head : ''}`;
}
