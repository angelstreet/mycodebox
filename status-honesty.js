// STATUS honesty (owner, 2026-11-11): "done and goal not achieved should not be a done status: it should be blocked or failure, which means
// the agent needs help and the manager should look at it." opus-openexit ended `STATUS: done — anchor not valid on stb4 today, so v2 stays and
// no v3 was built`; task208-pick5 called radio "green" from success flags with no playback evidence. Closed vocabulary (docs/REFERENCE.md
// "STATUS vocabulary"):
//   STATUS: done — <what> · goal: achieved · evidence: <links / run ids / frames>   only when the task's goal was achieved
//   STATUS: failed — goal not achieved: <why> · tried: <list>                         the agent needs help: a manager item, never parked as finished
//   STATUS: blocked: <system id or reason + what you tried> | waiting: <system id> | needs-owner: <floor item> | needs-manager: <ask>
// Pure functions only; done-check.js wakes the session, server.js / manager.js route `failed` like needs-manager.

// ---- the task goal ----
// cbsession writes the prompt to ~/handovers/<name>.prompt.md behind its own preamble (Ship rule, worktree line, found-bug and closing review
// rules). The goal is an explicit `Goal:` line when there is one, else the first line of the task text (a `# Task: ...` heading or the first sentence).
const PREAMBLE_RE = /^(?:ship rule\b|ship rule \(|your worktree is ready|first command|a bug you find|closing review before|bug outside your scope|public repos?\b)/i;
export function goalOf(prompt) {
  const lines = String(prompt || '').split('\n').map((l) => l.trim());
  const g = lines.find((l) => /^(?:[*_#>\s]*)goal\s*:/i.test(l));
  if (g) return clip(g.replace(/^(?:[*_#>\s]*)goal\s*:\s*/i, ''));
  const first = lines.find((l) => l && !PREAMBLE_RE.test(l.replace(/^[#*_>\s]+/, '')));
  if (!first) return '';
  const t = first.replace(/^#+\s*/, '').replace(/^(?:task|job)\s*:\s*/i, '');
  return clip((/^(.{20,}?[.!?])(?=\s+[A-Z"'(\[]|$)/.exec(t) || [, t])[1]);
}
const unmark = (s) => String(s || '').replace(/[*`]+|(?<!\w)_+|_+(?!\w)/g, '');   // markdown marks out, snake_case ids kept
const clip = (s) => unmark(s).replace(/\s+/g, ' ').trim().slice(0, 300);

// ---- the last STATUS line (pane-wrapped continuation rows joined) ----
export function lastStatus(text) {
  const lines = String(text || '').split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (/^\W*STATUS:/i.test(l.trim())) at = i; });
  if (at < 0) return null;
  let line = lines[at].trim();
  for (let j = at + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]) && !/^\W*STATUS:/i.test(lines[j].trim()); j++) line += ' ' + lines[j].trim();
  const m = /^\W*STATUS:[*_`]*\s*([a-z][\w-]*(?: fully confirmed)?)\b[*_`]*\s*[:.—–-]*\s*(.*)$/i.exec(line);
  return m ? { kind: m[1].toLowerCase(), text: m[2].trim(), line } : null;
}
const DONE_KINDS = new Set(['done', 'ok', 'complete', 'completed', 'finished', 'shipped']);
// The claim part of a done line: before the closing review / bugs / unverified segments (those list what was filed or not checked, by design).
export function headlineOf(statusText) {
  return unmark(statusText).split(/\s[·|;]\s*(?=closing[ -]review|bugs?\s*[:=]|unverified|leftovers?\b)|\bclosing[ -]review\s*[:=]|\bbugs?\s*[:=]/i)[0].trim();
}
const segmentOf = (statusText, key) => (new RegExp(`\\b${key}\\s*[:=]?\\s+(.+?)(?=\\s[·|;]\\s|$)`, 'i').exec(unmark(statusText)) || [])[1] || '';

// ---- (1) done but the goal was not achieved ----
// Strong: the agent's own words say the goal failed. Fires whatever the goal is.
const STRONG = [
  ['goal not achieved', /\b(?:goal|aim|objective)s? (?:was |is |were )?not (?:achieved|met|reached)\b|\bnot achieved\b/i],
  ['did not achieve', /\bdid(?: not|n'?t) (?:achieve|work|pass|succeed|reproduce|land)\b/i],
  ['not valid', /\bnot valid\b|\binvalid(?:ated)?\b(?! (?:input|json|token|cache))/i],
  ['no X was built', /\bno \w+(?:[ -]\w+)? (?:was|were|got|has been|have been) (?:built|created|made|published|shipped|merged|produced|delivered|fixed|started)\b/i],
  ['nothing built', /\bnothing (?:was |got |has been )?(?:built|fixed|shipped|merged|published|delivered|achieved)\b/i],
  ['0 of N', /(?<![\d.])0\s*(?:of|\/)\s*[1-9]\d*\b(?!\s*(?:fail|error|red|regress))/i],
  ['failed N/N', /\bfail(?:ed|s)?\s+(\d+)\s*(?:of|\/)\s*\1\b/i],
  ['could not', /\b(?:could not|couldn'?t|was unable to|were unable to|unable to)\b/i],
  ['incomplete', /\b(?:proof|goal|run|check|validation|test|measurement)s? (?:is|was|are|were|remains?|stays?) (?:still )?(?:incomplete|unfinished|partial)\b/i],
  ['still failing', /\bstill (?:fails|failing|broken|red|not working|does not work)\b/i],
  ['gave up', /\b(?:gave up|abandoned)\b/i],
];
// Soft: a part not delivered. Fires only when that clause names the goal (two of its words), or when it stands in the headline of a line
// that does not state `goal: achieved`.
const SOFT = [
  ['blocked', /\bblocked\b/i],
  ['not done', /\bnot (?:measured|run|tested|verified|proven|built|done|fixed|working|reproduced|delivered|validated)\b/i],
  ['unverified', /\bunverified\b/i],
];
const STOP = new Set('the a an and or of to on in for with from by at is are was were be this that these those it its as into via per one two first then than not no our your their task owner request agent session fix make run use new old all any each only also both more most'.split(' '));
const words = (s) => new Set((String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9_+.-]{2,}/g) || []).filter((w) => !STOP.has(w)));
const clauses = (s) => String(s || '').split(/(?<=[.;:!?])\s+|\s[·|]\s|,\s+(?=(?:so|but|and)\b)|\s—\s/).map((x) => x.trim()).filter(Boolean);
function overlap(a, goalWords) { let n = 0; for (const w of words(a)) if (goalWords.has(w)) n++; return n; }

// Pure. text: the closing text (its last STATUS line decides); goal: the task goal (goalOf) or ''. -> null, or
// { hits: [{ label, clause, strong }], headline } when the last STATUS is done but its own words say the goal was not achieved.
export function doneButFailedOf(text, goal = '') {
  const st = lastStatus(text);
  if (!st || !DONE_KINDS.has(st.kind)) return null;
  const head = headlineOf(st.text);
  const achieved = /\bgoal\s*[:=]\s*achieved\b/i.test(st.text);
  const gw = words(goal);
  const hits = [];
  for (const c of clauses(head)) {
    const clean = c.replace(/\b(?:no|not|nothing) (?:\w+ )?(?:was |is )?(?:needed|required|necessary|pending|changed|left)\b/gi, '');   // "no tree change was needed" is not a failure
    const s = STRONG.find(([, re]) => re.test(clean));
    if (s) { hits.push({ label: s[0], clause: c.slice(0, 200), strong: true }); continue; }
    if (achieved) continue;
    const w = SOFT.find(([, re]) => re.test(clean));
    if (w && gw.size && overlap(c, gw) >= 2) hits.push({ label: w[0], clause: c.slice(0, 200), strong: false });
  }
  // the unverified segment of the closing review: only what names the goal itself (2+ goal words) counts
  if (gw.size >= 3 && !achieved) for (const c of segmentOf(st.text, 'unverified').split(/,\s+|;\s+/)) if (overlap(c, gw) >= 3) hits.push({ label: 'goal unverified', clause: c.slice(0, 200), strong: false });
  return hits.length ? { hits, headline: head.slice(0, 300) } : null;
}
export function doneButFailedMessage(f, goal = '') {
  const said = f.hits.slice(0, 2).map((h) => `"${h.clause}"`).join(' and ');
  return `Status check: your STATUS says done, but your own text says the goal was not achieved: ${said}.${goal ? ` The goal of this session: "${goal.slice(0, 160)}".` : ''} `
    + 'Done is only for an achieved goal. Restate the line: `STATUS: failed — goal not achieved: <why> · tried: <what you tried>` (the manager looks at it and helps), '
    + 'or `STATUS: blocked: <system id or reason + what you tried>`, or `STATUS: waiting: <system id>`. If the goal WAS achieved, rewrite the done line with '
    + '`goal: achieved · evidence: <report links / run ids / frames>` and the closing review. Do not ask; pick the true one.';
}

// ---- (2) proof claims without evidence ----
// "green / pass / proven / works" in the done claim needs a reference the owner can open: a URL, a report / run / result id, a frame / audio /
// screenshot file, or an `evidence:` segment that holds one of those.
const PROOF_RE = /\b(?:green|pass(?:ed|es|ing)?|proven|proved|proof|works|working|validated|verified on)\b/i;
const EVIDENCE_RE = /https?:\/\/\S+|\b(?:report|run|result|results|execution|script|job|frame|screenshot|capture|recording|video|audio)s?\s*[#:=]?\s*\(?[`"]?[0-9a-f]{6,}\b|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\S+\.(?:png|jpe?g|webp|gif|mp4|webm|mkv|ts|wav|mp3|ogg|m4a|html|json|log)\b|\bevidence\s*[:=]\s*\S*(?:\/|[0-9a-f]{6,})/i;
// Pure. -> null, or { claim } when the last STATUS is done, its claim says green / pass / proven, and neither the line nor the closing paragraph
// above it carries a reference.
export function proofWithoutEvidenceOf(text) {
  const st = lastStatus(text);
  if (!st || !DONE_KINDS.has(st.kind)) return null;
  const head = headlineOf(st.text);
  const m = PROOF_RE.exec(head);
  if (!m) return null;
  if (/\b(?:tests?|npm test|suite|typecheck|lint|ci|unit)\b[^.;·]{0,40}\b(?:green|pass)/i.test(head) && !/\b(?:device|box|stb|tv|phone|prod|run on|playback|audio|video|frame)\b/i.test(head)) return null;   // a test suite is its own evidence
  const paras = String(text || '').split(/\n\s*\n/);
  const tail = paras.slice(-2).join('\n');
  if (EVIDENCE_RE.test(st.text) || EVIDENCE_RE.test(tail)) return null;
  const i = Math.max(0, m.index - 60);
  return { claim: head.slice(i, m.index + 60).trim() };
}
export function proofWithoutEvidenceMessage(f) {
  return `Status check: your done line claims a proof ("${f.claim}") but names no evidence. Add the report links, run / result ids, or frame / audio files the claim rests on `
    + '(`goal: achieved · evidence: <links>`), the way the owner can open them. A success flag is not proof of playback: if you only read flags, say so and run the check that shows it, '
    + 'or restate the line as `STATUS: failed — goal not achieved: ...` / `blocked: ...`. One push only.';
}

// ---- the closed vocabulary ----
export const VOCABULARY = ['done', 'failed', 'blocked', 'waiting', 'needs-owner', 'needs-manager', 'handoff', 'acknowledged'];
// Pure. `STATUS: failed — goal not achieved: <why> · tried: <list>` -> { why, tried } | null.
export function failedOf(text) {
  const st = lastStatus(text);
  if (!st || st.kind !== 'failed') return null;
  const t = unmark(st.text);
  const why = (/goal not achieved\s*[:—–-]?\s*(.+?)(?=\s[·|;]\s*tried\b|$)/i.exec(t) || [, t.split(/\s[·|;]\s*tried\b/i)[0]])[1].trim();
  const tried = (/\btried\s*[:=]?\s*(.+?)(?=\s[·|;]\s*(?:closing|bugs)\b|$)/i.exec(t) || [])[1]?.trim() || '';
  return { why: why.slice(0, 300), tried: tried.slice(0, 300) };
}
