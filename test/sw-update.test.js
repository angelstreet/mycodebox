import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadGuard } from '../public/sw-update.js';

// Pure guard logic for the SW controllerchange reload path. The page should reload (or receive a
// "reload" signal) when idle, and surface a "tap to reload" toast when the owner is typing in the
// send dock or has a popup Reply open. Tested without DOM / I/O.

test('reloadGuard: idle -> reload', () => {
  assert.deepEqual(reloadGuard({ inputText: '', inputFocused: false, popupReplyOpen: false }), { shouldReload: true, showToast: false });
});

test('reloadGuard: send dock has text -> toast (not reload)', () => {
  assert.deepEqual(reloadGuard({ inputText: 'hello', inputFocused: false, popupReplyOpen: false }), { shouldReload: false, showToast: true });
});

test('reloadGuard: send dock has focus -> toast (not reload)', () => {
  assert.deepEqual(reloadGuard({ inputText: '', inputFocused: true, popupReplyOpen: false }), { shouldReload: false, showToast: true });
});

test('reloadGuard: whitespace-only text is NOT "typing" -> reload', () => {
  assert.deepEqual(reloadGuard({ inputText: '   ', inputFocused: false, popupReplyOpen: false }), { shouldReload: true, showToast: false });
});

test('reloadGuard: popup Reply open -> toast', () => {
  assert.deepEqual(reloadGuard({ inputText: '', inputFocused: false, popupReplyOpen: true }), { shouldReload: false, showToast: true });
});

test('reloadGuard: typing + popup open -> toast (typing wins)', () => {
  assert.deepEqual(reloadGuard({ inputText: 'x', inputFocused: true, popupReplyOpen: true }), { shouldReload: false, showToast: true });
});

test('reloadGuard: text + popup open -> toast', () => {
  assert.deepEqual(reloadGuard({ inputText: 'hello', inputFocused: false, popupReplyOpen: true }), { shouldReload: false, showToast: true });
});

test('reloadGuard: focus + popup open -> toast', () => {
  assert.deepEqual(reloadGuard({ inputText: '', inputFocused: true, popupReplyOpen: true }), { shouldReload: false, showToast: true });
});

test('reloadGuard: no args -> reload (idle)', () => {
  assert.deepEqual(reloadGuard(), { shouldReload: true, showToast: false });
});

test('reloadGuard: empty string inputText (not undefined) is treated as empty', () => {
  assert.deepEqual(reloadGuard({ inputText: '', inputFocused: false, popupReplyOpen: false }), { shouldReload: true, showToast: false });
});

test('reloadGuard: null inputText falls back to ""', () => {
  assert.deepEqual(reloadGuard({ inputText: null, inputFocused: false, popupReplyOpen: false }), { shouldReload: true, showToast: false });
});

test('reloadGuard: a single character is enough to be "typing"', () => {
  assert.deepEqual(reloadGuard({ inputText: 'a', inputFocused: false, popupReplyOpen: false }), { shouldReload: false, showToast: true });
});