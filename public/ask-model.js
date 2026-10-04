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
import { needsOwner, parseQuestionForm, parseMultiReply, formatMultiAnswer, clip } from './buttons.js';

// Same predicate renderAttention() (NEEDS YOU strip) uses: a waiting session, or a finished one whose
// closing question the AI reviewer sent to the owner (triage done / skipped / error, not pending).
export function isOwnersTurn(st) {
  if (!st) return false;
  if (st.state === 'waiting') return true;
  return st.state === 'done' && needsOwner(st) && !!st.triage && st.triage.state !== 'pending';
}

// The id that ties status flickers together. stall.id (the manager's stop id) wins, then triage.id.
// A waiting session the manager has not classified yet has neither: a weak id ('~' prefix) made of the
// session + its wait reason stands in, and is adopted silently when the real id arrives (no re-animation).
export function stallId(st) {
  return st?.stall?.id || st?.triage?.id || null;
}
const weakId = (name, st) => `~${name}|${String(st?.waitReason || st?.stall?.question || '').slice(0, 80)}`;

const prioRank = (p) => ({ P0: 0, P1: 1, P2: 2 }[p] ?? 2);
const byPrio = (a, b) => prioRank(a.priority) - prioRank(b.priority) || a.name.localeCompare(b.name);

// The live queue: every session that needs the owner now, P0 first (the strip's order).
export function buildQueue(statuses, prios, sessions) {
  const out = [];
  for (const s of sessions) {
    const st = statuses[s.name];
    if (!isOwnersTurn(st)) continue;
    const real = stallId(st);
    const id = real || weakId(s.name, st);
    out.push({ name: s.name, id, weak: !real, key: `${s.name}\x1f${id}`, priority: st?.priority || prios?.[s.name] || 'P2' });
  }
  return out.sort(byPrio);
}

export const KEEP_MS = 8000;

// Reconcile the popup's items against the live statuses. An item stays until (a) the owner answered it
// (a send to that session, from the popup or anywhere), (b) its session has been something other than
// waiting / done-needs-owner continuously for >= KEEP_MS, or (c) its stall id changed (that is a new item).
// prev = { items, answered: Map<key, ts> }. Returns { items, answered, changed, added } where `added` are
// items whose key was not in prev (the popup animates only for ids it has never shown).
export function reconcileQueue(prev, statuses, sessions, now = Date.now()) {
  const live = buildQueue(statuses, {}, sessions);
  const answered = new Map(prev.answered || []);
  for (const [k, t] of answered) if (now - t > 10 * 60 * 1000) answered.delete(k);
  const liveByKey = new Map(live.map((it) => [it.key, it]));
  const liveByName = new Map(live.map((it) => [it.name, it]));
  const next = [];
  const kept = new Set();
  for (const it of prev.items || []) {
    const cur = liveByKey.get(it.key);
    const byName = liveByName.get(it.name);
    if (cur && !answered.has(cur.key)) {
      next.push({ ...it, priority: cur.priority, nonEligibleSince: null }); kept.add(cur.key);
    } else if (cur) {
      // answered: stays gone while the same stop is still on screen
    } else if (it.weak && byName && !byName.weak && !answered.has(byName.key)) {
      next.push({ ...it, id: byName.id, key: byName.key, weak: false, priority: byName.priority, nonEligibleSince: null }); kept.add(byName.key);   // weak id upgraded in place
    } else if (byName) {
      // eligible again but under another stall id: c) it is a new item, this one is gone
    } else {
      const st = statuses[it.name];
      const sid = stallId(st);
      if (!st || (sid && sid !== it.id && !it.weak)) continue;   // session gone, or a different stop took over
      const since = it.nonEligibleSince ?? now;
      if (now - since < KEEP_MS) next.push({ ...it, nonEligibleSince: since });
    }
  }
  const added = [];
  for (const it of live) {
    if (kept.has(it.key) || answered.has(it.key)) continue;
    const item = { ...it, nonEligibleSince: null };
    next.push(item); added.push(item);
  }
  next.sort(byPrio);
  const sig = (l) => l.map((x) => x.key).join('|');
  return { items: next, answered, changed: sig(next) !== sig(prev.items || []), added };
}

// The owner answered this item (or sent to its session): it leaves the queue until its stop id changes.
export function markAnswered(prev, name, now = Date.now()) {
  const answered = new Map(prev.answered || []);
  const items = [];
  for (const it of prev.items || []) {
    if (it.name === name) answered.set(it.key, now); else items.push(it);
  }
  return { items, answered };
}

