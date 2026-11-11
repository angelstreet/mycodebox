// STATUS honesty (owner, 2026-11-11): "done and goal not achieved should not be a done status: it should be blocked or failure, which means
// the agent needs help and the manager should look at it." opus-openexit ended `STATUS: done — anchor not valid on stb4 today, so v2 stays and
// no v3 was built`; task208-pick5 called radio "green" from success flags with no playback evidence. Closed vocabulary (docs/REFERENCE.md
// "STATUS vocabulary"):
//   STATUS: done — <what> · goal: achieved · evidence: <links / run ids / frames>   only when the task's goal was achieved
//   STATUS: failed — goal not achieved: <why> · tried: <list>                         the agent needs help: a manager item, never parked as finished
//   STATUS: waiting: <integration / deploy id, lease ticket, own job, worker names, a time> | blocked: <what stops you> · tried: <list> · need: <manager action> | needs-owner: <floor item> | needs-manager: <ask>
// Pure functions only; done-check.js wakes the session, server.js / manager.js route `failed` like needs-manager.

// ---- the task goal ----
// cbsession writes the prompt to ~/handovers/<name>.prompt.md behind its own preamble (Ship rule, worktree line, found-bug and closing review
// rules). The goal is an explicit `Goal:` line when there is one, else the first line of the task text (a `# Task: ...` heading or the first sentence).
const PREAMBLE_RE = /^(?:you are picking up work|ship rule\b|ship rule \(|your worktree is ready|first command|a bug you find|closing review before|bug outside your scope|public repos?\b)/i;
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
  // owner 2026-11-11 (harness-done-honest): a done line that says the work is not done is refused without AI
  ['not done', /\b(?:is|are|was|were|remains?|stays?)?\s*not (?:yet )?(?:done|finished|complete|completed|fixed|started|published|merged|deployed|confirmed)\b|\bnot yet (?:deployed|verified|merged|measured|published|confirmed|run|tested|fixed|done|built)\b/i],
  ['still open', /\b(?:still|remains?) (?:open|pending|unresolved|missing|unfinished|queued|waiting|to do)\b/i],
  ['partly achieved', /\b(?:partly|partially|half) (?:achieved|done|fixed|delivered|complete|completed|met|reached|working)\b/i],
  ['incomplete', /\b(?:is|are|was|were|remains?) incomplete\b|\bincomplete\b(?=\s*(?:[,;.:·]|$|with\b))/i],
  ['goal not met', /\bgoal not (?:met|reached|achieved)\b/i],
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
    + 'or `STATUS: blocked: <what stops you> · tried: <list> · need: <what the manager must do>`, or `STATUS: waiting: <what is running>`. If the goal WAS achieved, rewrite the done line with '
    + '`goal: achieved · evidence: <report links / run ids / frames>` and the closing review. Do not ask; pick the true one.';
}

