// Copy icon on every agent-prompt surface (.mdbody). One tap copies the raw markdown
// to the clipboard so the owner can paste a long answer, an owner-ask, or a task
// document into chat / email / a notes app. The raw source travels on a data-copy
// attribute on the button itself, so the same widget works for the answer popup
// question, the multi-question block, the owner-asks popover, and the task doc
// (mounted in their respective mdbody / mdbar; see ask-popup.js + app.js). On a
// successful copy the icon swaps to a check for 1.5s, then reverts. A single
// delegated click listener is attached on first wireCopyPrompt() and catches
// every current and future .copy-prompt — no per-render wiring needed.

import { icon } from './icons.js';

const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Returns the button HTML. Pass the raw markdown the user wants to copy; the
// wireCopyPrompt() handler reads it back from the data-copy attribute.
export function copyPromptButtonHtml({ text, label = 'Copy' } = {}) {
  return `<button type="button" class="copy-prompt" data-copy="${escAttr(text || '')}" aria-label="${escAttr(label)}" title="${escAttr(label)}"><span class="copy-prompt-ico">${icon('clipboard', 14)}</span></button>`;
}

let wired = false;
// Idempotent: safe to call from every render path. Uses a single document-level
// delegated listener so dynamically created .copy-prompt buttons are picked up
// without a re-wire. No-op outside the browser (the module is also imported
// from node tests, which run without a DOM).
export function wireCopyPrompt() {
  if (wired) return;
  wired = true;
  if (typeof document === 'undefined') return;
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy-prompt');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();   // a click on the button must not bubble into the popup's / popover's own click handlers
    const text = btn.dataset.copy || '';
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) return;
    const ico = btn.querySelector('.copy-prompt-ico');
    if (ico) {
      ico.innerHTML = icon('check', 14);
      btn.classList.add('done');
      setTimeout(() => {
        if (!ico.isConnected) return;
        ico.innerHTML = icon('clipboard', 14);
        btn.classList.remove('done');
      }, 1500);
    }
  });
}

// navigator.clipboard first (modern, async, no DOM mutation). Fall back to the
// deprecated but still-widely-supported document.execCommand('copy') in an
// off-screen textarea for insecure contexts and old browsers. Returns true on
// success.
export async function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}
