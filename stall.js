// Stall classifier (TASK-44 phase 2): why did an agent session stop, and what would a safe
// answer be? Pure functions over pane lines, no I/O; the manager (manager.js) calls Jev for the
// cases the rules leave ambiguous and logs everything.
//
// Cases
//   continue          the agent asks whether to carry on with work it already planned
//   menu_recommended  a numbered menu where one option is marked recommended
//   permission        a tool permission prompt (run this command? apply this edit?)
//   owner_decision    a real choice only the owner can make
//   done              the turn finished, nothing asked
//   error             usage limit, rate limit, API error
//
// Would-answer: `continue` -> "Yes, continue."; `menu_recommended` -> the option's number in a live
// menu, or "Yes, go with your recommendation." after a finished turn; everything else -> owner.
// A forbidden topic (deploy, push to main, delete, .env, money, customer, credential, ...) or an
// unsent draft in the input box always means owner, whatever the rules or Jev said.

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

const RULE_LINE = /^\s*[─━]{4,}/;
const PROMPT_GLYPH = /^\s*[❯›>]\s?/;
// A narrow pane wraps a line's last char or two onto its own row ("e", "…", "─"): not content.
const FRAGMENT = /^\s*(?:[…─━,.;:)]{1,3}|\S)\s*$/;
const NOISE = /^\s*(?:[✻✶✳✢✽]\s+\S+ for \d|└ Completed in|─+ Worked for|※ recap:|\(disable recaps)|Message · Enter send|bypass permissions|Update installed|\/clear to save|^\s*\/rc\s*$|← for agents|esc to interrupt|for shortcuts|^\s*(?:FULL|Ctx)\b.*│|Ask Mcode|context left/i;

// The input box: the last line that starts with a prompt glyph, within the last 14 lines, below a rule.
function inputLineIndex(lines) {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 14); i--) {
    if (!PROMPT_GLYPH.test(stripAnsi(lines[i]))) continue;
    let j = i - 1;
    while (j > 0 && FRAGMENT.test(stripAnsi(lines[j]))) j--;
    if (j >= 0 && RULE_LINE.test(stripAnsi(lines[j]))) return i;
  }
  return -1;
}

const PLACEHOLDERS = /^(?:Ask Mcode\b.*|Try ".*"|Implement \{feature\}|Message\b.*|Type a message.*)$/i;

