// Push and deploy decisions (round 8, OWNER_DECISIONS §15): like merge-policy.js, the manager decides a session's "push it?" and
// "deploy it?" questions itself when nothing argues against it. Facts come from git (read-only, async, fail closed), the deploy
// queue snapshot, the lease list and the session's closing text; the floor lists reasons to escalate; Jev (or the manager's own
// reasoning) rates what is left. Round 13 (2026-10-18): the auto-answer SAFETY FILTER (stall.js FORBIDDEN_RE) is restored exactly
// as on main -- it is the hard gate that never lets ghosty auto-answer deploy / push / merge / sudo / migration / money / customer /
// destructive data / third-party credential / physical. The OWNER-vs-MANAGER ROUTING floor is the narrower OWNER_FLOOR set (stall.js
// OWNER_FLOOR_RE, router.js STOP_FLOOR_TOPICS): money/payments, customers, deleting shared data, owner-held credentials (third-party
// logins, keys to rotate -- never app-generated secrets), and physical actions on a device. Migrations, generated app secrets, merge/
// push, deploys/restarts, infra config and tests/CI are manager decisions and route to the manager, never to the owner.
import { basename } from 'node:path';
import { buildRequest } from './router.js';
import { deployHint } from './stall.js';
import { git, repoNames, repoToplevel, scanRange, testEvidence, SENS_TEXT, short, sensitivePath, MERGE_DEFAULTS } from './merge-policy.js';

export const DECIDE_DEFAULTS = { labEnvs: [], migrationProcedure: {}, pushDecisions: true, deployDecisions: true, pushMinConfidence: 0.85, deployMinConfidence: 0.85, pushOptOut: [], deployOptOut: [] };

