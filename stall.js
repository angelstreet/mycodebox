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
//   stopped_short     the agent announced its next step and stopped, no question, no blocker
//   waiting_deploy    waiting for leases / a deploy / the owner's go-ahead to deploy (never auto-answered)
//   owner_action      the agent asks the owner for a small manual thing (reload, plug, press)
//   own_job_wait      STATUS blocked|waiting on a job of the session's own (pid, log, run id): woken when it ends, never a needs-you
// Any finished turn also carries `no_status` (closing text gives no done / tested / left / next / blocked
// information); that is a flag, not a case, with an `ask_status` would-answer candidate.
//
// Would-answer: `continue` -> "Yes, continue."; `menu_recommended` -> the option's number in a live
// menu, or "Yes, go with your recommendation." after a finished turn; everything else -> owner.
// A forbidden topic (deploy, push to main, delete, .env, money, customer, credential, ...) or an
// unsent draft in the input box always means owner, whatever the rules or Jev said.

import { waitsOnOwnJob, jobRefs, hasRef } from './job-refs.js';

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

// Claude Code shows an optional feedback survey at the bottom of the pane ("How is Claude
// doing this session? (optional)" + a line of 0/1/2/3 rating options that may wrap to 1-2
// extra rows in narrow panes). The session is still working while it renders, so the survey
// alone must never produce a question, menu or options, and never make a stall.
const SURVEY_HEADER = /^\W*how is claude doing this session\?\s*\(optional\)/i;
// Survey rating token: "N:" (N = 0..3), optionally followed by a rating word (Bad, Fine,
// Good, Dismiss) or a wrapped fragment (Dis, miss, goo miss, good miss). The word part is
// optional so glued forms like "3:    0: Dis" still match (the "3:" is left dangling for
// the next row).
const SURVEY_TOKEN = '[0-3]:(?:\\s*(?:Bad|Fine|Good|Dismiss|Dis\\b|miss\\b|goo\\s*miss|good\\s*miss))?';
const SURVEY_OPTION = new RegExp(`^\\s*(?:${SURVEY_TOKEN}\\s*){1,5}$`, 'i');
// A wrapped fragment of a survey option line: just one or more survey words, no "N:"
// (e.g. "Good  miss" or "Dis" or "miss" — the tail of a survey line that wrapped to a new row).
const SURVEY_FRAGMENT = /^\s*(?:(?:Bad|Fine|Good|Dismiss|Dis\b|miss\b|goo\s*miss|good\s*miss)\s+)*(?:Bad|Fine|Good|Dismiss|Dis\b|miss\b|goo\s*miss|good\s*miss)\s*$/i;

function stripSurvey(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!SURVEY_HEADER.test(stripAnsi(lines[i]))) { out.push(lines[i]); i++; continue; }
    // Drop the header and the next 1-3 lines that look like survey rating options or
    // their wrapped fragments. Text above the header is classified exactly as before.
    i++;
    let dropped = 0;
    while (i < lines.length && dropped < 3) {
      const t = stripAnsi(lines[i]).trim();
      if (SURVEY_OPTION.test(t) || SURVEY_FRAGMENT.test(t)) { i++; dropped++; continue; }
      break;
    }
  }
  return out;
}

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

// Claude Code tool-call lines ("Bash(...)", "Read(...)", "mcp__x__y(...)") and their "⎿" output lines are
// chrome, never the agent's words: they must not leak into the question or the excerpt tail.
const TOOL_CALL_RE = /^\s*(?:[⏺●•]\s+)?(?:Bash|Read|Edit|Write|MultiEdit|Update|Grep|Glob|Search|List|Task|Agent|WebFetch|WebSearch|TodoWrite|NotebookEdit|Skill|Monitor|mcp__[\w-]+)\(/;
const TOOL_OUT_RE = /^\s*⎿/;
// Index of the first line of the agent's own closing words: after the last tool-call / ⎿ line, skipping the
// deeper-indented continuation rows of a tool output ("… +22 lines", wrapped result text).
function agentTextStart(lines) {
  let k = -1;
  for (let i = 0; i < lines.length; i++) if (TOOL_CALL_RE.test(lines[i]) || TOOL_OUT_RE.test(lines[i])) k = i;
  if (k < 0) return 0;
  let i = k + 1;
  if (TOOL_OUT_RE.test(lines[k])) while (i < lines.length && /^\s{4,}\S/.test(lines[i])) i++;
  return i < lines.length ? i : lines.length;
}

// At most `max` chars, ending on the last text: whole sentences from the end, never starting mid-word.
export function tailSentences(text, max = 300) {
  const t = String(text).trim();
  if (t.length <= max) return t;
  const parts = t.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [t];
  let out = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const cand = (parts[i].trim() + (out ? ' ' + out : '')).trim();
    if (cand.length > max) break;
    out = cand;
  }
  if (out) return out;
  const cut = t.slice(-max);
  const sp = cut.indexOf(' ');
  return '… ' + (sp >= 0 ? cut.slice(sp + 1) : cut);
}

