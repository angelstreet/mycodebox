// Merge policy (round 7): the manager decides a session's "merge <branch>?" question itself when nothing argues
// against it (OWNER_DECISIONS §14). Facts come from git without fetch, checkout, or any ref, index or work-tree change
// (merge-tree --write-tree writes loose objects only); the floor lists reasons to escalate; Jev (or the manager's own reasoning) rates what is left.
// Deploy, deletions, credentials, money and customers stay hard floors (stall.js hardMatch): a merge+deploy question
// is split, the merge decided here, the deploy escalated.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, resolve } from 'node:path';
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
// Clause by clause: a count or "N/M" only counts next to the word test(s) / pass, "tests not run" anywhere makes it unknown,
// a negation applies to its own match only, red wins. A question never reports a result (except a failure it mentions).
const clausesOf = (t) => t.split(/(?<=[.!?;])\s+|\n+/).map((c) => c.trim()).filter(Boolean);
const NOT_RUN = /\buntested\b|\bno (?:unit |automated |real )?tests?\b|\b(?:not|never|n'?t|yet to)\s+(?:yet\s+|been\s+)?(?:run|ran|tested|executed)\b|\b(?:tests?|suite|specs?)\b[^.?;]*\b(?:not run|weren'?t run|were not run|skipped|not executed)\b|\b(?:previous|earlier|prior|old)\s+commit\b|\bbefore my (?:last )?change/i;
const PASS_COND = /\bnot all\b[^.?;]*\bpass|\b(?:once|when|if|before|until|unless|after|whether)\b[^.?;]*\bpass|\b(?:will|should|would|to|must|can|could|might)\s+pass\b|\bpass(?:es)?\s+(?:on|through|over)\s+(?:the\s+)?(?:deploy|merge|call|this|that|it)\b/i;
const sentence = (c) => c.slice(0, 160);
export function testEvidence(text, { branch = null } = {}) {
  const t = String(text || '');
  const cls = clausesOf(t);
  // red: a nonzero failure count, "failing", "red", "broken", "FAIL"; "0 failed" / "no failures" / "not red" only for its own match
  for (const c of cls) {
    const failRe = /(?:(\d+)\s*(?:tests?\s+)?)?\b(fail(?:s|ed|ing|ures?)?)\b/gi;
    let m;
    while ((m = failRe.exec(c))) {
      const n = m[1] != null ? Number(m[1]) : null;
      if (n === 0 || /\b(?:no|zero|without|0)\s*$/i.test(c.slice(Math.max(0, m.index - 12), m.index))) continue;
      if (n == null && /^\s*[:=]?\s*0(?![.\d])/.test(c.slice(m.index + m[0].length))) continue;   // "fail 0" (Node's runner summary); "6 failed: 0 retried" stays red
      if (/^(?:fail-?safe|failover)/i.test(c.slice(m.index))) continue;
      return { state: 'red', explicit: n != null, quote: sentence(c) };
    }
    const wre = /\bred\b|\bbroken\b|\bFAIL\b/g;
    while ((m = wre.exec(c))) {
      if (/\b(?:not|no|isn'?t|never|n'?t)\s+(?:be\s+|been\s+)?$/i.test(c.slice(Math.max(0, m.index - 14), m.index))) continue;
      return { state: 'red', explicit: false, quote: sentence(c) };
    }
  }
  const nr = cls.find((c) => NOT_RUN.test(c));
  if (nr) return { state: 'unknown', explicit: false, quote: sentence(nr) };
  const refOk = (c, idx) => {   // "pass on <ref>": only the evaluated branch counts
    const m = /^\s+on\s+(\S+)/i.exec(c.slice(idx)) || /\b(?:pass(?:es|ed|ing)?|green)\s+on\s+(\S+)/i.exec(c);
    if (!m) return true;
    const ref = m[1].replace(/[.,;:)?!]+$/, '');
    return branch ? ref === branch : !/^(?:main|master|develop|origin|trunk)\b/i.test(ref);
  };
  for (const c of cls) {
    if (/\?\s*$/.test(c) || PASS_COND.test(c)) continue;
    const ctx = /\btests?\b|\bsuite\b|\bspecs?\b|\bpass/i.test(c);
    const frac = ctx && /\b(\d+)\s*\/\s*(\d+)\b/.exec(c);
    if (frac && Number(frac[2]) >= 1) {
      if (Number(frac[1]) < Number(frac[2])) return { state: 'red', explicit: true, quote: sentence(c) };
      if (!refOk(c, frac.index + frac[0].length)) continue;
      return { state: 'green', explicit: true, quote: sentence(c) };
    }
    const sum = /\bpass(?:ed|ing)?\s*[:=]?\s*(\d+)\b/i.exec(c);   // Node's runner summary: "pass 12" with "fail 0" somewhere
    if (sum && Number(sum[1]) > 0 && /\bfail(?:ed|ures?)?\s*[:=]?\s*0\b/i.test(t) && refOk(c, sum.index + sum[0].length)) return { state: 'green', explicit: true, quote: sentence(c) };
    const cnt = /\b(\d+)\s+(?:(?:unit\s+|integration\s+)?tests?\s+)?(?:passed|passing|pass)\b(?=\s*(?:$|[,.;:)(]|\b(?:in|on|at|with|for)\b))/i.exec(c);
    if (cnt && Number(cnt[1]) > 0 && refOk(c, cnt.index + cnt[0].length)) return { state: 'green', explicit: true, quote: sentence(c) };
    const word = /\ball\s+(?:tests?\s+)?(?:green|pass(?:ed|ing)?)\b|\ball green\b|\btests?\s+(?:are\s+|is\s+|all\s+)?(?:green|pass(?:ed|es|ing)?)\b|\bCI\s+(?:is\s+)?green\b|\bgreen\s+(?:tests?|suite|CI)\b|\b(?:npm|yarn|pnpm)\s+test\s+(?:is\s+)?(?:green|passes|passed)\b/i.exec(c);
    if (word && refOk(c, word.index + word[0].length)) return { state: 'green', explicit: false, quote: sentence(c) };
    const onRef = /\bpass(?:es|ed)?\s+on\s+(\S+)/i.exec(c);
    if (onRef && branch && onRef[1].replace(/[.,;:)?!]+$/, '') === branch) return { state: 'green', explicit: false, quote: sentence(c) };
  }
  return { state: 'unknown', explicit: false, quote: '' };
}

