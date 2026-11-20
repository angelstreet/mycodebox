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

const strip = (s) => String(s).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<(command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, '').trim();
function blocks(content) { return typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []; }

// jsonl text -> markdown-ish text for the reader: "> prompt", the reply text, the progress updates the terminal shows ("updates" thinking),
// one `tool` line per tool call. Other thinking is never shown (the terminal does not show it either).
export function renderConversation(jsonl) {
  const out = [];
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }   // the first line of a tail may be cut
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta) continue;
    for (const b of blocks(o.message?.content)) {
      if (b.type === 'text') {
        const t = strip(b.text); if (!t) continue;
        out.push(o.type === 'user' ? t.split('\n').map((l) => `> ${l}`).join('\n') : t);
      } else if (b.type === 'thinking' && o.type === 'assistant' && o.thinkingDisplay === 'updates') {
        // "updates" mode: Claude Code prints these progress lines in the terminal (marked "· summary"), so the reader shows them too
        const t = strip(b.thinking || ''); if (t) out.push(`_${t.replace(/_/g, '\\_')}_`);
      } else if (b.type === 'tool_use' && o.type === 'assistant') {
        const arg = b.input && (b.input.command || b.input.file_path || b.input.pattern || b.input.description || b.input.prompt || b.input.url || '');
        out.push(`\`${b.name}${arg ? ' ' + String(arg).replace(/\s+/g, ' ').slice(0, 100) : ''}\``);
      }
    }
  }
  return out.join('\n\n');
}

export async function readConversation(file, maxBytes = TAIL_BYTES) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat(); const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start); await fh.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8'); if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return renderConversation(text);
  } finally { await fh.close(); }
}
