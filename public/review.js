// Swipe review of agent stops (TASK-44 phase 2b): one card at a time, swipe right = legit stop,
// left = stopped for no reason, up = skip. Labels are POSTed to /api/manager/label; Undo withdraws the
// newest one (/api/manager/unlabel). The deck comes from GET /api/manager/review.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); return r.json(); });

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const wouldText = (c) => (c.wouldSend ? (c.wouldSend.text != null ? `"${c.wouldSend.text}"` : `option ${c.wouldSend.key}`) : 'leave it to you');

export function openReview({ onSession, toast = () => {}, onClose = () => {} } = {}) {
  const root = document.createElement('div');
  root.className = 'rv';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Review stops');
  root.innerHTML = `
    <div class="rv-top"><button class="rv-x" data-a="close" aria-label="Close review">&#10005;</button><span class="rv-prog" id="rvProg">loading…</span>
      <button class="rv-undo" data-a="undo" aria-label="Undo last swipe" disabled>&#8630; Undo</button></div>
    <div class="rv-stage" id="rvStage"></div>
    <div class="rv-hint">swipe right = legit · left = no reason · up = skip · hold = note</div>
    <div class="rv-btns">
      <button class="rv-b bad" data-a="bad" aria-label="Bad: stopped for no reason" title="No reason (left arrow)">&#10005;</button>
      <button class="rv-b skip" data-a="skip" aria-label="Skip" title="Skip (up arrow)">&#8631;</button>
      <button class="rv-b good" data-a="good" aria-label="Good: legit stop" title="Legit (right arrow)">&#10003;</button>
    </div>`;
  document.body.appendChild(root);
  const stage = root.querySelector('#rvStage');
  const prog = root.querySelector('#rvProg');
  const undoBtn = root.querySelector('[data-a="undo"]');

  const S = { deck: [], left: 0, today: 0, cases: [], loaded: false, undo: [], busy: false, notes: new Map(), fetching: false, error: null };

  const merge = (d) => {
    const have = new Set(S.deck.map((c) => c.id));
    for (const c of d.cards) if (!have.has(c.id)) S.deck.push(c);
    S.cases = d.cases || S.cases;
  };
  async function load(first) {
    if (S.fetching) return;
    S.fetching = true;
    try {
      const d = await fetch('/api/manager/review?limit=50').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
      const pending = new Set(S.undo.map((u) => u.card.id));   // just-labelled ones may still be in flight
      d.cards = d.cards.filter((c) => !pending.has(c.id) || S.deck.some((x) => x.id === c.id));
      merge(d);
      S.today = d.labelledToday;
      S.left = d.unlabelled;
      S.loaded = true; S.error = null;
    } catch (e) { S.error = e.message; }
    S.fetching = false;
    if (first) render(); else paintProg();
  }
  function paintProg() {
    prog.textContent = S.error ? 'could not load' : !S.loaded ? 'loading…' : `${S.left} left · ${S.today} done today`;
    undoBtn.disabled = !S.undo.length;
  }

  // ---------- cards ----------
  function cardHtml(c, role) {
    const note = S.notes.get(c.id);
    const chips = [
      `<span class="rv-chip case">${esc(c.case)}</span>`,
      c.no_status ? '<span class="rv-chip warn">no status</span>' : '',
      c.deployHint ? `<span class="rv-chip">deploy${c.deployHint.scope ? ' ' + esc(c.deployHint.scope) : ''}</span>` : '',
      c.jev ? `<span class="rv-chip">jev ${esc(c.jev.choice)}${c.jev.confidence != null ? ' ' + Math.round(c.jev.confidence * 100) + '%' : ''}</span>` : '',
    ].join('');
    return `<div class="rv-card ${role}" data-id="${esc(c.id)}">
      <div class="rv-stamp bad">BAD</div><div class="rv-stamp good">GOOD</div><div class="rv-stamp skip">SKIP</div>
      <div class="rv-meta">
        <div class="rv-l1"><button class="rv-sess" data-a="open" data-s="${esc(c.session)}">${esc(c.session)}</button><span>${esc(c.agent || '')}</span><span>${esc(ago(c.at))}</span></div>
        <div class="rv-l2">${chips}</div>
        <div class="rv-l3">manager chose <b>${esc(c.case)}</b>; would answer <b>${esc(wouldText(c))}</b>${c.why && !c.wouldSend ? ` <i>(${esc(c.why)})</i>` : ''}</div>
      </div>
      ${c.ai ? `<div class="rv-ai"><div class="rv-ail">${c.jev ? `<b>Jev</b> ${esc(c.jev.choice)}${c.jev.confidence != null ? ' ' + Math.round(c.jev.confidence * 100) + '%' : ''} &middot; ` : ''}<b>AI</b> ${c.ai.proposed_reply ? `&ldquo;${esc(c.ai.proposed_reply)}&rdquo;` : 'needs you' + (c.ai.owner_needed_why ? ' &mdash; ' + esc(c.ai.owner_needed_why) : '')}</div>
        <div class="rv-air">${esc(c.ai.reasoning || '')} <i>(confidence ${Number(c.ai.confidence).toFixed(2)})</i></div>
        <div class="rv-aiv"><span>AI was</span><button class="${c.aiVerdict === 'right' ? 'on right' : ''}" data-a="aiRight" aria-label="AI proposal was right">&#10003; right</button><button class="${c.aiVerdict === 'wrong' ? 'on wrong' : ''}" data-a="aiWrong" aria-label="AI proposal was wrong">&#10005; wrong</button></div></div>` : ''}
      <div class="rv-text">${esc(c.excerpt)}</div>
      ${c.outcome ? `<div class="rv-outcome">you replied (${esc(c.outcome.kind || '?')}${c.outcome.via ? ', ' + esc(c.outcome.via) : ''}): <b>${esc(c.outcome.reply || '–')}</b></div>` : ''}
      ${note ? `<div class="rv-notechip">&#9998; ${esc(note.correctCase ? note.correctCase + ' ' : '')}${esc(note.note || '')}</div>` : ''}
    </div>`;
  }
  function render() {
    paintProg();
    if (!S.loaded) { stage.innerHTML = `<div class="rv-empty">${S.error ? 'could not load stops' : 'loading…'}</div>`; return; }
    if (!S.deck.length) {
      stage.innerHTML = `<div class="rv-empty"><div class="big">&#10003;</div>all stops reviewed<div class="dim">${S.today} done today</div></div>`;
      return;
    }
    const [a, b] = S.deck;
    stage.innerHTML = (b ? cardHtml(b, 'under') : '') + cardHtml(a, 'top');
    const top = stage.querySelector('.rv-card.top');
    const t = top.querySelector('.rv-text');
    if (t.scrollHeight > t.clientHeight + 2) { top.classList.add('scrolls'); t.scrollTop = t.scrollHeight; }   // the end of the closing text matters most
    wire(top);
    if (S.deck.length <= 3 && S.left > S.deck.length) load(false);   // prefetch more
  }

  // ---------- gestures ----------
  const THRESH = () => Math.min(130, stage.clientWidth * 0.3);
  function stampFor(dx, dy) {
    const T = THRESH();
    if (dy < 0 && -dy > Math.abs(dx)) return ['skip', Math.min(1, -dy / T)];
    return dx < 0 ? ['bad', Math.min(1, -dx / T)] : ['good', Math.min(1, dx / T)];
  }
  function paintDrag(card, dx, dy) {
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    const [k, p] = stampFor(dx, dy);
    for (const el of card.querySelectorAll('.rv-stamp')) el.style.opacity = el.classList.contains(k) ? String(p < 0.25 ? p * 0.4 : p) : '0';
    card.classList.toggle('past', p >= 1);
  }
  function wire(card) {
    let id = null, x0 = 0, y0 = 0, dx = 0, dy = 0, moved = false, lp = null;
    const scroller = card.querySelector('.rv-text');
    card.addEventListener('pointerdown', (e) => {
      if (S.busy || e.target.closest('button,textarea,select,input,.rv-pad')) return;
      id = e.pointerId; x0 = e.clientX; y0 = e.clientY; dx = dy = 0; moved = false;
      card.classList.add('drag');
      lp = setTimeout(() => { if (!moved && id != null) { id = null; card.classList.remove('drag'); openNote(); } }, 550);
    });
    card.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      dx = e.clientX - x0; dy = e.clientY - y0;
      if (!moved && Math.hypot(dx, dy) > 9) {
        moved = true; clearTimeout(lp);
        try { card.setPointerCapture(id); } catch {}
      }
      if (moved) paintDrag(card, dx, Math.min(dy, 60));
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      clearTimeout(lp); id = null;
      card.classList.remove('drag');
      if (!moved) return;
      const T = THRESH();
      if (-dy > T && -dy > Math.abs(dx)) decide('skip', card, dx, dy);
      else if (Math.abs(dx) > T) decide(dx < 0 ? 'bad' : 'good', card, dx, dy);
      else { card.style.transform = ''; card.classList.remove('past'); for (const el of card.querySelectorAll('.rv-stamp')) el.style.opacity = ''; }
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', (e) => { if (e.pointerId === id) { clearTimeout(lp); id = null; card.classList.remove('drag'); card.style.transform = ''; for (const el of card.querySelectorAll('.rv-stamp')) el.style.opacity = ''; } });
    void scroller;
  }

  // ---------- decisions ----------
  async function decide(kind, card, dx = 0, dy = 0) {
    if (S.busy || !S.deck.length) return;
    card = card || stage.querySelector('.rv-card.top');
    if (!card) return;
    S.busy = true;
    const c = S.deck[0];
    const w = stage.clientWidth;
    const fx = kind === 'bad' ? -w * 1.4 : kind === 'good' ? w * 1.4 : dx;
    const fy = kind === 'skip' ? -stage.clientHeight * 1.2 : dy;
    for (const el of card.querySelectorAll('.rv-stamp')) el.style.opacity = el.classList.contains(kind) ? '1' : '0';
    card.classList.add('fly');
    card.style.transform = `translate(${fx}px, ${fy}px) rotate(${fx / 14}deg)`;
    card.style.opacity = '0';
    S.deck.shift();
    const note = S.notes.get(c.id);
    if (kind === 'skip') { S.deck.push(c); S.undo.push({ kind, card: c }); }
    else {
      S.left = Math.max(0, S.left - 1); S.today += 1;
      S.undo.push({ kind, card: c, posted: post('/api/manager/label', { id: c.id, label: kind === 'bad' ? 'no_reason' : 'legit', note: note?.note || undefined, correctCase: note?.correctCase || undefined })
        .catch((e) => { toast('label failed: ' + e.message); S.undo = S.undo.filter((u) => u.card !== c); S.deck.unshift(c); S.left++; S.today--; render(); }) });
    }
    if (S.undo.length > 30) S.undo.shift();
    paintProg();
    setTimeout(() => { S.busy = false; render(); }, 230);
  }
  async function undo() {
    if (S.busy || !S.undo.length) return;
    const u = S.undo.pop();
    S.busy = true;
    try {
      if (u.kind === 'skip') S.deck = [u.card, ...S.deck.filter((x) => x.id !== u.card.id)];
      else {
        await u.posted;
        await post('/api/manager/unlabel', { id: u.card.id });
        S.left += 1; S.today = Math.max(0, S.today - 1);
        S.deck.unshift(u.card);
      }
    } catch (e) { toast('undo failed: ' + e.message); S.undo.push(u); }
    S.busy = false;
    render();
  }

  // ---------- note / wrong case (long press) ----------
  function openNote() {
    const c = S.deck[0];
    if (!c || root.querySelector('.rv-pad')) return;
    const cur = S.notes.get(c.id) || {};
    const pad = document.createElement('div');
    pad.className = 'rv-pad';
    pad.innerHTML = `<div class="rv-padbox"><b>Note on this stop</b>
      <textarea maxlength="500" placeholder="what was wrong (optional)" aria-label="Note">${esc(cur.note || '')}</textarea>
      <label>manager got the case wrong<select aria-label="Correct case"><option value="">no, the case was right</option>${S.cases.filter((x) => x !== c.case).map((x) => `<option value="${esc(x)}"${cur.correctCase === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <div class="rv-padrow"><button data-p="cancel">Cancel</button><button class="on" data-p="save">Save, then swipe</button></div></div>`;
    root.appendChild(pad);
    pad.querySelector('textarea').focus();
    const born = Date.now();
    pad.onclick = (e) => {
      if (Date.now() - born < 350) return;   // the finger that long-pressed is still lifting
      const b = e.target.closest('[data-p]');
      if (!b && e.target !== pad) return;
      if (b?.dataset.p === 'save') {
        const note = pad.querySelector('textarea').value.trim(), correctCase = pad.querySelector('select').value;
        if (note || correctCase) S.notes.set(c.id, { note, correctCase: correctCase || null }); else S.notes.delete(c.id);
      }
      pad.remove(); render();
    };
  }

  // ---------- the AI's proposal: right / wrong (measured apart from the stop's label) ----------
  async function rateAi(v) {
    const c = S.deck[0];
    if (!c?.ai) return;
    const was = c.aiVerdict;
    c.aiVerdict = was === v ? null : v;
    render();
    try { if (c.aiVerdict) await post('/api/manager/label', { id: c.id, aiVerdict: c.aiVerdict }); }
    catch (e) { c.aiVerdict = was; toast('rating failed: ' + e.message); render(); }
  }

  // ---------- chrome ----------
  function close() { document.removeEventListener('keydown', onKey, true); root.remove(); onClose(); }
  function onKey(e) {
    if (e.target.closest?.('textarea,select,input')) { if (e.key === 'Escape') root.querySelector('.rv-pad [data-p="cancel"]')?.click(); return; }
    const k = { ArrowLeft: 'bad', ArrowRight: 'good', ArrowUp: 'skip' }[e.key];
    if (k) { e.preventDefault(); decide(k); }
    else if (e.key === 'Backspace' || ((e.ctrlKey || e.metaKey) && e.key === 'z') || e.key === 'u') { e.preventDefault(); undo(); }
    else if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'close') close();
    else if (a === 'undo') undo();
    else if (a === 'open') { close(); onSession?.(b.dataset.s); }
    else if (a === 'aiRight' || a === 'aiWrong') rateAi(a === 'aiRight' ? 'right' : 'wrong');
    else decide(a);
  });
  load(true);
  return { close };
}