// ---- git facts (async, bounded: the server's event loop must not wait on a slow repo) ----
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
const execFileP = promisify(execFile);
export async function git(cwd, args, { max = 4 * 1024 * 1024, okCodes = [0] } = {}) {
  try {
    const r = await execFileP('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: max, env: GIT_ENV });
    return { code: 0, out: r.stdout };
  } catch (e) {
    const truncated = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || e.code === 'ENOBUFS';
    const code = typeof e.code === 'number' ? e.code : -1;
    if (truncated) return { code, out: String(e.stdout || ''), err: 'output too large', truncated: true };
    if (okCodes.includes(code)) return { code, out: String(e.stdout || ''), err: String(e.stderr || '') };
    return { code, out: String(e.stdout || ''), err: String(e.stderr || e.message || '').trim().split('\n')[0], timedOut: !!e.killed };
  }
}
// The repo toplevel of a working directory, or null.
export async function repoToplevel(cwd) {
  if (!cwd) return null;
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.out.trim() : null;
}
// Docs-only: markdown, a few well-known text files, and non-code files under docs/. Test code and generic .txt are code-like.
const CODE_EXT = /\.(?:m?[jt]sx?|cjs|py|sh|bash|ps1|psm1|bat|cmd|rb|go|rs|java|c|cc|cpp|h|json|ya?ml|toml|sql|service|timer|socket|html?|css|php|pl)$|(?:^|\/)(?:GNU)?makefile$/i;
const DOC_NAMES = /(^|\/)(?:LICENSE|CHANGELOG|NOTICE|AUTHORS|CONTRIBUTING|CODEOWNERS)(?:\.(?:md|txt))?$/;
export const isDocFile = (f) => /\.(?:md|markdown)$/i.test(f) || DOC_NAMES.test(f) || (/^docs\//.test(f) && !CODE_EXT.test(f));
const DOC_IMAGE = /^docs\/.*\.(?:png|jpe?g|gif|svg)$/i;
export const isConvention = (f, conv) => conv.some((c) => f === c || basename(f) === c);
const SENSITIVE_CONTENT = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'], [/AKIA[0-9A-Z]{16}/, 'cloud access key'], [/ghp_[A-Za-z0-9]{30,}/, 'git host token'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'chat token'], [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/, 'api key'],
];
export const SECRET_PATTERNS = SENSITIVE_CONTENT.map(([re]) => re);
export function sensitivePath(f) {
  const segs = f.split('/'), base = segs[segs.length - 1], lower = f.toLowerCase();
  if (/^\.env/.test(base) || /^(?:\.netrc|\.npmrc|\.pypirc|authorized_keys)$/.test(base)) return 'secret';
  if (/\.(?:pem|key|p12|pfx|jks)$/i.test(base) || /^id_(?:rsa|ed25519|ecdsa|dsa)/.test(base)) return 'secret';
  if (segs.some((s) => /secret|credential|password/i.test(s))) return 'secret';
  if (/(^|\/)migrations\//.test(lower) || /\.sql$/.test(lower)) return 'migration';
  if (/sudoers/.test(lower)) return 'sudoers';
  if (/\.(service|timer|socket)$/.test(lower) || /(^|\/)systemd\//.test(lower)) return 'systemd';
  if (/^\.github\/workflows\//.test(lower) || /(^|\/)(?:\.gitlab-ci\.yml|jenkinsfile)$/.test(lower) || /^\.circleci\//.test(lower)
    || /^dockerfile|^docker-compose/.test(base.toLowerCase()) || /\.tf$/.test(lower) || /(^|\/)(?:terraform|ansible|helm|k8s|kubernetes)\//.test(lower)) return 'deploy';
  if (!/\.(?:md|markdown)$/i.test(f) && segs.some((s) => /deploy|update_core|safe-restart|restart/i.test(s))) return 'deploy';
  return null;
}

// Repo names the opt-out list is matched against: the toplevel dir (a worktree's own name), the main repo dir behind a
// worktree, and the origin remote's repo name.
export async function repoNames(repo, remote = 'origin') {
  const names = new Set([basename(repo)]);
  const cd = await git(repo, ['rev-parse', '--git-common-dir']);
  if (cd.code === 0 && cd.out.trim()) { const c = resolve(repo, cd.out.trim()); names.add(basename(basename(c) === '.git' ? dirname(c) : c).replace(/\.git$/, '')); }
  const ro = await git(repo, ['remote', 'get-url', remote]);
  if (ro.code === 0) { const n = ro.out.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop(); if (n) names.add(n); }
  names.delete('');
  return [...names];
}

// Files, docs-only, sensitive paths / content and binaries of a diff spec ("a...b"). -> { error } | { facts }. A scan that cannot
// read the whole diff sets scanError (fails closed in the floors).
export async function scanRange(repo, spec, conventionFiles = MERGE_DEFAULTS.mergeConventionFiles) {
  const out = { files: [], docsOnly: false, sensitive: [], scanError: null, binary: [] };
  const names2 = await git(repo, ['diff', '--name-only', '-z', spec]);
  if (names2.code !== 0) return { error: `git diff failed: ${names2.err || 'unknown'}` };
  out.files = names2.out.split('\0').filter(Boolean);
  const real = out.files.filter((f) => !isConvention(f, conventionFiles));
  out.docsOnly = real.length > 0 ? real.every(isDocFile) : out.files.length > 0;
  for (const f of out.files) { const why = sensitivePath(f); if (why) out.sensitive.push({ file: f, why }); }
  // added lines only, capped at 2 MB; an unreadable, timed-out or truncated scan fails closed (mergeFloor)
  const diff = await git(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', spec], { max: 2 * 1024 * 1024 });
  if (diff.code !== 0 || diff.truncated || diff.timedOut) out.scanError = diff.truncated ? 'larger than 2 MB' : diff.err || 'unreadable';
  let file = null;
  for (const line of diff.out.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
    const bin = /^Binary files (.*) and (.*) differ$/.exec(line);
    if (bin) { if (bin[1] === '/dev/null') { const nf = bin[2].replace(/^b\//, ''); if (!DOC_IMAGE.test(nf)) out.binary.push(nf); } continue; }
    if (!line.startsWith('+')) continue;
    for (const [re, label] of SENSITIVE_CONTENT) {
      if (re.test(line) && !out.sensitive.some((s) => s.file === file && s.why === 'secret-content')) out.sensitive.push({ file, why: 'secret-content', what: label });
    }
  }
  return { facts: out };
}

export async function gitFacts({ cwd, branch, branchSha = null, target, remote = 'origin', conventionFiles = MERGE_DEFAULTS.mergeConventionFiles } = {}) {
  const fail = (error) => ({ ok: false, error, repo: null, repoName: null, repoNames: [], branch: branch || null, target: target || null, branchSha: null, targetSha: null, targetShaLocal: null, alreadyMerged: false, conflicts: [], conventionOnly: false, files: [], docsOnly: false, sensitive: [], scanError: null, binary: [] });
  if (!cwd) return fail('no working directory');
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return fail('not a git repository');
  const repo = top.out.trim();
  const repoName = basename(repo);
  const names = await repoNames(repo, remote);
  const resolves = async (ref) => (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0;
  // branch: the named one; the session's current branch only when none was named
  let bName = null, bRef = null;
  if (branch && branchSha && /^[0-9a-f]{40,64}$/.test(branchSha) && await resolves(branchSha)) { bName = branch; bRef = branchSha; }   // a pinned commit (the integration lane): the exact one it will merge, whatever local refs say
  else if (branch) {
    if (await resolves(`refs/heads/${branch}`)) { bName = branch; bRef = `refs/heads/${branch}`; }
    else if (await resolves(`refs/remotes/${remote}/${branch}`)) { bName = branch; bRef = `refs/remotes/${remote}/${branch}`; }
  } else {
    const cur = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const c = cur.code === 0 ? cur.out.trim() : '';
    if (c && c !== 'HEAD') { bName = c; bRef = `refs/heads/${c}`; }
  }
  // target: named, else origin/HEAD's branch, else main; origin/<target> preferred, the local one checked too when it differs
  let tName = target || null;
  if (!tName) {
    const h = await git(repo, ['symbolic-ref', '--short', '--quiet', `refs/remotes/${remote}/HEAD`]);
    tName = h.code === 0 && h.out.trim() ? h.out.trim().replace(`${remote}/`, '') : 'main';
  }
  const oRef = (await resolves(`refs/remotes/${remote}/${tName}`)) ? `refs/remotes/${remote}/${tName}` : null;
  const lRef = (await resolves(`refs/heads/${tName}`)) ? `refs/heads/${tName}` : null;
  const tRef = oRef || lRef;
  const base = { ok: true, repo, repoName, repoNames: names, branch: bName, target: tName, branchSha: null, targetSha: null, targetShaLocal: null, alreadyMerged: false, conflicts: [], conventionOnly: false, files: [], docsOnly: false, sensitive: [], scanError: null, binary: [] };
  if (!bRef || bName === tName) return { ...base, ok: false, error: 'branch not found' };
  if (!tRef) return { ...base, ok: false, error: `target ${tName} not found` };
  const sha = async (r) => (await git(repo, ['rev-parse', r])).out.trim();
  const out = { ...base, branchSha: await sha(bRef), targetSha: await sha(tRef) };
  const lSha = lRef ? await sha(lRef) : null;
  out.targetShaLocal = lSha && lSha !== out.targetSha ? lSha : null;
  out.alreadyMerged = (await git(repo, ['merge-base', '--is-ancestor', bRef, tRef], { okCodes: [0, 1] })).code === 0;
  // conflicts against every target ref that exists (origin and a differing local one): both must merge
  const conflicts = new Set();
  for (const t of [tRef, ...(out.targetShaLocal ? [lRef] : [])]) {
    const mt = await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', t, bRef], { okCodes: [0, 1] });
    if (mt.code !== 0 && mt.code !== 1) return { ...out, ok: false, error: `merge-tree failed: ${mt.err || 'unknown'}` };
    if (mt.code === 1) for (const l of mt.out.split('\n').slice(1)) if (l.trim()) conflicts.add(l.trim());
  }
  out.conflicts = [...conflicts];
  out.conventionOnly = out.conflicts.length > 0 && out.conflicts.every((f) => isConvention(f, conventionFiles));
  const sc = await scanRange(repo, `${tRef}...${bRef}`, conventionFiles);
  if (sc.error) return { ...out, ok: false, error: sc.error };
  Object.assign(out, sc.facts);
  return out;
}

export const SENS_TEXT = { secret: 'a secret/credential path', migration: 'a migration', sudoers: 'sudoers', systemd: 'a systemd unit', deploy: 'a CI/deploy/infra path', 'secret-content': 'secret-looking content' };
// Reasons to escalate; empty = the manager may proceed.
export function mergeFloor(facts, ev, { optOut = [], conventionFiles = MERGE_DEFAULTS.mergeConventionFiles } = {}) {
  if (!facts) return ['not a git repository or git error'];
  const reasons = [];
  const out = (optOut || []).map(String);
  const names = facts.repoNames?.length ? facts.repoNames : facts.repoName ? [facts.repoName] : [];
  if (facts.repo && out.some((o) => o === facts.repo || names.includes(o))) return [`repo ${facts.repoName} is opted out of manager merge decisions`];
  if (!facts.ok) return [facts.error === 'branch not found' ? 'branch not found' : /^not a git/.test(facts.error) ? 'not a git repository' : `git error: ${facts.error}`];
  if (facts.alreadyMerged) return [`${facts.branch} is already merged into ${facts.target}`];
  const outside = (facts.conflicts || []).filter((f) => !isConvention(f, conventionFiles));
  if (outside.length) reasons.push(`conflicts outside convention: ${outside.join(', ')}`);
  if (ev?.state === 'red') reasons.push(`tests reported red: ${ev.quote}`);
  else if (ev?.state !== 'green' && !facts.docsOnly) reasons.push('no green test report on the branch');
  for (const s of facts.sensitive || []) reasons.push(`touches ${SENS_TEXT[s.why] || 'a sensitive path'}: ${s.file}`);
  if (facts.scanError) reasons.push('diff too large or unreadable to scan');
  for (const f of facts.binary || []) reasons.push(`adds a binary file: ${f}`);
  return reasons;
}

// The manager's own rating when Jev is not available (the floor already passed).
export function reasoningDecision(facts, ev) {
  const strong = facts.docsOnly || (ev.state === 'green' && ev.explicit);
  return { source: 'reasoning', choice: 'merge', confidence: strong ? 0.9 : 0.8 };
}

export const short = (sha) => String(sha || '').slice(0, 12);
function summarize(facts, ev) {
  const bits = [];
  bits.push(facts.conflicts?.length ? `merges with convention-file conflicts only (${facts.conflicts.join(', ')})` : 'merges cleanly');
  bits.push(ev.state === 'green' ? 'tests green' : facts.docsOnly ? 'docs/test-only change' : `tests ${ev.state}`);
  bits.push(`${facts.files.length} file${facts.files.length === 1 ? '' : 's'}${facts.docsOnly ? ' (docs-only)' : ''}`);
  return bits.join(', ');
}

// -> { verdict: 'merge'|'escalate', reasons, rationale, facts, tests, decision }. `jev` is injected: async (body) =>
// reply | { skipped } | { error }. Jev is asked only when the floor passed.
export async function evaluateMerge({ cwd, text, session = null, config = {}, jev = null, branch = null, target = null, tests: testsGiven = null, evidenceText = null } = {}) {
  const cfg = { ...MERGE_DEFAULTS, ...config };
  const parsed = parseMergeAsk(text);
  const ask = { branch: branch || parsed.branch, target: target || parsed.target };   // explicit names (the CLI) win over the text
  const facts = await gitFacts({ cwd, branch: ask.branch, target: ask.target, conventionFiles: cfg.mergeConventionFiles });
  // test evidence comes from the session's closing text (a question reports nothing); a given value is vouched for by the caller (merge-eval.js --tests)
  const tests = testsGiven || testEvidence(evidenceText ?? text, { branch: facts.branch });
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

// A record for <state>/manager-decisions.jsonl (round 7: merge-decisions.jsonl), shaped like a V2 decision (orchestration/task-contract.js validateDecision).
export function journalRecord(ev, { id, session = null, at = new Date() } = {}) {
  const f = ev.facts || {}, d = ev.decision || {};
  const ts = at instanceof Date ? at.toISOString() : typeof at === 'number' ? new Date(at).toISOString() : String(at);
  const evidence = [
    f.ok ? (f.conflicts?.length ? `merge-tree conflicts: ${f.conflicts.join(', ')}` : 'merge-tree clean') : `git: ${f.error || 'no facts'}`,
    `tests: ${ev.tests?.quote || ev.tests?.state || 'unknown'}`,
    `files: ${f.files?.length ?? 0}${f.docsOnly ? ' (docs-only)' : ''}`,
    `branch ${f.branch}@${short(f.branchSha)} -> ${f.target}@${short(f.targetSha)}${f.targetShaLocal ? ` (local ${f.target}@${short(f.targetShaLocal)})` : ''}`,
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
    branch_sha: f.branchSha || null, target_sha: f.targetSha || null, target_sha_local: f.targetShaLocal || null,
    jev_decision_id: d.source === 'jev' ? (d.decision_id || 'jev') : 'reasoning',
    ...(ev.reasons?.length ? { reasons: ev.reasons } : {}),
  };
}

// One reply for the session: the information answers, the merge / push / deploy answers and (when anything remains) a pointer to the owner.
// info = [{ part, answer, source }], merge = { repo, branch, target, rationale } | null, push = { repo, branch, dest, rationale } | null,
// deploy = { env, scope, ref, sha, rationale, rollback } | null. -> { text, info: [kept indexes], merge, push, deploy: bool } | null.
// Every line must pass the hard floor with only the decided topics exempt; a line that would trip it is dropped, never reworded.
export function composeReply({ info = [], merge = null, push = null, deploy = null, remaining = false } = {}) {
  const lines = [], keptInfo = [];
  const label = (p) => String(p || '').replace(/^\s*(?:\(?[a-z0-9]\)|\d+[.)])\s*/i, '').replace(/[\s,;:.?]+$/, '').replace(/^(?:and|plus)\s+/i, '').replace(/^./, (c) => c.toUpperCase()).slice(0, 80);
  const present = { mergePresent: !!merge, pushPresent: !!push, deployPresent: !!deploy, migrationsOk: !!deploy?.migrations?.length };   // additive lab migrations read by the deploy evaluation: the noun "migration" is covered
  info.forEach((i, n) => {
    const line = `${i.label || label(i.part)}: ${i.answer}${i.source ? ` (from ${i.source})` : ''}`;
    if (hardMatch(line, { ...present, migrationsOk: false })) return;   // a landing is exempt only in a reply that carries its verdict
    lines.push(line); keptInfo.push(n);
  });
  const used = { merge: false, push: false, deploy: false };
  // a topic line: the full one, else the bare one; checked with only the topics used so far (plus itself) exempt
  const add = (kind, full, bare) => {
    const ok = (l) => !hardMatch(l, { mergePresent: used.merge || kind === 'merge', pushPresent: used.push || kind === 'push', deployPresent: used.deploy || kind === 'deploy', migrationsOk: present.migrationsOk });
    const line = ok(full) ? full : ok(bare) ? bare : null;
    if (line) { lines.push(line); used[kind] = true; }
  };
  if (merge) {
    const r = merge.repo ? merge.repo + ' ' : '';
    add('merge', `Merge: yes - the manager evaluated ${r}${merge.branch} -> ${merge.target}: ${merge.rationale}. Merge it now.`, `Merge: yes - the manager evaluated ${r}${merge.branch} -> ${merge.target}. Merge it now.`);
  }
  if (push) {
    const r = push.repo ? push.repo + ' ' : '';
    add('push', `Push: yes - ${r}${push.branch} -> origin/${push.dest}: ${push.rationale}. Push it now.`, `Push: yes - ${r}${push.branch} -> origin/${push.dest}. Push it now.`);
  }
  if (deploy) {
    const head = `Deploy: yes - ${deploy.env} ${deploy.scope} ${deploy.ref}@${String(deploy.sha || '').slice(0, 12)}`;
    const tail = `Request it through the deploy queue; the runner starts it when nothing blocks. ${deploy.rollback || 'Rollback: request a deploy of the previous release.'}`;
    add('deploy', `${head}: ${deploy.rationale}. ${tail}`, `${head}. ${tail}`);
  }
  if (!lines.length) return null;
  if (remaining) lines.push('The rest of your question went to the owner: wait for their answer on it.');
  const text = lines.join(' ');
  if (hardMatch(text, { mergePresent: used.merge, pushPresent: used.push, deployPresent: used.deploy, migrationsOk: present.migrationsOk && used.deploy })) return null;
  return { text, info: keptInfo, merge: used.merge, push: used.push, deploy: used.deploy };
}
