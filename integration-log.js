// The format of <state>/integration/requests.jsonl, for its one writer (the lane) and every reader.
// A line is either a full request ({id, ...}) or the changes since the previous line of that request:
//   {of: <id>, set?: {key: value}, del?: [key], steps?: {at: <index>, items: [steps from that index on]}}
// Every save used to append the whole request with all step tails, so the file grew with the square of the steps (444 MB, 2026-11-28).
// Changes say `of`, never `id`: code from before this format skips them and still reads the last full line.
// A full line is written on the first save of a request by this process and on every change of state.
// Lines are only appended, never rewritten; the file must not be head-truncated (a change line needs its full line).
import fs from 'node:fs';
import path from 'node:path';

// lines: raw strings or parsed objects, in file order -> Map id -> latest request (insertion = first seen). Bad lines are skipped.
export function readRequests(lines) {
  const out = new Map();
  for (let l of lines) {
    if (typeof l === 'string') { try { l = JSON.parse(l); } catch { continue; } }
    if (l?.id) { out.set(l.id, l); continue; }
    const base = l?.of && out.get(l.of);
    if (!base) continue;
    const r = { ...base, ...l.set };
    for (const k of l.del || []) delete r[k];
    if (l.steps) r.steps = [...(base.steps || []).slice(0, l.steps.at), ...l.steps.items];
    out.set(l.of, r);
  }
  return out;
}

const shape = (r) => {
  const keys = new Map();
  for (const [k, v] of Object.entries(r)) { if (k === 'steps' && Array.isArray(v)) continue; const j = JSON.stringify(v); if (j !== undefined) keys.set(k, j); }
  return { keys, steps: Array.isArray(r.steps) ? r.steps.map((s) => JSON.stringify(s)) : null };
};

// -> the line to append for `r` given what was last written (null: nothing changed)
function encode(prev, next, r) {
  if (!prev || prev.keys.get('state') !== next.keys.get('state') || !prev.steps !== !next.steps) return JSON.stringify(r);
  const d = { of: r.id };
  const changed = [...next.keys].filter(([k, j]) => prev.keys.get(k) !== j);
  if (changed.length) d.set = Object.fromEntries(changed.map(([k, j]) => [k, JSON.parse(j)]));
  const gone = [...prev.keys.keys()].filter((k) => !next.keys.has(k));
  if (gone.length) d.del = gone;
  if (next.steps) {
    let at = 0; while (at < next.steps.length && prev.steps[at] === next.steps[at]) at++;
    if (at < next.steps.length || next.steps.length !== prev.steps.length) d.steps = { at, items: next.steps.slice(at).map((j) => JSON.parse(j)) };
  }
  return Object.keys(d).length > 1 ? JSON.stringify(d) : null;
}

// -> append(request); throws when the write fails.
export function createRequestWriter(file, { append = fs.appendFileSync } = {}) {
  const written = new Map();   // id -> shape of what the file holds
  let checkTail = true;        // a torn last line (crash, full disk) must not swallow the next one
  const torn = () => {
    let fd; try { fd = fs.openSync(file, 'r'); const n = fs.fstatSync(fd).size, b = Buffer.alloc(1); return n > 0 && fs.readSync(fd, b, 0, 1, n - 1) === 1 && b[0] !== 10; } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  return (r) => {
    const next = shape(r);
    const line = encode(written.get(r.id), next, r);
    if (line === null) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      append(file, `${checkTail && torn() ? '\n' : ''}${line}\n`, { mode: 0o600 });
    } catch (e) { written.delete(r.id); checkTail = true; throw e; }   // the next save of this request is a full line again
    checkTail = false;
    written.set(r.id, next);
  };
}
