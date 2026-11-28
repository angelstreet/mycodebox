// Test / retest loop detector (owner 2026-11-28): a session that runs the same command (or sends the same prompt) again and again
// burns its whole context each time. Reads the Claude transcripts of the last windowH hours: Bash tool_use commands and user prompts,
// normalised (numbers, hashes and ids collapsed), counted per session. Pure core (loopsOf) + a cached file scanner (scanLoops).
import { promises as fs, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';

export const LOOP_DEFAULTS = { windowH: 48, minCommand: 8, minPrompt: 4, minLen: 12, top: 3 };
const WAITISH = /(\bwait\b|\bsleep\b|\buntil\b|\bpoll|\bstatus\b|\bwatch\b|manager-wait)/i;
const TESTISH = /\b(test|tests|pytest|jest|vitest|mocha|playwright|tsc|typecheck|lint|build|ci)\b/i;

export function normalise(s) {
  return String(s).replace(/\s+/g, ' ').trim().replace(/[0-9a-f]{12,}/gi, 'H').replace(/\d+/g, 'N').slice(0, 200);
}

// items: [{ kind: 'command'|'prompt', text }] of one session -> findings
export function loopsOf(items, o = {}) {
  const c = { ...LOOP_DEFAULTS, ...o }, counts = new Map();
  for (const it of items) {
    const raw = String(it.text || '').trim();
    if (raw.length < c.minLen) continue;
    const k = `${it.kind}|${normalise(raw)}`;
    const e = counts.get(k) || { kind: it.kind, count: 0, sample: raw.slice(0, 160) };
    e.count++; counts.set(k, e);
  }
  const out = [];
  for (const e of counts.values()) {
    if (e.kind === 'command' && e.count >= c.minCommand) out.push({ kind: TESTISH.test(e.sample) ? 'test-loop' : WAITISH.test(e.sample) ? 'wait-loop' : 'command-loop', count: e.count, sample: e.sample });
    if (e.kind === 'prompt' && e.count >= c.minPrompt) out.push({ kind: 'prompt-repeat', count: e.count, sample: e.sample });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, c.top);
}

// One transcript line -> items. Only lines that can hold a Bash call or a typed user prompt are parsed.
// withAt: also carry the line's time (ms) as `at`, so a cached file can be re-cut when the window moves.
export function itemsOfLine(line, sinceMs = 0, withAt = false) {
  const isTool = line.includes('"name":"Bash"'), isUser = line.includes('"role":"user"');
  if (!isTool && !isUser) return [];
  let o; try { o = JSON.parse(line); } catch { return []; }
  if (sinceMs && o.timestamp && Date.parse(o.timestamp) < sinceMs) return [];
  const content = o?.message?.content, out = [], at = withAt && o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (o?.message?.role === 'assistant' && Array.isArray(content)) {
    for (const b of content) if (b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string') out.push({ kind: 'command', text: b.input.command });
  } else if (o?.message?.role === 'user' && !o.isMeta && !o.toolUseResult) {
    const t = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : '';
    if (t && !t.startsWith('<') && !t.startsWith('[SYSTEM')) out.push({ kind: 'prompt', text: t });
  }
  if (Number.isFinite(at)) for (const it of out) it.at = at;
  return out;
}

async function* files(dir, sinceMs) {
  let ents = [];
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p, sinceMs);
    else if (e.name.endsWith('.jsonl')) { try { const st = await fs.stat(p); if (st.mtimeMs >= sinceMs) yield { p, size: st.size, mtime: st.mtimeMs }; } catch { /* gone */ } }
  }
}

// Scans claudeDir; per-file results are cached by size+mtime so a repeat pass only re-reads files that grew. Cached items keep their
// time and are cut to the current window on every pass: a file that stopped growing (a finished session) must not keep counting
// commands older than windowH hours until its mtime ages out (token audit re-measure 2026-11-28).
export function createLoopScanner({ claudeDir, now = () => Date.now(), opts = {} }) {
  const cache = new Map();
  return async function scan() {
    const c = { ...LOOP_DEFAULTS, ...opts }, since = now() - c.windowH * 3600e3, bySession = new Map();
    for await (const f of files(claudeDir, since)) {
      let items;
      const hit = cache.get(f.p);
      if (hit && hit.size === f.size && hit.mtime === f.mtime) items = hit.items;
      else {
        items = [];
        const rl = createInterface({ input: createReadStream(f.p, { encoding: 'utf8' }), crlfDelay: Infinity });
        for await (const l of rl) for (const it of itemsOfLine(l, since, true)) items.push(it);
        cache.set(f.p, { size: f.size, mtime: f.mtime, items });
      }
      items = items.filter((it) => !(it.at < since));
      // subagent transcripts live in <session>/subagents/*.jsonl: they belong to their parent session
      const parts = f.p.split('/'), sid = parts.includes('subagents') ? parts[parts.indexOf('subagents') - 1] : basename(f.p, '.jsonl');
      (bySession.get(sid) || bySession.set(sid, []).get(sid)).push(...items);
    }
    const out = [];
    for (const [session, items] of bySession) for (const l of loopsOf(items, c)) out.push({ session, ...l });
    return out.sort((a, b) => b.count - a.count);
  };
}
