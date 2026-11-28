// One clipboard icon, three explicit sources. Loading the transcript when opening the menu keeps the eventual
// clipboard write inside a fresh user gesture (needed by Safari), and never copies a cached partial conversation.
import { icon } from './icons.js';
import { copyText } from './copy-prompt.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LABELS = { reply: 'reply', full: 'full session', summary: 'summary' };
export function copyPayloads({ reply = '', full = '', summary = [] } = {}) {
  return { reply: String(reply ?? '').trim(), full: String(full ?? '').trim(), summary: Array.isArray(summary) ? summary.join('\n').trim() : '' };
}
export function readerCopyButtonHtml(session) {
  const id = 'rd-copy-' + Array.from(String(session), (c) => c.codePointAt(0).toString(16)).join('-');
  return `<span class="rd-copy" data-copy-session="${esc(session)}"><button type="button" class="rd-copy-trigger" aria-label="Copy options" title="Copy reply, full session or summary" aria-haspopup="menu" aria-expanded="false" command="toggle-popover" commandfor="${id}"><span class="rd-copy-icon" aria-hidden="true">${icon('clipboard', 14)}</span></button><div id="${id}" class="rd-copy-pop" popover="auto"><div focusgroup="menu nomemory" aria-label="Copy text">${Object.entries(LABELS).map(([kind, label]) => `<button type="button" data-copy-kind="${kind}" command="--copy-${kind}" commandfor="${id}"${kind === 'full' ? ' disabled' : ''}>Copy ${label}</button>`).join('')}</div><span class="rd-copy-note" role="status"></span></div><span class="rd-copy-status" role="status" aria-atomic="true"></span></span>`;
}