// rawLines = pane lines WITH ansi. Dim text (SGR 2) after the glyph is Claude's prompt suggestion,
// not something the owner typed. Returns { draft, suggestion } (strings or null).
export function inputBox(rawLines) {
  const i = inputLineIndex(rawLines);
  if (i < 0) return { draft: null, suggestion: null };
  const raw = rawLines[i];
  const dim = [];
  const notDim = raw.replace(/\x1b\[2m([\s\S]*?)(?:\x1b\[(?:0|22)?m|$)/g, (_, t) => { dim.push(stripAnsi(t)); return ''; });
  const draft = stripAnsi(notDim).replace(PROMPT_GLYPH, '').trim();
  const suggestion = dim.join(' ').replace(/\s+/g, ' ').trim();
  return {
    draft: draft && !PLACEHOLDERS.test(draft) ? draft : null,
    suggestion: suggestion && !PLACEHOLDERS.test(suggestion) ? suggestion : null,
  };
}

// Body = everything above the input box's top rule (or the whole pane when there is no box).
export function bodyLines(plain) {
  const i = inputLineIndex(plain);
  let end = i > 0 ? i - 1 : plain.length;
  while (i > 0 && end > 0 && !RULE_LINE.test(plain[end])) end--;
  return plain.slice(0, end);
}

// The agent's closing text: last `n` meaningful lines of the body, chrome and timers dropped,
// stopping at the previous user prompt line.
export function closingLines(plain, n = 16) {
  const body = bodyLines(plain);
  const out = [];
  for (let i = body.length - 1; i >= 0 && out.length < n; i--) {
    const l = body[i];
    if (!l.trim() || NOISE.test(l) || RULE_LINE.test(l)) continue;
    if (FRAGMENT.test(l) && i > 0 && body[i - 1].trim()) {
      // a wrapped tail: glue it to the line above (unless that line is chrome)
      if (!/^[…─━]+$/.test(l.trim())) body[i - 1] = body[i - 1].replace(/\s+$/, '') + l.trim();
      continue;
    }
    if (/^\s*[❯›]\s+\S/.test(l) && !/^\s*[❯›]\s+\d+[.)]\s/.test(l)) break;   // the owner's previous prompt (not a menu cursor)
    out.unshift(l.replace(/^\s*[⏺●•]\s+/, '').replace(/\s+$/, ''));
  }
  return out;
}

// Joins wrapped lines into paragraphs; the last paragraph is what the agent ended on.
function lastParagraph(lines) {
  const text = lines.map((l) => l.trim()).join('\n');
  const paras = text.split(/\n(?=\s*(?:\d+[.)]\s|[-*]\s))|\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  return paras.length ? paras[paras.length - 1] : '';
}

// Only the agent CLI's own error lines, not prose that mentions a limit.
export const ERROR_RE = /^\s*(?:⎿\s*)?(?:You'?ve hit your|.*\busage limit (?:reached|·|\|)|.*\blimit reached\b.*resets|API Error\b|.*\boverloaded_error\b|.*\brate_limit_error\b|Credit balance is too low|Request timed out|■ (?:You'?ve hit|stream error|unexpected status))/i;
const PERMISSION_RE = /Do you want to (?:proceed|make this edit|create|run|allow|overwrite)|Would you like to (?:run|allow|make)|Yes, and don'?t ask again|Allow (?:command|this|once|always)|Apply (?:this )?(?:patch|changes)\?|Run this command\?|Approve\?/i;
const LIVE_MENU_RE = /Enter to (?:select|confirm)|↑\/↓ to navigate|Esc to cancel/i;
const OPTION_RE = /^\s*(?:[❯›>]\s*)?(\d+)[.)]\s+(.*)$/;
const RECOMMENDED_RE = /\(recommended\)|\brecommended\b\s*[:)]?$|^recommended\b/i;
const CONTINUE_Q = /\b(?:shall|should|can|may) I (?:continue|proceed|go ahead|keep going|carry on|move on|start (?:on )?(?:it|that|phase|step|the next))|\bwant me to (?:continue|proceed|go ahead|keep going|carry on|start (?:on )?(?:it|phase|step|the next)|move on)|\bready (?:to|for me to) (?:continue|proceed|move on)|\b(?:continue|proceed|go ahead)\?\s*$|\bnext (?:phase|step)\?\s*$|\bok to (?:continue|proceed)\b/i;
const DECISION_Q = /^which\b|\bwhich (?:one|option|approach|do you|would you|should)\b|\bwould you (?:rather|prefer|like me to)\b|\bor (?:should I|do you|would you|leave|keep|wait|not)\b|\bdo you want (?:me to )?\S.*\bor\b|\byour call\b|\bprefer\b/i;
const NEXT_STEP = /\bnext(?::| is| step| phase| I'?d| I will| I'll)|\bI'?ll (?:now|next|then)\b|\bthen I(?:'ll| will)\b|\bstill to do\b|\bremaining\b/i;

export const FORBIDDEN_RE = /\bdeploy|update_core|\brollout\b|systemctl (?:restart|stop|start)|pm2 (?:restart|stop|delete)|\brestart (?:the )?(?:service|server|unit|host)|\bpush(?:ed|ing)?\b[^.\n]{0,30}\bmain\b|\bmerge\b[^.\n]{0,30}\bmain\b|\bgit push\b|force[- ]?push|reset --hard|\bdelet(?:e|ing|ion)\b|\bremov(?:e|ing)\b|\brm -r|\bdrop (?:table|database|schema)|\bprune\b|\btruncate\b|\bmigrat(?:e|ion)|\.env\b|credential|password|passphrase|\bsecret|access token|auth token|bearer\b|\bapi[_ -]?key|ssh key|private key|\bmoney\b|\bpay(?:ment|ing)?\b|\bpurchase|\bbuy\b|\bbilling\b|\binvoice|credit card|add credit|\bcustomer/i;

let forbiddenExtra = null;
// Extra forbidden words that must not live in a public repo (customer names, ...): GHOSTY_FORBIDDEN_EXTRA.
export function setForbiddenExtra(pattern) {
  forbiddenExtra = pattern ? new RegExp(pattern, 'i') : null;
}

export function forbiddenMatch(text) {
  const m = String(text).match(FORBIDDEN_RE) || (forbiddenExtra && String(text).match(forbiddenExtra));
  return m ? m[0] : null;
}

function menuOptions(lines) {
  const opts = [];
  for (const l of lines) {
    const m = l.match(OPTION_RE);
    if (m) opts.push({ n: Number(m[1]), text: m[2].trim() });
  }
  return opts;
}

