// Suggestions the Opus triage parked with the owner (suggestion-triage.js, owner 2026-11-27): one chip in the NEEDS YOU strip and a popup with a
// yes / no per item. The session never waits on them; the owner answers at any time. Pure HTML builders; app.js polls and wires the buttons.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// items: GET /api/suggestions/owner .items -> the strip chip, or '' when none.
export function parkedChipHtml(items = []) {
  if (!items.length) return '';
  const title = items.map((i) => `${i.session} ${i.n}. ${i.text}`).join('\n');
  return `<button data-parked="1" title="${esc(title)}">suggestions · ${items.length}</button>`;
}

// One row per item: session, the suggestion, why it is the owner's (a floor, or Opus's doubt), Opus's proposal, then Yes / No.
export function parkedRowsHtml(items = [], { name = (s) => s } = {}) {
  const why = (i) => (i.floor ? `Owner only: ${i.floor}` : `Opus in doubt${i.why ? `: ${i.why}` : ''}`);
  return '<div class="qrow1"><b>Suggestions for you</b><div class="qwhy">The Opus triage left these to you. No session waits on them.</div></div>'
    + items.map((i) => `<div class="qrow1 prk" data-s="${esc(i.session)}" data-n="${esc(i.n)}"><b>${esc(name(i.session))} · ${esc(i.n)}</b> ${esc(i.text)}`
      + `<div class="qwhy">${esc(why(i))}</div><div class="qrec">Opus proposes: ${esc(i.proposed || 'no')}</div>`
      + `<div class="prkbtns"><button class="prk-yes" data-a="yes">Yes, build it</button><button class="prk-no" data-a="no">No</button></div></div>`).join('');
}
