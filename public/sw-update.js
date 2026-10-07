// Service worker reload guard.
// The phone app keeps running old JS after a deploy: a controllerchange event means a new SW is
// now in control of the page. We want to reload ONCE so the owner sees the new shell. But not
// while the owner is typing in the send dock or has a popup Reply open: surface a "tap to reload"
// toast and reload only when the owner taps it.
// Pure: no DOM, no I/O. Tested in test/sw-update.test.js.

// inputText: the current value of the send dock input. Any non-whitespace text -> the owner is typing.
// inputFocused: true when the send dock input is the active element.
// popupReplyOpen: true when the popup is showing (the popup has its own answer / Reply flow).
// coarse: a touch device (phone) - a focused input means the keyboard is open, so never reload under it. On a desktop
// (coarse false) only real typed text blocks the reload; an empty focused box or an open popup does not, so a deploy
// reaches an open tab within about a minute instead of waiting for a tap on the toast.
export function reloadGuard({ inputText = '', inputFocused = false, popupReplyOpen = false, coarse = true } = {}) {
  const typed = String(inputText || '').trim().length > 0;
  if (typed || (coarse && inputFocused)) return { shouldReload: false, showToast: true };
  if (coarse && popupReplyOpen) return { shouldReload: false, showToast: true };
  return { shouldReload: true, showToast: false };
}