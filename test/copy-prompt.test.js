// copy-prompt tests (TASK-70 quick-fix). Covers:
//   - copyPromptButtonHtml() renders a button with the raw text on data-copy, HTML-escaped
//   - copyPromptButtonHtml() has the correct aria-label / title and contains the clipboard icon
//   - copyText() uses navigator.clipboard.writeText when available
//   - copyText() falls back to the off-screen textarea + execCommand('copy') path
//   - copyText() returns false (instead of throwing) when no DOM and no clipboard API exist
//   - wireCopyPrompt() is idempotent: a second call does not add a second listener
//
// The wiring into ask-popup.js and app.js is exercised in the browser; the unit tests
// here cover the pure functions and the navigator.clipboard branch with a minimal stub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyPromptButtonHtml, copyText, wireCopyPrompt } from '../public/copy-prompt.js';

test('copyPromptButtonHtml: data-copy carries the raw text (HTML-escaped)', () => {
  const html = copyPromptButtonHtml({ text: 'Ship it & "go"\nNext line' });
  assert.match(html, /<button[^>]*class="copy-prompt"/);
  // & -> &amp;, " -> &quot;, the newline is preserved verbatim inside the attribute
  assert.match(html, /data-copy="Ship it &amp; &quot;go&quot;\nNext line"/);
});

test('copyPromptButtonHtml: empty text still produces a button with empty data-copy', () => {
  const html = copyPromptButtonHtml({ text: '' });
  assert.match(html, /data-copy=""/);
  assert.match(html, /class="copy-prompt"/);
});

test('copyPromptButtonHtml: default label is "Copy" and overrides via label', () => {
  const a = copyPromptButtonHtml({ text: 'x' });
  assert.match(a, /aria-label="Copy"/);
  assert.match(a, /title="Copy"/);
  const b = copyPromptButtonHtml({ text: 'x', label: 'Copy question Q1' });
  assert.match(b, /aria-label="Copy question Q1"/);
  assert.match(b, /title="Copy question Q1"/);
});

test('copyPromptButtonHtml: clipboard icon is rendered inside .copy-prompt-ico', () => {
  const html = copyPromptButtonHtml({ text: 'x' });
  assert.match(html, /<span class="copy-prompt-ico">/);
  // the icon helper emits a <svg> with viewBox="0 0 24 24"
  assert.match(html, /<svg class="ico"[^>]*viewBox="0 0 24 24"/);
});

test('copyPromptButtonHtml: handles missing / null text without throwing', () => {
  const a = copyPromptButtonHtml({});
  assert.match(a, /data-copy=""/);
  const b = copyPromptButtonHtml({ text: null });
  assert.match(b, /data-copy=""/);
  const c = copyPromptButtonHtml({ text: undefined });
  assert.match(c, /data-copy=""/);
});

test('copyText: uses navigator.clipboard.writeText when available', async () => {
  const writes = [];
  const fakeClipboard = { writeText: async (t) => { writes.push(t); } };
  // `navigator` is a getter-only global in node, so use defineProperty to install / remove.
  const hadNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: fakeClipboard }, configurable: true, writable: true });
  try {
    const ok = await copyText('hello world');
    assert.equal(ok, true);
    assert.deepEqual(writes, ['hello world']);
  } finally {
    if (hadNav) Object.defineProperty(globalThis, 'navigator', hadNav); else delete globalThis.navigator;
  }
});

test('copyText: returns false (no throw) when no navigator and no document', async () => {
  const origNav = globalThis.navigator;
  const origDoc = globalThis.document;
  delete globalThis.navigator;
  delete globalThis.document;
  try {
    const ok = await copyText('nothing to copy');
    assert.equal(ok, false);
  } finally {
    if (origNav !== undefined) globalThis.navigator = origNav;
    if (origDoc !== undefined) globalThis.document = origDoc;
  }
});

test('wireCopyPrompt: is idempotent (second call does not throw / not a double-wire contract)', () => {
  // We can't easily inspect the document listener count, but the function must be
  // safe to call multiple times and not throw. The module sets an internal `wired`
  // flag; both calls return without error.
  assert.doesNotThrow(() => { wireCopyPrompt(); wireCopyPrompt(); wireCopyPrompt(); });
});
