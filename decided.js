// "Decided for you" (round 8, OWNER_DECISIONS §15): everything the manager typed on the owner's behalf, newest first, with the
// reason, the evidence and the way back. Pure: the caller reads stalls.jsonl and the decision journal and passes the records.
// Item: { id, at, session, kind, what, why, evidence: [], revert: { label, text } | null, url }
//   kind: continue | menu | ai_reply | info | merge | push | deploy
import { short } from './merge-policy.js';

export const KINDS = ['merge', 'push', 'deploy', 'menu', 'continue', 'ai_reply', 'info'];
const DECISION_KINDS = ['merge', 'push', 'deploy'];
const ms = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return v; const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const quote = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
// A pick is product-visible when its option or question names something the user sees: UI, wording, defaults, release notes (round 9, item 3).
const PRODUCT_RE = /\b(?:pages?|buttons?|themes?|colou?rs?|fonts?|layouts?|wording|copy|defaults?|release[- ]notes?|screenshots?|mock-?ups?|ui|ux|icons?|labels?|headings?|tabs?|menus?|dialogs?|popups?|banners?|dark mode|light mode|styles?|styling|typography|spacing|animations?|tooltips?|toasts?)\b/i;
export const productVisible = (item) => !!item && item.kind !== 'merge' && item.kind !== 'push' && item.kind !== 'deploy' && PRODUCT_RE.test([item.pick, item.question, item.what].filter(Boolean).join(' '));
const urlOf = (session) => `/?s=${encodeURIComponent(session || '')}`;

export const correctionDraft = (answer) => `Correction to the answer the manager gave you ("${quote(answer)}"): `;

// The revert text the owner sends (merge / push / deploy) or the draft they edit (everything else).
export function revertOf(kind, j, answerText) {
  if (kind === 'merge') {
    const branch = j?.branch || 'the branch', target = j?.target || 'the target branch';
    return { label: 'Revert merge', text: `Revert the merge the manager approved: git revert -m 1 the merge commit of ${branch} on ${target}, run the tests, push.` };
  }
  if (kind === 'push') {
    const dest = j?.dest || j?.branch || 'the remote branch', from = short(j?.remote_sha || j?.branch_sha);
    return { label: 'Revert push', text: `Revert the commits the manager approved pushing to ${dest} (${from ? from + '..' : 'the pushed range'}): git revert, run the tests, push.` };
  }
  if (kind === 'deploy') return { label: 'Roll back', text: j?.rollback || 'Rollback: request a deploy of the previous release.' };
  return { label: 'Correct', text: correctionDraft(answerText) };
}
// What POST /api/manager/decided/:id/revert does for an item, given the session's facts { exists, state, draft, menu, reverted }:
// { status: 200, draft, label } (a draft for the owner to edit: nothing is sent), { status: 200, send: text } or { status: 404|409, error }.
// A revert is typed into a session that finished its turn (done), with no live menu and no draft, and once per item.
export function revertPlan(item, { exists = false, state = null, draft = false, menu = false, reverted = false } = {}) {
  if (!item) return { status: 404, error: 'unknown decided item' };
  if (!item.revert) return { status: 409, error: 'nothing to revert' };
  if (!DECISION_KINDS.includes(item.kind)) return { status: 200, draft: item.revert.text, label: item.revert.label };
  if (reverted) return { status: 409, error: 'already reverted' };
  if (!exists) return { status: 409, error: 'the session no longer exists' };
  if (state !== 'done') return { status: 409, error: 'the session is not stopped with a finished turn' };
  if (menu) return { status: 409, error: 'the session shows a menu: free text would pick an option' };
  if (draft) return { status: 409, error: 'the session has an unsent draft in its input box' };
  return { status: 200, send: item.revert.text };
}
export const isRevertable = (item) => !!item && DECISION_KINDS.includes(item.kind) && !!item.revert;
export const revertTextOf = (item) => (isRevertable(item) ? item.revert.text : null);

