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
    what: oneLine(ask?.what) || oneLine(ask?.question),
    why: oneLine(ask?.why),
    rec: recommendationText(ask),
  };
}

// One line for a push, a title or a tooltip: id · what · why you · my view.
export function askLine(ask) {
  const s = askSummary(ask);
  return [s.id, s.what, s.why ? `why you: ${s.why}` : '', s.rec ? `my view: ${s.rec}` : ''].filter(Boolean).join(' · ');
}
