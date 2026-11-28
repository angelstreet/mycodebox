// The last STATUS line of an agent's text and its claim part. Pure, no DOM: status-honesty.js re-exports both (one parser). The reader's
// play button reads the agent's Summary: lines only (public/reader-summary.js), never the STATUS line.
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