// plain = ANSI-stripped pane lines; raw = the same lines with ANSI (for the input box);
// state = ghosty state ('waiting' | 'done' | 'idle' | ...).
// Returns { case, source: 'rule'|'ambiguous', answer, question, forbidden, draft, suggestion, excerpt }.
export function classifyStall({ plain, raw = null, state }) {
  const close = closingLines(plain, 16);
  const tail = close.slice(-8);
  const excerpt = close.join('\n');
  const { draft, suggestion } = inputBox(raw || plain);
  const out = { case: null, source: 'rule', answer: null, question: null, forbidden: null, draft, suggestion, excerpt };

  if (tail.slice(-3).some((l) => ERROR_RE.test(l))) {
    out.case = 'error';
    out.question = tail.filter((l) => ERROR_RE.test(l)).pop().trim();
    return finish(out);
  }

  if (state === 'waiting') {
    const block = close.slice(-14);
    const opts = menuOptions(block);
    out.question = (block.slice().reverse().find((l) => /\?\s*$/.test(l) && !OPTION_RE.test(l)) || block[block.length - 1] || '').trim();
    const rec = opts.find((o) => RECOMMENDED_RE.test(o.text));
    if (PERMISSION_RE.test(block.join('\n'))) out.case = 'permission';
    else if (rec && (LIVE_MENU_RE.test(block.join('\n')) || opts.length >= 2)) { out.case = 'menu_recommended'; out.answer = { key: String(rec.n) }; }
    else out.case = 'owner_decision';
    out.forbiddenText = block.join('\n');
    return finish(out);
  }

  // A finished turn: what did the agent end on?
  const last = lastParagraph(close);
  out.question = last.slice(-300);
  // A question anywhere in the closing paragraph ("Can I run it? After that I'd ...").
  const asks = /\?(?:["')\]]|\s|$)/.test(last.replace(/https?:\S+/g, ''));
  const opts = menuOptions(close);
  const rec = opts.find((o) => RECOMMENDED_RE.test(o.text)) || (/\bI(?:'d| would)? recommend (?:option )?(\d)\b/i.exec(close.join(' ')) && { n: Number(/\bI(?:'d| would)? recommend (?:option )?(\d)\b/i.exec(close.join(' '))[1]) });
  out.forbiddenText = close.slice(-6).join('\n');
  if (asks) {
    if (opts.length >= 2 && rec) { out.case = 'menu_recommended'; out.answer = { text: 'Yes, go with your recommendation.' }; }
    else if (opts.length >= 2 || DECISION_Q.test(last)) out.case = 'owner_decision';
    else if (CONTINUE_Q.test(last)) { out.case = 'continue'; out.answer = { text: 'Yes, continue.' }; }
    else { out.case = 'owner_decision'; out.source = 'ambiguous'; }
  } else if (NEXT_STEP.test(close.slice(-4).join(' '))) {
    // Stopped while announcing a next step: maybe it should just carry on.
    out.case = 'done'; out.source = 'ambiguous';
  } else out.case = 'done';
  return finish(out);
}

function finish(out) {
  out.forbidden = forbiddenMatch(out.forbiddenText ?? out.question ?? '');
  delete out.forbiddenText;
  return out;
}

// Apply a Jev decision (continue | take_recommended | ask_owner) to an ambiguous stall.
export function applyJev(stall, choice) {
  const s = { ...stall, source: 'jev', jevChoice: choice };
  if (choice === 'continue') { s.case = 'continue'; s.answer = { text: 'Yes, continue.' }; }
  else if (choice === 'take_recommended') { s.case = 'menu_recommended'; s.answer = { text: 'Yes, go with your recommendation.' }; }
  else { s.case = s.case === 'done' ? 'done' : 'owner_decision'; s.answer = null; }
  return s;
}

// The final gate: what would actually be typed. Forbidden topics, drafts and owner cases never are.
export function wouldSend(stall) {
  if (!stall.answer) return { send: null, why: stall.case === 'done' ? 'finished' : 'owner' };
  if (stall.forbidden) return { send: null, why: `forbidden: ${stall.forbidden}` };
  if (stall.draft) return { send: null, why: 'owner has a draft in the input box' };
  return { send: stall.answer, why: stall.case };
}

// What the owner actually did next, reduced to the same vocabulary, for the shadow-mode report.
export function outcomeKind(text) {
  const t = String(text || '').trim();
  if (!t) return 'unknown';
  if (/^\d$/.test(t) || /^(?:go with|take) (?:your |the )?(?:recommend|option \d)/i.test(t)) return 'take_recommended';
  if (t.length <= 40 && /^(?:y|yes|yep|yeah|ok|okay|sure|go|go ahead|continue|proceed|carry on|keep going|do it|please do|yes,? (?:continue|go ahead|please|do it|proceed))\b[.!]*$/i.test(t)) return 'continue';
  return 'owner_specific';
}
