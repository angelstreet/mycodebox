// Who wrote a prompt (owner 2026-11-22): the owner's own messages and the ones the AI side typed (manager agent, checks, the
// integration lane) look the same in the pane and in the session file. The server records each send with its actor; a prompt is
// matched to a send by the start of its text. Shared by the server (prompt-senders.js) and the dashboard (reader and terminal).
export const SIG_CHARS = 48;
export function promptSig(text) {
  return String(text || '').replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '').replace(/^\s*[❯>]\s?/, '').replace(/\s+/g, ' ').trim().slice(0, SIG_CHARS).toLowerCase();
}
// Short label for an AI actor, shown on its prompt in the reader.
const LABELS = { 'manager-agent': 'manager', manager: 'manager', 'stop-answer': 'manager', harness: 'check', integration: 'integration lane', 'found-bugs': 'bug intake', 'lease-nudge': 'lease', 'quota-resume': 'quota', 'claude-accounts': 'accounts' };
export const senderLabel = (by) => LABELS[by] || String(by || 'AI');
// ai: [{ sig, by }] from /api/senders. -> the AI actor of the prompt, or null (the owner's, or not recorded: shown as the owner's).
// The dashboard's own checks open with a fixed phrase: recognised even when the send was never logged (before 2026-11-22).
const CHECK_RE = /^(?:goal check|done check):/;
export function aiSenderOf(text, ai = []) {
  const s = promptSig(text);
  if (s.length < 8) return null;
  if (CHECK_RE.test(s)) return 'harness';
  for (const x of ai) if (x.sig && (s.startsWith(x.sig) || x.sig.startsWith(s))) return x.by;
  return null;
}
