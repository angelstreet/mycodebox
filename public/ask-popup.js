// Answer popup (TASK-44 phase 11). One bottom-right popup for every session that needs the owner:
// the question, answer buttons (yes/no, numbered options, Reply...), the AI reviewer's pick pre-highlighted
// and Jev's probabilities. Sends go through the page's askSend() (same /api/send path, same
// confirm-on-forbidden second tap); each owner answer is logged through onAnswer() as an owner-vs-AI-vs-Jev record.
// The queue logic is pure and lives in ask-model.js.

import { deriveButtons, lastQuestion, listQuestions } from './buttons.js';
import { reconcileQueue, markAnswered, mapAiToButton, shouldHighlight, jevLine, whyModel } from './ask-model.js';

const MIN_KEY = 'ghosty.askPopup.minimized';
const WHY_KEY = 'ghosty.askPopup.whyOpen';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stripNum = (label) => String(label).replace(/^\s*\d+\s*[.\-)\]:|·•]?\s*/, '');
const JEV_PLAIN = { continue: 'continue', take_recommended: 'take recommended', ask_owner: 'ask you' };
const truncText = (s, n) => { s = String(s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

export function mountAskPopup({ state, openCard, prefillDock, askSend, confirmThen, onAnswer }) {
  const el = document.getElementById('askPopup');
  const pill = document.getElementById('askPopupPill');
  const body = el?.querySelector('.ap-body');
  if (!el || !pill || !body) return null;

  let q = { items: [], answered: new Map() };   // the queue (ask-model.js)
  let curKey = null;                            // which item is showing
  let minimised = false;
  let whyOpen = false;                          // expandable AI/Jev "Why" section, collapsed by default
  let renderedKey = '';                         // content signature: re-render only when it changes (keeps a armed confirm alive)
  let ctx = null;                               // the showing item's derived view: { item, kind, buttons, aiId, aiConf, jev }
  const known = new Set();                      // stop ids already shown: only a new one slides in
  const replying = new Map();                   // name -> ctx of a Reply... tap, logged when the dock send happens
  const ownSend = new Map();                    // name -> ts of a send the popup made itself
  try { minimised = sessionStorage.getItem(MIN_KEY) === '1'; } catch {}
  try { whyOpen = sessionStorage.getItem(WHY_KEY) === '1'; } catch {}

  // Keep the popup above the send dock: --ask-bottom = the dock's real top edge measured from the viewport bottom.
  const dockEl = document.getElementById('dock');
  const syncDock = () => {
    const top = dockEl ? dockEl.getBoundingClientRect().top : window.innerHeight;
    document.documentElement.style.setProperty('--ask-bottom', `${Math.max(0, Math.round(window.innerHeight - top))}px`);
  };
  syncDock();
  window.addEventListener('resize', syncDock);
  if (dockEl && typeof ResizeObserver !== 'undefined') new ResizeObserver(syncDock).observe(dockEl);

  const setMin = (on) => {
    minimised = !!on;
    try { sessionStorage.setItem(MIN_KEY, on ? '1' : '0'); } catch {}
    render(true);
  };
  const setWhy = (on) => {
    whyOpen = !!on;
    try { sessionStorage.setItem(WHY_KEY, on ? '1' : '0'); } catch {}
    render(true);
  };
  const cur = () => q.items.find((i) => i.key === curKey) || q.items[0] || null;
  const move = (d) => {
    if (q.items.length < 2) return;
    const i = Math.max(0, q.items.findIndex((x) => x.key === curKey));
    curKey = q.items[(i + d + q.items.length) % q.items.length].key;
    render();
  };

  function view(item) {
    const st = state.status[item.name];
    if (!st) return null;
    const d = deriveButtons({ state: st.state, stall: st.stall, triage: st.triage });
    const ai = st.triage?.ai || null;
    let aiId = ai?.proposed_reply ? mapAiToButton(d.buttons, d.kind, ai.proposed_reply) : null;
    const btns = d.buttons.map((b) => (b.id === aiId && ai?.forbidden ? { ...b, confirm: true } : b));   // a forbidden AI pick needs the second tap
    if (!btns.some((b) => b.reply)) btns.push({ id: 'reply', label: '\u270e reply\u2026', reply: true });   // a live menu has no Reply button of its own
    const marked = btns.map((b) => ({ ...b, hl: !!aiId && b.id === aiId && shouldHighlight(b, st.triage) }));
    if (!marked.some((b) => b.hl)) aiId = null;
    // Several decisions in one stop: when the closing text has ≥ 2 numbered decision lines, render
    // each of them in the question area (max 3) and prefix the sent button text with the last
    // question's number so Claude knows which one the owner answered.
    const closingText = st.stall?.excerpt || st.stall?.question || '';
    const decisions = listQuestions(closingText);
    let btnsView = marked;
    let questionsView = null;
    let lastDecisionN = null;
    if (decisions.length >= 2) {
      lastDecisionN = decisions.length;
      questionsView = decisions;
      btnsView = marked.map((b) => (b.text ? { ...b, text: `${lastDecisionN}: ${b.text}` } : b));
    }
    const baseQ = ((st.state === 'waiting' ? st.waitReason : null) || (st.stall?.question ? lastQuestion(st.stall.question) : '') || 'waiting for your answer').slice(0, 2000);   // the question area scrolls; never cut it mid-line
    const question = questionsView ? '' : baseQ;
    return { item, kind: d.kind, buttons: btnsView, aiId, aiConf: aiId ? Number(ai.confidence) : null, jev: st.stall?.jev || null, question, questions: questionsView, decisionCount: decisions.length, prio: st.priority || item.priority || 'P2', why: whyModel(st) };
  }

  function metaText(v) {
    const jp = v.jev?.probabilities || {};
    const jl = (v.jev?.choice && Number.isFinite(jp[v.jev.choice]) && jp[v.jev.choice] > 0)
      ? `Jev: ${JEV_PLAIN[v.jev.choice] || v.jev.choice} ${Math.round(jp[v.jev.choice] * 100)}%`   // footer stays one short line; the Why section lists all three
      : jevLine(v.jev);
    const a = v.aiId ? `AI ★ ${Math.round((v.aiConf || 0) * 100)}%` : 'AI: yours to decide';
    return jl ? `${a}  ·  ${jl}` : a;
  }

  function whyHtml(v) {
    const w = v.why || { ai: { present: false }, jev: { present: false } };
    const ai = w.ai;
    const jev = w.jev;
    let aiRow;
    if (ai.present) {
      const conf = ai.conf != null ? `${Math.round(ai.conf * 100)}%` : '–';
      aiRow = `<div class="ap-why-row"><span class="ap-why-name">AI</span><span class="ap-why-pick">${esc(ai.label)}</span><span class="ap-why-conf">${esc(conf)}</span></div>`;
    } else {
      aiRow = `<div class="ap-why-row"><span class="ap-why-name">AI</span><span class="ap-why-missing">not run yet</span></div>`;
    }
    const aiReason = (ai.present && ai.reasoning)
      ? `<div class="ap-why-reason">${esc(truncText(ai.reasoning, 240))}</div>`
      : '';
    let jevRow;
    if (jev.present) {
      const probs = jev.probs || {};
      const main = jev.label || jev.choice || 'unknown';
      const mainKey = jev.choice;
      const mainPct = (mainKey && Number.isFinite(probs[mainKey])) ? `${Math.round(probs[mainKey] * 100)}%` : '–';
      const others = ['continue', 'take_recommended', 'ask_owner']
        .filter((k) => k !== mainKey && Number.isFinite(probs[k]) && probs[k] > 0)
        .map((k) => `${esc(JEV_PLAIN[k] || k)} ${Math.round(probs[k] * 100)}%`)
        .join('  ·  ');
      jevRow = `<div class="ap-why-row"><span class="ap-why-name">Jev</span><span class="ap-why-pick">${esc(main)}</span><span class="ap-why-conf">${esc(mainPct)}</span>${others ? `<span class="ap-why-probs">${others}</span>` : ''}</div>`;
    } else {
      jevRow = `<div class="ap-why-row"><span class="ap-why-name">Jev</span><span class="ap-why-missing">not asked</span></div>`;
    }
    return `<div class="ap-why">${aiRow}${aiReason}${jevRow}</div>`;
  }

  function btnHtml(b, label, n) {
    const cls = ['ap-b', b.hl ? 'hl' : '', b.confirm ? 'cf' : '', b.muted ? 'muted' : '', b.id === 'yes' || b.id === 'no' ? 'yn' : b.reply ? 'rep' : 'op'].filter(Boolean).join(' ');
    const star = b.hl ? '<i class="star">★</i>' : '';
    return n
      ? `<button class="${cls}" data-btn="${esc(b.id)}"><span class="n">${n}</span><span class="t">${esc(label)}</span>${star}</button>`
      : `<button class="${cls}" data-btn="${esc(b.id)}"><span class="t">${esc(label)}</span>${star}</button>`;
  }

  function render(force) {
    const r = reconcileQueue(q, state.status || {}, state.sessions || []);
    q = { items: r.items, answered: r.answered };
    if (!q.items.length) {
      curKey = null; ctx = null; renderedKey = '';
      el.classList.add('hidden'); pill.classList.add('hidden'); body.innerHTML = '';
      return;
    }
    if (!q.items.some((i) => i.key === curKey)) {
      // the shown item left: stay on the same slot when possible
      curKey = q.items[0].key;
    }
    const item = cur();
    const v = view(item);
    if (!v) return;
    ctx = v;
    const idx = q.items.findIndex((i) => i.key === item.key);
    pill.querySelector('.ap-pill-n').textContent = String(q.items.length);
    pill.classList.toggle('hidden', !minimised);
    const wasHidden = el.classList.contains('hidden');
    el.classList.toggle('hidden', minimised);
    const sig = JSON.stringify([item.key, idx, q.items.length, v.question, v.questions, v.prio, v.buttons.map((b) => [b.id, b.label, b.hl, b.confirm, b.muted]), metaText(v), v.why && { ai: { present: v.why.ai.present, conf: v.why.ai.conf, reasoning: v.why.ai.reasoning }, jev: { present: v.why.jev.present, choice: v.why.jev.choice, probs: v.why.jev.probs } }]);
    if (sig !== renderedKey || force) {
      renderedKey = sig;
      const opts = v.buttons.filter((b) => !b.reply);
      const reply = v.buttons.find((b) => b.reply);
      let btns;
      if (v.kind === 'yesno') btns = opts.map((b) => btnHtml(b, b.label)).join('') + (reply ? btnHtml(reply, 'Reply…') : '');
      else btns = opts.map((b, i) => btnHtml(b, v.kind === 'menu' ? stripNum(b.label) : b.label, i + 1)).join('') + (reply ? btnHtml(reply, 'Reply…') : '');
      const qBlock = v.questions
        ? `<div class="ap-qs">${v.questions.map((qq, i) => `<div class="ap-q-row"><span class="ap-q-n">${i + 1}.</span><span class="ap-q-t">${esc(qq)}</span></div>`).join('')}<div class="ap-qs-note">${v.questions.length} decisions — Reply… to answer all</div></div>`
        : `<div class="ap-q">${esc(v.question)}</div>`;
      body.innerHTML = `<div class="ap-head">
          <button class="ap-name" data-act="card" title="Open ${esc(item.name)}">${esc(item.name)}</button>
          <span class="ap-prio ${esc(v.prio)}">${esc(v.prio)}</span>
          <span class="ap-cnt">${idx + 1}/${q.items.length}</span>
          <button class="ap-nav" data-act="prev" aria-label="Previous">‹</button>
          <button class="ap-nav" data-act="next" aria-label="Next">›</button>
          <button class="ap-x" data-act="min" aria-label="Minimise">✕</button>
        </div>
        ${qBlock}
        <div class="ap-btns ${esc(v.kind)}">${btns}</div>
        <button type="button" class="ap-meta" data-act="why" aria-expanded="${whyOpen ? 'true' : 'false'}" title="Why these buttons?">${esc(metaText(v))} <span class="ap-toggle">${whyOpen ? '▾' : '▸'}</span></button>
        ${whyOpen ? whyHtml(v) : ''}`;
    }
    // slide in only for a stop id never shown before (and only when the popup is visible)
    const fresh = r.added.filter((it) => !known.has(it.id));
    for (const it of r.added) known.add(it.id);
    if (fresh.length && !minimised) {
      el.classList.remove('ap-anim'); void el.offsetWidth; el.classList.add('ap-anim');
    } else if (!wasHidden && !fresh.length) el.classList.remove('ap-anim');
  }

  function answer(b, extra) {
    const v = ctx; if (!v) return;
    const item = v.item;
    onAnswer({ name: item.name, id: item.id, kind: v.kind, button: b ? b.id : 'reply', text: extra?.text ?? (b && b.text) ?? null, aiButtonId: v.aiId, aiConfidence: v.aiConf, jev: v.jev });
  }
  function pick(b) {
    const v = ctx; if (!v || !b) return;
    if (b.reply) { replying.set(v.item.name, v); q = markAnswered(q, v.item.name); prefillDock(v.item.name, ''); render(); return; }
    const go = () => {
      answer(b);
      ownSend.set(v.item.name, Date.now());
      askSend(v.item.name, v.item.id, b.key != null ? { key: b.key } : { text: b.text }, b.id === v.aiId ? 'sent' : null);
      q = markAnswered(q, v.item.name);
      render();
    };
    const node = body.querySelector(`[data-btn="${CSS.escape(b.id)}"]`);
    confirmThen(node, !!b.confirm, go);
  }
  const btnById = (id) => ctx?.buttons.find((b) => b.id === id);

  body.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.act === 'card') { const i = cur(); if (i) openCard(i.name); return; }
    if (t.dataset.act === 'prev') return move(-1);
    if (t.dataset.act === 'next') return move(+1);
    if (t.dataset.act === 'min') return setMin(true);
    if (t.dataset.act === 'why') return setWhy(!whyOpen);
    if (t.dataset.btn) pick(btnById(t.dataset.btn));
  });
  pill.addEventListener('click', () => setMin(false));
  document.addEventListener('keydown', (e) => {
    if (minimised || el.classList.contains('hidden') || !ctx) return;
    const tg = e.target; if (tg && (tg.tagName === 'TEXTAREA' || tg.tagName === 'INPUT' || tg.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { e.preventDefault(); return setMin(true); }
    const opts = ctx.buttons.filter((b) => !b.reply);
    let b = null;
    if (/^[1-9]$/.test(e.key)) b = opts[Number(e.key) - 1];
    else if (ctx.kind === 'yesno' && /^[yn]$/i.test(e.key)) b = btnById(e.key.toLowerCase() === 'y' ? 'yes' : 'no');
    else if (e.key === 'Enter') b = ctx.buttons.find((x) => x.hl);
    if (b) { e.preventDefault(); pick(b); }
  });
  setInterval(() => render(), 1000);   // expires the 8 s keep-alive even when no status arrives

  return {
    tick: () => render(),
    // jump to a session (strip name / card chip): reopens the popup and drops any "answered" mark on it
    showFor(name) {
      for (const k of [...q.answered.keys()]) if (k.startsWith(`${name}\x1f`)) q.answered.delete(k);
      minimised = false; try { sessionStorage.setItem(MIN_KEY, '0'); } catch {}
      render(true);
      const it = q.items.find((i) => i.name === name);
      if (it) { curKey = it.key; render(true); }
    },
    // the page sent keys to a session (dock, card, popup...): that stop is answered
    sent(name, text) {
      const own = ownSend.get(name);
      ownSend.delete(name);
      const rep = replying.get(name);
      if (rep && !(own && Date.now() - own < 10000)) {
        replying.delete(name);
        onAnswer({ name, id: rep.item.id, kind: rep.kind, button: 'reply', text: text ?? '', aiButtonId: rep.aiId, aiConfidence: rep.aiConf, jev: rep.jev });
      }
      q = markAnswered(q, name);
      render();
    },
    isOpen: () => !minimised && !el.classList.contains('hidden'),
  };
}
