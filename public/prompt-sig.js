// Who wrote a prompt (owner 2026-11-22): the owner's own messages and the ones the AI side typed (manager agent, checks, the
// integration lane) look the same in the pane and in the session file. The server records each send with its actor; a prompt is
// matched to a send by the start of its text. Shared by the server (prompt-senders.js) and the dashboard (reader and terminal).
export const SIG_CHARS = 48;
export function promptSig(text) {
  // a long prompt is stored in the session file as <pasted_content id="…">text</pasted_content id="…">: match on the text inside
  return String(text || '').replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '').replace(/^\s*[❯>]\s?/, '').replace(/^\s*<pasted_content\b[^>]*>\s*/, '').replace(/\s+/g, ' ').trim().slice(0, SIG_CHARS).toLowerCase();
}
// Short label for an AI actor, shown on its prompt in the reader.
const LABELS = { 'manager-agent': 'manager', manager: 'manager', 'stop-answer': 'manager', harness: 'check', compaction: 'context summary', integration: 'integration lane', 'found-bugs': 'bug intake', 'lease-nudge': 'lease', 'quota-resume': 'quota', 'claude-accounts': 'accounts' };
export const senderLabel = (by) => LABELS[by] || String(by || 'AI');
// ai: [{ sig, by }] from /api/senders. -> the AI actor of the prompt, or null (the owner's, or not recorded: shown as the owner's).
// The dashboard's own checks open with a fixed phrase: recognised even when the send was never logged (before 2026-11-22).
const CHECK_RE = /^(?:goal check|done check|status check):/;
// Claude Code's own summary after a context compaction is typed as a user prompt: it is not the owner's (owner 2026-11-23)
const COMPACT_RE = /^this session is being continued from a previous\b/;   // the signature keeps 48 chars
export function aiSenderOf(text, ai = []) {
  const s = promptSig(text);
  if (s.length < 8) return null;
  if (CHECK_RE.test(s)) return 'harness';
  if (COMPACT_RE.test(s)) return 'compaction';
  for (const x of ai) if (x.sig && (s.startsWith(x.sig) || x.sig.startsWith(s))) return x.by;
  return null;
}
// An AI prompt this long starts folded in the reader to its first line (owner 2026-11-23: a summary or brief is not the
// conversation); a short one (a goal check, the lane's merge line) stays open.
export const FOLD_LINES = 4, FOLD_CHARS = 400;
export const foldsPrompt = (lines) => lines.length > FOLD_LINES || lines.join(' ').length > FOLD_CHARS;