const whatOf = (kind, session, j, answerText) => {
  const s = session || 'the session';
  if (kind === 'merge') return `approved the merge of ${j?.branch || 'a branch'} into ${j?.target || 'its target'} for ${s}`;
  if (kind === 'push') return `approved pushing ${j?.branch || 'a branch'} to origin/${j?.dest || j?.branch || 'its branch'} for ${s}`;
  if (kind === 'deploy') return `approved requesting the deploy of ${j?.ref || 'a ref'} to ${j?.env || 'an environment'} (${j?.scope || 'full'}) for ${s}`;
  if (kind === 'ai_reply') return `sent the AI reviewer's reply "${quote(answerText)}" to ${s}`;
  if (kind === 'info') return `answered a question from the docs for ${s}: "${quote(answerText)}"`;
  return `answered ${answerText.startsWith('option ') ? answerText : `'${quote(answerText)}'`} to ${s}`;
};
const whyOf = (kind, j, stall, rec) => {
  if (j?.rationale && DECISION_KINDS.includes(kind)) return String(j.rationale);
  if (kind === 'continue') return 'the agent asked whether to carry on with work it already planned';
  if (kind === 'menu') return 'the agent recommended one of the options';
  if (kind === 'ai_reply') return 'the AI reviewer proposed this reply and was confident';
  if (kind === 'info') return 'the information was in the repository docs';
  return stall?.why || rec?.case || 'decided by the manager';
};

// recs: stalls.jsonl records; journal: manager-decisions.jsonl (+ legacy merge-decisions.jsonl) records.
export function decidedItems({ recs = [], journal = [], since = null, until = null } = {}) {
  const lo = ms(since), hi = ms(until);
  const stalls = new Map(), lastCancel = new Map();
  recs.forEach((r, i) => {
    if (r?.type === 'stall' && r.id) stalls.set(r.id, r);
    else if (r?.type === 'answer_cancelled' && r.id) lastCancel.set(r.id, i);   // an answer counts unless it came before the id's last cancellation (held, then sent, counts)
  });
  const jById = new Map();
  for (const j of journal) if (j?.decision_id) jById.set(j.decision_id, j);
  const items = [];
  for (const [idx, r] of recs.entries()) {
    if (r?.type !== 'answer' || !r.id || (lastCancel.has(r.id) && lastCancel.get(r.id) > idx)) continue;
    const at = ms(r.at);
    if (at == null || (lo != null && at < lo) || (hi != null && at > hi)) continue;
    const stall = stalls.get(r.id);
    const answerText = r.answer?.text != null ? String(r.answer.text) : `option ${r.answer?.key}`;
    const ids = [...new Set([...(r.decision_ids || []), ...(r.merge_decision_id ? [r.merge_decision_id] : [])])];
    const js = ids.map((i) => jById.get(i)).filter(Boolean).filter((j) => DECISION_KINDS.includes(j.kind) && j.chosen === j.kind);
    const mk = (id, kind, what, why, evidence, revert, extra = {}) => {
      const it = { id, at: new Date(at).toISOString(), session: r.session || '', kind, what, why, evidence, revert, url: urlOf(r.session) };
      for (const [k, v] of Object.entries(extra)) Object.defineProperty(it, k, { value: v, enumerable: false });   // pick / question: for productVisible and the summary, not part of the item's JSON
      return it;
    };
    if (js.length) {
      for (const j of js) {
        const kind = j.kind;
        items.push(mk(js.length === 1 ? r.id : `${r.id}:${kind}`, kind, whatOf(kind, r.session, j, answerText), whyOf(kind, j, stall, r),
          Array.isArray(j.evidence) ? j.evidence.map(String) : [], revertOf(kind, j, answerText)));
      }
      continue;
    }
    const kind = r.source === 'ai' ? 'ai_reply' : r.source === 'manager_decision' ? 'info' : r.answer?.key != null || r.case === 'menu_recommended' ? 'menu' : 'continue';
    const mj = kind === 'menu' ? jById.get(`menu-${r.id}`) : null;   // the menu pick's own decision record
    items.push(mk(r.id, kind, mj ? `took the ${mj.unmarked ? 'unmarked first option' : 'recommended option'} ${mj.key ?? ''} ("${quote(mj.option)}") for ${r.session || 'the session'}`.replace('option  (', 'option (') : whatOf(kind, r.session, null, answerText),
      mj ? mj.rationale : whyOf(kind, null, stall, r),
      mj ? mj.evidence.map(String) : stall?.excerpt ? [`stop: ${quote(stall.question || stall.excerpt)}`] : [], revertOf(kind, null, answerText),
      { pick: quote(mj ? mj.option : answerText), question: quote(mj ? mj.question : stall?.question || '') }));
  }
  for (const it of items) it.productVisible = productVisible(it);   // after the other fields: the item's JSON gains one flag
  // product-visible picks first (the owner reviews those at the end), each group newest first
  return items.sort((a, b) => (b.productVisible - a.productVisible) || Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : -1));
}

