// Answer popup (TASK-44 phase 11). One bottom-right popup for every session that needs the
// owner's attention, with the AI reviewer's pick pre-highlighted and Jev's probabilities shown.
// Sends go through the existing /api/send path (same confirm-on-forbidden second tap); the choice
// (owner vs AI vs Jev) is logged as {type:'choice'} in stalls.jsonl.
//
// Mounted once from index.html (#askPopup). The popup reads window.appState (the shared state from
// app.js) and exposes a small mount() / open() / showFor(name) API. The card keeps a one-line chip
// that calls showFor(name); tapping a NEEDS YOU strip button also calls showFor(name); tapping the
// session name inside the popup opens the card.

import { deriveButtons, lastQuestion } from '/buttons.js';
import { buildQueue, reconcileQueue, mapAiToButton, shouldHighlight, jevLine, jevAgreesOwner, isOwnersTurn, stallId } from '/ask-model.js';

const LS_MINIMIZED = 'ghosty.askPopup.minimized';

const popup = {
  el: null,
  pill: null,
  body: null,
  items: [],
  index: 0,
  lastNames: [],        // names of items currently in the popup, for the pill "N need you"
  knownIds: new Set(), // stall ids already shown (for the slide-up animation gate)
};

// ---------- mount ----------
export function mountAskPopup({ state, openCard, prefillDock, askSend, confirmThen, postSend, onAnswer, toastFn, sendKeyFn }) {
  popup.el = document.getElementById('askPopup');
  popup.pill = document.getElementById('askPopupPill');
  popup.body = popup.el?.querySelector('.ap-body') || null;
  if (!popup.el || !popup.pill || !popup.body) return null;

  // hide / minimise
  popup.el.querySelector('.ap-close').onclick = () => setMinimized(true);
  popup.pill.onclick = () => { setMinimized(false); render(); };
  popup.el.querySelector('.ap-prev').onclick = () => move(-1);
  popup.el.querySelector('.ap-next').onclick = () => move(+1);
  // tap on session name opens the card
  popup.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]') || e.target.closest('button');
    if (!t) return;
    const item = currentItem(); if (!item) return;
    const act = t.dataset.act;
    if (act === 'open-card') { openCard(item.name); return; }
    if (act === 'reply') { setMinimized(true); prefillDock(item.name, ''); onAnswer({ name: item.name, id: item.id, button: 'reply', text: '' }); return; }
    if (act === 'btn') {
      const b = t.dataset.btn;
      const text = t.dataset.text;
      const confirm = t.dataset.confirm === '1';
      sendPick(item, b, text, confirm);
      return;
    }
  });
  // ESC minimises, 1..9 picks an option, y/n for yes/no, Enter = the highlighted one
  document.addEventListener('keydown', (e) => {
    if (popup.el.classList.contains('hidden')) return;
    if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) return;
    if (e.key === 'Escape') { e.preventDefault(); setMinimized(true); return; }
    const cur = currentItem(); if (!cur) return;
    const d = cur.buttons;
    if (!d) return;
    if (/^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      const b = d.buttons.find((b) => b.id === `o${idx + 1}` || (d.kind === 'yesno' && idx === 0 && b.id === 'yes'));
      if (b) { e.preventDefault(); pickAndSend(b); }
      return;
    }
    if (d.kind === 'yesno') {
      if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); pickAndSend(d.buttons.find((b) => b.id === 'yes')); return; }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); pickAndSend(d.buttons.find((b) => b.id === 'no')); return; }
    }
    if (e.key === 'Enter') {
      const hi = d.buttons.find((b) => b.highlight);
      if (hi) { e.preventDefault(); pickAndSend(hi); }
    }
  });

  // start minimised if they left it minimised last time
  try { if (sessionStorage.getItem(LS_MINIMIZED) === '1') setMinimized(true); } catch {}

  return {
    tick: () => render(),
    showFor: (name) => showFor(name),
    hide: () => setMinimized(true),
    open: () => setMinimized(false),
    minimised: () => popup.el.classList.contains('hidden'),
  };

  // ----- inner helpers -----
  function setMinimized(on) {
    popup.el.classList.toggle('hidden', !!on);
    popup.pill.classList.toggle('hidden', !on);
    try { sessionStorage.setItem(LS_MINIMIZED, on ? '1' : '0'); } catch {}
  }
  function currentItem() {
    if (!popup.items.length) return null;
    const i = Math.max(0, Math.min(popup.index, popup.items.length - 1));
    return popup.items[i];
  }
  function move(d) {
    if (!popup.items.length) return;
    popup.index = (popup.index + d + popup.items.length) % popup.items.length;
    render();
  }
  function render() {
    // reconcile queue against the live state
    const live = buildQueue(state.status || {}, {}, state.sessions || []);
    const r = reconcileQueue({ items: popup.items }, state.status || {}, state.sessions || []);
    popup.items = r.items;
    popup.lastNames = popup.items.map((it) => it.name);
    // snap index to a still-present one (the name may have moved on)
    if (popup.index >= popup.items.length) popup.index = 0;
    const item = currentItem();
    if (!item) {
      popup.body.innerHTML = '';
      popup.el.querySelector('.ap-cnt').textContent = '';
      popup.el.querySelector('.ap-q').textContent = '';
      popup.el.querySelector('.ap-meta').textContent = '';
      popup.el.querySelector('.ap-btns').innerHTML = '';
      // count pill
      if (popup.lastNames.length === 0) popup.pill.classList.add('hidden');
      else popup.pill.querySelector('.ap-pill-n').textContent = String(popup.lastNames.length);
      return;
    }
    const st = state.status[item.name];
    if (!st) return;
    // build buttons via the same logic the card uses (avoids drift)
    const buttons = deriveButtons({ state: st.state, stall: st.stall, triage: st.triage });
    // mark the AI highlight
    const aiId = (() => {
      const ai = st.triage?.ai;
      if (!ai || !ai.proposed_reply) return null;
      if (ai && trefs.aiNotHighlighted(st)) return null;
      return mapAiToButton(buttons.buttons, buttons.kind, ai.proposed_reply);
    })();
    const annotated = buttons.buttons.map((b) => {
      const hl = aiId === b.id && shouldHighlight(b, st.triage);
      return { ...b, highlight: hl };
    });
    // remember for currentItem()
    item.buttons = { kind: buttons.kind, buttons: annotated, aiButtonId: aiId };
    // figure the question text (matches the card's pick)
    const q = (st.state === 'waiting' ? st.waitReason : null) || (st.stall?.question ? lastQuestion(st.stall.question) : '') || 'waiting for your answer';
    const qSliced = q.slice(0, 220);
    // layout
    const prio = item.priority || 'P2';
    const name = item.name;
    popup.body.innerHTML = `
      <div class="ap-row ap-head">
        <span class="ap-name" data-act="open-card" title="Open ${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="ap-prio ${prio}">${prio}</span>
        <span class="ap-cnt"></span>
        <button class="ap-x" aria-label="Minimise">${'\u2715'}</button>
      </div>
      <div class="ap-q"></div>
      <div class="ap-btns"></div>
      <div class="ap-meta"></div>
      <div class="ap-reply"><button data-act="reply">Reply\u2026</button></div>`;
    popup.body.querySelector('.ap-x').onclick = (e) => { e.stopPropagation(); setMinimized(true); };
    popup.body.querySelector('.ap-cnt').textContent = `${popup.index + 1}/${popup.items.length} \u2039 \u203a`;
    popup.body.querySelector('.ap-q').textContent = qSliced;
    // Buttons row.
    const btnsEl = popup.body.querySelector('.ap-btns');
    btnsEl.innerHTML = '';
    if (buttons.kind === 'yesno') {
      const yes = annotated.find((b) => b.id === 'yes');
      const no = annotated.find((b) => b.id === 'no');
      btnsEl.appendChild(makeBtn(yes, 'yes'));
      btnsEl.appendChild(makeBtn(no, 'no'));
    } else {
      // menu / either / open: numbered options
      const opts = annotated.filter((b) => b.id !== 'reply');
      opts.forEach((b, i) => btnsEl.appendChild(makeBtn(b, String(i + 1))));
    }
    // Bottom line: AI + Jev
    const meta = popup.body.querySelector('.ap-meta');
    const ai = st.triage?.ai;
    const aiLine = ai ? `AI \u2605 ${Math.round((Number(ai.confidence) || 0) * 100)}%` : 'AI: yours to decide';
    const jLine = jevLine(st.stall?.jev);
    meta.textContent = aiId ? `${aiLine}   ${jLine}` : (jLine ? `${aiLine}\n${jLine}` : aiLine);
    // slide-up animation when the top item's stall id wasn't seen before
    if (r.animate && !popup.knownIds.has(item.id)) {
      popup.el.classList.remove('ap-anim'); void popup.el.offsetWidth; popup.el.classList.add('ap-anim');
      popup.knownIds.add(item.id);
    }
    // pill
    popup.pill.classList.toggle('hidden', popup.el.classList.contains('hidden'));
    popup.pill.querySelector('.ap-pill-n').textContent = String(popup.lastNames.length);
  }

  function makeBtn(b, label) {
    const el = document.createElement('button');
    el.className = (b.highlight ? 'highlight ' : '') + (b.id === 'yes' || b.id === 'no' ? 'yn ' : 'op ') + (b.confirm ? 'confirm ' : '');
    el.dataset.btn = b.id;
    if (b.text != null) el.dataset.text = b.text;
    if (b.confirm) el.dataset.confirm = '1';
    el.dataset.act = 'btn';
    el.innerHTML = `${label}${b.highlight ? ' <i class="star">\u2605</i>' : ''}`;
    return el;
  }

  function pickAndSend(b) {
    if (!b) return;
    if (b.id === 'reply') {
      const item = currentItem();
      setMinimized(true);
      prefillDock(item.name, '');
      onAnswer({ name: item.name, id: item.id, button: 'reply', text: '' });
      return;
    }
    if (b.confirm) {
      const el = popup.body.querySelector(`[data-btn="${b.id}"]`);
      if (!confirmThen(el, true, () => doSend(b))) return;
      return;
    }
    doSend(b);
  }
  function doSend(b) {
    const item = currentItem();
    if (!item) return;
    const st = state.status[item.name];
    if (b.key != null) askSend(item.name, item.id, { key: b.key }, null);
    else if (b.text != null) askSend(item.name, item.id, { text: b.text }, null);
    else return;
    onAnswer({ name: item.name, id: item.id, button: b.id, text: b.text || null });
    toastFn && toastFn(`sent \u2192 ${item.name}`, 900);
    // close the popup if this was the only item
    if (popup.items.length <= 1) setMinimized(true);
    else { popup.items = popup.items.filter((x) => x.key !== item.key); popup.index = 0; render(); }
  }
}

// public: jump the popup to a specific session (used by the NEEDS YOU strip and the card chip).
export function showAskPopup(name, getApi) {
  const api = getApi && getApi(); if (!api) return null;
  api.open();
  // re-render and try to focus the requested session
  api.tick();
  const list = popup.items;
  const i = list.findIndex((it) => it.name === name);
  if (i >= 0) { popup.index = i; api.tick(); }
  return api;
}

// pure helper exposed so the server's choice handler can do the same jev agreement mapping
export { jevAgreesOwner } from '/ask-model.js';

// small HTML helper — escape text
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}