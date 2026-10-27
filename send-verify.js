// A dashboard send types the text into the agent's prompt (tmux paste) and presses Enter. Claude Code handles a paste asynchronously: a path
// to an image file (every uploaded screenshot) is turned into an `[Image #n]` attachment, a long paste becomes `[Pasted text ...]`, and an
// Enter that arrives meanwhile is swallowed: the text just sits in the prompt and the owner presses send a second time. Reproduced with a
// Haiku probe session: 3 of 6 messages naming a .png stayed as drafts, 0 of 12 without. So after the Enter, look at the prompt; if our text
// (or a paste placeholder) is still there, press Enter again, a few times, never blocking the HTTP reply.

// Is `draft` (what the prompt holds now) what we just typed? The start of our text, or one of the agent's paste placeholders.
export function isOurDraft(draft, text) {
  const d = String(draft || '').replace(/\s+/g, ' ').trim();
  if (!d) return false;
  if (/\[(?:Image #\d+|Pasted text)/.test(d)) return true;
  const sig = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 18);
  return sig.length > 0 && d.includes(sig);
}

// deps: draftNow() -> the prompt's current draft (string|null), pressEnter() -> Promise, sleep(ms) -> Promise, onRetry(n)
// -> the number of extra Enters pressed.
export async function verifyDelivered({ text, draftNow, pressEnter, sleep, onRetry = () => {}, retries = 3, waitMs = 650 }) {
  let pressed = 0;
  for (let i = 0; i < retries; i++) {
    await sleep(waitMs);
    if (!isOurDraft(await draftNow(), text)) return pressed;
    pressed++; onRetry(pressed);
    await pressEnter();
  }
  return pressed;
}

// Chunked-paste race (2026-10-27): tmux feeds a long paste to the TUI in ~165-char chunks, and an Enter right after the last chunk can land
// while the TUI is still flushing it, so the text stays in the composer. Before the Enter, wait until the pane has stopped changing.
export const pasteChunks = (text) => Math.max(1, Math.ceil(String(text || '').length / 165));
export const settleBudgetMs = (text) => Math.min(8000, 400 + pasteChunks(text) * 300);

// deps: capture() -> pane text, sleep(ms), now() -> ms. Resolves true when the pane was unchanged for quietMs, false at the budget.
export async function waitSettled({ capture, sleep, now = Date.now, budgetMs, quietMs = 250, pollMs = 100 }) {
  const t0 = now();
  let last = null, since = t0;
  for (;;) {
    let cur; try { cur = await capture(); } catch { return false; }
    const t = now();
    if (cur !== last) { last = cur; since = t; }
    else if (t - since >= quietMs) return true;
    if (t - t0 >= budgetMs) return false;
    await sleep(pollMs);
  }
}

// Like verifyDelivered, but awaited and honest: { pressed, submitted }. submitted is false when our text is still in the prompt after
// the last retry; null when the prompt could not be read.
export async function confirmDelivered({ text, draftNow, pressEnter, sleep, onRetry = () => {}, retries = 1, waitMs = 650 }) {
  let pressed = 0;
  for (let i = 0; i <= retries; i++) {
    await sleep(waitMs);
    const d = await draftNow();
    if (d === null) return { pressed, submitted: null };
    if (!isOurDraft(d, text)) return { pressed, submitted: true };
    if (i === retries) break;
    pressed++; onRetry(pressed);
    await pressEnter();
  }
  return { pressed, submitted: false };
}
