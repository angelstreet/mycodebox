// Answer popup — pure model (TASK-44 phase 11).
// All queue / keep-alive / AI->button mapping / Jev line formatting live here so they can be
// unit-tested without DOM or fetch. Imported by public/ask-popup.js and test/ask-popup.test.js.
//
// Data the popup reads (from state.status / window.state via the popup):
//   st.name, st.state ('waiting'|'done'|...), st.waitReason, st.stall, st.triage, st.priority, st.lastActivitySec, st.stall.id, st.triage.ai
//
// Notes:
//   - "needs owner" is the same predicate buttons.js / app.js use (waiting + done with a question)
//   - a stall's *id* is the unit of identity across status flickers (TUI repaints can flip a session
//     to 'working' for a few seconds). When the id changes the popup treats it as a new item.
//   - the popup never sends anything itself: it calls askSend() (the existing /api/send + retry
//     path) and then POSTs /api/manager/choice for the agreement record.

// ---------- queue ----------
// Visible condition: a session that needs the owner's attention right now. Same set the NEEDS YOU
// strip shows in public/app.js renderAttention().
export function isOwnersTurn(st) {
  if (!st) return false;
  if (st.state === 'waiting') return true;
  if (st.state === 'done' && /\?/.test(st.question || st.stall?.question || '')) return true;
  return false;
}

// The id that ties together status flickers (a TUI repaint can flip state to 'working' and back
// without the stall moving on). One popup item per id; the same id re-shows in place.
export function stallId(st) {
  return st?.stall?.id || st?.triage?.id || null;
}

// Build the queue from the current set of statuses, in the priority order the NEEDS YOU strip uses
// (P0 first, then the rest). Each entry: { name, id, key, lastEligibleAt }. `key` is the dedupe key
// the popup uses to decide "still the same item".
export function buildQueue(statuses, prios, sessions, now = Date.now()) {
  const out = [];
  for (const s of sessions) {
    const st = statuses[s.name];
    if (!isOwnersTurn(st)) continue;
    const id = stallId(st);
    if (!id) continue;
    const priority = st?.priority || prios[s.name] || 'P2';
    out.push({ name: s.name, id, key: `${s.name}\x1f${id}`, lastEligibleAt: now, priority });
  }
  out.sort((a, b) => prioRank(a.priority) - prioRank(b.priority) || a.name.localeCompare(b.name));
  return out;
}
const prioRank = (p) => ({ P0: 0, P1: 1, P2: 2 }[p] ?? 2);

// Reconcile the live queue against the popup's known items. Three rules:
//   1. a fresh stall id not seen before appears -> slide-up animation runs (animate: true)
//   2. an item stays in the queue while (a) the owner hasn't answered it AND (b) it has not been
//      continuously something other than waiting/done-needs-owner for >= 8s AND (c) its stall id
//      hasn't changed
//   3. an item is removed when the owner answers it, OR its non-eligible streak reaches 8s, OR
//      its stall id changed (then the new id is the next item, with a fresh animation)
//
// `now` is ms; the popup calls this on every status tick with the live statuses.
// Returns { items, changed, animate } — items is the new ordered list (name+key), changed is true
// when the order or contents shifted (the popup re-renders), animate is true when at least one new
// id appeared (the popup runs the slide-up).
export function reconcileQueue(prev, statuses, sessions, now = Date.now()) {
  const live = buildQueue(statuses, Object.fromEntries(sessions.map((s) => [s.name, statuses[s.name]?.priority || 'P2'])), sessions, now);
  const liveByKey = new Map(live.map((it) => [it.key, it]));
  const prevByKey = new Map((prev.items || []).map((it) => [it.key, it]));

  const next = [];
  let changed = false;
  let animate = false;
  const keep = new Set();
  for (const it of prev.items || []) {
    const cur = liveByKey.get(it.key);
    if (cur) {
      // still eligible, same id — keep it in its current position; clear any "non-eligible since" timer
      next.push({ ...it, lastEligibleAt: cur.lastEligibleAt, priority: it.priority });
      keep.add(it.key);
    } else if (it.nonEligibleSince) {
      // we saw it go non-eligible already (a working flicker): keep it for up to 8 s
      const elapsed = now - it.nonEligibleSince;
      if (elapsed < 8000) {
        next.push({ ...it });
        keep.add(it.key);
      } else {
        changed = true;
      }
    } else {
      // first tick we miss it: drop immediately (the stall id changed -> new item)
      changed = true;
    }
  }
  // append brand-new ids at the tail, then re-sort by priority (P0 first), then name
  for (const it of live) {
    if (!keep.has(it.key)) { next.push({ ...it, nonEligibleSince: null }); changed = true; animate = true; }
  }
  next.sort((a, b) => prioRank(a.priority) - prioRank(b.priority) || a.name.localeCompare(b.name));
  // re-detect "same stall id, different session" as a fresh item: the byKey map catches renames
  return { items: next, changed, animate };
}

