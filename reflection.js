// Reflection after an accepted done (owner, 2026-11-26): "when a task is done we should always have that reflection, if and only if the goal was met:
// any leftover, suggestion of improvements". goal-check.js asks it once, after a done is accepted with the goal met. Same day, second rule: "we should
// not say done until i say yes or no for the improvements": only the owner answers, workers included (suggestions.js holds the items). Nobody builds a
// suggestion unasked and nothing answers the choice automatically (manager.js, owner-push.js, server.js). Pure functions only.
// Rule text: AGENTS.md "Reflection after an accepted done".
import { lastStatus } from './status-honesty.js';

// The fixed words of the closing line that hands the choice over. Fixed, so a topic word in a suggestion never turns it into a merge or deploy ask.
export const ASK_WORDS = 'improvement suggestions above, nothing built';
const ASK_LINE = `\`STATUS: needs-owner: ${ASK_WORDS} — should I do <numbers>?\``;

// Pure. -> true when the last STATUS hands the choice of suggestions over, in the fixed words.
export function isReflectionAsk(text) {
  const st = lastStatus(text);
  return !!st && (st.kind === 'needs-owner' || st.kind === 'needs-manager') && /^improvement suggestions\b/i.test(st.text);
}

// One message each, under the 2000 characters the Mac hook's answer carries.
export function reflectionQuestion() {
  return 'Reflection (your done is accepted, goal met; asked once): any leftover, any suggestion of improvement? Answer both, kept apart. '
    + '(a) Leftovers of THIS task (part of the goal unfinished or unverified, something you broke, a stale doc): your done is then not final. Fix them now, end `running` / `waiting` while they are open, and write the done line again when none is left. If there are none, write `Leftovers: none`. '
    + '(b) Improvement suggestions (beyond the goal, things you noticed on the way): build NONE of them and file none. Write `Suggestions:` then a short ranked list, best first: '
    + '`Worth doing:` with numbered items, `Smaller:` numbered on from there, one line each (what and why), then one `Recommendation: <which numbers and why>. Should I do them?` '
    + `With ANY item, worth doing or smaller, end ${ASK_LINE}: the OWNER answers yes or no per item, also when you are a worker (not the manager, not a peer). `
    + 'Only with none at all: write the single line `no suggestions`, then repeat your done line with its Verification block, closing review and bugs field. That is the only reply that leaves you done.';
}
export function openSuggestionsMessage(items = []) {
  return `Status check: you cannot be done, ${items.length} improvement suggestion(s) you listed have no yes or no from the owner (${items.slice(0, 8).map((i) => `${i.n}. ${i.text.slice(0, 60)}`).join(' | ').slice(0, 700)}). `
    + `Build none of them. List them under \`Suggestions:\` with these numbers and end ${ASK_LINE}. Only the owner answers (\`yes 1 3, no 2\`, \`no all\`); a manager or peer message is not the answer, and writing \`no suggestions\` now does not remove them.`;
}
export function missingReplyMessage() {
  return 'Status check: your reply does not answer the reflection question, so you are not done. Either write the single line `no suggestions` above your done line, '
    + `or list them under \`Suggestions:\` (\`Worth doing:\` / \`Smaller:\`, numbered) and end ${ASK_LINE}. One push only.`;
}
