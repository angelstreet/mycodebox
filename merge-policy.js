// Merge policy (round 7): the manager decides a session's "merge <branch>?" question itself when nothing argues
// against it (OWNER_DECISIONS §14). Facts come from read-only git (no fetch, no checkout, no write to refs or the
// work tree); the floor lists reasons to escalate; Jev (or the manager's own reasoning) rates what is left.
// Deploy, deletions, credentials, money and customers stay hard floors (stall.js hardMatch): a merge+deploy question
// is split, the merge decided here, the deploy escalated.
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { buildRequest } from './router.js';
import { hardMatch } from './stall.js';

export const MERGE_DEFAULTS = { mergeDecisions: true, mergeMinConfidence: 0.85, mergeOptOut: [], mergeConventionFiles: ['VERSION.txt'], infoAnswers: true, infoRoots: [] };

const WORD_SKIP = new Set(['it', 'this', 'that', 'them', 'these', 'the', 'a', 'an', 'my', 'our', 'your', 'its', 'branch', 'pr', 'pull', 'request', 'work', 'changes', 'change', 'into', 'to', 'onto', 'in', 'and', 'then', 'now', 'first', 'or', 'with', 'after', 'before', 'once', 'when', 'if', 'whether', 'yes', 'no', 'all', 'everything', 'conflicts', 'conflict', 'commit', 'commits']);
const REF_TOKEN = String.raw`[\w][\w./@+-]*`;
const clean = (t) => String(t || '').replace(/^[`'"(\[]+|[`'"),.;:?!\]]+$/g, '');

// "merge <branch> [into|to|onto <target>]" -> { branch, target } (null when not named).
export function parseMergeAsk(text) {
  const t = String(text || '');
  const tok = String.raw`(${REF_TOKEN}|[\`'"]${REF_TOKEN}[\`'"])`;
  const re = new RegExp(String.raw`\bmerg(?:e|es|ed|ing)\b\s+(?:(?:the|branch|pr)\s+)*${tok}(?:\s+(?:in|on)?to\s+(?:the\s+)?${tok})?`, 'ig');
  let m;
  while ((m = re.exec(t))) {
    const branch = clean(m[1]);
    if (!branch || WORD_SKIP.has(branch.toLowerCase())) continue;
    const target = m[2] ? clean(m[2]) : null;
    return { branch, target: target && !WORD_SKIP.has(target.toLowerCase()) ? target : null };
  }
  // "merge into main": no branch named
  const only = /\bmerg(?:e|es|ed|ing)\s+(?:(?:it|this|that|these|them|the|branch|pr)\s+)*(?:in|on)?to\s+(?:the\s+)?(\S+)/i.exec(t);
  const tgt = only ? clean(only[1]) : null;
  return { branch: null, target: tgt && !WORD_SKIP.has(tgt.toLowerCase()) ? tgt : null };
}

// ---- test evidence in the session's closing text ----
const sentenceOf = (text, idx) => {
  const dot = text.lastIndexOf('. ', idx);
  const s = Math.max(text.lastIndexOf('\n', idx) + 1, dot < 0 ? 0 : dot + 2);
  let e = text.slice(idx).search(/\n|\. /);
  e = e < 0 ? text.length : idx + e;
  return text.slice(s, e).replace(/\s+/g, ' ').trim().slice(0, 160);
};
export function testEvidence(text) {
  const t = String(text || '');
  // red: a nonzero failure count, "failing", "red", "broken", "FAIL". "0 failed" / "no failures" is fine.
  const failRe = /(?:(\d+)\s*(?:tests?\s+)?)?\b(fail(?:s|ed|ing|ures?)?)\b/gi;
  let m;
  while ((m = failRe.exec(t))) {
    const n = m[1] != null ? Number(m[1]) : null;
    const before = t.slice(Math.max(0, m.index - 12), m.index);
    if (n === 0 || /\b(?:no|zero|without|0)\s*$/i.test(before)) continue;
    if (/\bfail(?:s|ed|ing|ures?)?$/i.test(m[2]) && /\b(?:fail-?safe|failover)\b/i.test(t.slice(m.index, m.index + 12))) continue;
    return { state: 'red', explicit: n != null, quote: sentenceOf(t, m.index) };
  }
  const red = /\bred\b|\bbroken\b|\bFAIL\b/.exec(t);
  if (red && !/\b(?:not|no|isn'?t|never)\s+(?:red|broken)\b/i.test(t)) return { state: 'red', explicit: false, quote: sentenceOf(t, red.index) };
  // "N/M" with tests/pass nearby: fewer passed than ran is red.
  const frac = /\b(\d+)\s*\/\s*(\d+)\b/.exec(t);
  if (frac && /\btests?\b|\bpass/i.test(t) && Number(frac[2]) >= 1) {
    if (Number(frac[1]) < Number(frac[2])) return { state: 'red', explicit: true, quote: sentenceOf(t, frac.index) };
    return { state: 'green', explicit: true, quote: sentenceOf(t, frac.index) };
  }
  const counted = /\b(\d+)\s+(?:tests?\s+)?(?:passed|passing|pass)\b/i.exec(t);
  if (counted && Number(counted[1]) > 0) return { state: 'green', explicit: true, quote: sentenceOf(t, counted.index) };
  const word = /\ball\s+(?:tests?\s+)?(?:green|pass(?:ed|ing)?)\b|\ball green\b|\btests?\s+(?:are\s+|is\s+|all\s+)?(?:green|pass(?:ed|es|ing)?)\b|\bCI\s+(?:is\s+)?green\b|\bpass(?:es)?\s+on\s+\S+|\bgreen\s+(?:tests?|suite|CI)\b|\b(?:npm|yarn|pnpm)\s+test\s+(?:is\s+)?(?:green|passes|passed)\b/i.exec(t);
  if (word) return { state: 'green', explicit: false, quote: sentenceOf(t, word.index) };
  return { state: 'unknown', explicit: false, quote: '' };
}

// ---- read-only git facts ----
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
function git(cwd, args, { max = 4 * 1024 * 1024, okCodes = [0] } = {}) {
  try {
    return { code: 0, out: execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: max, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    const code = typeof e.status === 'number' ? e.status : -1;
    if (okCodes.includes(code) || e.code === 'ENOBUFS') return { code, out: String(e.stdout || ''), err: String(e.stderr || ''), truncated: e.code === 'ENOBUFS' };
    return { code, out: String(e.stdout || ''), err: String(e.stderr || e.message || '').trim().split('\n')[0] };
  }
}
// The repo toplevel of a working directory, or null.
export function repoToplevel(cwd) {
  if (!cwd) return null;
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.out.trim() : null;
}
const DOCS_RE = /\.md$|\.txt$|^docs\/|(^|\/)tests?\/|__tests__|\.test\.|\.spec\./;
const isConvention = (f, conv) => conv.some((c) => f === c || basename(f) === c);
const SENSITIVE_CONTENT = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'], [/AKIA[0-9A-Z]{16}/, 'cloud access key'], [/ghp_[A-Za-z0-9]{30,}/, 'git host token'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'chat token'], [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/, 'api key'],
];
export function sensitivePath(f) {
  const segs = f.split('/'), base = segs[segs.length - 1], lower = f.toLowerCase();
  if (/^\.env/.test(base)) return 'secret';
  if (/\.pem$|\.key$/i.test(base) || /^id_rsa/.test(base)) return 'secret';
  if (segs.some((s) => /secret|credential|password/i.test(s))) return 'secret';
  if (/(^|\/)migrations\//.test(lower) || /\.sql$/.test(lower)) return 'migration';
  if (/sudoers/.test(lower)) return 'sudoers';
  if (/\.(service|timer|socket)$/.test(lower) || /(^|\/)systemd\//.test(lower)) return 'systemd';
  return null;
}

export function gitFacts({ cwd, branch, target, conventionFiles = MERGE_DEFAULTS.mergeConventionFiles } = {}) {
  const fail = (error) => ({ ok: false, error, repo: null, repoName: null, branch: branch || null, target: target || null, branchSha: null, targetSha: null, alreadyMerged: false, conflicts: [], conventionOnly: false, files: [], docsOnly: false, sensitive: [] });
  if (!cwd) return fail('no working directory');
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return fail('not a git repository');
  const repo = top.out.trim();
  const repoName = basename(repo);
  const resolves = (ref) => git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).code === 0;
  // branch: the named one when it exists, else the session's current branch
  let bName = null, bRef = null;
  if (branch) {
    if (resolves(`refs/heads/${branch}`)) { bName = branch; bRef = `refs/heads/${branch}`; }
    else if (resolves(`refs/remotes/origin/${branch}`)) { bName = branch; bRef = `refs/remotes/origin/${branch}`; }
  }
  if (!bRef) {
    const cur = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const c = cur.code === 0 ? cur.out.trim() : '';
    if (c && c !== 'HEAD') { bName = c; bRef = `refs/heads/${c}`; }
  }
  // target: named, else origin/HEAD's branch, else main; prefer origin/<target>
  let tName = target || null;
  if (!tName) {
    const h = git(repo, ['symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD']);
    tName = h.code === 0 && h.out.trim() ? h.out.trim().replace(/^origin\//, '') : 'main';
  }
  const tRef = resolves(`refs/remotes/origin/${tName}`) ? `refs/remotes/origin/${tName}` : resolves(`refs/heads/${tName}`) ? `refs/heads/${tName}` : null;
  const base = { ok: true, repo, repoName, branch: bName, target: tName, branchSha: null, targetSha: null, alreadyMerged: false, conflicts: [], conventionOnly: false, files: [], docsOnly: false, sensitive: [] };
  if (!bRef) return { ...base, ok: false, error: 'branch not found' };
  if (!tRef) return { ...base, ok: false, error: `target ${tName} not found` };
  if (bRef === tRef || bName === tName) return { ...base, ok: false, error: 'branch not found' };
  const sha = (r) => git(repo, ['rev-parse', r]).out.trim();
  const out = { ...base, branchSha: sha(bRef), targetSha: sha(tRef) };
  out.alreadyMerged = git(repo, ['merge-base', '--is-ancestor', bRef, tRef], { okCodes: [0, 1] }).code === 0;
  const mt = git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', tRef, bRef], { okCodes: [0, 1] });
  if (mt.code !== 0 && mt.code !== 1) return { ...out, ok: false, error: `merge-tree failed: ${mt.err || 'unknown'}` };
  if (mt.code === 1) out.conflicts = [...new Set(mt.out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean))];
  out.conventionOnly = out.conflicts.length > 0 && out.conflicts.every((f) => isConvention(f, conventionFiles));
  const names = git(repo, ['diff', '--name-only', '-z', `${tRef}...${bRef}`]);
  if (names.code !== 0) return { ...out, ok: false, error: `git diff failed: ${names.err || 'unknown'}` };
  out.files = names.out.split('\0').filter(Boolean);
  const real = out.files.filter((f) => !isConvention(f, conventionFiles));
  out.docsOnly = real.length > 0 ? real.every((f) => DOCS_RE.test(f)) : out.files.length > 0;
  for (const f of out.files) { const why = sensitivePath(f); if (why) out.sensitive.push({ file: f, why }); }
  // added lines only, capped at 2 MB
  const diff = git(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', `${tRef}...${bRef}`], { max: 2 * 1024 * 1024 });
  let file = null;
  for (const line of diff.out.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
    if (!line.startsWith('+')) continue;
    for (const [re, label] of SENSITIVE_CONTENT) {
      if (re.test(line) && !out.sensitive.some((s) => s.file === file && s.why === 'secret-content')) out.sensitive.push({ file, why: 'secret-content', what: label });
    }
  }
  return out;
}

const SENS_TEXT = { secret: 'a secret/credential path', migration: 'a migration', sudoers: 'sudoers', systemd: 'a systemd unit', 'secret-content': 'secret-looking content' };
// Reasons to escalate; empty = the manager may proceed.
export function mergeFloor(facts, ev, { optOut = [], conventionFiles = MERGE_DEFAULTS.mergeConventionFiles } = {}) {
  if (!facts) return ['not a git repository or git error'];
  const reasons = [];
  const out = (optOut || []).map(String);
  if (facts.repo && out.some((o) => o === facts.repoName || o === facts.repo)) return [`repo ${facts.repoName} is opted out of manager merge decisions`];
  if (!facts.ok) return [facts.error === 'branch not found' ? 'branch not found' : /^not a git/.test(facts.error) ? 'not a git repository' : `git error: ${facts.error}`];
  if (facts.alreadyMerged) return [`${facts.branch} is already merged into ${facts.target}`];
  const outside = (facts.conflicts || []).filter((f) => !isConvention(f, conventionFiles));
  if (outside.length) reasons.push(`conflicts outside convention: ${outside.join(', ')}`);
  if (ev?.state === 'red') reasons.push(`tests reported red: ${ev.quote}`);
  else if (ev?.state !== 'green' && !facts.docsOnly) reasons.push('no green test report on the branch');
  for (const s of facts.sensitive || []) reasons.push(`touches ${SENS_TEXT[s.why] || 'a sensitive path'}: ${s.file}`);
  return reasons;
}

// The manager's own rating when Jev is not available (the floor already passed).
export function reasoningDecision(facts, ev) {
  const strong = facts.docsOnly || (ev.state === 'green' && ev.explicit);
  return { source: 'reasoning', choice: 'merge', confidence: strong ? 0.9 : 0.8 };
}

const short = (sha) => String(sha || '').slice(0, 12);
function summarize(facts, ev) {
  const bits = [];
  bits.push(facts.conflicts?.length ? `merges with convention-file conflicts only (${facts.conflicts.join(', ')})` : 'merges cleanly');
  bits.push(ev.state === 'green' ? `tests green${ev.quote ? ` (${ev.quote.slice(0, 80)})` : ''}` : facts.docsOnly ? 'docs/test-only change' : `tests ${ev.state}`);
  bits.push(`${facts.files.length} file${facts.files.length === 1 ? '' : 's'}${facts.docsOnly ? ' (docs-only)' : ''}`);
  return bits.join(', ');
}

// -> { verdict: 'merge'|'escalate', reasons, rationale, facts, tests, decision }. `jev` is injected: async (body) =>
// reply | { skipped } | { error }. Jev is asked only when the floor passed.
export async function evaluateMerge({ cwd, text, session = null, config = {}, jev = null, branch = null, target = null, tests: testsGiven = null } = {}) {
  const cfg = { ...MERGE_DEFAULTS, ...config };
  const parsed = parseMergeAsk(text);
  const ask = { branch: branch || parsed.branch, target: target || parsed.target };   // explicit names (the CLI) win over the text
  const facts = gitFacts({ cwd, branch: ask.branch, target: ask.target, conventionFiles: cfg.mergeConventionFiles });
  const tests = testsGiven || testEvidence(text);   // given: the caller (merge-eval.js --tests) vouches for it
  const question = `Merge ${facts.branch || ask.branch || 'the branch'} into ${facts.target || ask.target || 'the target'}?`;
  const reasons = mergeFloor(facts, tests, { optOut: cfg.mergeOptOut, conventionFiles: cfg.mergeConventionFiles });
  const done = (verdict, why, decision) => ({ verdict, reasons: verdict === 'merge' ? [] : why, rationale: verdict === 'merge' ? summarize(facts, tests) : why.join('; '), question, facts, tests, decision });
  if (reasons.length) return done('escalate', reasons, { source: 'floor', choice: 'escalate', confidence: 1, decision_id: null });
  const min = cfg.mergeMinConfidence;
  const jevFacts = { session, repo: facts.repoName, branch: facts.branch, target: facts.target, conflicts: facts.conflicts, convention_only: facts.conventionOnly, tests: tests.state, tests_quote: tests.quote, docs_only: facts.docsOnly, files: facts.files.length, floor_reasons: [] };
  let reply = null;
  if (typeof jev === 'function') {
    try { reply = await jev(buildRequest('merge', jevFacts, { refs: { source: 'ghosty-merge-policy', session } })); } catch { reply = null; }
  }
  const a = reply && reply.success !== false && !reply.skipped && !reply.error ? reply.answers?.choice : null;
  if (a && (a.choice === 'merge' || a.choice === 'escalate')) {
    const conf = Number(a.probabilities?.[a.choice] ?? a.confidence);
    const confidence = Number.isFinite(conf) ? conf : 0;
    const decision = { source: 'jev', choice: a.choice, confidence, decision_id: reply.decision_id || null };
    if (a.choice === 'escalate') return done('escalate', [`Jev rates it escalate (${confidence.toFixed(2)})`], decision);
    if (confidence < min) return done('escalate', [`Jev confidence ${confidence.toFixed(2)} below ${min}`], decision);
    return done('merge', [], decision);
  }
  const r = reasoningDecision(facts, tests);
  const decision = { ...r, decision_id: null };
  if (r.confidence < min) return done('escalate', [`manager confidence ${r.confidence.toFixed(2)} below ${min} (no explicit test count)`], decision);
  return done('merge', [], decision);
}

// A record for <state>/merge-decisions.jsonl, shaped like a V2 decision (orchestration/task-contract.js validateDecision).
export function journalRecord(ev, { id, session = null, at = new Date() } = {}) {
  const f = ev.facts || {}, d = ev.decision || {};
  const ts = at instanceof Date ? at.toISOString() : typeof at === 'number' ? new Date(at).toISOString() : String(at);
  const evidence = [
    f.ok ? (f.conflicts?.length ? `merge-tree conflicts: ${f.conflicts.join(', ')}` : 'merge-tree clean') : `git: ${f.error || 'no facts'}`,
    `tests: ${ev.tests?.quote || ev.tests?.state || 'unknown'}`,
    `files: ${f.files?.length ?? 0}${f.docsOnly ? ' (docs-only)' : ''}`,
    `branch ${f.branch}@${short(f.branchSha)} -> ${f.target}@${short(f.targetSha)}`,
  ];
  if (f.sensitive?.length) evidence.push(`sensitive: ${f.sensitive.map((s) => s.file).join(', ')}`);
  const merged = ev.verdict === 'merge';
  return {
    decision_id: `merge-${id}`, task_id: `manager:${session || 'unknown'}`, kind: 'merge', ts,
    question: ev.question || `Merge ${f.branch} into ${f.target}?`,
    chosen: ev.verdict,
    alternatives: [
      { option: 'merge', pros: ['the session is not blocked on the owner', 'reversible with a revert of the merge commit'], cons: ['a wrong call lands unreviewed work on the target'] },
      { option: 'escalate', pros: ['the owner sees anything risky first'], cons: ['the session waits for the owner'] },
    ],
    expected_effect: merged ? `The session merges ${f.branch} into ${f.target} without asking the owner.` : `The owner is asked: ${(ev.reasons || []).join('; ') || 'not decided'}.`,
    rationale: ev.rationale || (merged ? 'floor passed' : 'escalated'),
    evidence,
    actor: { role: 'manager', runtime: null, model: null },
    confidence: Number.isFinite(d.confidence) ? d.confidence : null,
    policy_ref: 'OWNER_DECISIONS §14',
    reversible: true,
    rollback: 'git revert -m 1 <merge commit> on the target branch',
    session, repo: f.repoName || null, branch: f.branch || null, target: f.target || null,
    branch_sha: f.branchSha || null, target_sha: f.targetSha || null,
    jev_decision_id: d.source === 'jev' ? (d.decision_id || 'jev') : 'reasoning',
    ...(ev.reasons?.length ? { reasons: ev.reasons } : {}),
  };
}

// One reply for the session: the information answers, the merge answer and (when anything remains) a pointer to the owner.
// info = [{ part, answer, source }], merge = { branch, target, rationale } | null. -> { text, info: [kept indexes], merge: bool } | null.
// Every line must pass the hard floor (merge present); a line that would trip it is dropped, never reworded.
export function composeReply({ info = [], merge = null, remaining = false } = {}) {
  const lines = [], keptInfo = [];
  const label = (p) => String(p || '').replace(/^\s*(?:\(?[a-z0-9]\)|\d+[.)])\s*/i, '').replace(/[\s,;:.?]+$/, '').replace(/^(?:and|plus)\s+/i, '').replace(/^./, (c) => c.toUpperCase()).slice(0, 80);
  info.forEach((i, n) => {
    const line = `${label(i.part)}: ${i.answer}${i.source ? ` (from ${i.source})` : ''}`;
    if (hardMatch(line, { mergePresent: true })) return;
    lines.push(line); keptInfo.push(n);
  });
  let mergeUsed = false;
  if (merge) {
    const full = `Merge: yes - the manager evaluated ${merge.branch} -> ${merge.target}: ${merge.rationale}. Merge it now.`;
    const bare = `Merge: yes - the manager evaluated ${merge.branch} -> ${merge.target}. Merge it now.`;
    const line = !hardMatch(full, { mergePresent: true }) ? full : !hardMatch(bare, { mergePresent: true }) ? bare : null;
    if (line) { lines.push(line); mergeUsed = true; }
  }
  if (!lines.length) return null;
  if (remaining) lines.push('The rest of your question went to the owner: wait for their answer on it.');
  const text = lines.join(' ');
  if (hardMatch(text, { mergePresent: true })) return null;
  return { text, info: keptInfo, merge: mergeUsed };
}