// Joins wrapped lines into paragraphs; the last paragraph is what the agent ended on.
function paragraphs(lines) {
  const text = lines.map((l) => l.trim()).join('\n');
  return text.split(/\n(?=\s*(?:\d+[.)]\s|[-*]\s))|\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
}
function lastParagraph(lines, { stripTools = true } = {}) {
  if (stripTools) lines = lines.slice(agentTextStart(lines));
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
// stopped_short: "I'll start adding X", "Next I'll ...", "Once it's built I'll rerun ...". A blocker, a wait,
// an explicit stop or an offer ("if you want") is not a stop for no reason.
const SHORT_RE = /\b(?:I'?ll|I will|I'?m going to|I am going to)\s+(?:now\s+|next\s+|then\s+|also\s+)?(?!wait\b|stop\b|leave\b|hold\b|pause\b|not\b|need\b)[a-z]+|\bnext(?: improvement| up)?\s*:|\bnext,? I'?ll\b|\bonce\b[^.\n]{0,60},? I'?ll\b/i;
const SHORT_BLOCK_RE = /\bblocked\b|\bcannot\b|\bcan'?t\b|\bwaiting\b|\bI'?ll wait\b|\bwill wait\b|\bI'?m stopping\b|\bstopping here\b|\bI'?ll stop\b|\bI'?ll leave\b|\bpausing\b|\bneed(?:s)? (?:your|you|a |an )|\buntil you\b|\bonce you\b|\blet me know\b|\bif you(?:'d)? (?:want|like|prefer)\b|\bbefore (?:deploy|pushing|merging)|\bsay the word\b|\bas soon as you\b|\b(?:send|tell|give|paste) me\b|\bI'?ll (?:report|resume|let you know|review)\b|\b(?:still )?running\b|\bin the background\b|\b(?:finishes|completes|goes through)\b|\bwhen it\b/i;
// waiting_deploy: waiting on leases, live runs, a deploy, or the owner's go-ahead for one.
const WAIT_DEPLOY_RE = /\b(?:may|can|shall|should) I (?:queue|deploy|restart)\b[^.\n]{0,60}\?|\bwaiting (?:on|for)\b[^.\n]{0,80}(?:go-ahead|approval|approve|leases?|deploy|restart|live runs?)|\bgo-ahead (?:to|for)\b[^.\n]{0,60}(?:deploy|restart|update_core)|\bwait(?:ing)? (?:for|on) your (?:answer|ok|go-ahead|approval)\b[^.\n]{0,40}(?:deploy|restart)|\bupdate_core(?:\.sh)?\b[^.\n]{0,40}(?:go-ahead|approv|waiting)|\bblocked by\b[^.\n]{0,40}(?:live )?(?:runs?|leases?)|\b(?:once|when|after)\b[^.\n]{0,40}\bleases? (?:clear|release|free|expire)|\bnot deployed yet\b|\bneeds a (?:server |host |frontend )?restart\b/i;
// Sentences that mention a restart / deploy only to say none was needed (or that it already happened).
const NEGATED_RE = /\bno (?:server |host |frontend |service )?(?:restart|deploy(?:ment)?)\b|\bwithout (?:a |any )?(?:restart|deploy)|\b(?:restart|deploy(?:ment)?)\b[^.\n]{0,30}\b(?:was|were|is|are)(?: not|n'?t)? (?:needed|required|necessary)|\b(?:did(?: not|n'?t)|do(?: not|n'?t)|does(?: not|n'?t)) (?:need|require) (?:a |any )?(?:restart|deploy)|\bnot (?:need|require)[sd]? (?:a |any )?(?:restart|deploy)|\b(?:already|was|were|got|been|has been|have been) (?:deployed|restarted)\b/i;
// "Reload the page to pick it up": an FYI at the end of a finished report, not something the agent is waiting on.
const FYI_RELOAD_RE = /^tap (?:the )?["'\u201c\u2018]?new version["'\u201d\u2019]?(?: toast| banner| pill)?\b[^.\n?]*|^(?:reload|refresh|hard[- ]refresh)\b[^.\n?]*\b(?:to (?:pick|see|get|load|apply|use|view|have|make)|so (?:you|it|that) (?:can |will |'ll )?(?:see|get|pick)|for (?:it|the change|this) to (?:take|show|apply))/i;
const OWNER_ACTION_RE = /(?:^|[,;:.]\s+(?:so\s+)?|\bplease\s+|\byou (?:need to|can|should|have to|must|could)\s+|\b(?:can|could|would) you\s+)(reload|refresh|hard[- ]refresh|plug(?: in)?|unplug|replug|power[- ]cycle|press|tap|click|reconnect|check (?:the |your )?(?:phone|tv|screen|device|box|remote)|(?:turn|switch) (?:on|off)|open (?:the|your) (?:app|page|phone|tv))\b([^.\n?]*)/im;
const STATUS_RE = /\b(?:done|finished|complete[d]?|tested|verified|passed|passing|green|failing|failed|left|remaining|to do|todo|next|blocked|pending|not (?:yet )?(?:tested|deployed|done|run)|untested|still needs?|status)\b|\b\d+\s+(?:passed|failed|tests?)\b/i;
const NEXT_STEP = /\bnext(?::| is| step| phase| I'?d| I will| I'll)|\bI'?ll (?:now|next|then)\b|\bthen I(?:'ll| will)\b|\bstill to do\b|\bremaining\b/i;

