// Per session, the recent prompts the AI side typed (every send that is not the owner's), so the dashboard can tell them from the owner's
// own messages (owner 2026-11-22). Fed by logSend; seeded at boot from the tail of stalls.jsonl, where every send is logged with its actor.
import { open, stat } from 'node:fs/promises';
import { promptSig } from './public/prompt-sig.js';

const OWNER = new Set(['owner', '', undefined, null]);
export function createPromptSenders({ max = 300 } = {}) {
  const by = new Map();   // session -> [{ sig, by }] newest last
  function note(session, actor, text) {
    if (OWNER.has(actor) || typeof text !== 'string') return;
    const sig = promptSig(text);
    if (sig.length < 8) return;
    const l = by.get(session) || [];
    l.push({ sig, by: actor });
    if (l.length > max) l.splice(0, l.length - max);
    by.set(session, l);
  }
  const of = (session) => by.get(session) || [];
  // the last `bytes` of the log: a send line is {"type":"send","session":..,"by":..,"text":..}
  async function seed(file, bytes = 8 * 1024 * 1024) {
    let fh;
    try {
      const { size } = await stat(file);
      fh = await open(file, 'r');
      const start = Math.max(0, size - bytes), buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.includes('"type":"send"') || !line.includes('"text"')) continue;
        try { const o = JSON.parse(line); note(o.session, o.by, o.text); } catch { /* a cut first line */ }
      }
    } catch { /* no log yet */ } finally { await fh?.close().catch(() => {}); }
  }
  return { note, of, seed };
}