// ---------- AI -> button mapping ----------
// Does the AI's proposed reply map to a button? Returns the button id or null.
//   yesno  : a reply starting with yes/continue/ok -> 'yes'; no/stop -> 'no'. Anything else -> null.
//   menu   : the option whose number or label matches the proposal. The proposal may be
//            "2" / "option 2" / "Release APK" — match by number first, then by case-insensitive
//            trimmed text against the option label.
//   either / open : the AI's proposal lives on its own button (id 'ai'). Claude's own dim suggestion is never a button. For an either question with parsed
//            lettered/phrase alternatives, the proposal may start with a letter ("A" / "B") or
//            name one of the phrases — match that alts-button too (it's flagged `ai: true` by
//            buttons.js so the popup can highlight it).
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
  // either with parsed alts: id 'oA'/'oB'/... marked ai:true, OR match the letter/phrase.
  const aiFlag = buttonList.find((b) => b.ai);
  if (aiFlag) return aiFlag.id;
  const letterMatch = ai.match(/^\s*([A-D])\b/);
  if (letterMatch) {
    const cand = buttonList.find((b) => b.id === `o${letterMatch[1]}`);
    if (cand) return cand.id;
  }
  // either / open: the AI's proposal is a button called 'ai' (set by buttons.js), text-on-it.
  const aiBtn = buttonList.find((b) => b.id === 'ai');
  if (aiBtn && aiBtn.text && normText(aiBtn.text) === normText(ai)) return 'ai';
  return null;
}
// Whether the proposed highlight should be shown: the button exists, has no `confirm` (i.e. it is
// not on a forbidden topic) and the AI didn't say the owner must answer.
export function shouldHighlight(button, triage) {
  if (!button || button.confirm) return false;
  if (triage?.ai?.owner_needed || triage?.ai?.forbidden) return false;
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

// ---------- Why (expandable AI + Jev opinion) ----------
// Plain English for the Jev choice keys, used in the expanded Why section.
const JEV_PLAIN = { continue: 'continue', take_recommended: 'take recommended', ask_owner: 'ask you' };

// Returns { ai: { present, label, conf, reasoning }, jev: { present, choice, label, probs } }
// for the expandable "Why" section. `present: false` means the model wasn't run yet / Jev was
// not asked — the section still renders (showing "not run yet" / "not asked") so the owner
// sees both machine opinions before deciding.
export function whyModel(st) {
  const ai = st?.triage?.ai || null;
  const jev = st?.stall?.jev || null;
  const aiOut = ai
    ? {
        present: true,
        label: (ai.proposed_reply && !ai.owner_needed) ? ai.proposed_reply : 'yours to decide',
        conf: Number.isFinite(ai.confidence) ? ai.confidence : null,
        reasoning: ai.owner_needed ? (ai.owner_needed_why || 'needs owner') : (ai.reasoning || ''),
      }
    : { present: false, label: '', conf: null, reasoning: '' };
  const jevOut = jev
    ? {
        present: true,
        choice: jev.choice || null,
        label: jev.choice ? (JEV_PLAIN[jev.choice] || jev.choice) : '',
        probs: {
          continue: Number.isFinite(jev.probabilities?.continue) ? jev.probabilities.continue : 0,
          take_recommended: Number.isFinite(jev.probabilities?.take_recommended) ? jev.probabilities.take_recommended : 0,
          ask_owner: Number.isFinite(jev.probabilities?.ask_owner) ? jev.probabilities.ask_owner : 0,
        },
      }
    : { present: false, choice: null, label: '', probs: { continue: 0, take_recommended: 0, ask_owner: 0 } };
  return { ai: aiOut, jev: jevOut };
}

// Was Jev's call `continue` or `take_recommended`? Owner agrees when they picked the highlighted
// (positive) answer — Yes for a yes/no, the AI's button for a menu/either.
export function jevAgreesOwner(jevChoice, ownerButtonId, aiButtonId) {
  if (!jevChoice) return null;
  if (jevChoice === 'continue' || jevChoice === 'take_recommended') {
    // agree when the owner picked the AI's highlighted button, OR yes (yesno default positive)
    if (ownerButtonId === 'yes' || ownerButtonId === 'continue') return true;
    if (aiButtonId && ownerButtonId === aiButtonId) return true;
    return false;
  }
  if (jevChoice === 'ask_owner') {
    // agree when the owner did NOT just rubber-stamp the AI: they picked something else OR replied.
    return ownerButtonId === 'reply' || ownerButtonId !== aiButtonId;
  }
  return null;
}
// ---------- Details (last ~300 characters of the stop's closing text) ----------
// Prefers stall.excerpt, else stall.question. Returns '' when there is none. Starts with '…' when cut.
export const DETAILS_CHARS = 300;
export function detailsText(stall, max = DETAILS_CHARS) {
  const t = String(stall?.closing || stall?.excerpt || stall?.question || '').replace(/\r/g, '').trim();
  if (!t) return '';
  return t.length > max ? `…${t.slice(-max).trimStart()}` : t;
}

// ---------- multi-question form ----------
// The closing text carries >= 2 numbered questions that each have parsed "(1) a, (2) b" options (stall.closing is the
// long closing text, stall.excerpt the 16-line tail). The AI reviewer's per-question picks are optional:
// triage.ai.picks = { "1": "2", ... } or, when absent, proposed_reply written as "1: 2, 2: 1". No picks -> nothing highlighted.
// -> { questions: [{ n, label, options: [{ n, text, short, recommended, ai }], aiPick }], aiPicks } | null
export function multiFormModel(stall, triage) {
  const qs = parseQuestionForm(stall?.closing || stall?.excerpt || stall?.question || '');
  if (!qs) return null;
  const ai = triage?.ai || null;
  let picks = {};
  if (ai && !ai.owner_needed && !ai.forbidden) {
    if (ai.picks && typeof ai.picks === 'object' && !Array.isArray(ai.picks)) for (const [k, v] of Object.entries(ai.picks)) picks[String(k)] = String(v);
    else picks = parseMultiReply(ai.proposed_reply);
  }
  const questions = qs.map((q) => {
    const pick = q.options.some((o) => String(o.n) === picks[q.n]) ? picks[q.n] : null;
    return { n: q.n, label: clip(q.label, 80), options: q.options.map((o) => ({ n: String(o.n), text: o.text, short: clip(o.text, 24), recommended: o.recommended, ai: pick === String(o.n) })), aiPick: pick };
  });
  const aiPicks = {};
  for (const q of questions) if (q.aiPick) aiPicks[q.n] = q.aiPick;
  return { questions, aiPicks };
}

// The send string: "1: 1, 2: 1, 3: 1" (question order; unpicked questions are left out).
export const multiSendText = (picks, form) => formatMultiAnswer(picks, form.questions);
export const multiComplete = (picks, form) => form.questions.every((q) => picks[q.n] != null);
