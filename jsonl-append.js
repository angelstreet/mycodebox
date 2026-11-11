// JSON-safe append of one record to a JSONL ledger (manager-actions.jsonl had hand-appended invalid lines, review 2026-11-11 item 7).
// Accepts an object or one JSON text; refuses anything that would not be exactly one valid JSON object line.
import { appendFileSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';

export function oneJsonLine(rec) {
  let obj = rec;
  if (typeof rec === 'string') { try { obj = JSON.parse(rec); } catch (e) { throw new Error(`not valid JSON: ${e.message}`); } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('a ledger line must be a JSON object');
  const line = JSON.stringify(obj);
  if (line.includes('\n')) throw new Error('line contains a newline');
  return line;
}

// Appends `line\n`; if the file does not end in a newline (a torn hand write) a newline goes first, so the new line stays its own.
export function appendJsonLine(file, rec, { fs = { appendFileSync, statSync, openSync, readSync, closeSync } } = {}) {
  const line = oneJsonLine(rec);
  let prefix = '';
  try {
    const size = fs.statSync(file).size;
    if (size > 0) { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); if (b[0] !== 10) prefix = '\n'; } finally { fs.closeSync(fd); } }
  } catch { /* new file */ }
  fs.appendFileSync(file, `${prefix}${line}\n`);
  return line;
}