// ---------- AI -> button mapping ----------
// Does the AI's proposed reply map to a button? Returns the button id or null.
//   yesno  : a reply starting with yes/continue/ok -> 'yes'; no/stop -> 'no'. Anything else -> null.
//   menu   : the option whose number or label matches the proposal. The proposal may be
//            "2" / "option 2" / "Release APK" — match by number first, then by case-insensitive
//            trimmed text against the option label.
//   either / open : the AI's proposal lives on its own button (id 'ai'), or 'sug' for Claude's own
//            dim suggestion when the AI proposal is missing. Match by case-insensitive trimmed
//            text against the proposal / suggestion.
const YES_RE = /^\s*(?:yes|y|continue|go|ok(?:ay)?|sure|do it)\b/i;
const NO_RE  = /^\s*(?:no|n|stop|don't|dont|cancel|skip|abort)\b/i;
const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

export function mapAiToButton(buttonList, kind, proposedReply) {
  if (!buttonList || !buttonList.length) return null;
  const ai = String(proposedReply || '').trim();
  if (!ai) return null;
  if (kind === 'yesno') {
    if (YES_RE.test(ai)) return 'yes';
    if (NO_RE.test(ai)) return 'no';
    return null;
  }
  if (kind === 'menu') {
    // match by number prefix: "option 2", "2.", "2)", "2 - ", "2 · ", "2 Release APK", or bare "2".
    // The reviewer may propose just the number on its own, so a trailing separator is optional.
    const numMatch = ai.match(/^\s*option\s+(\d+)|^(\d+)(?:[.\-)\]:|·•]\s+|\s+|$)/);
    if (numMatch) {
      const n = numMatch[1] || numMatch[2];
      const cand = buttonList.find((b) => b.id === `o${n}`);
      if (cand) return cand.id;
    }
    const aiN = normText(ai);
    // strip option number prefix from the candidate label ("2 · Release APK" -> "release apk").
    // Matches "1.", "1)", "1 -", "1 - ", "1 · " too — buttons.js uses " · " (middle dot) but the
    // prefix may be other separators depending on the agent's prompt.
    const matchByLabel = buttonList.find((b) => {
      const labelN = normText(b.label.replace(/^\s*\d+\s*[.\-)\]:|·•]\s*/, ''));
      return labelN && labelN === aiN;
    });
    return matchByLabel ? matchByLabel.id : null;
  }
  // either / open: the AI's proposal is a button called 'ai' (set by buttons.js), text-on-it.
  // If we don't see one (no triage) we look at 'sug'.
  const aiN2 = normText(ai);
  const aiBtn = buttonList.find((b) => b.id === 'ai');
  if (aiBtn && aiBtn.text && normText(aiBtn.text) === aiN2) return 'ai';
  const sug = buttonList.find((b) => b.id === 'sug');
  if (sug && sug.text && normText(sug.text) === aiN2) return 'sug';
  return null;
}
// Whether the proposed highlight should be shown: the button exists, has no `confirm` (i.e. it is
// not on a forbidden topic) and the AI didn't say the owner must answer.
export function shouldHighlight(button, triage) {
  if (!button || button.confirm) return false;
  if (triage?.ai?.owner_needed) return false;
  return true;
}

// ---------- Jev line ----------
// Format the Jev probabilities for the bottom line. `st.stall.jev.probabilities` is
// { continue: 0..1, take_recommended: 0..1, ask_owner: 0..1 } (some may be missing).
// We show only options with probability > 0; renamed to friendlier labels.
// Returns '' when there is nothing to show.
const JEV_LABEL = { continue: 'continue', take_recommended: 'recommended', ask_owner: 'ask you' };
export function jevLine(jev) {
  if (!jev) return '';
  const p = jev.probabilities || {};
  const parts = [];
  for (const k of ['continue', 'take_recommended', 'ask_owner']) {
    if (Number.isFinite(p[k]) && p[k] > 0) parts.push(`${JEV_LABEL[k] || k} ${Math.round(p[k] * 100)}%`);
  }
  return parts.length ? `Jev: ${parts.join(' \u00b7 ')}` : '';
}

// Was Jev's call `continue` or `take_recommended`? Owner agrees when they picked the highlighted
// (positive) answer — Yes for a yes/no, the AI's button for a menu/either.
export function jevAgreesOwner(jevChoice, ownerButtonId, aiButtonId) {
  if (!jevChoice) return null;
  if (jevChoice === 'continue' || jevChoice === 'take_recommended') {
    // agree when the owner picked the AI's highlighted button, OR yes (yesno default positive)
    if (ownerButtonId === 'yes') return true;
    if (aiButtonId && ownerButtonId === aiButtonId) return true;
    return false;
  }
  if (jevChoice === 'ask_owner') {
    // agree when the owner did NOT just rubber-stamp the AI: they picked something else OR replied.
    if (ownerButtonId === 'reply') return true;
    if (aiButtonId && ownerButtonId !== aiButtonId) return true;
    return false;
  }
  return null;
}