// ---- (2) proof claims without evidence ----
// "green / pass / proven / works" in the done claim needs a reference the owner can open: a URL, a report / run / result id, a frame / audio /
// screenshot file, or an `evidence:` segment that holds one of those.
const PROOF_RE = /\b(?:green|pass(?:ed|es|ing)?|proven|proved|proof|works|working|validated|verified on)\b/i;
const EVIDENCE_RE = /https?:\/\/\S+|\b(?:report|run|result|results|execution|script|job|frame|screenshot|capture|recording|video|audio)s?\s*[#:=]?\s*\(?[`"]?[0-9a-f]{6,}\b|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\S+\.(?:png|jpe?g|webp|gif|mp4|webm|mkv|ts|wav|mp3|ogg|m4a|html|json|log)\b|\bevidence\s*[:=]\s*[^·|;]*?(?:\/|\b[0-9a-f]{7,40}\b|\bint-[0-9a-z]{6,}|\bbug-[0-9a-f]{8}|\bt-[0-9a-f]{6,})/i;   // `evidence: merge 082d43609e7b` (fp-audit-opus, 2026-11-11: warned wrongly)
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
export const VOCABULARY = ['done', 'running', 'waiting', 'needs-manager', 'needs-owner', 'blocked', 'failed', 'handoff', 'acknowledged'];
// The seven words of the owner's table (docs/STATUS-TABLE.md, 2026-11-11). `handoff` and `acknowledged` (and the done aliases stall.js reads: ack, noted,
// ok, shipped, complete(d), finished) are tolerated: guard messages ask for `STATUS: acknowledged` from an idle session. Anything else is unknown.
export const SEVEN_WORDS = ['done', 'running', 'waiting', 'needs-manager', 'needs-owner', 'blocked', 'failed'];
const TOLERATED = new Set([...SEVEN_WORDS, 'handoff', 'acknowledged', 'ack', 'noted', 'ok', 'shipped', 'complete', 'completed', 'finished', 'not', 'partial']);   // `not fully confirmed` / `partial` have their own check
// Pure. -> null, or { word } when the last STATUS line starts with a word that is not one of the seven (nor a tolerated system reply).
export function unknownStatusWordOf(text) {
  const st = lastStatus(text);
  return st && !TOLERATED.has(st.kind) ? { word: st.kind, line: st.line.slice(0, 160) } : null;
}
// blocked lines and unknown words are what done-check (I) looks at
export const blockedOrUnknownStatus = (text) => { const st = lastStatus(text); return !!st && (st.kind === 'blocked' || !TOLERATED.has(st.kind)); };
export function unknownStatusWordMessage(f) {
  return `Status check: \`STATUS: ${f.word}\` is not a STATUS word. The seven: done (goal reached, proof in hand, nothing of yours running) · running (work of yours still goes: your background job, a worker you started) · `
    + 'waiting (you depend on something not yours that ends by itself: lane, deploy, lease ticket, another session, a time) · needs-manager (you need a decision or an answer) · needs-owner (money, customers, deleting shared data, an owner-only credential, a physical action) · '
    + 'blocked (you cannot work and nothing running will fix it: `blocked: <what stops you> · tried: <list> · need: <who must do what>`) · failed (`failed — goal not achieved: <why> · tried: <list>`). Rewrite your STATUS line with the true one of the seven. One push only.';
}
// Pure. `STATUS: failed — goal not achieved: <why> · tried: <list>` -> { why, tried } | null.
export function failedOf(text) {
  const st = lastStatus(text);
  if (!st || st.kind !== 'failed') return null;
  const t = unmark(st.text);
  const why = (/goal not achieved\s*[:—–-]?\s*(.+?)(?=\s[·|;]\s*tried\b|$)/i.exec(t) || [, t.split(/\s[·|;]\s*tried\b/i)[0]])[1].trim();
  const tried = (/\btried\s*[:=]?\s*(.+?)(?=\s[·|;]\s*(?:closing|bugs)\b|$)/i.exec(t) || [])[1]?.trim() || '';
  return { why: why.slice(0, 300), tried: tried.slice(0, 300) };
}

// ---- (3) done without `goal: achieved` + evidence (Mac stops; harness-done-honest 2026-11-11) ----
// Pure. -> null, or { missing: ['goal: achieved', 'evidence'] } when the last STATUS is done and lacks the goal statement or a reference.
export function doneWithoutGoalOf(text) {
  const st = lastStatus(text);
  if (!st || !DONE_KINDS.has(st.kind)) return null;
  const missing = [];
  if (!/\bgoal\s*[:=]\s*achieved\b/i.test(st.text)) missing.push('goal: achieved');
  if (!/\bevidence\s*[:=]\s*\S{3,}/i.test(st.text)) missing.push('evidence: <links / run ids / frames>');
  return missing.length ? { missing } : null;
}
export function doneWithoutGoalMessage(f) {
  return `Status check: your done line lacks ${f.missing.join(' and ')}. Done is only for an achieved goal: rewrite it as `
    + '`STATUS: done — <what> · goal: achieved · evidence: <report links / run ids / commits / frames> · closing review: ...`, '
    + 'or, if the goal was not reached, `STATUS: failed — goal not achieved: <why> · tried: <list>` / `blocked: <reason + what you tried>` / `waiting: <system id>`. Do not ask; pick the true one.';
}

// ---- (4) blocked is not a wait (owner, 2026-11-11 evening) ----
// "blocked is for an agent that cannot work and requires attention from the manager": `blocked: <what stops you> · tried: <list> · need: <what the manager
// must do>`. A wait on something running or queued is `waiting: <integration / deploy id, lease ticket, own background job, worker session, a time>`;
// a session whose part is done while workers it started still run ends on `waiting: <worker names>`. 2026-11-11: 47 of 118 distinct blocked lines were waits.
const RUNNING = [
  ['background job', /\bbackground\s+(?:job\s+|task\s+|run\s+)?`?b[0-9a-z]{7,}\b|\(background\b/i],
  ['waiting on a run', /\b(?:waiting|waits?) (?:on|for) (?:(?:my|the|a|an|our|own|local) )*(?:[\w./+-]+ ){0,3}?(?:sweeps?|runs?|replay|executions?|integration|deploy(?:ment)?|lease|claim|background|monitor|tests?|jobs?|nightly|ci|workers?)\b/i],
  ['time', /\b(?:kept free|free|held|reserved|wait(?:ing)?) until \d{1,2}:\d{2}\b|\buntil \d{1,2}:\d{2} (?:utc|cet|cest)\b/i],
  ['lease held / queued', /\b(?:held|leased) by\b|\bis (?:held|leased)\b|\bqueued (?:claims?|next|behind)\b/i],
  ['monitor', /\ba monitor will\b|\bmonitor will (?:tell|wake|report)\b/i],
];
// Pure. -> null (not a blocked line, or a good one) | { running: [labels], missing: ['tried:', 'need:'] }.
export function blockedHonestyOf(text) {
  const st = lastStatus(text);
  if (!st || st.kind !== 'blocked') return null;
  const t = unmark(st.text);
  const head = t.split(/\s[·|;]\s*closing[ -]review\b/i)[0];
  const running = RUNNING.filter(([, re]) => re.test(head)).map(([k]) => k);
  const missing = [];
  if (!/\btried\s*[:=]/i.test(head)) missing.push('tried:');
  if (!/\bneeds?\s*[:=]/i.test(head)) missing.push('need:');
  return running.length || missing.length ? { running, missing, text: head.slice(0, 200) } : null;
}
// own work (a background job of the session) is `running`; something not its own (lane, deploy, lease, another session, a time) is `waiting`
const OWN_LABELS = new Set(['background job', 'waiting on a run']);
export function blockedHonestyMessage(f) {
  const parts = [];
  if (f.running.length) {
    const own = f.running.every((k) => OWN_LABELS.has(k));
    parts.push(`it names something running or queued (${f.running.join(', ')}): that is not a block, restate it as ${own ? '`STATUS: running: <job id / worker names> — <what is left>` (work of yours that still goes)' : '`STATUS: waiting: <integration / deploy id, lease ticket, session, or a time>` (something not yours that ends by itself)'}; if both apply, running comes first`);
  }
  if (f.missing.length && !f.running.length) parts.push(`it lacks ${f.missing.join(' and ')}`);
  return `Status check: your STATUS is blocked, but ${parts.join('; ')}. \`blocked\` is only for an agent that cannot work and needs the manager: `
    + '`STATUS: blocked: <what stops you> · tried: <what you tried> · need: <what the manager must do>`. If your part is done while workers you started still run, end on `STATUS: running: <worker names>`. One push only.';
}

// ---- goal first, verification last (owner, 2026-11-11, docs/GOAL-RULE.md) ----
// Time box: `Time box: 2 h` / `90 min` / `6h` -> ms, or null. A bare number is hours.
export function timeBoxOf(prompt) {
  const m = /^\s*(?:[*_#>\s-]*)time[ -]?box\s*[:=]\s*~?(\d+(?:[.,]\d+)?)\s*(h(?:ours?|rs?)?|min(?:utes?)?|m)?\b/im.exec(String(prompt || ''));
  if (!m) return null;
  const n = Number(m[1].replace(',', '.')), minutes = /^m/i.test(m[2] || '');
  const ms = Math.round(n * (minutes ? 60e3 : 3600e3));
  return ms >= 60e3 && ms <= 72 * 3600e3 ? ms : null;
}
// The last `Verification:` block of the closing text -> [{ n, verdict: 'pass'|'fail'|'not checked'|'dropped', text }] (rows `<n>. pass | fail | not checked — <why>`).
export function verificationRowsOf(text) {
  const lines = String(text || '').split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (/^\s*(?:[*_#>\s-]*)verification\s*:?[*_]*\s*$/i.test(l.trim())) at = i; });
  if (at < 0) return null;
  const rows = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) { if (rows.length) break; continue; }
    if (/^\W*STATUS:/i.test(l)) break;
    const m = /^(?:[-*]\s*)?(\d+)\s*[.)]\s*\**\s*(pass(?:ed)?|fail(?:ed)?|not checked|dropped by owner|dropped)\b\**\s*(?:[—–:-]\s*)?(.*)$/i.exec(l);
    if (m) rows.push({ n: Number(m[1]), verdict: /^pass/i.test(m[2]) ? 'pass' : /^fail/i.test(m[2]) ? 'fail' : /^not/i.test(m[2]) ? 'not checked' : 'dropped', text: m[3].slice(0, 200) });
    else if (rows.length) break;
  }
  return rows;
}
// Pure. text: the closing text; parts: the stored Done-when lines. -> null (not a done line, or no stored parts), else { ok, total, passed, problems: [..] }.
// A done line needs a Verification block with one row per stored line, same count and numbering, every row pass (a row the owner dropped counts as passed).
export function verificationOf(text, parts = []) {
  const st = lastStatus(text);
  if (!st || !DONE_KINDS.has(st.kind) || !parts.length) return null;
  const rows = verificationRowsOf(text);
  const total = parts.length, problems = [];
  if (!rows) return { ok: false, total, passed: 0, problems: ['no `Verification:` block'] };
  const byN = new Map(rows.map((r) => [r.n, r]));
  let passed = 0;
  for (let i = 1; i <= total; i++) {
    const r = byN.get(i);
    if (!r) { problems.push(`row ${i} is missing (${String(parts[i - 1]).slice(0, 60)})`); continue; }
    if (r.verdict === 'pass' || r.verdict === 'dropped') passed++;
    else problems.push(`row ${i} is ${r.verdict} (${String(parts[i - 1]).slice(0, 60)})`);
  }
  for (const r of rows) if (r.n < 1 || r.n > total) problems.push(`row ${r.n} has no Done-when line (the list has ${total}: never change it at the end)`);
  return { ok: !problems.length, total, passed, problems };
}
export function verificationMessage(v, parts = []) {
  return `Status check: your done line needs a \`Verification:\` block with one row per Done-when line, same count and numbering, every row \`pass\`: ${v.problems.slice(0, 4).join('; ')} (${v.passed} of ${v.total} rows pass). `
    + `The Done-when list of this task: ${parts.slice(0, 6).map((p, i) => `${i + 1}. ${String(p).slice(0, 70)}`).join(' ')}. `
    + 'Write `Verification:` then `<n>. pass | fail | not checked — <evidence that resolves, or why>` for each line, then the STATUS line. All pass = done; any fail or not checked = `running`, `waiting` or `failed`. Never change the Done-when list to fit what you did. One push only.';
}
export const timeBoxWakeMessage = (box) => `Time box reached (${Math.round(box / 6e4)} min): write \`Verification:\` as it stands (one row per Done-when line) and end \`failed\` or \`needs-manager\` with what would unblock it. You do not extend your own time box: the manager or the owner does.`;
