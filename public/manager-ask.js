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