// Topics the AI manager and the rule path must never answer (AGENTS.md: the forbidden-topic filter always wins).
// One alternative per line so a paraphrase can be added without untangling a wall of regex; matched case-insensitively.
const PUSH_MAIN = String.raw`\bpush(?:ed|ing)?\b[^.\n]{0,30}\bmain\b`;
const MERGE_MAIN = String.raw`\bmerge\b[^.\n]{0,30}\bmain\b`;
const REBASE_MAIN = String.raw`\brebase\b[^.\n]{0,30}(?<![/\w-])(?:main|master)\b(?![-/])`;
const GIT_PUSH = String.raw`\bgit push\b`;
const HARD_GIT = String.raw`force[- ]?push|reset --hard|\bhard[- ]?reset\b`;
const MIGRATE = String.raw`\bmigrat(?:e|ion)`;
const FORBIDDEN_PARTS = [
  // deploys and service control
  String.raw`\bre-?deploy|\bdeploy|update_core|\brollout\b`,
  String.raw`systemctl (?:restart|stop|start)|pm2 (?:restart|stop|delete)`,
  String.raw`\brestart\b[^.\n]{0,30}\b(?:service|server|unit|host|daemon|ghosty)\b`,   // "restart the ghosty service"
  // "live"/"staging"/"main" followed by - or / is a word part or a path ("live-reload", "staging/", "feature/main-menu").
  String.raw`\b(?:ship|release(?! (?:the |a |its |my )?locks?\b)|roll ?out|promote)\b[^.\n]{0,40}\b(?:prod(?:uction)?|staging|live)\b(?![-/])|\bgo(?:ing)? live\b(?![-/])`,
  String.raw`\bpublish(?:ed|ing)?\b|\bpush(?:ed|ing)?\b[^.\n]{0,30}\btags?\b|\bterraform\b[^.\n]{0,20}\b(?:apply|destroy)\b|\bapply\b[^.\n]{0,20}\bterraform\b`,
  String.raw`\bkill\b[^.\n]{0,30}\bprod(?:uction)?\b|\b(?:upgrade|alter|modify)\b[^.\n]{0,20}\b(?:live|prod(?:uction)?)\b(?![-/])`,
  // git history and main (named groups: the merge topic is split out for the manager's merge evaluation, see hardMatch)
  PUSH_MAIN,
  MERGE_MAIN,
  REBASE_MAIN,
  GIT_PUSH,
  HARD_GIT,
  // destructive data operations
  String.raw`\bdelet(?:e|es|ed|ing|ion)\b|\bremov(?:e|es|ed|ing|al)\b|\bdrop(?:s|ped|ping)?\b|\brm\b|\bprun(?:e|es|ed|ing)\b|\btruncat(?:e|es|ed|ing|ion)\b|\bwip(?:e|es|ed|ing)\b|\boverwrit(?:e|es|ten|ing)\b|\bpurg(?:e|es|ed|ing)\b|\beras(?:e|es|ed|ing|ure)\b|\bdestr(?:oy(?:s|ed|ing)?|uction)\b|\bnuk(?:e|es|ed|ing)\b`,
  String.raw`\bdrop\b[^.\n]{0,20}\b(?:table|database|db|schema)\b`,
  MIGRATE,
  // credentials and secrets
  String.raw`\.env\b|credential|password|passphrase|\bsecret|access token|auth token|bearer\b|\bapi[_ -]?key|ssh key|private key|\brevo(?:k(?:e|es|ed|ing)|cation)\b|\brotat(?:e|es|ed|ing|ion)\b[^.\n]{0,20}\b(?:keys?|tokens?|certs?|certificates?)\b|\b(?:keys?|tokens?|certs?|certificates?)\b[^.\n]{0,20}\brotat(?:e|es|ed|ing|ion)\b`,
  // money and customers
  String.raw`\bmoney\b|\bpay(?:s|ment|ing)?\b|\bpaid\b|\bpurchase|\bbuy\b|\bbilling\b|\binvoice|credit card|add credit|\bcard on file\b|\bcharg(?:e|ing)\b(?! ahead)[^.\n]{0,30}\b(?:card|account|customer|invoice|fee)s?\b|\bcustomer|\brefund|\btransfer\b[^.\n]{0,20}\bfunds?\b|\b(?:e-?mail|message|contact|call|reply to)\b[^.\n]{0,20}\bclients?\b`,
  // host administration and schema tools (round 8: strictly more conservative for every caller)
  String.raw`sudoers|/etc/sudo|visudo`,
  String.raw`\bunit file|/etc/systemd|systemctl (?:enable|disable|daemon-reload|mask)|\.service\b`,
  String.raw`\breboot\b|\bshutdown\b|\bsudo\b`,
  String.raw`alembic|upgrade head|prisma migrate|db:migrate|flyway|liquibase|knex migrate`,
  String.raw`\breset\b[^.\n]{0,20}\b(?:database|db|schema)\b|\bre-?create\b[^.\n]{0,20}\bschema\b`,
];
export const FORBIDDEN_RE = new RegExp(FORBIDDEN_PARTS.join('|'), 'i');
// The merge topic alone, and the floor without it: a merge is decided by the manager's merge evaluation (merge-policy.js);
// the push that lands it is part of the merge (excluded from hardMatch only when a merge is present).
export const MERGE_RE = /\bmerg(?:e|es|ed|ing)\b/i;
const PUSH_COLON = String.raw`\bpush(?:ed|es|ing)?\b[^.\n]*:\S`;
const PUSH_COLON_RE = new RegExp(PUSH_COLON, 'i');
// History rewrites and pushes that are not the plain landing of a merge stay hard whatever else the text says.
const HARD_EXTRA = [
  String.raw`\bpush(?:ed|es|ing)?\b[^.\n]*(?:--force\b|--force-with-lease|--mirror|--delete\b|\s-f\b|\s\+\S)`,   // push --force, push -f, push origin +main
  PUSH_COLON,   // push origin :old, push origin HEAD:production (read on the text and its spellings, not on joined words: "Push:yes" is not a refspec)
  String.raw`\bpush(?:ed|es|ing)?\b[^.\n]{0,40}\b(?:prod(?:uction)?|staging|live)\b(?![-/])`,
  String.raw`\brewrit(?:e|es|ing|ten)\b[^.\n]{0,20}\bhistory\b|\bamend(?:ed|ing|s)?\b[^.\n]{0,40}\b(?:commit|main|master)\b|\bfilter-(?:branch|repo)\b`,
];
// Topic split (round 8): merge, push and deploy are decided by the manager (OWNER_DECISIONS §15); the rest stays hard.
// Deploy topic parts come from FORBIDDEN_PARTS (deploy words, ship/release/promote to prod, go live) plus a restart of a service-like thing.
const DEPLOY_WORDS = FORBIDDEN_PARTS[0], DEPLOY_SHIP = FORBIDDEN_PARTS[3], RESTART_ANY = FORBIDDEN_PARTS[2];
// A restart of a service is not a deploy by itself: with a deploy word it rides along, never the ghosty service or a unit.
const RESTART_HARD = String.raw`\brestart\b[^.\n]{0,30}\b(?:unit|ghosty)\b`;
const PUSH_TAGS = String.raw`\bpush(?:ed|es|ing)?\b[^.\n]{0,30}\btags?\b`;   // pushing a tag publishes: hard
export const DEPLOY_RE = new RegExp([DEPLOY_WORDS, DEPLOY_SHIP].join('|'), 'i');
// A push mention: the present tense or a "pushed to main"; whether it is hard is decided by HARD_PUSH_RE.
export const PUSH_RE = /\bpush(?:ing)?\b|\bpushed\b(?:[^.\n]{0,30}\bmain\b)?/i;
const HARD_PUSH_RE = new RegExp([...HARD_EXTRA.filter((p) => p !== PUSH_COLON), HARD_GIT, PUSH_TAGS].join('|'), 'i');
const colonHit = (text) => { for (const v of [String(text), ...textVariants(text)]) { const k = v.match(PUSH_COLON_RE); if (k) return k[0]; } return null; };
const hardParts = ({ mergePresent = false, pushPresent = false, deployPresent = false, migrationsOk = false } = {}) => {
  const drop = new Set([MERGE_MAIN]);
  if (migrationsOk) drop.add(MIGRATE);   // the deploy evaluation read the migration files (additive, lab env): the noun is covered, "migrate" the verb is not (below)
  if (mergePresent || pushPresent) { drop.add(PUSH_MAIN); drop.add(GIT_PUSH); }
  if (deployPresent) { drop.add(DEPLOY_WORDS); drop.add(DEPLOY_SHIP); drop.add(RESTART_ANY); }
  let parts = [...FORBIDDEN_PARTS.filter((p) => !drop.has(p)), ...HARD_EXTRA.filter((p) => p !== PUSH_COLON)];
  if (deployPresent) parts.push(RESTART_HARD);
  if (migrationsOk) parts.push(String.raw`\bmigrat(?:e|es|ed|ing)\b`);
  return parts;
};
const HARD_RES = new Map();
const hardRe = (o) => { const k = `${+!!o.mergePresent}${+!!o.pushPresent}${+!!o.deployPresent}${+!!o.migrationsOk}`; if (!HARD_RES.has(k)) HARD_RES.set(k, new RegExp(hardParts(o).join('|'), 'i')); return HARD_RES.get(k); };
// `git push <remote> <refspec>` where the refspec is not main/master: not the landing of a merge.
const PUSH_OTHER_REF = String.raw`\bgit push\b(?:\s+-{1,2}[\w-]+)*\s+(?!-)\S+\s+(?!(?:main|master|and|then|after|once|when|if|to|now|again|too|so|or|before)\b)\S`;
const PUSH_OTHER_RE = new RegExp(PUSH_OTHER_REF, 'i');   // read on the text and its spelling variants, not on window joins (a joined word would look like another ref)

let forbiddenExtra = null;
// Extra forbidden words that must not live in a public repo (customer names, ...): GHOSTY_FORBIDDEN_EXTRA.
export function setForbiddenExtra(pattern) {
  forbiddenExtra = pattern ? new RegExp(pattern, 'i') : null;
}