const REF_TOKEN = String.raw`[\w][\w./@+-]*`;
const clean = (t) => String(t || '').replace(/^[`'"(\[]+|[`'"),.;:?!\]]+$/g, '');
const SKIP = new Set(['it', 'this', 'that', 'them', 'these', 'those', 'the', 'a', 'an', 'my', 'our', 'your', 'its', 'branch', 'pr', 'work', 'changes', 'change', 'commit', 'commits', 'everything', 'all', 'now', 'and', 'then', 'to', 'too', 'again', 'after', 'before', 'once', 'when', 'if', 'whether', 'or', 'so', 'first', 'next', 'later', 'up', 'out', 'back', 'yes', 'no', 'origin', 'remote', 'upstream', 'with', 'for', 'on', 'in', 'of', 'at', 'as', 'forward', 'through', 'tags', 'tag', 'safely', 'please', 'there', 'here', 'from', 'only', 'just', 'also', 'both', 'main-line']);

// "push [-u] [origin] <branch> [to [origin/]<dest>]" -> { branch, dest, branches, unparsed, remote }.
// branch / dest: the first named (null when not named); branches: every distinct branch the text names; unparsed: a ref-like word after
// "push" that no branch rule took ("push the tag v1.2", "push the release candidate"); remote: another remote than origin.
export function parsePushAsk(text) {
  const t = String(text || '');
  const tok = String.raw`(${REF_TOKEN}|[\`'"]${REF_TOKEN}[\`'"])`;
  const re = new RegExp(String.raw`\bpush(?:ing)?\b\s+(?:-{1,2}[\w-]+\s+)*(?:origin\s+)?${tok}(?:\s+to\s+(?:the\s+)?(?:origin\/)?${tok})?`, 'ig');
  let m, first = null;
  const branches = [];
  while ((m = re.exec(t))) {
    const branch = clean(m[1]).replace(/^origin\//, '');
    if (!branch || SKIP.has(branch.toLowerCase())) continue;
    if (!branches.includes(branch)) branches.push(branch);
    if (!first) { const dest = m[2] ? clean(m[2]).replace(/^origin\//, '') : null; first = { branch, dest: dest && !SKIP.has(dest.toLowerCase()) ? dest : null }; }
  }
  const rm = /\bpush(?:ing)?\b(?:\s+-{1,2}[\w-]+)*(?:\s+(?:it|this|that|the branch|to))?\s+(?:to\s+)?(upstream|fork|mirror|backup|github|gitlab)\b/i.exec(t) || /\bpush(?:ing)?\b[^.!?\n]{0,60}?\b(?:to|onto)\s+(?:the\s+)?(upstream|fork|mirror|backup|github|gitlab)\b/i.exec(t);
  const remote = rm ? rm[1].toLowerCase() : null;
  if (first) return { ...first, branches, unparsed: null, remote };
  // "push to main", "push it to origin/main": only filler words between push and "to" ("push and deploy to env-a" names no destination)
  const only = new RegExp(String.raw`\bpush(?:ing)?(?:\s+(?:it|this|that|them|these|the|branch|changes|work|commits?|origin|up|now))*\s+to\s+(?:the\s+)?(?:origin\/)?${tok}`, 'i').exec(t);
  const dest = only ? clean(only[1]).replace(/^origin\//, '') : null;
  // a word after push that the branch rules skipped but that names something ("push the release candidate"): the fallback must not stand
  let unparsed = null;
  const pm = /\bpush(?:ing)?\b([^!?\n]*)/i.exec(t);
  if (pm) {
    for (const raw of pm[1].trim().split(/\s+/)) {
      const w = clean(raw);
      if (/^(?:to|and|then|before|after|once|when|if|so|or|but|while|because)$/i.test(w)) break;
      if (!w || w.startsWith('-') || SKIP.has(w.toLowerCase())) { if (/[.;]$/.test(raw)) break; continue; }
      unparsed = w; break;
    }
  }
  return { branch: null, dest: dest && !SKIP.has(dest.toLowerCase()) ? dest : null, branches, unparsed, remote };
}

const resolves = async (repo, ref) => (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0;
const shaOf = async (repo, ref) => (await git(repo, ['rev-parse', ref])).out.trim();
async function defaultTarget(repo) {
  const h = await git(repo, ['symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD']);
  return h.code === 0 && h.out.trim() ? h.out.trim().replace(/^origin\//, '') : 'main';
}
const optedOut = (list, repo, names) => (list || []).map(String).some((o) => o === repo || names.includes(o));

// Jev's rating at a router point (shared by push and deploy). -> { escalate: reason } | { ok: true, decision } ; `choice` is the positive option.
async function rate(point, choice, { jev, jevFacts, session, min, reasoning }) {
  let reply = null;
  if (typeof jev === 'function') {
    try { reply = await jev(buildRequest(point, jevFacts, { refs: { source: 'ghosty-merge-policy', session } })); } catch { reply = null; }
  }
  const a = reply && reply.success !== false && !reply.skipped && !reply.error ? reply.answers?.choice : null;
  if (a && (a.choice === choice || a.choice === 'escalate')) {
    const conf = Number(a.probabilities?.[a.choice] ?? a.confidence);
    const confidence = Number.isFinite(conf) ? conf : 0;
    const decision = { source: 'jev', choice: a.choice, confidence, decision_id: reply.decision_id || null };
    if (a.choice === 'escalate') return { escalate: `Jev rates it escalate (${confidence.toFixed(2)})`, decision };
    if (confidence < min) return { escalate: `Jev confidence ${confidence.toFixed(2)} below ${min}`, decision };
    return { ok: true, decision };
  }
  const r = reasoning;
  const decision = { source: 'reasoning', choice, confidence: r, decision_id: null };
  if (r < min) return { escalate: `manager confidence ${r.toFixed(2)} below ${min} (no explicit test count)`, decision };
  return { ok: true, decision };
}

// ---- push ----
// -> { verdict: 'push'|'escalate', reasons, rationale, question, facts, tests, decision }
export async function evaluatePush({ cwd, text, session = null, config = {}, jev = null, branch = null, dest = null, tests: testsGiven = null, evidenceText = null, afterMerge = null } = {}) {
  const cfg = { ...MERGE_DEFAULTS, ...DECIDE_DEFAULTS, ...config };
  const parsed = parsePushAsk(text);
  let bName = branch || parsed.branch, dName = dest || parsed.dest;
  const namedBranches = branch ? [branch] : parsed.branches;
  const facts = { ok: false, repo: null, repoName: null, branch: bName, dest: dName, branchSha: null, remoteSha: null, ahead: 0, files: [], docsOnly: false, sensitive: [], binary: [], scanError: null, afterMerge: !!afterMerge };
  const done = (verdict, why, decision, tests, extra = {}) => ({ verdict, reasons: verdict === 'push' ? [] : why, rationale: verdict === 'push' ? extra.rationale : why.join('; '),
    question: `Push ${facts.branch || bName || 'the branch'} to origin/${facts.dest || dName || facts.branch || 'its branch'}?`, facts, tests: tests || { state: 'unknown', explicit: false, quote: '' }, decision });
  const esc = (why, tests) => done('escalate', Array.isArray(why) ? why : [why], { source: 'floor', choice: 'escalate', confidence: 1, decision_id: null }, tests);
  if (!cwd) return esc('no working directory');
  const repo = await repoToplevel(cwd);
  if (!repo) return esc('not a git repository');
  const names = await repoNames(repo);
  facts.repo = repo; facts.repoName = basename(repo);
  if (parsed.remote) return esc(`push to another remote (${parsed.remote}): only origin is decided`);
  if (namedBranches.length > 1) return esc(`which branch? the text names ${namedBranches.join(' and ')}`);
  if (!afterMerge && !bName && parsed.unparsed) return esc(`the text names ${parsed.unparsed}, which is not a branch I can resolve: which ref?`);
  if (optedOut([...(cfg.pushOptOut || []), ...(cfg.mergeOptOut || [])], repo, names)) return esc(`repo ${facts.repoName} is opted out of manager push decisions`);
  // a push that only lands a merge approved in the same reply: the target branch, after the merge
  if (afterMerge && !bName) { bName = afterMerge.target; dName = dName || afterMerge.target; facts.branch = bName; facts.dest = dName; }
  if (!bName) {
    const cur = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const c = cur.code === 0 ? cur.out.trim() : '';
    if (!c || c === 'HEAD') return esc('no branch to push (detached HEAD)');
    bName = c; facts.branch = c;
  }
  dName = dName || bName; facts.dest = dName;
  if (dName !== bName) return esc(`push to another ref (${bName} -> origin/${dName}): use the merge evaluation`);
  const bRef = `refs/heads/${bName}`;
  if (!(await resolves(repo, bRef))) return esc(`branch ${bName} not found`);
  facts.branchSha = await shaOf(repo, bRef);
  const oRef = `refs/remotes/origin/${dName}`;
  const hasRemote = await resolves(repo, oRef);
  let spec;
  if (hasRemote) {
    facts.remoteSha = await shaOf(repo, oRef);
    spec = `${oRef}...${bRef}`;
    const ff = await git(repo, ['merge-base', '--is-ancestor', oRef, bRef], { okCodes: [0, 1] });
    if (ff.code !== 0 && ff.code !== 1) return esc(`git error: ${ff.err || 'merge-base failed'}`);
    if (ff.code === 1) return esc(`origin/${dName} is not an ancestor of ${bName}: pushing needs a force push`);
    const n = await git(repo, ['rev-list', '--count', `${oRef}..${bRef}`]);
    if (n.code !== 0) return esc(`git error: ${n.err || 'rev-list failed'}`);
    facts.ahead = Number(n.out.trim()) || 0;
  } else {
    const tName = await defaultTarget(repo);
    const tRef = (await resolves(repo, `refs/remotes/origin/${tName}`)) ? `refs/remotes/origin/${tName}` : (await resolves(repo, `refs/heads/${tName}`)) ? `refs/heads/${tName}` : null;
    if (!tRef) return esc(`neither origin/${dName} nor ${tName} found: nothing to compare the push with`);
    spec = `${tRef}...${bRef}`;
    const n = await git(repo, ['rev-list', '--count', `${tRef}..${bRef}`]);
    if (n.code !== 0) return esc(`git error: ${n.err || 'rev-list failed'}`);
    facts.ahead = Number(n.out.trim()) || 0;
  }
  facts.ok = true;
  if (afterMerge) {
    // the merge evaluation covered the branch; what local <target> carries beyond origin/<target> is scanned here, fail closed
    if (!hasRemote) return esc(`origin/${dName} not found: nothing to compare the merged push with`);
    facts.ahead = Math.max(facts.ahead, 1);
    const tests = afterMerge.tests || { state: 'unknown', explicit: false, quote: '' };
    const sc0 = await scanRange(repo, spec, cfg.mergeConventionFiles);
    if (sc0.error) return esc(`git error: ${sc0.error}`, tests);
    Object.assign(facts, sc0.facts);
    const rs = [];
    for (const x of facts.sensitive) rs.push(`local ${bName} carries ${SENS_TEXT[x.why] || 'a sensitive path'}: ${x.file}`);
    if (facts.scanError) rs.push(`local ${bName}: diff too large or unreadable to scan`);
    for (const f of facts.binary) rs.push(`local ${bName} adds a binary file: ${f}`);
    if (rs.length) return esc(rs, tests);
    const r = await rate('push', 'push', { jev, jevFacts: { session, repo: facts.repoName, branch: bName, dest: dName, ahead: facts.ahead, after_merge: true, floor_reasons: [] }, session, min: cfg.pushMinConfidence, reasoning: afterMerge.decision?.confidence >= cfg.pushMinConfidence ? 0.9 : 0.8 });
    if (r.escalate) return done('escalate', [r.escalate], r.decision, tests);
    facts.docsOnly = !!afterMerge.facts?.docsOnly;
    return done('push', [], r.decision, tests, { rationale: `lands the merge of ${afterMerge.branch} approved in this reply; fast-forward of origin/${dName}` });
  }
  if (facts.ahead === 0) return esc('nothing to push');
  const sc = await scanRange(repo, spec, cfg.mergeConventionFiles);
  if (sc.error) return esc(`git error: ${sc.error}`);
  Object.assign(facts, sc.facts);
  const tests = testsGiven || testEvidence(evidenceText ?? text, { branch: bName });
  const reasons = [];
  if (tests.state === 'red') reasons.push(`tests reported red: ${tests.quote}`);
  else if (tests.state !== 'green' && !facts.docsOnly) reasons.push('no green test report on the branch');
  for (const s of facts.sensitive) reasons.push(`touches ${SENS_TEXT[s.why] || 'a sensitive path'}: ${s.file}`);
  if (facts.scanError) reasons.push('diff too large or unreadable to scan');
  for (const f of facts.binary) reasons.push(`adds a binary file: ${f}`);
  if (reasons.length) return esc(reasons, tests);
  const strong = facts.docsOnly || (tests.state === 'green' && tests.explicit);
  const r = await rate('push', 'push', { jev, jevFacts: { session, repo: facts.repoName, branch: bName, dest: dName, ahead: facts.ahead, tests: tests.state, tests_quote: tests.quote, docs_only: facts.docsOnly, files: facts.files.length, floor_reasons: [] }, session, min: cfg.pushMinConfidence, reasoning: strong ? 0.9 : 0.8 });
  if (r.escalate) return done('escalate', [r.escalate], r.decision, tests);
  const bits = [`${facts.ahead} commit${facts.ahead === 1 ? '' : 's'} ${hasRemote ? `fast-forward origin/${dName}` : `to the new origin/${dName}`}`,
    tests.state === 'green' ? 'tests green' : 'docs/test-only change', `${facts.files.length} file${facts.files.length === 1 ? '' : 's'}${facts.docsOnly ? ' (docs-only)' : ''}`];
  return done('push', [], r.decision, tests, { rationale: bits.join(', ') });
}

// ---- deploy ----
const SELF = (session) => new Set([session, `codebox:${session}`, `session:${session}`].filter(Boolean));
// Which leases keep a deploy of `scope` on `env` from starting (deploy-runner.js blockersOf, minus the runner's own and update_core's).
function leaseBlockers(leases, { env, scope, hosts = [], session }) {
  const self = SELF(session), out = [];
  const skips = scope === 'full' || scope === 'host';
  for (const l of leases || []) {
    if (l.env !== env) continue;
    const agent = String(l.agent || '');
    if (agent === 'manager:deploy' || agent.startsWith('update_core:') || self.has(agent)) continue;
    const res = l.resource || '*';
    let blocks = skips ? (res === '*' || (scope === 'full' && (l.kind || 'server') === 'server')) : (res === '*' || scope === 'server' || (scope === 'frontend' ? res === 'frontend' : res !== 'frontend'));
    if (scope === 'host' && hosts.includes(res)) blocks = true;
    if (blocks) out.push({ agent: agent || '?', resource: res });
  }
  return out;
}
const TARGETS = { full: ['frontend', 'server', 'host'], frontend: ['frontend'], server: ['server'], host: ['host'] };
export const MIGRATION_RE = /(^|\/)migrations\/|\.sql$/i;

// Additive SQL only (round 9, item 4): CREATE TABLE / INDEX / VIEW (OR REPLACE), ALTER TABLE ... ADD [COLUMN], INSERT. Anything else (DROP, DELETE,
// TRUNCATE, RENAME, ALTER ... DROP / TYPE / ALTER COLUMN, UPDATE, a statement this does not recognise) is destructive or unknown: not additive.
// -> { additive: boolean, why: string|null }.
// One pass over the text, so a comment marker inside a literal cannot hide a statement and a quote inside a comment cannot open a literal:
// '...' with '' escapes, "..." identifiers, $tag$...$tag$ bodies, -- and nested /* */ comments are blanked; E'...' strings, any backslash inside a
// literal, a psql meta-command (a line starting with a backslash: \!, \i, \copy) and unbalanced quotes, tags or comments are refused.
// Inherent limit (documented): a function CALLED by an allowed statement can still do anything. INSERT ... SELECT is refused, and a function call anywhere in a
// kept statement (DEFAULT, GENERATED, index expressions, WHERE, view bodies, CTAS) must be on the SAFE_FN allowlist; custom operators are refused too. What an
// allowlisted function does when the data changes later is not checked.
const SAFE_FN = new Set(['_', 'values', 'conflict', 'now', 'current_timestamp', 'current_date', 'gen_random_uuid', 'uuid_generate_v4', 'coalesce', 'nullif', 'greatest', 'least', 'lower', 'upper', 'length', 'trim', 'concat', 'substr', 'substring', 'left', 'right',
  'abs', 'round', 'floor', 'ceil', 'count', 'sum', 'min', 'max', 'avg', 'string_agg', 'array_agg', 'to_char', 'date_trunc', 'extract', 'nextval', 'cast', 'array', 'row', 'any', 'all', 'in', 'exists', 'on', 'over', 'filter', 'with', 'where', 'and', 'or', 'not', 'as', 'default',
  'check', 'key', 'unique', 'include', 'select', 'from', 'join', 'case', 'when', 'then', 'else', 'end', 'using', 'varchar', 'char', 'character', 'numeric', 'decimal', 'timestamp', 'timestamptz', 'time', 'timetz', 'interval', 'bit', 'varbit', 'float', 'constraint', 'generated', 'always', 'stored', 'by']);
const MASKS = [
  [/\b(TABLE|INTO|REFERENCES|VIEW|ONLY)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:""|[\w.]+)/gi, '$1 _'],
  [/\bINDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:""|[\w.]+)?\s*ON\s+(?:ONLY\s+)?(?:""|[\w.]+)(?:\s+USING\s+\w+)?/gi, 'INDEX _'],
];
const OPS_OK = new Set(['<=', '>=', '<>', '!=', '||', '->', '->>', '#>', '#>>', '@>', '<@', '&&', '>>', '<<', '=>']);
function suspicious(stmt) {
  let m = stmt; for (const [re, to] of MASKS) m = m.replace(re, to);
  const fn = [...m.matchAll(/\b([A-Za-z_][\w.]*)\s*\(/g)].map((x) => x[1].toLowerCase()).find((f) => !SAFE_FN.has(f));
  if (fn) return `function call ${fn}()`;
  const op = [...stmt.matchAll(/[+\-*\/<>=~!@#%^&|?]{2,}/g)].map((x) => x[0]).find((o) => !OPS_OK.has(o));
  return op ? `operator ${op}` : null;
}
function blank(src) {
  const n = src.length;
  let out = '', i = 0;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '-' && d === '-') { const e = src.indexOf('\n', i); if (e < 0) { i = n; } else { i = e; } out += ' '; continue; }
    if (c === '/' && d === '*') {
      let depth = 1, j = i + 2;
      while (j < n && depth) { if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; } else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; } else j++; }
      if (depth) return { why: 'unterminated block comment' };
      i = j; out += ' '; continue;
    }
    if ((c === 'E' || c === 'e') && d === "'" && !/[\w$]/.test(src[i - 1] || ' ')) return { why: 'an E\'...\' escape string' };
    if ((c === 'U' || c === 'u') && d === '&' && (src[i + 2] === "'" || src[i + 2] === '"') && !/[\w$]/.test(src[i - 1] || ' ')) return { why: 'a unicode escape string' };
    if (c === "'" || c === '"') {
      let j = i + 1, closed = false;
      while (j < n) {
        if (src[j] === '\\') return { why: 'a backslash inside a literal' };
        if (src[j] === c) { if (src[j + 1] === c) { j += 2; continue; } closed = true; break; }
        j++;
      }
      if (!closed) return { why: 'unbalanced quote' };
      out += c + c; i = j + 1; continue;
    }
    if (c === '$' && !/[\w$]/.test(src[i - 1] || ' ')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 80));
      if (m) {
        const e = src.indexOf(m[0], i + m[0].length);
        if (e < 0) return { why: 'unbalanced dollar quote' };
        if (src.slice(i + m[0].length, e).includes('\\')) return { why: 'a backslash inside a literal' };
        out += "''"; i = e + m[0].length; continue;
      }
    }
    if (c === '\\') return { why: 'a backslash outside a literal (psql meta-command)' };
    out += c; i++;
  }
  return { text: out };
}
export function analyzeMigrationSql(sql) {
  const src = String(sql ?? '');
  if (!src.trim()) return { additive: false, why: 'empty migration' };
  if (/^[ \t]*\\/m.test(src)) return { additive: false, why: 'a psql meta-command (backslash line)' };
  const b = blank(src);
  if (b.why) return { additive: false, why: b.why };
  const stmts = b.text.split(';').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!stmts.length) return { additive: false, why: 'no statements' };
  for (const raw of stmts) {
    const s = raw.replace(/\bON\s+(?:UPDATE|DELETE)\s+(?:CASCADE|RESTRICT|NO ACTION|SET (?:NULL|DEFAULT))/gi, ' ');
    const bad = /\b(?:DROP|DELETE|TRUNCATE|RENAME|UPDATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER)\b/i.exec(s);
    if (bad) return { additive: false, why: `${bad[0].toUpperCase()} in "${raw.slice(0, 60)}"` };
    const sus = suspicious(s);   // every kept statement: a function call off the allowlist (DEFAULT, GENERATED, index expressions, WHERE, view bodies) or a custom operator
    if (sus) return { additive: false, why: `${sus} in "${raw.slice(0, 60)}"` };
    if (/^INSERT\s+INTO\b/i.test(s)) {
      if (/\bSELECT\b/i.test(s)) return { additive: false, why: `INSERT ... SELECT in "${raw.slice(0, 60)}"` };
      continue;
    }
    if (/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\b/i.test(s)) continue;
    if (/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?VIEW\b/i.test(s)) continue;
    const alter = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?\S+\s+(.*)$/i.exec(s);
    if (alter) {
      const clauses = alter[1].split(/,\s*(?=ADD\b|ALTER\b|DROP\b|RENAME\b|SET\b|OWNER\b)/i);
      if (clauses.every((c) => /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?\S/i.test(c.trim()) && !/^ADD\s+(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(c.trim()))) continue;
      return { additive: false, why: `ALTER TABLE that is not only ADD COLUMN in "${raw.slice(0, 60)}"` };
    }
    return { additive: false, why: `unrecognised statement "${raw.slice(0, 60)}"` };
  }
  return { additive: true, why: null };
}

// Lab-database migrations (round 9, item 4): every migration in `files` must be an ADDED .sql file (not an edit or deletion of an applied one) whose
// statements are all additive. `revs`: refs that may hold the file; `bases`: refs the file must not exist in. -> { ok, why, files }
export async function additiveMigrations(repo, files, { revs, bases }) {
  for (const f of files) {
    if (!/\.sql$/i.test(f)) return { ok: false, why: `${f} is not a .sql file (cannot be read as additive)` };
    let content = null;
    for (const rev of revs) {
      const r = await git(repo, ['show', `${rev}:${f}`], { max: 512 * 1024 });
      if (r.code === 0) { content = r.out; break; }
      if (r.truncated) return { ok: false, why: `${f} is larger than 512 KB` };
    }
    if (content == null) return { ok: false, why: `${f} is deleted or unreadable` };
    for (const b of bases) if ((await git(repo, ['cat-file', '-e', `${b}:${f}`], { okCodes: [0, 1, 128] })).code === 0) return { ok: false, why: `${f} edits a migration that already exists` };
    const a = analyzeMigrationSql(content);
    if (!a.additive) return { ok: false, why: `${f}: ${a.why}` };
  }
  return { ok: true, why: null, files };
}

// The latest deployed commit/ref per relevant target of `env` from the "deployed now" ledger.
export function lastDeployed(deploys, env, scope) {
  const per = deploys?.deployed?.[env] || {};
  return (TARGETS[scope] || TARGETS.full).map((t) => ({ target: t, ...(per[t] || {}) })).filter((x) => x.commit || x.ref);
}
export const rollbackText = (env, scope, last) => {
  const p = last?.find((x) => x.commit);
  return p ? `Rollback: request a deploy of ${String(p.commit).slice(0, 12)} to ${env} (${scope}).`
    : `Rollback: the previous release is unknown for ${env} (${scope}): ask the owner before deploying anything else.`;
};

// -> { verdict: 'deploy'|'escalate', reasons, rationale, question, facts, tests, decision, rollback }
export async function evaluateDeploy({ session = null, text, cwd, config = {}, deploys = null, leases = null, envs = [], jev = null, evidenceText = null, tests: testsGiven = null, afterMerge = null, env: envGiven = null, scope: scopeGiven = null, ref: refGiven = null, branch: branchGiven = null } = {}) {
  const cfg = { ...MERGE_DEFAULTS, ...DECIDE_DEFAULTS, ...config };
  const hint = deployHint(String(text || ''));
  const facts = { ok: false, repo: null, repoName: null, env: envGiven || null, scope: scopeGiven || hint.scope || 'full', ref: refGiven || hint.ref || null, sha: null, branch: null, previous: null, files: 0, evidence: '' };
  const done = (verdict, why, decision, tests, extra = {}) => ({ verdict, reasons: verdict === 'deploy' ? [] : why, rationale: verdict === 'deploy' ? extra.rationale : why.join('; '),
    question: `Deploy ${facts.ref || 'the ref'} to ${facts.env || 'an environment'} (${facts.scope})?`, facts, tests: tests || { state: 'unknown', explicit: false, quote: '' }, decision, rollback: rollbackText(facts.env || 'the environment', facts.scope, facts.previous) });
  const esc = (why, tests) => done('escalate', Array.isArray(why) ? why : [why], { source: 'floor', choice: 'escalate', confidence: 1, decision_id: null }, tests);
  if (!cfg.deployRunner) return esc('deploy runner off: a deploy needs your approval tap');
  const names = [...(envs || [])].map(String);
  const t = String(text || '');
  // the sentence(s) that ask for the deploy: environment and target words are read there only
  const deployClause = (() => { const c = t.split(/(?<=[.!?])\s+|\n+/).filter((x) => /\b(?:re-?deploy|deploy|roll ?out|ship|release|promote|update_core)/i.test(x)); return c.length ? c.join(' ') : t; })();
  if (!facts.env) {
    const named = names.filter((n) => new RegExp(String.raw`(?<![\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\w-])`, 'i').test(deployClause)).sort((a, b) => b.length - a.length);
    if (named.length > 1) return esc(`which environment? the text names ${named.join(' and ')}`);
    facts.env = named[0] || (names.length === 1 ? names[0] : null);
  }
  // a target the registry does not know ("production", "staging", "live") is not the one configured environment; read only in the clause(s)
  // that name the deploy, where the environment goes ("to production", "deploy live"), not in the rest of the closing text
  const unknownTarget = (() => {
    const W = String.raw`prod(?:uction)?|staging|stage|live|dev|qa|uat|preprod|sandbox|backend|cluster|k8s|kubernetes|aws|gcp|azure|vercel|heroku|netlify|region`;
    const re = new RegExp(String.raw`\b(?:to|onto|on|in|at|for|into)\s+(?:the\s+)?(${W})\b(?![-/])|\b(?:re-?deploy|deploy|ship|release|promote|roll ?out)\w*\s+(?:it\s+|this\s+)?(${W})\b(?![-/])`, 'gi');
    for (const x of deployClause.matchAll(re)) { const w = x[1] || x[2]; if (!names.some((n) => n.toLowerCase() === w.toLowerCase())) return w; }
    return null;
  })();
  if (unknownTarget) return esc(`"${unknownTarget}" is not a configured environment (${names.join(', ') || 'none'}): which environment?`);
  if (!facts.env) return esc(names.length ? 'which environment?' : 'no deploy environments are configured');
  if (names.length && !names.includes(facts.env)) return esc(`unknown environment ${facts.env}`);
  if (!['full', 'frontend', 'server', 'host'].includes(facts.scope)) return esc(`unknown scope ${facts.scope}`);
  if (!deploys || deploys.ok === false) return esc('deploy queue state unavailable');
  if (!leases || leases.ok === false) return esc('deploy queue state unavailable (lease registry unreachable)');
  if (!cwd) return esc('no working directory');
  const repo = await repoToplevel(cwd);
  if (!repo) return esc('not a git repository');
  facts.repo = repo; facts.repoName = basename(repo);
  const rnames = await repoNames(repo);
  if (optedOut([...(cfg.deployOptOut || []), ...(cfg.mergeOptOut || [])], repo, rnames)) return esc(`repo ${facts.repoName} is opted out of manager deploy decisions`);
  // session branch and the ref to deploy
  let sBranch = branchGiven || afterMerge?.branch || null;
  if (!sBranch) { const cur = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']); const c = cur.code === 0 ? cur.out.trim() : ''; if (c && c !== 'HEAD') sBranch = c; }
  facts.branch = sBranch;
  const tName = await defaultTarget(repo);
  let ref = facts.ref || afterMerge?.target || tName;
  const refCands = [`refs/remotes/origin/${ref}`, `refs/heads/${ref}`, ref];
  let refGit = null;
  for (const c of refCands) if (await resolves(repo, c)) { refGit = c; break; }
  if (!refGit) return esc(`ref ${ref} not found`);
  facts.ref = ref; facts.sha = await shaOf(repo, refGit);
  facts.previous = lastDeployed(deploys, facts.env, facts.scope);
  const hostsM = /--hosts\s+([\w.,-]+)/.exec(t);
  const blockers = leaseBlockers(leases.leases, { env: facts.env, scope: facts.scope, hosts: hostsM ? hostsM[1].split(',') : [], session });
  if (blockers.length) return esc(blockers.map((b) => `${facts.env} leased by ${b.agent} (${b.resource})`));
  // tests: green on the ref (a report that names another ref, or no ref, counts only when the session's HEAD is that ref), or green on the
  // session's branch and that branch is in the ref (or merged by this very reply)
  const ev = evidenceText ?? text;
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = (await git(repo, ['rev-parse', 'HEAD'])).out.trim();
  let tests = testsGiven || testEvidence(ev, { branch: ref });
  const namesRef = tests.state === 'green' && new RegExp(String.raw`\bon\s+(?:origin/)?${escRe(ref)}\b`, 'i').test(tests.quote || '');
  if (tests.state === 'green' && (testsGiven || namesRef || head === facts.sha)) facts.evidence = `tests green on ${ref}`;
  else if (tests.state !== 'red' && sBranch) {
    const bt = testsGiven || testEvidence(ev, { branch: sBranch });
    if (bt.state === 'green') {
      if (afterMerge) { tests = bt; facts.evidence = `tests green on ${sBranch}; the merge into ${ref} is approved in this reply (decided against the branch)`; }
      else {
        const merged = (await resolves(repo, `refs/heads/${sBranch}`)) ? await git(repo, ['merge-base', '--is-ancestor', `refs/heads/${sBranch}`, refGit], { okCodes: [0, 1] }) : { code: 1 };
        if (merged.code === 0) { tests = bt; facts.evidence = `tests green on ${sBranch}, which is merged into ${ref}`; }
      }
    } else if (bt.state === 'red') tests = bt;
  }
  if (tests.state === 'red') return esc(`tests reported red: ${tests.quote}`, tests);
  if (tests.state !== 'green' || !facts.evidence) return esc(`no green test report on ${ref}${sBranch ? ` or on ${sBranch} merged into it` : ''}`, tests);
  // no database migration in what would go out: since the last deployed commit, else the session branch against its merge base
  const changed = new Set();
  let ranged = false;
  const baseCommits = [];   // the deployed commits that resolve: what a migration file must NOT exist in to count as new
  for (const p of facts.previous) {
    if (!p.commit || !(await resolves(repo, p.commit))) continue;
    baseCommits.push(p.commit);
    const d = await git(repo, ['diff', '--name-only', '-z', `${p.commit}..${refGit}`]);
    if (d.code !== 0) return esc(`cannot list the changed files (${d.err || 'git diff failed'})`, tests);
    for (const f of d.out.split('\0').filter(Boolean)) changed.add(f);
    ranged = true;
  }
  if (!ranged && !afterMerge) return esc('no deployed commit known: cannot bound the migration check', tests);
  if (afterMerge) {
    if (!sBranch) return esc('cannot tell what would be deployed (no session branch)', tests);
    const spec = `${refGit}...refs/heads/${sBranch}`;
    const d = await git(repo, ['diff', '--name-only', '-z', spec]);
    if (d.code !== 0) return esc(`cannot list the changed files (${d.err || 'git diff failed'})`, tests);
    for (const f of d.out.split('\0').filter(Boolean)) changed.add(f);
  }
  const mig = [...changed].filter((f) => MIGRATION_RE.test(f) || sensitivePath(f) === 'migration');
  let migNote = '';
  if (mig.length) {
    // An additive migration on a lab database, applied by the documented procedure, is a deploy step; customer databases, destructive
    // migrations and deletions stay with the owner (OWNER_DECISIONS: lab vs customer DB).
    const blocked = `contains a database migration: ${mig.slice(0, 3).join(', ')}`;
    if (!(cfg.labEnvs || []).includes(facts.env)) return esc(blocked, tests);
    const bases = [...baseCommits, ...(afterMerge ? [refGit] : [])];
    if (!bases.length) return esc(`${blocked} (not applied by the manager: cannot tell new from edited migrations)`, tests);
    const revs = [refGit, ...(sBranch ? [`refs/heads/${sBranch}`] : [])];
    const am = await additiveMigrations(repo, mig, { revs, bases });
    if (!am.ok) return esc(`${blocked} (not applied by the manager: ${am.why})`, tests);
    facts.migrations = mig; facts.migrationProcedure = String(cfg.migrationProcedure?.[facts.repoName] || 'the deploy queue');
    migNote = `; additive migration${mig.length === 1 ? '' : 's'} on the lab database ${facts.env} applied by ${facts.migrationProcedure}: ${mig.slice(0, 5).join(', ')}${mig.length > 5 ? ` and ${mig.length - 5} more` : ''}`;
  }
  facts.files = changed.size; facts.ok = true;
  const strong = tests.explicit;
  const r = await rate('deploy', 'deploy', { jev, jevFacts: { session, repo: facts.repoName, env: facts.env, scope: facts.scope, ref, tests: tests.state, tests_quote: tests.quote, files: changed.size, leases_blocking: 0, floor_reasons: [] }, session, min: cfg.deployMinConfidence, reasoning: strong ? 0.9 : 0.8 });
  if (r.escalate) return done('escalate', [r.escalate], r.decision, tests);
  return done('deploy', [], r.decision, tests, { rationale: `${facts.evidence}; no blocking lease on ${facts.env}; ${migNote ? migNote.slice(2) : `no database change in ${changed.size} file${changed.size === 1 ? '' : 's'}`}` });
}

// A record for <state>/manager-decisions.jsonl shaped like a V2 decision (orchestration/task-contract.js validateDecision); push and deploy.
export function decisionRecord(kind, ev, { id, session = null, at = new Date() } = {}) {
  const f = ev.facts || {}, d = ev.decision || {};
  const ts = at instanceof Date ? at.toISOString() : typeof at === 'number' ? new Date(at).toISOString() : String(at);
  const yes = ev.verdict === kind;
  const isPush = kind === 'push';
  const evidence = isPush
    ? [f.ok ? `${f.ahead} commit(s) ahead of origin/${f.dest}` : `git: ${(ev.reasons || [])[0] || 'no facts'}`, `tests: ${ev.tests?.quote || ev.tests?.state || 'unknown'}`, `files: ${f.files?.length ?? 0}${f.docsOnly ? ' (docs-only)' : ''}`, `branch ${f.branch}@${short(f.branchSha)} -> origin/${f.dest}${f.remoteSha ? `@${short(f.remoteSha)}` : ''}`]
    : [f.evidence || `tests: ${ev.tests?.quote || ev.tests?.state || 'unknown'}`, `env ${f.env} scope ${f.scope} ref ${f.ref}@${short(f.sha)}`, `files in range: ${f.files ?? 0}`, `last deployed: ${(f.previous || []).map((p) => `${p.target}=${p.ref || ''}@${short(p.commit)}`).join(', ') || 'unknown'}`];
  const title = isPush ? `Push ${f.branch} to origin/${f.dest}?` : `Deploy ${f.ref} to ${f.env} (${f.scope})?`;
  return {
    decision_id: `${kind}-${id}`, task_id: `manager:${session || 'unknown'}`, kind, ts,
    question: ev.question || title,
    chosen: ev.verdict,
    alternatives: [
      { option: kind, pros: ['the session is not blocked on the owner', isPush ? 'reversible with a revert' : 'reversible with a deploy of the previous release'], cons: ['a wrong call ships unreviewed work'] },
      { option: 'escalate', pros: ['the owner sees anything risky first'], cons: ['the session waits for the owner'] },
    ],
    expected_effect: yes ? `The session ${isPush ? `pushes ${f.branch} to origin/${f.dest}` : `requests the deploy of ${f.ref} to ${f.env} through the queue`} without asking the owner.` : `The owner is asked: ${(ev.reasons || []).join('; ') || 'not decided'}.`,
    rationale: ev.rationale || (yes ? 'floor passed' : 'escalated'),
    evidence,
    actor: { role: 'manager', runtime: null, model: null },
    confidence: Number.isFinite(d.confidence) ? d.confidence : null,
    policy_ref: 'OWNER_DECISIONS §15',
    reversible: true,
    rollback: isPush ? 'git revert the pushed commits, run the tests, push' : (ev.rollback || 'deploy the previous release'),
    session, repo: f.repoName || null, branch: f.branch || null,
    ...(isPush ? { dest: f.dest || null, branch_sha: f.branchSha || null, remote_sha: f.remoteSha || null } : { env: f.env || null, scope: f.scope || null, ref: f.ref || null, sha: f.sha || null }),
    jev_decision_id: d.source === 'jev' ? (d.decision_id || 'jev') : 'reasoning',
    ...(ev.reasons?.length ? { reasons: ev.reasons } : {}),
  };
}

// A record for a menu pick the manager sent on the owner's behalf (kind "menu"): the agent's own recommended option, taken when neither the
// question nor that option is a hard topic (or its merge / push / deploy topics passed their evaluation, journaled separately).
export function menuRecord({ id, session = null, at = new Date(), question = '', option = '', key = null, options = 0, answer = null, unmarked = false } = {}) {
  const ts = at instanceof Date ? at.toISOString() : typeof at === 'number' ? new Date(at).toISOString() : String(at);
  const sent = answer?.text != null ? answer.text : `option ${answer?.key ?? key}`;
  return {
    decision_id: `menu-${id}`, task_id: `manager:${session || 'unknown'}`, kind: 'menu', ts,
    question: question || 'Which option should I take?',
    chosen: String(key ?? 'recommended'),
    alternatives: [
      { option: 'take the recommended option', pros: ['the session is not blocked on the owner', 'the agent itself recommended it'], cons: ['a wrong call is only noticed afterwards'] },
      { option: 'escalate', pros: ['the owner picks'], cons: ['the session waits for the owner'] },
    ],
    expected_effect: `The session carries on with "${option}" without asking the owner.`,
    rationale: unmarked ? `The agent marked no option as recommended; "${option}" is option 1, and neither the question nor that option is a hard topic or a way out (skip / cancel), so the manager took it as the safe, reversible default.`
      : `The agent marked "${option}" as its recommendation and neither the question nor that option is a hard topic.`,
    evidence: [`question: ${question || 'unknown'}`, `${unmarked ? 'unmarked first option' : 'recommended option'} ${key ?? '?'}: ${option}`, `${options} options`, `sent: ${sent}`],
    actor: { role: 'manager', runtime: null, model: null },
    confidence: 1, policy_ref: 'OWNER_DECISIONS §15', reversible: true, rollback: 'send the session a correction naming the option you wanted',
    session, option, key: key ?? null, ...(unmarked ? { unmarked: true } : {}),
  };
}