// Send failures in the window (replies the manager could not type): the digest says "Nothing failed" only when there were none.
export function failedCount(recs = [], { since = null, until = null } = {}) {
  const lo = ms(since), hi = ms(until);
  return recs.filter((r) => r?.type === 'answer_cancelled' && /^send failed/.test(String(r.reason || '')) && (lo == null || ms(r.at) >= lo) && (hi == null || ms(r.at) <= hi)).length;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const names = (xs) => { const u = [...new Set(xs)]; return u.length <= 3 ? u.join(', ') : `${u.slice(0, 3).join(', ')} and ${u.length - 3} more`; };
// A short plain-English paragraph, deterministic, at most 600 characters.
export function decidedSummary(items = [], { hours = 24, failed = 0 } = {}) {
  const win = hours === 1 ? 'the last hour' : `the last ${hours} hours`;
  const byKind = Object.fromEntries(KINDS.map((k) => [k, items.filter((i) => i.kind === k).length]).filter(([, n]) => n > 0));
  const count = items.length;
  if (!count) return { count: 0, byKind, text: `Nothing was decided for you in ${win}.${failed ? ` ${plural(failed, 'reply', 'replies')} could not be sent.` : ''}`.slice(0, 600) };
  const pv = items.filter((i) => i.productVisible);
  const rest = items.filter((i) => !i.productVisible);
  const of = (k) => rest.filter((i) => i.kind === k);
  const bits = [];
  if (pv.length) bits.push(`${plural(pv.length, 'product-visible pick', 'product-visible picks')}: ${pv.slice(0, 3).map((i) => `"${quote(i.pick).slice(0, 40)}" (${i.session || 'a session'})`).join(', ')}${pv.length > 3 ? ` and ${pv.length - 3} more` : ''}`);
  for (const k of KINDS) {
    const xs = of(k); if (!xs.length) continue;
    const who = names(xs.map((i) => i.session));
    if (k === 'merge') bits.push(`${plural(xs.length, 'merge', 'merges')} (${who})`);
    else if (k === 'push') bits.push(`${plural(xs.length, 'push', 'pushes')} (${who})`);
    else if (k === 'deploy') bits.push(`${plural(xs.length, 'deploy', 'deploys')} of ${names(xs.map((i) => (/ to (\S+) \(/.exec(i.what) || [])[1] || 'an environment'))}`);
    else if (k === 'menu') bits.push(plural(xs.length, 'menu pick', 'menu picks'));
    else if (k === 'continue') bits.push(plural(xs.length, 'continue', 'continues'));
    else if (k === 'ai_reply') bits.push(plural(xs.length, 'AI reply', 'AI replies'));
    else bits.push(plural(xs.length, 'information answer', 'information answers'));
  }
  const tail = failed ? `${plural(failed, 'reply', 'replies')} could not be sent.` : 'Nothing failed.';
  const text = `In ${win} the manager decided ${plural(count, 'thing', 'things')} for you: ${bits.join(', ')}. ${tail}`;
  return { count, byKind, text: text.length > 600 ? `${text.slice(0, 597)}...` : text };
}
