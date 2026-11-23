// The conversation of a Claude Code session, read from its own session file (<config dir>/projects/<project>/<session id>.jsonl).
// A session in tmux's alternate screen (Claude Code fullscreen) has no scrollback, so the dashboard reader had one screenful. This text
// is loaded once into the card and scrolled locally: no request per scroll step.
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync } from 'node:fs';

export const TAIL_BYTES = 3 * 1024 * 1024;   // the newest ~3 MB of the file: the whole of most sessions, the recent part of a long one
const ID_RE = /^[0-9a-f-]{8,64}$/i;

// -> absolute path of <id>.jsonl under one of the roots (each holds project dirs), or null
export async function findSessionFile(id, roots = defaultRoots()) {
  if (!ID_RE.test(String(id || ''))) return null;
  for (const root of roots) {
    let dirs; try { dirs = await fsp.readdir(root); } catch { continue; }
    for (const d of dirs) { const f = join(root, d, `${id}.jsonl`); try { await fsp.access(f); return f; } catch { /* next */ } }
  }
  return null;
}
export function defaultRoots(home = homedir()) { return [join(home, '.claude', 'projects'), ...accountRoots(home)]; }
function accountRoots(home) { try { return readdirSync(join(home, '.claude-accounts')).map((a) => join(home, '.claude-accounts', a, 'projects')); } catch { return []; } }

// harness notices are not the owner's words: a <task-notification> or <system-reminder> in a user turn is dropped, never shown as "You"
const strip = (s) => String(s).replace(/<(system-reminder|task-notification|cross-session-message)[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<(command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, '').trim();
function blocks(content) { return typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []; }

// One session-file record -> the reader's text pieces: "> prompt" (also a prompt sent while the agent worked: a queued_command attachment),
// the reply text, the progress updates the terminal shows ("updates" thinking, marked "· summary"), one `tool` line per tool call.
// Other thinking is never shown (the terminal does not show it either).
export function renderRecord(o) {
  const out = [];
  if (!o || o.isSidechain || o.isMeta) return out;
  if (o.type === 'attachment' && o.attachment?.type === 'queued_command' && typeof o.attachment.prompt === 'string') {
    const t = strip(o.attachment.prompt); if (t) out.push(t.split('\n').map((l) => `> ${l}`).join('\n'));
    return out;
  }
  if (o.type !== 'user' && o.type !== 'assistant') return out;
  for (const b of blocks(o.message?.content)) {
    if (b.type === 'text') {
      const t = strip(b.text); if (!t) continue;
      out.push(o.type === 'user' ? t.split('\n').map((l) => `> ${l}`).join('\n') : t);
    } else if (b.type === 'thinking' && o.type === 'assistant' && o.thinkingDisplay === 'updates') {
      const t = strip(b.thinking || ''); if (t) out.push(`${t} · summary`);
    } else if (b.type === 'tool_use' && o.type === 'assistant') {
      const arg = b.input && (b.input.command || b.input.file_path || b.input.pattern || b.input.description || b.input.prompt || b.input.url || '');
      out.push(`\`${b.name}${arg ? ' ' + String(arg).replace(/\s+/g, ' ').slice(0, 100) : ''}\``);
      // a file sent to the owner (a picture, a mockup): one ![](path) line each, shown inline by the reader (media-links.js)
      if (b.name === 'SendUserFile' && Array.isArray(b.input?.files)) {
        const f = b.input.files.filter((x) => typeof x === 'string' && x.startsWith('/'));
        if (f.length) out.push(f.map((x) => `![](${x.replace(/[()\s]/g, encodeURIComponent)})`).join('\n'));
      }
    }
  }
  return out;
}
// A cheap look before JSON.parse: tool results (screenshots, file dumps) are most of a session file's bytes and never shown.
const worth = (line) => line.includes('"queued_command"') || line.includes('"type":"assistant"') || (line.includes('"type":"user"') && !line.includes('"tool_result"'));

export function renderConversation(jsonl) {
  const out = [];
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim() || !worth(line)) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    out.push(...renderRecord(o));
  }
  return out.join('\n\n');
}

export const MAX_CHARS = 200_000;          // enough conversation for a long scroll back
// ?max=N on /api/transcript: 0 (everything) when absent or not a number, else N kept between 5 000 and MAX_CHARS
export const tailChars = (raw) => { const n = Number(raw) || 0; return n > 0 ? Math.min(MAX_CHARS, Math.max(5000, Math.round(n))) : 0; };
export const MAX_SCAN = 96 * 1024 * 1024;  // never read more than this from the end of the file
const CHUNK = 4 * 1024 * 1024;
// The newest part of the conversation: the file is read backwards in chunks until MAX_CHARS of text are found (a session file is mostly
// tool output: 3 MB from the end held 2 kB of conversation in a 20 MB file) or MAX_SCAN bytes were read.
export async function readConversation(file, { maxChars = MAX_CHARS, maxScan = MAX_SCAN } = {}) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    let pos = size, carry = Buffer.alloc(0), chars = 0;
    const pieces = [];   // newest first
    while (pos > 0 && size - pos < maxScan && chars < maxChars) {
      const start = Math.max(0, pos - CHUNK);
      const buf = Buffer.alloc(pos - start); await fh.read(buf, 0, buf.length, start);
      let data = Buffer.concat([buf, carry]);
      let nl = start > 0 ? data.indexOf(0x0a) : -1;   // the first line may continue in the previous chunk
      carry = nl >= 0 ? data.subarray(0, nl) : Buffer.alloc(0);
      const lines = data.subarray(nl + 1).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && chars < maxChars; i--) {
        const line = lines[i];
        if (!line || !worth(line)) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const r = renderRecord(o);
        for (let k = r.length - 1; k >= 0; k--) { pieces.push(r[k]); chars += r[k].length + 2; }
      }
      pos = start;
    }
    return pieces.reverse().join('\n\n');
  } finally { await fh.close(); }
}