// ---- spelling variants (shared with orchestration/policy.js) -----------------------------------------------------
// Spellings an author might use to slip a restricted topic past a plain regex. Every variant is matched in addition
// to the raw text: a variant can only add a match (fail closed), never remove one.
export const HOMOGLYPH = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ⅼ: 'l', ı: 'i' };
// Cyrillic/Greek letters that look Latin (lower-cased before lookup). Store identities keep the narrower HOMOGLYPH.
const CONFUSABLE = { ...HOMOGLYPH, к: 'k', м: 'm', н: 'h', т: 't', в: 'b', ԛ: 'q', ԝ: 'w', ɡ: 'g',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y', ω: 'w' };
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
// Protected verbs and nouns a split spelling may hide ("mer ge", "pass word", "cust omer"). Rejoined only when the
// whole joined token is one of these, so "the mer chant" or "a de bug log" stay as written.
const SPLIT_WORD_RE = new RegExp(`^(?:${[
  '(?:re)?deploy(?:s|ed|ing|ment)?', 'merg(?:e|es|ed|ing)', 'rebas(?:e|es|ed|ing)', 'push(?:es|ed|ing)?', 'publish(?:es|ed|ing)?',
  'ship(?:s|ped|ping)?', 'rollout', 'promot(?:e|es|ed|ing)', 'delet(?:e|es|ed|ing|ion)', 'remov(?:e|es|ed|ing)', 'wip(?:e|es|ed|ing)',
  'prun(?:e|es|ed|ing)', 'truncat(?:e|es|ed|ing)', 'overwrit(?:e|es|ing)', 'migrat(?:e|es|ed|ing|ion)', 'revok(?:e|es|ed|ing)',
  'rotat(?:e|es|ed|ing)', 'restart(?:s|ed|ing)?', 'refund(?:s|ed|ing)?', 'purchas(?:e|es|ed|ing)', 'payment', 'billing',
  'password', 'passwd', 'passphrase', 'secrets?', 'credentials?', 'customers?', 'invoices?', 'apikeys?', 'tokens?', 'prod', 'production',
].join('|')})$`, 'i');
// Any 1-3 non-alphanumerics (space, tab, newline, punctuation, fillers) may split a protected word: the rejoin is
// gated on the joined token being protected, so the separator class need not be.
const SPLIT_SEP_RE = /^[^A-Za-z0-9]{1,3}$/;
const MAX_FRAGMENTS = 8;   // "d e p l o y m e n t" is 10; anything longer is not a split word (and keeps this linear)
// Invisible letters (Hangul fillers, halfwidth filler, braille blank) that are neither marks nor format characters.
const FILLERS = /[\u115F\u1160\u3164\uFFA0\u2800]/g;

// Base form: compatibility-decomposed, combining marks, format characters (zero-width, soft hyphen, word joiner) and
// fillers removed, other whitespace (Ogham space, ...) as a plain space, confusable letters mapped to Latin.
export function baseForm(text) {
  return String(text ?? '').normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').replace(FILLERS, '').replace(/[^\S\n\r]/g, ' ')
    .replace(/[^\x00-\x7F]/g, (c) => CONFUSABLE[c.toLowerCase()] ?? c);
}

// Letter runs split by 1-3 non-alphanumerics (including a line break) rejoined only when the joined token is a
// protected word; whitespace runs collapsed. "mer ge into main" -> "merge into main", "dep\nloy" -> "deploy".
export function normalizeSplits(text) {
  const parts = baseForm(text).replace(/[ \t]+/g, ' ').match(/[A-Za-z]+|[^A-Za-z]+/g) || [];
  const out = [];
  for (let i = 0; i < parts.length;) {
    let end = i, joined = null;
    if (/^[A-Za-z]/.test(parts[i])) {
      let w = parts[i];
      for (let j = i + 2, n = 2; j < parts.length && n <= MAX_FRAGMENTS && SPLIT_SEP_RE.test(parts[j - 1]); j += 2, n += 1) {
        w += parts[j];
        if (SPLIT_WORD_RE.test(w)) { joined = w; end = j; }
      }
    }
    if (joined) { out.push(joined); i = end + 1; } else { out.push(parts[i]); i += 1; }
  }
  return out.join('');
}

// A space splitting ANY forbidden keyword ("merge into ma in", "go li ve", ".e nv"): two or three adjacent tokens of
// one line joined, read in their surrounding words (same line only: the [^.\n] windows of FORBIDDEN_RE are kept).
// Only joins that contain a keyword stem are tried, and each window is a few tokens: linear in the input.
const KEYWORD_STEM_RE = /amend|histor|filter|rewrit|deploy|update_core|roll|systemctl|pm2|restart|servi|server|daemon|ghosty|ship|releas|promot|prod|staging|live|publish|push|tag|terraform|apply|destroy|kill|upgrad|alter|modify|main|master|merg|rebas|git|force|reset|hard|delet|remov|rm|prun|truncat|wip|overwrit|drop|table|database|db|schema|migrat|env|credential|password|passphrase|secret|token|bearer|api|key|ssh|private|revok|rotat|cert|money|pay|purchas|buy|billing|invoice|credit|card|charg|customer|refund|transfer|fund|mail|message|contact|call|reply|client/i;
export function* windowJoins(text) {
  for (const line of baseForm(text).split(/\r?\n|\r/)) {
    const t = line.split(/[ \t]+/).filter(Boolean);
    for (let i = 0; i < t.length - 1; i++) {
      for (let n = 2; n <= 3 && i + n <= t.length; n++) {
        const joined = t.slice(i, i + n).join('');
        if (joined.length > 40 || !KEYWORD_STEM_RE.test(joined)) continue;
        yield [...t.slice(Math.max(0, i - 8), i), joined, ...t.slice(i + n, i + n + 10)].join(' ');
      }
    }
  }
}

export function textVariants(text) {
  const nfkc = String(text ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[^\x00-\x7F]/g, (c) => CONFUSABLE[c.toLowerCase()] ?? c);
  const base = baseForm(text);
  const spaced = base.replace(/\b(?:[A-Za-z0-9][^A-Za-z0-9\n\r]{1,3}){2,}[A-Za-z0-9]\b/g, (m) => m.replace(/[^A-Za-z0-9]/g, ''));   // d e p l o y, d,e,p,l,o,y
  const joined = spaced.replace(/([A-Za-z])[^A-Za-z0-9\s]+(?=[A-Za-z])/g, '$1');                                                     // de-ploy, de(ploy
  const leetI = joined.replace(/[013457@$]/g, (c) => LEET[c]);                                                                       // d3pl0y
  const leetL = joined.replace(/[013457@$]/g, (c) => (c === '1' ? 'l' : LEET[c]));                                                   // dep1oy
  const digitless = joined.replace(/([A-Za-z])[0-9]+(?=[A-Za-z])/g, '$1');                                                          // de2ploy
  return [...new Set([nfkc, base, spaced, joined, leetI, leetL, digitless, normalizeSplits(text), normalizeSplits(leetI), normalizeSplits(leetL)])];
}

// First match of `re` (or the extra pattern) in the text or any disguised spelling of it; null when none.
function matchWith(re, text, extra = null) {
  const match = (t) => t.match(re) || (extra && t.match(extra));
  const raw = String(text);
  const m = match(raw);
  if (m) return m[0];
  // The forbidden-topic filter always wins: a disguised spelling is still the topic.
  for (const v of textVariants(raw)) { if (v === raw) continue; const k = match(v); if (k) return k[0]; }
  for (const w of windowJoins(raw)) { const k = match(w); if (k) return k[0]; }
  return null;
}

export const forbiddenMatch = (text) => matchWith(FORBIDDEN_RE, text, forbiddenExtra);
// Like a deploy or a push, a merge counts as a topic only when the text asks to perform it ("Should I merge ..."), not for a noun ("the merge policy page").
export const mergeMatch = (text) => requested(text, MERGE_RE);
// The floor without the topics the manager decides. A merge exempts the push that lands it (main / master), a push topic any
// plain push, a deploy topic the deploy words; options: { mergePresent, pushPresent, deployPresent, migrationsOk } (a bare boolean = mergePresent); migrationsOk: the noun "migration" is covered by a deploy evaluation of additive lab migrations.
export function hardMatch(text, opts = {}) {
  const o = typeof opts === 'object' && opts ? opts : { mergePresent: !!opts };
  const hit = matchWith(hardRe(o), text, forbiddenExtra) || colonHit(text);
  if (hit) return hit;
  if (o.mergePresent && !o.pushPresent) for (const v of [String(text), ...textVariants(text)]) { const k = v.match(PUSH_OTHER_RE); if (k) return k[0]; }
  return null;
}
const SERVICE_CTL_RE = new RegExp(FORBIDDEN_PARTS[1], 'i');
// A deploy or a push counts as a topic only when the agent asks to perform it ("Should I deploy ...", "Deploy X to Y?", "ready to deploy"),
// not when the word is a noun or a modifier ("the deploy queue page", "push notifications"). Text that mentions the word without
// asking stays in the hard floor, so it is escalated, never answered.
const REQ_BEFORE_RE = /\b(?:should|shall|can|could|may|would|will|do|did)\s+(?:i|we)\b|\bwant me to\b|\b(?:ready|ok(?:ay)?|fine|safe|time|going|about|needs?|plans?|planned|propos(?:e|ed|ing)) to\b|\bgo ahead\b|\blet me\b|\bi(?:'ll|'d| will| can| could| would| plan| propose| recommend| suggest)\b|\bwe(?:'ll| will| can| could| should| need)\b|\bnext(?: step)?\s*[:,-]|\bthen\b|\bplease\b|\b(?:whether|how|when|where) to\b|\b(?:ok(?:ay)?|fine|alright|good)\s+if\s+(?:i|we)\b|\bwant(?:s)? (?:me|us) to\b/i;
// "request / queue / kick off / start / trigger / run / retry / want a deploy" and the passive "should this be deployed", "want it pushed"
const ACTION_DET_RE = /\b(?:request|queue|kick off|kick|start|trigger|run|re-?run|retry|schedule|perform|do|want|need|order)\s+(?:(?:off|up)\s+)?(?:a|an|the|another|that|this|one)\s+(?:(?:failed|failing|latest|last|previous|pending|same|quick|full|fresh|new|frontend|server|host)\s+)*$/i;
// after "run / queue / retry ... the deploy" only these may follow: the end of the clause, "it", "now" / "again", "of / to / for / on <x>" (anything else makes "deploy" a noun: "the deploy tests", "the deploy job")
const ACTION_AFTER_OK_RE = /^\s*(?:$|[?.!,;)]|(?:it|this|that|now|again|please)\b|(?:of|to|for|on|onto)\s+\S|(?:and|then)\b)/i;
const PASSIVE_BEFORE_RE = /\b(?:be|get|getting|been)\s+$/i;
const PASSIVE_ASK_RE = /\b(?:should|shall|can|could|may|might|must|would|ready|need(?:s)? to|ok(?:ay)? to|want(?:s)?|time to)\b/i;
const WANT_IT_RE = /\bwant(?:s)?\s+(?:it|this|that|them|these|those)\s+$/i;
const IMPERATIVE_BEFORE_RE = /^\s*(?:[(\[]?\w{1,2}[)\]:.]\s*|\d+[.)]\s*|[-*]\s*)?(?:(?:and|then|also|please|now|first|just|run|execute|try|bash|sh|npm|node)\s+)*(?:git\s+)?$/i;
const DET_BEFORE_RE = /\b(?:the|a|an|this|that|our|your|my|each|every|last|next|new|failed|failing|pending|recent|same|its|their|another|any|no|per|of|every)\s+$/i;
const NOUN_AFTER_RE = /^(?:\s+(?:queue|queues|page|pages|button|buttons|log|logs|script|scripts|user|users|key|keys|notifications?|notifs?|status|ledger|runner|view|panel|config|configuration|history|tab|list|step|steps|flow|pipeline|hooks?|events?|messages?|endpoint|api|token|time|date|rules?|plan|process|window|badge|banner|card|sheet|screen|name|names|ids?|state|feature|support|mode|policy|command|commands)\b|(?:ment|ments|er|ers)\b)/i;
const COMPOUND_AFTER_RE = /^[-_/.]\w/;   // deploy-runner, deploy.sh, push/notify (update_core.sh is the command itself)
const CONJUNCT_BEFORE_RE = /(?:,|;|\band|\bthen|\bplus)\s+(?:(?:also|then|now|just)\s+)*$/i;
const ABOUT_THING_RE = /^\s*(?:\W*\w{0,2}[)\]:.]\s*)?(?:should|shall|can|could|may|would|will|do|does|did|is|are|was|were|what|why|how|which|when|where)\s+(?:the|a|an|this|that|these|those|our|your|my|its|their|\w+'s)\b/i;
function requestHit(text, re) {
  const g = new RegExp(re.source, 'ig');
  for (const sent of String(text).split(/(?<=[.!?])\s+|\n+/)) {
    g.lastIndex = 0;
    let m;
    while ((m = g.exec(sent))) {
      if (!m[0]) { g.lastIndex++; continue; }
      const before = sent.slice(0, m.index);
      let after = sent.slice(m.index + m[0].length), hit = m[0];
      // "deploy" + "ed" and "pushed" are passive only after "be / get" in a question or a wish ("should this be deployed", "want it pushed")
      const past = /^ed\b/i.test(after) || /ed$/i.test(m[0]);
      if (past) {
        if (/^ed\b/i.test(after)) after = after.slice(2);
        if ((PASSIVE_BEFORE_RE.test(before) && PASSIVE_ASK_RE.test(before)) || WANT_IT_RE.test(before)) return hit;
        continue;
      }
      if (ACTION_DET_RE.test(before) && ACTION_AFTER_OK_RE.test(after)) return hit;   // "request a deploy of main to env-a", "queue the deploy"
      if (DET_BEFORE_RE.test(before) || NOUN_AFTER_RE.test(after) || (COMPOUND_AFTER_RE.test(after) && !/^update_core/i.test(m[0]))) continue;
      if (IMPERATIVE_BEFORE_RE.test(before) || REQ_BEFORE_RE.test(before)) return m[0];
      // "merge X and deploy once the host frees?": a conjunct of an imperative chain, unless the sentence is a question about a thing ("Should the page also ...")
      if (CONJUNCT_BEFORE_RE.test(before) && !ABOUT_THING_RE.test(sent)) return m[0];
    }
  }
  return null;
}
const requested = (text, re) => { for (const v of [String(text), ...textVariants(text)]) { const k = requestHit(v, re); if (k) return k; } return null; };
// systemctl / pm2 commands stay hard: no deploy topic beside them.
export const deployMatch = (text) => (matchWith(SERVICE_CTL_RE, text) ? null : requested(text, DEPLOY_RE));
// A plain push (not a force, a rewrite, a delete or a push to prod/staging/live: those stay hard).
export const pushMatch = (text) => (matchWith(HARD_PUSH_RE, text) || colonHit(text) ? null : requested(text, PUSH_RE));
export function topicSplit(text) {
  const merge = mergeMatch(text), push = pushMatch(text), deploy = deployMatch(text);
  return { merge, push, deploy, hard: hardMatch(text, { mergePresent: !!merge, pushPresent: !!push, deployPresent: !!deploy }) };
}

// ---- the approved action (round 9, item 2, redesigned after review) ---------------------------------------------------
// The floor text of a yes / continue / recommended-option answer is the option (or the "Shall I X?" question) + the commands it runs + the question
// line + the WHOLE stem around it (the other options of the menu and their descriptions are left out, as in round 8). How specific the option is never
// removes the stem. FORBIDDEN_RE is unchanged. Only two things are dropped or relaxed:
//   (a) a narrative sentence: the destructive verb in it is itself past tense ("removed", "overwrote", "was deleted"), no present / imperative / future /
//       conditional wording, no command, no approval phrase ("as agreed", "approved ... ago"), no data object, a time marker, a plain spelling;
//   (b) the soft words remove / overwrite / replace / update and the noun "migration" when their clause's object is an ordinary file or doc
//       (SKILL.md, a README, a template, a config file) and names no data (database, table, backups, production, customer, .env, secrets ...).
// The hard verbs (delete, drop, wipe, truncate, purge, destroy, erase, nuke, prune, rm) always block, except as a past-tense narrative under (a).
const OPTION_LINE = /^\s*(?:[❯›>]\s*)?\d+[.)]\s+/;
const GENERIC_FILLER = /\b(?:yes|yep|yeah|ok|okay|sure|proceed|continue|go|ahead|do|it|that|this|the|plan|planned|as|with|please|recommend(?:ed|ation)?|approve|accept|confirm|apply|run|start|now|all|and|then|sounds?|good|great|agreed|option|my|your|lets?|let's|take|choose|pick|take)\b/gi;
const isGenericOption = (t) => {
  const bare = String(t || '').replace(/\(\s*recommended\s*\)/ig, ' ');
  if (!bare.replace(GENERIC_FILLER, ' ').split(/[\W_\d]+/).some((w) => w.length > 2)) return true;   // a bare label ("A", "Option 2") is generic too
  return bare.trim().split(/\s+/).length <= 3 && /\b(?:it|that|this|them|these|those)\b/i.test(bare);   // "Send it", "Apply that": a pronoun for the question's action
};
const COMMAND_RES = [/`([^`\n]{2,})`/g, /^\s*\$\s+(\S.*)$/gm];
export function commandsIn(text) {
  const out = [];
  for (const re of COMMAND_RES) { re.lastIndex = 0; let m; while ((m = re.exec(String(text || '')))) out.push(m[1].trim()); }
  return [...new Set(out)];
}
const DESTRUCTIVE_PART = /delet\(\?:e|migrat\(\?:e/;
const DESTRUCTIVE_WORDS = new RegExp(FORBIDDEN_PARTS.find((p) => /delet\(\?:e/.test(p)), 'gi');
const NONDESTRUCTIVE_RE = new RegExp([...FORBIDDEN_PARTS.filter((p) => !DESTRUCTIVE_PART.test(p)), ...HARD_EXTRA].join('|'), 'i');
const HARD_PAST = /^(?:remov|delet|dropp|wip|truncat|purg|destroy|eras|nuk|prun)ed$|^overwr(?:ote|itten)$/i;
const PAST_TIME_RE = /\b(?:earlier|yesterday|already|previously|ago|so far|just now|this morning|last (?:night|week|time|run|session|turn))\b/i;
// present, imperative-leaning, future or conditional wording: the sentence is a plan, not a report
const PLANNED_RE = /\b(?:will|won'?t|would|going to|about to|shall|should|could|can|may|might|must|now|currently|next|then|first|runs?|running|executes?|applies|plans?|planned|steps?|if|unless|when|once|before|after that|tonight|today|tomorrow|am|is|are)\b|'ll\b/i;
const APPROVAL_RE = /\bas (?:we |already |previously |i )?(?:discussed|agreed|approved|requested|planned|confirmed|decided|promised)\b|\balready (?:agreed|approved|discussed|requested|decided)\b|\b(?:was|were|been|is) (?:agreed|approved|requested|authori[sz]ed)\b|\bapproved\b[^.\n]{0,40}\bago\b|\bwith your (?:approval|ok|go-ahead)\b|\bper your\b|\bapproved by\b/i;
const OBJ_FILE = /[\w./-]+\.(?:md|txt|json|ya?ml|js|ts|py|sh|toml|html|css|csv)\b|\b(?:skill|readme|docs?|documentation|templates?|config file|changelog)\b/i;
const OBJ_DATA = /\b(?:databases?|db|tables?|schemas?|data dir(?:ectory)?|volumes?|buckets?|backups?|prod(?:uction)?|customers?|user data|rows?|records?|uploads?|secrets?|keys?|tokens?|passwords?|credentials?)\b|\.env\b/i;
export function isPastNarrative(sentence) {
  const t = String(sentence || '').trim();
  if (!t || /\?["')\]]*\s*$/.test(t) || !PAST_TIME_RE.test(t) || PLANNED_RE.test(t) || APPROVAL_RE.test(t) || OBJ_DATA.test(t)) return false;
  if (commandsIn(t).length || /\b(?:rm|mv|dd)\b/i.test(t) || /\bmigrat/i.test(t)) return false;
  if (matchWith(NONDESTRUCTIVE_RE, t, forbiddenExtra)) return false;
  DESTRUCTIVE_WORDS.lastIndex = 0;
  for (const m of t.matchAll(DESTRUCTIVE_WORDS)) if (!HARD_PAST.test(m[0])) return false;
  const hit = forbiddenMatch(t);
  return !hit || FORBIDDEN_RE.test(t);   // a hit that shows only in a disguised spelling is not narrative
}
const sentencesOf = (text) => String(text || '').split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
export const withoutNarrative = (text) => String(text || '').split('\n').map((l) => (OPTION_LINE.test(l) ? l : sentencesOf(l).filter((x) => !isPastNarrative(x)).join(' '))).filter((l) => l.trim()).join('\n');
// (b): a soft word is neutral when the clause around it names an ordinary file or doc and no data.
const SOFT_RE = /\b(?:remov(?:e|es|ed|ing|al)|overwrit(?:e|es|ten|ing)|overwrote|replac(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|migrations?)\b/gi;
export function relaxSoft(text) {
  return String(text || '').split('\n').map((line) => {
    return line.split(/(?<=[.;!?])\s+|;/).map((clause) => (OBJ_FILE.test(clause) && !OBJ_DATA.test(clause) && !commandsIn(clause).length ? clause.replace(SOFT_RE, 'change') : clause)).join(' ');
  }).join('\n');
}
const floorText = (t) => relaxSoft(withoutNarrative(t));
// The menu's lines without the other options (and their indented descriptions); the kept option, plan steps and everything else stay.
function menuStem(lines, options, keepN) {
  const others = (options || []).filter((o) => o.n !== keepN && o.text);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (OPTION_LINE.test(l) && others.some((o) => l.includes(String(o.text).slice(0, 40)))) {
      while (i + 1 < lines.length && !OPTION_LINE.test(lines[i + 1]) && /^\s{2,}\S/.test(lines[i + 1])) i++;
      continue;
    }
    out.push(l);
  }
  return out;
}

// stall: { options?, question?, fullText? | closing? | excerpt?, approvalText? } -> { text, commands, source }
//   source: 'option' | 'option+question' (a generic option inherits the question) | 'question' (a yes / continue answer)
export function approvedAction(stall) {
  const all = String(stall.fullText || stall.closing || stall.excerpt || '').split('\n');
  const rec = stall.options?.find((o) => o.recommended) || stall.rec || null;
  if (!rec) {
    const body = floorText(String(stall.approvalText ?? stall.question ?? ''));
    return { text: body, commands: commandsIn(body), source: 'question' };
  }
  const text = floorText([...menuStem(all, stall.options, rec.n), rec.text, stall.question || ''].join('\n'));
  return { text, commands: commandsIn(text), source: isGenericOption(rec.text) ? 'option+question' : 'option' };
}

export function menuOptions(lines) {
  const opts = [];
  for (const l of lines) {
    const m = l.match(OPTION_RE);
    if (m) opts.push({ n: Number(m[1]), text: m[2].trim() });
  }
  return opts;
}

// Unmarked menus (round 9, item 3): no "(recommended)" tag, but option 1 is a safe, reversible default. Only a clean 1..N list counts, and option 1
// must not be a way out ("skip", "cancel", "do nothing") nor carry a hard topic or a merge / push / deploy.
const OUT_OPTION_RE = /^\W*(?:skip|cancel|abort|stop|quit|exit|do nothing|nothing|leave (?:it|them|this)|no\b|none\b|not now|later|wait\b|don'?t|dismiss|decline|keep (?:it )?as is|ignore|something else|other\b|type something|chat about)/i;
export function unmarkedFirst(opts, lines = []) {
  if (!opts || opts.length < 2 || opts.some((o, i) => o.n !== i + 1) || opts.some((o) => RECOMMENDED_RE.test(o.text))) return null;
  const first = opts[0];
  if (OUT_OPTION_RE.test(first.text)) return null;
  // the stem around the menu (every line but the other options) and option 1 must hold no forbidden word at all, once (b) is applied: no narrative is dropped here
  const text = relaxSoft([...menuStem(lines, opts, 1), first.text].join('\n'));
  if (forbiddenMatch(text) || topicSplit(text).hard) return null;
  return first;
}

// The agent's own last-line verdict (AGENTS.md "End every turn with a STATUS line"):
//   STATUS: done | needs-owner: <question> | blocked: <what> | handoff: <resource> -> <session> by <HH:MM> | waiting: deploy <id>
// Looked for in the last 3 closing lines only. Returns { kind, text } or null (Codex/MiniMax panes, turns without the line).
const STATUS_LINE_RE = /^\s*(?:[*_`]*)STATUS:(?:[*_`]*)\s*(done|needs-owner|blocked|handoff|waiting|acknowledged|ack|noted|ok|shipped|completed?|finished)\b[*_`]*\s*[:.]?\s*(.*)$/i;
// Verdicts agents write instead of "done" ("STATUS: acknowledged.", "STATUS: shipped"): a finished turn, never a question.
// Read as plain text they fell to the heuristics: "I will ask before any force-push" became stopped_short (2026-10-15).
const DONE_ALIASES = new Set(['acknowledged', 'ack', 'noted', 'ok', 'shipped', 'complete', 'completed', 'finished']);
// MiniMax (mcode) prints its todo panel under the reply: "✓ ...", "○ ...", "… +17 more · 18/20 done · 1 pending · Ctrl+T expand".
const TODO_PANEL_END_RE = /\b\d+\/\d+ done\b[^\n]*(?:pending|Ctrl\+T)|^\s*…\s*\+\d+ more\b/;
export function statusLine(lines) {
  const panel = lines.slice(-4).some((l) => TODO_PANEL_END_RE.test(l));   // the STATUS line sits above the panel (and its "◐ Tasks · 1 agent active" line)
  for (const l of lines.slice(panel ? -14 : -3).reverse()) {
    const m = STATUS_LINE_RE.exec(l);
    if (!m) continue;
    const k = m[1].toLowerCase(), text = stripSeparator(m[2].replace(/[*_`]+\s*$/, '').trim());
    if (DONE_ALIASES.has(k) && /\?/.test(text.replace(/https?:\S+/g, ''))) return null;   // "STATUS: ok — should I ...?" still asks: the heuristics decide
    return { kind: DONE_ALIASES.has(k) ? 'done' : k, text };
  }
  return null;
}
// "STATUS: done — branch x pushed": the text after the verdict loses its leading separator (— – - : ·). A hyphen only
// counts when a space follows ("--server" and "-> x" are text, not separators).
export function stripSeparator(text) {
  return String(text ?? '').replace(/^(?:\s*(?:[—–·:]|[*_`]+(?=\s)|-(?=\s|$)))+\s*/, '').trim();
}

// plain = ANSI-stripped pane lines; raw = the same lines with ANSI (for the input box);
// state = ghosty state ('waiting' | 'done' | 'idle' | ...).
// Returns { case, source: 'rule'|'ambiguous', answer, question, forbidden, draft, suggestion, excerpt }.
export function classifyStall({ plain, raw = null, state, fromReport = false }) {
  plain = stripSurvey(plain);
  raw = raw ? stripSurvey(raw) : null;
  const close = closingLines(plain, 16);
  const tail = close.slice(-8);
  const excerpt = close.join('\n');
  const closing = closingLines(plain, 90).join('\n').slice(-6000);   // the long closing text: the popup's multi-question form needs every numbered question, not the 16-line tail
  const { draft, suggestion } = inputBox(fromReport ? raw || [] : raw || plain);   // the draft is always read off the pane
  const out = { case: null, source: 'rule', answer: null, question: null, forbidden: null, draft, suggestion, excerpt, closing };

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
    else if (!rec && (LIVE_MENU_RE.test(block.join('\n')) || opts.length >= 2) && unmarkedFirst(opts, block)) { out.case = 'menu_recommended'; out.answer = { key: String(opts[0].n) }; out.source = 'unmarked-first'; }
    else out.case = 'owner_decision';
    out.forbiddenText = block.join('\n');
    if (opts.length >= 2) out.options = opts.map((o) => ({ n: o.n, text: o.text, recommended: RECOMMENDED_RE.test(o.text) || (out.source === 'unmarked-first' && o.n === opts[0].n), ...(out.source === 'unmarked-first' && o.n === opts[0].n ? { unmarked: true } : {}), forbidden: forbiddenMatch(o.text) }));
    return finish(out);
  }

  // A finished turn: what did the agent end on?
  const last = lastParagraph(close);
  // The STATUS line, when the agent wrote one, decides first; the regexes below stay for turns without it.
  const st = statusLine(close);
  if (st) {
    out.status = st.kind;
    out.question = st.text || last.slice(0, 300);
    out.source = 'rule';
    out.no_status = false;
    out.forbiddenText = close.slice(-6).join('\n');
    if (st.kind === 'needs-owner') { out.case = 'owner_decision'; const o = menuOptions(close); if (o.length >= 2) out.options = o.map((x) => ({ n: x.n, text: x.text, recommended: RECOMMENDED_RE.test(x.text), forbidden: forbiddenMatch(x.text) })); }
    // a job of the session's own, named by a concrete pid / log / run id: the manager wakes it when the job ends (own-jobs.js); never a needs-you.
    // Without a concrete reference the old case stands ("waiting for the CI run" may be someone else's); `jobNoun` lets the manager upgrade it when the agent has a live child process.
    else if ((st.kind === 'blocked' || st.kind === 'waiting') && !/^deploy\b/i.test(st.text) && waitsOnOwnJob(st.text, st.kind) && hasRef(jobRefs(st.text))) { out.case = 'own_job_wait'; out.ownJob = jobRefs(st.text); out.answer = null; out.autoCase = undefined; }
    else if (st.kind === 'blocked') { out.case = 'owner_decision'; out.blocked = st.text; if (waitsOnOwnJob(st.text, st.kind)) out.jobNoun = true; }
    else if (st.kind === 'waiting') { out.case = 'waiting_deploy'; out.deployHint = deployHint(st.text); const id = /\bdeploy\s+(\S+)/i.exec(st.text); if (id) out.deployHint.id = id[1]; }
    else if (st.kind === 'handoff') { out.case = 'done'; out.handoff = st.text; }
    else out.case = 'done';
    return finish(out);
  }
  out.question = tailSentences(last, 300);
  // A question anywhere in the closing paragraph ("Can I run it? After that I'd ...").
  let asks = /\?(?:["')\]]|\s|$)/.test(last.replace(/https?:\S+/g, ''));
  const opts = menuOptions(close);
  const rec = opts.find((o) => RECOMMENDED_RE.test(o.text)) || (/\bI(?:'d| would)? recommend (?:option )?(\d)\b/i.exec(close.join(' ')) && { n: Number(/\bI(?:'d| would)? recommend (?:option )?(\d)\b/i.exec(close.join(' '))[1]) });
  out.forbiddenText = close.slice(-6).join('\n');
  // The agent's own words: lines after the last tool-output line (its "5 passed" is not a status report).
  const toolEnd = close.reduce((k, l, i) => (/^\s*[⎿└]/.test(l) ? i : k), -1);
  const msg = close.slice(toolEnd + 1).length ? close.slice(toolEnd + 1) : close;
  // A question line right before a numbered option list ("Should I split it?" 1. ... 2. ...): the last paragraph is
  // then only the final option, so look at the line above the first option. A status list with no question above stays done.
  if (!asks && opts.length >= 2) {
    const first = msg.findIndex((l) => OPTION_RE.test(l));
    const lead = first > 0 ? msg.slice(Math.max(0, first - 2), first).filter((l) => !OPTION_RE.test(l)).map((l) => l.trim()) : [];
    if (lead.length && /\?["')\]]*\s*:?\s*$/.test(lead[lead.length - 1])) { asks = true; out.question = tailSentences(lead[lead.length - 1], 300); }
  }
  const tailText = msg.slice(-6).join(' ').replace(/\s+/g, ' ');
  const lastText = last.replace(/\s+/g, ' ');
  const shortText = lastParagraph(close, { stripTools: false }).replace(/\s+/g, ' ');   // stopped_short keeps the tool output: a still-running background task blocks it
  const paras = paragraphs(msg);
  const lastPara = paras[paras.length - 1] || '';
  // A wait is the agent's own closing state: the last paragraphs, but a list item only counts when it is the very last
  // one (a feature description inside an earlier bullet is not the agent waiting), minus sentences that say no
  // restart / deploy was needed.
  const isItem = (p) => /^\s*(?:[-*]|\d+[.)])\s/.test(p);
  const waitText = paras.slice(-4).filter((p) => !isItem(p) || p === lastPara).join(' ')
    .split(/(?<=[.!?])\s+/).filter((x) => !NEGATED_RE.test(x)).join(' ').replace(/\s+/g, ' ').slice(-600);
  const wait = WAIT_DEPLOY_RE.exec(waitText);
  let act = opts.length < 2 && !wait ? OWNER_ACTION_RE.exec(lastText) || OWNER_ACTION_RE.exec(tailText) : null;
  let fyi = null;
  if (act && FYI_RELOAD_RE.test(`${act[1]}${act[2] || ''}`)) { fyi = actionOf(act, tailText); act = null; asks = /\?["')\]]*\s*$/.test(lastText); }   // an FYI report asks only when it really ends on a question (a code line's "a ? b : c" is not one)
  if (wait) {
    out.case = 'waiting_deploy';
    out.deployHint = deployHint(waitText);
  } else if (act) {
    out.case = 'owner_action';
    out.action = actionOf(act, tailText);
  } else if (asks) {
    if (opts.length >= 2 && rec) { out.case = 'menu_recommended'; out.answer = { text: 'Yes, go with your recommendation.' }; }
    else if (opts.length >= 2 && unmarkedFirst(opts, close) && !wait) { out.case = 'menu_recommended'; out.answer = { text: `Go with option ${opts[0].n}.` }; out.source = 'unmarked-first'; }
    else if (opts.length >= 2 || DECISION_Q.test(last)) out.case = 'owner_decision';
    else if (CONTINUE_Q.test(last)) { out.case = 'continue'; out.answer = { text: 'Yes, continue.' }; }
    else { out.case = 'owner_decision'; out.source = 'ambiguous'; }
  } else if (SHORT_RE.test(shortText) && !SHORT_BLOCK_RE.test(shortText)) {
    out.case = 'stopped_short'; out.answer = { text: 'Yes, continue.' };
  } else if (NEXT_STEP.test(close.slice(-4).join(' '))) {
    // Stopped while announcing a next step: maybe it should just carry on.
    out.case = 'done'; out.source = 'ambiguous';
  } else out.case = 'done';
  // no_status: a closing text that never says what is done / tested / left / next / blocked. A question,
  // a deploy wait and an owner action each state their own next step, so they are not flagged.
  if (asks && opts.length >= 2) out.options = opts.map((o) => ({ n: o.n, text: o.text, recommended: RECOMMENDED_RE.test(o.text) || (out.source === 'unmarked-first' && o.n === opts[0].n), ...(out.source === 'unmarked-first' && o.n === opts[0].n ? { unmarked: true } : {}), forbidden: forbiddenMatch(o.text) }));
  if (fyi) out.fyi = fyi;
  out.no_status = !asks && !fyi && !['waiting_deploy', 'owner_action'].includes(out.case) && !STATUS_RE.test(tailText);
  if (out.no_status && out.case === 'done') { out.answer = { text: ASK_STATUS_TEXT }; out.autoCase = 'ask_status'; }
  return finish(out);
}

export const ASK_STATUS_TEXT = 'Before stopping: what is done, what is left?';

// {scope?, ref?} when the closing text names them (--host / --server / --frontend, a branch).
export function deployHint(text) {
  const hint = {};
  const flag = /--(host|server|frontend)\b/i.exec(text) || /\b(host|server|frontend)\s+(?:deploy|restart)/i.exec(text) || /\b(?:deploy|restart)\s+(?:the |every )?(host|server|frontend)\b/i.exec(text);
  if (flag) hint.scope = flag[1].toLowerCase();
  const ref = /\bupdate_core(?:\.sh)?\s+(?!-)([\w./-]+)/i.exec(text) || /\bbranch\s+[`']?([\w.-]*[\/-][\w./-]*)/i.exec(text) || /\b(main|master)\b/.exec(text);
  if (ref) hint.ref = ref[1];
  return hint;
}

// "reload it" + "Review page" earlier -> "reload the review page".
function actionOf(m, text) {
  let a = `${m[1]}${(m[2] || '').split(/,|;|\s(?:to|so|and|or|because|if|—)\s|\s-\s/)[0]}`.replace(/\s+/g, ' ').trim().toLowerCase();
  if (/\b(?:it|this|that|them)$/i.test(a)) {
    const noun = /\b([A-Za-z-]+) page\b/.exec(text);
    a = a.replace(/\b(?:it|this|that|them)$/i, noun ? `the ${noun[1].toLowerCase()} page` : '').trim();
  }
  return a.slice(0, 60);
}

function finish(out) {
  let text = out.forbiddenText ?? out.question ?? '';
  // A yes / continue answer approves the question and its plan, not finished-work narrative around it (round 9, item 2).
  if (out.case === 'continue' && out.forbiddenText != null) { const a = approvedAction({ case: out.case, approvalText: out.forbiddenText }); text = [a.text, ...a.commands].join('\n'); }
  out.forbidden = forbiddenMatch(text);
  out.topics = topicSplit(text);
  Object.defineProperty(out, 'topicsText', { value: text, enumerable: false, writable: true });   // what the topics were read over (the manager re-reads it when a decided deploy covers a topic)
  delete out.forbiddenText;
  return out;
}

// Apply a Jev decision (continue | take_recommended | ask_owner) to an ambiguous stall.
export function applyJev(stall, choice) {
  const s = { ...stall, source: 'jev', jevChoice: choice, autoCase: undefined };
  if (choice === 'continue') { s.case = 'continue'; s.answer = { text: 'Yes, continue.' }; }
  else if (choice === 'take_recommended') { s.case = 'menu_recommended'; s.answer = { text: 'Yes, go with your recommendation.' }; }
  else { s.case = s.case === 'done' ? 'done' : 'owner_decision'; s.answer = null; }
  return s;
}

// The final gate: what would actually be typed. Forbidden topics, drafts and owner cases never are.
export function wouldSend(stall) {
  if (!stall.answer) return { send: null, why: { done: 'finished', waiting_deploy: 'deploy waiting', owner_action: 'owner action', background_wait: 'background work still running', own_job_wait: 'waiting on its own job' }[stall.case] || 'owner' };
  if (stall.forbidden) return { send: null, why: `forbidden: ${stall.forbidden}` };
  if (stall.draft) return { send: null, why: 'owner has a draft in the input box' };
  return { send: stall.answer, why: stall.autoCase || stall.case };
}

// What the owner actually did next, reduced to the same vocabulary, for the shadow-mode report.
export function outcomeKind(text) {
  const t = String(text || '').trim();
  if (!t) return 'unknown';
  if (/^\d$/.test(t) || /^(?:go with|take) (?:your |the )?(?:recommend|option \d)/i.test(t)) return 'take_recommended';
  if (t.length <= 40 && /^(?:y|yes|yep|yeah|ok|okay|sure|go|go ahead|continue|proceed|carry on|keep going|do it|please do|yes,? (?:continue|go ahead|please|do it|proceed))\b[.!]*$/i.test(t)) return 'continue';
  return 'owner_specific';
}
