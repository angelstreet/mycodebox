// A manager question in the ask popup (a ledger ask): tappable options instead of a read-only list, the recommended one highlighted in place
// instead of a separate "Recommends" box. The ledger writes options as "1 yes, add it" (number included) and the recommendation as "1" or "1 — why".

// -> [{ n, label, rec, why }]; `rec` marks the recommended one. Options without a number are numbered by position.
export function askOptions(ask) {
  const raw = Array.isArray(ask?.options) ? ask.options.map(String) : [];
  const recText = String(ask?.recommendation ?? '').trim();
  const recN = (/^\s*(\d+)\b/.exec(recText) || [])[1] ?? null;
  const why = recText.replace(/^\s*\d+\s*[-—:.)]*\s*/, '').trim();
  return raw.map((o, i) => {
    const m = /^\s*(\d+)\s*[.):\-]?\s+(\S[\s\S]*)$/.exec(o);
    const n = m ? m[1] : String(i + 1);
    return { n, label: (m ? m[2] : o).trim(), rec: recN !== null && recN === n, why: recN !== null && recN === n ? why : '' };
  });
}

// The recommendation, when it does not point at one of the options (free text): the popup still shows it as a note.
export function looseRecommendation(ask) {
  const recText = String(ask?.recommendation ?? '').trim();
  if (!recText) return '';
  return askOptions(ask).some((o) => o.rec) ? '' : recText;
}

// The message typed to the manager when the owner taps an option.
export function answerText(ask, opt) {
  return `Owner answer to ${ask?.id || 'your question'} — option ${opt.n}: ${opt.label}`;
}

// Where a tapped answer goes: the session the ask is about while it runs, else the manager; null when neither runs.
export function answerTarget(ask, statuses) {
  return ask?.session && statuses?.[ask.session] ? ask.session : (statuses?.manager ? 'manager' : null);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The options of one row in the strip's question list, as buttons (owner, 2026-11-28: "i should be able to click to select a
// decision"). `picked` is the number already sent: it stays marked and the row takes no second answer.
export function askOptionButtonsHtml(ask, picked = null) {
  const opts = askOptions(ask);
  if (!opts.length) return '';
  const done = picked !== null;
  return `<div class="qopts" data-ask="${esc(ask.id)}">${opts.map((o, i) => `<button type="button" class="qopt${o.rec ? ' rec' : ''}${done && o.n === picked ? ' picked' : ''}" data-opt="${i}" aria-pressed="${done && o.n === picked}"${done ? ' disabled' : ''}>${esc(o.n)}. ${esc(o.label)}</button>`).join('')}<div class="qsent" role="status">${done ? `Sent: option ${esc(picked)}` : ''}</div></div>`;
}

// Wire those buttons. `send(target, text)` must reject when the answer was not delivered: the row then says so and takes
// another tap. `sent` (ask id -> option number) outlives the popup, so reopening it cannot send a second answer.
export function wireAskOptions(root, asks, { statuses, send, sent, onSent }) {
  for (const row of root.querySelectorAll('.qopts[data-ask]')) {
    const ask = asks.find((a) => String(a.id) === row.dataset.ask);
    const buttons = [...row.querySelectorAll('button[data-opt]')];
    const note = row.querySelector('.qsent');
    for (const b of buttons) b.onclick = async (e) => {
      e.stopPropagation();
      const opt = ask && askOptions(ask)[Number(b.dataset.opt)];
      if (!opt || sent.has(String(ask.id))) return;
      const target = answerTarget(ask, statuses());
      if (!target) { note.textContent = 'Not sent: the manager session is not running'; note.className = 'qsent bad'; return; }
      sent.set(String(ask.id), opt.n);
      for (const x of buttons) x.disabled = true;
      b.classList.add('picked'); b.setAttribute('aria-pressed', 'true');
      note.textContent = 'Sending\u2026'; note.className = 'qsent';
      try {
        await send(target, answerText(ask, opt));
        note.textContent = `Sent: option ${opt.n}`;
        onSent?.(target, ask, opt);
      } catch (err) {
        sent.delete(String(ask.id));
        for (const x of buttons) x.disabled = false;
        b.classList.remove('picked'); b.setAttribute('aria-pressed', 'false');
        note.textContent = `Not sent: ${err.message}. Tap to try again`; note.className = 'qsent bad';
      }
    };
  }
}

// ---- what the owner reads (owner, 2026-10-25) ----
// The owner asked for four things, in this order: the ask id, a one-line "what it is", why it is his, and the
// recommendation. The strip, the answer popup, the push and the voice all read this one shape, so they cannot
// disagree about what a question is.
export function oneLine(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || '';
}

// The recommendation the owner reads: the recommended option's own words, plus the manager's view when there is one.
export function recommendationText(ask) {
  const rec = askOptions(ask).find((o) => o.rec);
  if (rec) return `${rec.n} — ${rec.label}${rec.why ? ` (${rec.why})` : ''}`.trim();
  return looseRecommendation(ask);
}

// -> { id, what, why, rec }: the four fields, in the owner's order.
export function askSummary(ask) {
  return {
    id: String(ask?.id || ''),
    what: `${oneLine(ask?.what) || oneLine(ask?.question)}${ask?.source ? ` (from session ${ask.source})` : ''}`,
    why: oneLine(ask?.why),
    rec: recommendationText(ask),
  };
}

// One line for a push, a title or a tooltip: id · what · why you · my view.
export function askLine(ask) {
  const s = askSummary(ask);
  return [s.id, s.what, s.why ? `why you: ${s.why}` : '', s.rec ? `my view: ${s.rec}` : ''].filter(Boolean).join(' · ');
}
