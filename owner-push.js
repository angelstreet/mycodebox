// Owner pushes the manager can send (owner, 2026-10-28: "I keep asking: any leftovers? any suggestion? fix remaining bugs,
// continue, implement. Most of those things don't break anything"). A review of the owner's replies of 2026-10-27 found
// three push shapes besides done-with-leftovers (done-leftovers.js); each is a pure reading of a turn's closing text:
//   suggestions   STATUS done, and the text proposes work the session can do itself ("I'd add ...", "fixes proposed",
//                 "would settle it", "Suggestions:") -> implement the bug fixes and additive ones, list what was skipped
//   routine-ask   STATUS needs-owner / needs-manager asking for a routine step: a host catch-up through update_core /
//                 the deploy queue, an allowlisted restart, a reviewed install with a rollback line, an additive migration,
//                 or a menu whose first option is "yes" / marked recommended -> "yes, do it"
//   blocked-host  STATUS blocked (or a long lease queue) on a host that is locked, down or busy -> use a free one of the
//                 same kind (the manager checks `vpt-lease list` before it sends)
// Hard floor: any item or ask that names deleting data, credentials, money, customers, sudoers, a production host, a
// destructive migration, a force-push / history rewrite or publishing never fires (ownerFloorMatch + FLOOR_EXTRA).
// Nothing here types into a session: the watcher wakes the manager, the manager sends (gates in TASK-44 §5).
import { ownerFloorMatch } from './stall.js';
import { routineRestart } from './routine-restart.js';
import { routineChange } from './host-unit-routine.js';

const STATUS = /^\W*STATUS:\W*([a-z-]+)\b[*_`]*\s*[:.—–-]?\s*(.*)$/i;
const DONE = /^(?:done|ok|complete|completed|finished|shipped)$/i;
// the floor the owner floor leaves to other checks (stall.js hardMatch): still never a push
const FLOOR_EXTRA = /force[- ]?push|--force\b|reset --hard|\brewrit\w*\b[^.\n]{0,20}\bhistory\b|filter-(?:branch|repo)|\bsudo(?:ers)?\b|visudo|(?<!non-)\bprod(?:uction)?\b(?![-/])|\bcustomers?\b|\bpublish\w*|\bpush\w*\b[^.\n]{0,30}\btags?\b|\bdestructive\b|\birreversible\b|\bghosty-sessions\b|\breboot\b|\bshutdown\b|\bsms\b|\bphone\b|\blog ?in\b|\bsign(?:ed)?[- ]in\b|\bprovide\b|\bhardware\b|\bbring \S+ back\b|\bsideload\w*/i;

export function floorOf(text) {
  const t = String(text || '');
  return ownerFloorMatch(t) || (FLOOR_EXTRA.exec(t) || [])[0] || null;
}

// A list header that is done-leftovers.js's job ("Left to do", "Remaining", "Still open", "open:" on the STATUS line).
const LEFTOVER_HEAD = /^\W*(?:left to do|leftovers?|remaining(?: work| items| steps)?|still (?:to do|open)|todo|to do|open items?)\W*:|\bopen\s*:\s*\S/im;
const PROPOSAL = /\bI'?d (?:next |then |also |rather )?(?:add|check|run|fix|build|measure|try|change|replace|implement|write|capture|test|move|split|cache)\b|\bwould (?:settle|fix|confirm|prove|pin (?:it )?down|remove|explain)\b|\b(?:fix(?:es)?|changes?|improvements?) (?:are |were )?proposed\b|\bproposed (?:fix(?:es)?|changes?|improvements?)\b|\bproposals?\b|\bI could (?:also )?(?:add|fix|build|run|write|check|try|implement)\b|\bif you (?:want|like),? I(?:'ll| can| could)\b|^\W*(?:suggestions?|next improvements?|improvement ideas|ideas|follow-?ups?|recommendations?)\W*:/im;

const statusOf = (lines) => {
  let at = -1, m = null;
  lines.forEach((l, i) => { const s = STATUS.exec(l.trim()); if (s) { at = i; m = s; } });
  return m ? { at, kind: m[1].toLowerCase(), text: m[2].trim() } : null;
};
const sentences = (text) => String(text).replace(/[*_`]+/g, '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const clip = (s, n = 200) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Options in an ask: "[1 yes, ... / 2 no, ...]" or "options: 1 ... (recommended), 2 ...". -> { pre, opts: [{n, text, rec}] } | null
export function optionsOf(ask) {
  const s = String(ask || '');
  const m = /(?:\[|\boptions?\s*:\s*|\?\s+)(?=1\s)/i.exec(s);
  if (!m) return null;
  const body = s.slice(m.index + m[0].length).replace(/\]\s*$/, '');
  const parts = body.split(/\s*(?:\/|,|;)\s*(?=\d\s)/);
  const opts = parts.map((p) => { const o = /^(\d)\s+(.*)$/s.exec(p.trim()); return o && { n: +o[1], text: o[2].replace(/\]\s*$/, '').trim(), rec: /\brecommended\b/i.test(o[2]) }; }).filter(Boolean);
  return opts.length >= 2 ? { pre: s.slice(0, m.index).trim(), opts } : null;
}

