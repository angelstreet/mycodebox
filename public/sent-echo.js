// A phone keyboard can re-commit the composed text after the box was cleared (any time
// from a few ms to seconds later, often on the next keystroke). Returns what the box should
// hold: the value without the just-sent text when it comes back as a prefix, else unchanged.
export const ECHO_WINDOW_MS = 8000;

export function stripSentEcho(value, sent, sentAt, now, inputType = '') {
  if (!sent || !value || now - sentAt > ECHO_WINDOW_MS) return value;
  if (inputType.startsWith('insertFromPaste') || inputType.startsWith('insertFromDrop')) return value;
  return value.startsWith(sent) ? value.slice(sent.length) : value;
}