let wired = false, lastMessage = '';
const timers = new WeakMap();
export function wireReaderCopy({ replyOf, summaryOf, fullOf } = {}) {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  const invokers = 'commandForElement' in HTMLButtonElement.prototype;
  const popovers = 'showPopover' in HTMLElement.prototype;
  const focusgroup = 'focusGroup' in HTMLElement.prototype;
  let current = null;
  const items = (menu) => [...menu.querySelectorAll('[data-copy-kind]')].filter((b) => !b.disabled);
  const open = (menu) => popovers ? menu.matches(':popover-open') : menu.hasAttribute('data-open');
  const focusItem = (menu, index) => {
    const bs = items(menu), b = bs[index < 0 ? bs.length - 1 : index];
    if (!b) return;
    if (!focusgroup) bs.forEach((x) => { x.tabIndex = x === b ? 0 : -1; });
    b.focus({ preventScroll: true });
  };
  function hide(entry, restore = true) {
    if (!entry) return;
    if (restore && entry.trigger.isConnected) entry.trigger.focus({ preventScroll: true });
    entry.controller.abort();
    if (popovers && open(entry.menu)) entry.menu.hidePopover();
    if (!popovers) {
      entry.menu.removeAttribute('data-open');
      entry.trigger.setAttribute('aria-expanded', 'false');
      if (entry.trigger.isConnected) entry.trigger.after(entry.menu);
    }
    if (current === entry) current = null;
  }
  function position(menu, trigger) {
    if (CSS.supports('position-area: block-end') && popovers) return;
    const a = trigger.getBoundingClientRect(), r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(a.left, innerWidth - r.width - 8))}px`;
    menu.style.top = `${Math.max(8, a.top >= r.height + 8 ? a.top - r.height - 6 : Math.min(a.bottom + 6, innerHeight - r.height - 8))}px`;
  }
  function wireMenu(menu, trigger) {
    if (menu.dataset.wired) return;
    menu.dataset.wired = '1';
    trigger.style.setProperty('anchor-name', `--${menu.id}`);
    menu.style.setProperty('position-anchor', `--${menu.id}`);
    if (!popovers) menu.style.setProperty('position-area', 'none');
    if (!invokers && popovers) trigger.setAttribute('popovertarget', menu.id);
    if (!focusgroup) {
      menu.firstElementChild.setAttribute('role', 'menu');
      menu.querySelectorAll('[data-copy-kind]').forEach((b) => { b.setAttribute('role', 'menuitem'); b.tabIndex = -1; });
    }
    // toggle is queued: a transcript repaint can otherwise replace an already-open menu before aria catches up.
    menu.addEventListener('beforetoggle', (e) => {
      trigger.setAttribute('aria-expanded', String(e.newState === 'open'));
    });
    menu.addEventListener('toggle', (e) => {
      if (e.newState === 'open') {
        position(menu, trigger);
        if (current?.menu === menu && current.keyboard) focusItem(menu, 0);
        else trigger.focus({ preventScroll: true });
      } else if (current?.menu === menu) hide(current, menu.contains(document.activeElement));
    });
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.stopPropagation();
        if (e.key === 'Escape') e.preventDefault();
        hide(current);
      } else if (['Home', 'End', 'ArrowDown', 'ArrowUp'].includes(e.key) && (!focusgroup || ['Home', 'End'].includes(e.key))) {
        const bs = items(menu), i = bs.indexOf(document.activeElement);
        e.preventDefault(); e.stopPropagation();
        focusItem(menu, e.key === 'Home' ? 0 : e.key === 'End' ? -1 : (i + (e.key === 'ArrowUp' ? -1 : 1) + bs.length) % bs.length);
      }
    });
    menu.addEventListener('pointermove', (e) => { const b = e.target.closest('[data-copy-kind]'); if (b && !b.disabled) b.focus({ preventScroll: true }); });
  }
  function prepare(trigger, keyboard) {
    const menu = document.getElementById(trigger.getAttribute('commandfor'));
    wireMenu(menu, trigger);
    if (open(menu)) return null;
    hide(current, false);
    const session = trigger.closest('.rd-copy').dataset.copySession;
    const entry = { trigger, menu, keyboard, controller: new AbortController(), text: copyPayloads({ reply: replyOf(session), summary: summaryOf(session) }) };
    current = entry;
    for (const b of menu.querySelectorAll('[data-copy-kind]')) {
      b.disabled = !entry.text[b.dataset.copyKind];
      b.title = b.dataset.copyKind === 'summary' && b.disabled ? 'No summary yet' : '';
    }
    const note = menu.querySelector('.rd-copy-note'); note.textContent = 'Loading full session…';
    Promise.resolve().then(() => fullOf(session, entry.controller.signal)).then((text) => {
      if (current !== entry || entry.controller.signal.aborted) return;
      entry.text.full = String(text || '').trim();
      menu.querySelector('[data-copy-kind="full"]').disabled = !entry.text.full;
      note.textContent = entry.text.full ? '' : 'No session text available';
      position(menu, trigger);
    }).catch(() => { if (current === entry && !entry.controller.signal.aborted) note.textContent = 'Could not load full session. Reopen to retry.'; });
    return entry;
  }
  async function copy(button) {
    const entry = current, kind = button.dataset.copyKind, text = entry?.text[kind];
    if (!text || button.disabled) return;
    entry.copying = true;
    const ok = await copyText(text);
    entry.copying = false;
    if (!entry.trigger.isConnected || current !== entry) return;
    const feedback = entry.trigger.closest('.rd-copy').querySelector('.rd-copy-status');
    let message = ok ? `Copied ${LABELS[kind]}` : 'Copy failed. Try again.';
    if (message === lastMessage) message += '\u00a0';
    lastMessage = message;
    clearTimeout(timers.get(entry.trigger));
    feedback.textContent = message;
    const ico = entry.trigger.querySelector('.rd-copy-icon');
    if (ok) { ico.innerHTML = icon('check', 14); hide(entry); }
    timers.set(entry.trigger, setTimeout(() => { feedback.textContent = ''; ico.innerHTML = icon('clipboard', 14); }, 2000));
  }
  if (invokers) document.addEventListener('command', (e) => { if (e.command?.startsWith('--copy-') && e.source?.matches('[data-copy-kind]') && e.target.matches('.rd-copy-pop')) copy(e.source); }, true);
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('.rd-copy-trigger');
    if (trigger) {
      e.stopPropagation();
      const entry = prepare(trigger, e.detail === 0);
      if (!popovers) {
        e.preventDefault();
        if (!entry) { hide(current); return; }
        document.body.append(entry.menu); entry.menu.setAttribute('data-open', '');
        trigger.setAttribute('aria-expanded', 'true'); position(entry.menu, trigger);
        if (entry.keyboard) focusItem(entry.menu, 0); else trigger.focus({ preventScroll: true });
      }
      return;
    }
    const b = e.target.closest('.rd-copy-pop [data-copy-kind]');
    if (b) { e.stopPropagation(); if (!invokers) { e.preventDefault(); copy(b); } }
  });
  document.addEventListener('keydown', (e) => {
    if (current && e.key === 'Tab' && e.target === current.trigger) { hide(current); return; }
    if (!popovers && current && e.key === 'Escape') { e.preventDefault(); hide(current); return; }
    const trigger = e.target.closest('.rd-copy-trigger');
    if (trigger && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      const menu = document.getElementById(trigger.getAttribute('commandfor'));
      if (!open(menu)) trigger.click();
      else focusItem(menu, e.key === 'ArrowUp' ? -1 : 0);
    }
  });
  document.addEventListener('focusin', (e) => { if (current && !current.copying && e.target !== current.trigger && !current.menu.contains(e.target)) hide(current, false); });
  document.addEventListener('pointerdown', (e) => { if (current && !current.menu.contains(e.target) && !current.trigger.contains(e.target)) hide(current, false); });
  window.addEventListener('resize', () => { if (current) position(current.menu, current.trigger); });
}