const UPDATE_HOST = /\bupdate_core(?:\.sh)?\b[^\n]{0,60}--hosts?\s+\S+|\b(?:host deploy|catch-?up to main|bring (?:it|the host|\S+) to main)\b/i;
const SERVICE_STEP = /\b(?:install\w*|restart\w*)\b[^.\n]{0,80}\b(?:service|registry|daemon|timer|unit)\b/i;
const MERGED = /\bmerged\b/i, ROLLBACK = /\brollback\b|\broll(?:s|ed)? back\b|\brevert\b/i;
const ADDITIVE = /\badditive\b[^.\n]{0,30}\bmigrations?\b|\bmigrations?\b[^.\n]{0,60}\b(?:create (?:table|index)|add column|additive)\b/i;
const LOCKED = /\b(?:locked by|is down|are (?:still )?down|unreachable|(?:host|device|box)\w* (?:is |are )?offline|no (?:quiet|free|spare) (?:\w+ )?(?:host|device)|queued behind)\b/i;
const LONG_QUEUE = /\b\d{4,} ?s lease wait\b|\blease wait of (?:[3-9]\d|\d{3,}) ?min/i;
const YES_OPT = /^(?:yes|go|do it|implement|let me|I (?:can |will |'ll )?(?:run|do|fix|capture|implement|apply))\b/i;

// The routine step an ask names, or null. closing: the whole turn text (a rollback line often sits above the STATUS line).
function routineStep(ask, closing) {
  if (UPDATE_HOST.test(ask)) return 'host catch-up through the deploy queue';
  if (routineRestart(ask).routine) return 'allowlisted device-side restart';
  if (routineChange(closing).routine) return 'reviewed install with backup and rollback';
  if (SERVICE_STEP.test(ask) && MERGED.test(closing) && ROLLBACK.test(closing)) return 'install / restart of merged code with a rollback line';
  if (ADDITIVE.test(ask)) return 'additive migration';
  return null;
}

// Pure. text: the closing text of a turn (pane excerpt). -> { kind, items, skipped, step?, option?, why } | null
export function pushOf(text) {
  const raw = String(text || '');
  const lines = raw.split('\n');
  const st = statusOf(lines);
  if (!st) return null;
  const tail = lines.slice(Math.max(0, st.at - 30), st.at + 1).join('\n');

  if (DONE.test(st.kind)) {
    if (LEFTOVER_HEAD.test(tail)) return null;   // done-leftovers.js owns a listed "Left to do"
    const hits = sentences(tail).filter((s) => PROPOSAL.test(s));
    if (!hits.length) return null;
    const items = [], skipped = [];
    for (const s of hits) { const f = floorOf(s); (f ? skipped : items).push(f ? `${clip(s)} (owner: ${f})` : clip(s)); }
    return items.length ? { kind: 'suggestions', items: items.slice(0, 4), skipped, why: 'done with its own proposals' } : null;
  }

  if (st.kind === 'needs-owner' || st.kind === 'needs-manager') {
    const ask = st.text;
    // a menu is answered for needs-manager only: a needs-owner menu (approve a table, a design, a plan) is the owner's review
    const menu = st.kind === 'needs-manager' ? optionsOf(ask) : null;
    if (menu) {
      const pick = menu.opts.find((o) => o.rec) || (YES_OPT.test(menu.opts[0].text) ? menu.opts[0] : null);
      if (!pick) return null;
      const f = floorOf(`${menu.pre} ${pick.text}`);
      if (f) return null;
      return { kind: 'routine-ask', items: [clip(pick.text)], skipped: [], option: pick.n, why: pick.rec ? 'option marked recommended' : 'first option is "yes"' };
    }
    const step = routineStep(ask, tail);
    if (!step || floorOf(ask)) return null;
    return { kind: 'routine-ask', items: [clip(ask)], skipped: [], step, why: step };
  }

  // blocked on a host, or a long lease queue (the manager checks `vpt-lease list` for a free one before it sends)
  const on = st.kind === 'blocked' ? st.text : st.kind === 'waiting' ? tail : '';
  const why = on && sentences(on).find((s) => (st.kind === 'blocked' ? LOCKED : LONG_QUEUE).test(s));
  if (why && !floorOf(why)) return { kind: 'blocked-host', items: [clip(why)], skipped: [], why: st.kind === 'blocked' ? 'blocked on a locked, down or busy host' : 'long lease queue' };
  return null;
}

// The reply the manager sends (it may sharpen it with the facts it checked; the gates stay its own).
export function replyFor(p) {
  if (!p) return null;
  if (p.kind === 'suggestions') return `Implement your own proposals now: ${p.items.join(' | ')}. Do the ones that fix a bug or add something new without breaking anything, verify each, and list what you skip and why. Skip anything that deletes data, touches credentials, money, customers, sudoers, a production host, a destructive migration or a force-push. STATUS: done only when nothing you can do yourself is left.`;
  if (p.kind === 'routine-ask') return p.option
    ? `Yes, option ${p.option}: ${p.items[0]}. It is a routine step (AGENTS.md autonomy, no hard-floor item): do it by the normal procedure (lease first, deploy queue, rollback line), journal it, then continue.`
    : `Yes, do it: ${p.items[0]}. It is a routine step (${p.step}; AGENTS.md autonomy, no hard-floor item): lease first, deploy queue, keep the rollback line, then continue.`;
  if (p.kind === 'blocked-host') return `Do not wait on that host (${p.items[0]}): use a free host or device of the same kind from \`vpt-lease list\` (claim it with --wait), leave the locked one alone, then continue.`;
  return null;
}
