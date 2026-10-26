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

export const MERGE_DEFAULTS = { mergeDecisions: true, mergeMinConfidence: 0.85, mergeOptOut: [], mergeConventionFiles: ['VERSION.txt'], schemaPaths: ['setup/db/schema', 'setup/db/migrations', 'supabase/migrations', 'migrations'], schemaIgnore: [], infoAnswers: true, infoRoots: [] };

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
// Explicit allowlist of deploy/infra paths (matched on the lowercased path). Never a substring match on "deploy": tests and
// docs are exempt, and a feature file such as integration-deploys.js is code, not infra.
const DOC_OR_TEST = /^(?:tests?|docs?)\/|\.(?:md|markdown)$|\.test\.[cm]?js$/;
const INFRA_PATHS = [
  /^scripts\/[^/]*(?:deploy|update_core|safe-restart|restart)/,   // scripts/deploy.sh, scripts/safe-restart.sh
  /(?:^|\/)update_core[^/]*$/,
  /(?:^|\/)deploy-runner\.js$/,
  /(?:^|\/)(?:safe-restart|deploy)\.(?:sh|ya?ml)$/,
];
// Source files are code, not a place a secret is kept. A name that spells secret/credential/password describes the FEATURE
// (apps/web/src/app/set-password/actions.ts, forgot-password/actions.ts, components/auth/PasswordField.tsx, lib/password.ts are
// ordinary auth code), and flagging those by name blocked real merges (integration int-mvk2yoqw1888e1, evolai
// feat/simple-admin-home). A literal secret inside a source file is caught by the diff scan instead: SENSITIVE_CONTENT over the
// added lines of scanRange (why 'secret-content'), so nothing is judged on its name alone. Extensions, not directories: a key
// or .pem file keeps the floor above whatever it is called.
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|mts|cts|py|go|rs|java|rb|php|pl|sh|bash|zsh|ps1|psm1|bat|cmd|c|cc|cpp|cxx|h|hpp|cs|kt|kts|swift|scala|vue|svelte|dart|ex|exs|erl|hs|lua|r)$/i;
export function sensitivePath(f) {
  const segs = f.split('/'), base = segs[segs.length - 1], lower = f.toLowerCase();
  const template = /\.(?:example|sample|template)$/i.test(base);   // .env.server.example is a template: not a secret by name (content is still scanned)
  if ((/^\.env/.test(base) && !template) || /^(?:\.netrc|\.npmrc|\.pypirc|authorized_keys)$/.test(base)) return 'secret';
  if (/\.(?:pem|key|p12|pfx|jks)$/i.test(base) || /^id_(?:rsa|ed25519|ecdsa|dsa)/.test(base)) return 'secret';
  // Data artefacts keep the name rule: a secrets.json, credentials.yaml or my-secrets/a.txt STORES the credential, and unlike
  // a source file there is no code to scan. Everything below this line (migration, sudoers, systemd, deploy) is untouched.
  if (!SOURCE_EXT.test(base) && segs.some((s) => /secret|credential|password/i.test(s))) return 'secret';
  // The runner skips <name>_rollback.sql in a migrations dir (platform_update/migrations.py, upgrade_notes.py: "do not apply"), so the file
  // is never run on a database by the pipeline. Only that exact suffix: _down.sql is NOT skipped by the runner and stays a migration.
  if (/(^|\/)migrations?\/(?:[^/]+\/)*[^/]+_rollback\.sql$/.test(lower)) return null;
  if (/(^|\/)(?:migrations?|migrate|alembic|flyway|liquibase)\//.test(lower) || /(^|\/)alembic\.ini$/.test(lower) || /(^|\/)db\/(?:migrate|migrations?|schema\.rb|structure\.sql)/.test(lower) || /\.sql$/.test(lower)) return 'migration';
  if (/sudoers/.test(lower)) return 'sudoers';
  // A unit / timer file in a repo is text: the merge installs nothing (installing is the routine host-unit class, owner 2026-10-26,
  // host-unit-routine.js). Only this product's own service and manager units stay a floor: they have their own restart procedure.
  if (/\.(service|timer|socket)$/.test(lower) || /(^|\/)systemd\//.test(lower)) return /^ghosty-(?:sessions|manager)/.test(base) ? 'systemd' : null;
  if (!DOC_OR_TEST.test(lower) && (/^\.github\/workflows\//.test(lower) || /(^|\/)(?:\.gitlab-ci\.yml|jenkinsfile)$/.test(lower) || /^\.circleci\//.test(lower)
    || /^dockerfile|^docker-compose/.test(base.toLowerCase()) || /\.tf$/.test(lower) || /(^|\/)(?:terraform|ansible|helm|k8s|kubernetes)\//.test(lower))) return 'deploy';
  if (DOC_OR_TEST.test(lower)) return null;   // tests and docs only describe infra (test/foo-deploy.test.js, docs/deploy.md), they never change it
  if (INFRA_PATHS.some((re) => re.test(lower))) return 'deploy';
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

// ---- migrations by effect (Q199, owner 2026-10-20) ----
// A migration merges when it only ADDS objects (CREATE TABLE / CREATE INDEX / ALTER TABLE ... ADD COLUMN) or does the session, policy
// and grant bookkeeping a real migration carries (BEGIN/COMMIT, SET search_path, COMMENT ON, GRANT, CREATE POLICY, RLS): the lane
// cannot read the target DB, so the manager attests with --migration-applied that those objects are already there. Anything that
// removes, rewrites or writes data is destructive and stays with the owner; anything we cannot read is not additive.
const MIG_LINE_CAP = 4000;
// Additive statement heads, checked in order. OR REPLACE is deliberately absent: it rewrites an object that may already exist
// (the reason names it), so CREATE OR REPLACE FUNCTION / VIEW is refused even though a plain CREATE FUNCTION is additive.
const SQL_ADDITIVE = [
  /^(?:begin|start\s+transaction|commit|end)\b/,                                          // the transaction wrapper
  /^set\s+(?!session\s+(?:role|authorization)\b)(?!role\b)(?!authorization\b)\S/,          // SET LOCAL / SET search_path, never a role change
  /^comment\s+on\b/,                                                                    // COMMENT ON TABLE x IS '...'
  /^grant\b/,                                                                           // GRANT SELECT ON t TO app
  /^create\s+policy\b/,                                                                 // CREATE POLICY "p" ON t
  /^create\s+(?:or\s+replace\s+)?function\b/,                                              // the body is not read ($body$); OR REPLACE is gated in migrationAdditive (trigger functions only)
  /^create\s+(?:constraint\s+)?trigger\b/,                                                // a plain CREATE TRIGGER (an existing one fails, it never rewrites)
  /^create\s+(?:unique\s+|fulltext\s+|spatial\s+|concurrently\s+|temp(?:orary)?\s+|unlogged\s+|global\s+|local\s+)*(?:table|index|sequence|view|type|extension|schema)\b/,
];
// ALTER TABLE is additive action by action (ADD COLUMN / ADD CONSTRAINT / ENABLE|FORCE ROW LEVEL SECURITY), so a mixed
// ALTER TABLE t ADD COLUMN c int, DROP COLUMN d is refused on the DROP.
const SQL_ALTER_TABLE = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?[`"'\w.$]+(?:\s*\.\s*[`"'\w.$]+)?\s+(.*)$/;
const SQL_ALTER_ADDITIVE = /^(?:add\b|(?:enable|force)\s+row\s+level\s+security\b)/;
// The destructive shape, most specific first, so the reason names what it found ("DROP COLUMN in db/migrations/x.sql").
const SQL_DESTRUCTIVE = [
  [/\bdrop\s+(column|table|index|constraint|view|schema|function|type|trigger|sequence|database|extension|policy|role|user)\b/, (m) => `DROP ${m[1].toUpperCase()}`],
  [/\btruncate\b/, () => 'TRUNCATE'],
  [/\bdelete\s+from\b/, () => 'DELETE'],
  [/\bupdate\s+(?!or\s+roll\s+back\s+on\s+no\s+data\s+found)[\w"'`.[\]]+\s+set\b/, () => 'UPDATE'],
  [/\binsert\s+into\b/, () => 'INSERT'],
  [/\brevoke\b/, () => 'REVOKE'],
  [/\bset\s+(?:session\s+)?(?:role|authorization)\b/, () => 'SET ROLE'],
  [/\btype\s+\w+/, () => 'ALTER ... TYPE'],
  [/\brename\s+(to|column|constraint|index|table)\b/, () => 'RENAME'],
  [/\balter\s+(table|column)\b[\s\S]*\bset\s+default\b/, () => 'ALTER ... SET DEFAULT'],
  [/\balter\s+(table|column)\b[\s\S]*\bset\s+not\s+null\b/, () => 'ALTER ... SET NOT NULL'],
  [/\bowner\s+to\b/, () => 'ALTER ... OWNER TO'],
  [/\bcreate\s+or\s+replace\b/, () => 'replaces an existing object'],
];
// The re-create pattern: DROP POLICY "p" ON t is additive only when a LATER statement in the same file CREATEs "p" on t again.
const SQL_DROP_POLICY = /^drop\s+policy\s+(?:if\s+exists\s+)?("[^"]+"|[^\s]+)\s+on\s+("[^"]+"|[^\s]+)/;
const SQL_CREATE_POLICY = /^create\s+policy\s+(?:if\s+not\s+exists\s+)?("[^"]+"|[^\s]+)\s+on\s+("[^"]+"|[^\s]+)/;
const policyParts = (sql) => { const m = SQL_CREATE_POLICY.exec(sql) || SQL_DROP_POLICY.exec(sql); return m ? [m[1], m[2]] : null; };
// The same pattern for triggers: DROP TRIGGER [IF EXISTS] t ON tbl is additive only when a LATER CREATE TRIGGER t ... ON tbl follows.
// A bare drop (nothing creates it again) removes a trigger and stays destructive.
const SQL_DROP_TRIGGER = /^drop\s+trigger\s+(?:if\s+exists\s+)?("[^"]+"|[^\s]+)\s+on\s+("[^"]+"|[^\s]+)/;
const SQL_CREATE_TRIGGER = /^create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+("[^"]+"|[^\s]+)\s[\s\S]*?\bon\s+("[^"]+"|[^\s]+)/;
const triggerParts = (sql) => { const m = SQL_CREATE_TRIGGER.exec(sql) || SQL_DROP_TRIGGER.exec(sql); return m ? [m[1], m[2]] : null; };
const policyKey = ([name, table]) => `${String(name).replace(/["'`]/g, '').toLowerCase()} on ${String(table).replace(/["'`]/g, '').toLowerCase()}`;
// The default-grant rule: REVOKE <privs> ON [TABLE] <obj>[, <obj>...] FROM <roles> is additive only when EVERY object it names is
// CREATEd as a table EARLIER in the same file. It then strips the default grants of a table this file adds, so by effect it removes
// nothing that existed before. Anything else stays destructive with reason REVOKE: an existing table, ALL TABLES IN SCHEMA, a
// schema/function/database, a role membership (REVOKE <role> FROM <user>), or a table created AFTER the REVOKE.
const SQL_REVOKE_ON = /^revoke\b[\s\S]*?\bon\s+(.+?)\s+from\b/;
// the created table's name is read whole: a dotted path whose segments may be quoted (public.ai_benchmarks, "public"."ai_benchmarks")
const SQL_CREATE_TABLE = /^create\s+table\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))*)/;
// The same rule for the other objects a file creates and then locks down: REVOKE/GRANT ON SEQUENCE s (a serial/identity column's
// <table>_<col>_seq, or a CREATE SEQUENCE) and REVOKE ON FUNCTION f(...) (a CREATE [OR REPLACE] FUNCTION f(...) earlier).
const SQL_CREATE_SEQUENCE = /^create\s+(?:temp(?:orary)?\s+|unlogged\s+)?sequence\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))*)/;
const SQL_CREATE_FUNCTION = /^create\s+(?:or\s+replace\s+)?function\s+((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))*)\s*\(/;
// Split on commas outside parentheses: a function's argument list has commas of its own.
const splitTop = (text) => {
  const out = []; let depth = 0, cur = '';
  for (const c of text) {
    if (c === '(') depth++; else if (c === ')') depth--;
    if (c === ',' && depth <= 0) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
};
// The object list, one entry per comma: REVOKE ALL ON TABLE t FROM app and REVOKE ALL ON t, t2 FROM app name the same objects.
// -> { kind: 'table'|'sequence'|'function', objs } | null
const revokeObjects = (sql) => {
  const m = SQL_REVOKE_ON.exec(sql);
  if (!m) return null;
  const k = /^(table|sequence|function)\s+/.exec(m[1]);
  return { kind: k ? k[1] : 'table', objs: splitTop(k ? m[1].slice(k[0].length) : m[1]) };
};
// "public.f(a int, b text) returns ..." -> key of f plus its argument count, so an overload the file did not create does not pass.
const fnKey = (text) => {
  const i = text.indexOf('(');
  if (i < 0) return `${objectKey(text)}/0`;
  let depth = 0, j = i;
  for (; j < text.length; j++) { if (text[j] === '(') depth++; else if (text[j] === ')' && --depth === 0) break; }
  return `${objectKey(text.slice(0, i))}/${splitTop(text.slice(i + 1, j)).length}`;
};
// The sequences a CREATE TABLE makes: <table>_<col>_seq for every serial / identity column (id -> <table>_id_seq).
const tableSequences = (sql, key) => {
  const body = sql.slice(sql.indexOf('(') + 1);
  const cols = [...body.matchAll(/(?:^|[(,])\s*("[^"]+"|\w+)\s+(?:(?:big|small)?serial\b|\w+\s+generated\s+(?:always|by\s+default)\s+as\s+identity\b)/g)];
  return cols.map((c) => `${key}_${c[1].replace(/"/g, '')}_seq`);
};
// A bare name is public, so "x" and "public.x" are the same object; "other.x" is not. Quotes and case never matter.
const objectKey = (name) => { const p = String(name).replace(/["'`]/g, '').toLowerCase().split('.').map((s) => s.trim()).filter(Boolean); return p.length > 1 ? p.join('.') : `public.${p[0] || ''}`; };
// An alembic (or any non-SQL) revision: only the three additive ops, module boilerplate around them ignored.
const PY_ADDITIVE = /^op\.(create_table|create_index|add_column)\s*\(/;
const PY_BOILERPLATE = /^(?:from\s+\S+\s+import\b|import\s+\S+|\w+\s*=\s*(?:sa\.)?(?:sqlalchemy\.)?Column|revision\b|down_revision\b|branch_labels\b|depends_on\b|def\s+\w+\s*\(|"""|'''|#)/;
const PY_DESTRUCTIVE = /^op\.(drop_\w+|alter_column|batch_alter_table|execute|bulk_insert)\s*\(/;
// Split SQL into whole statements: a statement may span lines, and a ';' inside a string literal or a dollar-quoted body (CREATE
// FUNCTION) does not end it. Comments go, but a quote inside a comment cannot open a literal and a marker inside a literal cannot
// hide a statement. A dollar-quoted body is kept as the placeholder $body$: its text is data the caller never ran here, and CREATE
// FUNCTION / CREATE OR REPLACE FUNCTION are told apart by their head, not by what the body says.
// -> { stmts } | { error }
function splitSql(lines) {
  const src = lines.map((l) => l.replace(/\\[ \t]*$/, '')).join('\n');   // a trailing backslash is psql's line continuation
  const stmts = [];
  let cur = '', i = 0;
  const flush = () => { const s = cur.replace(/\s+/g, ' ').trim(); if (s) stmts.push(s); cur = ''; };
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '-' && d === '-') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; cur += ' '; continue; }
    if (c === '/' && d === '*') {
      let depth = 1, j = i + 2;
      while (j < src.length && depth) {
        if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; } else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; } else j++;
      }
      if (depth) return { error: 'unterminated comment' };
      cur += ' '; i = j; continue;
    }
    if (c === "'" || c === '"') {                                     // a literal, '' / "" escapes
      let j = i + 1, closed = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { if (src[j + 1] === c) { j += 2; continue; } closed = true; break; }
        j++;
      }
      if (!closed) return { error: 'unbalanced quote' };
      cur += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '$') {                                                 // a dollar-quoted body, $$ or $tag$
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 40));
      if (tag) {
        const e = src.indexOf(tag[0], i + tag[0].length);
        if (e < 0) return { error: 'unbalanced dollar quote' };
        cur += '$body$'; i = e + tag[0].length; continue;
      }
    }
    if (c === ';') { flush(); i++; continue; }
    cur += c; i++;
  }
  flush();
  return { stmts };
}
// One SQL statement of the file -> true (additive) | null (a statement the caller judges against the file's other statements) |
// { reason } naming what it found.
function sqlAdditive(s) {
  const head = s.toLowerCase().replace(/;+\s*$/, '').replace(/^[^a-z$]*/, '');
  if (head.startsWith('\\')) return { reason: 'a psql meta-command' };
  for (const re of SQL_ADDITIVE) if (re.test(head)) return true;
  if (SQL_DROP_POLICY.test(head) || SQL_DROP_TRIGGER.test(head)) return null;   // additive only as the re-create pattern, the caller has the later statements
  if (SQL_REVOKE_ON.test(head)) return null;      // additive only on tables this file CREATEs earlier, the caller has the earlier statements
  const alter = SQL_ALTER_TABLE.exec(head);
  if (alter && alter[1].split(/,\s*(?=add\b|drop\b|alter\b|rename\b|set\b|owner\b)/).every((c) => SQL_ALTER_ADDITIVE.test(c.trim()))) return true;
  for (const [re, name] of SQL_DESTRUCTIVE) { const m = re.exec(head); if (m) return { reason: name(m) }; }
  return { reason: `not additive: ${head.slice(0, 80)}` };
}
// Join a statement spread over several lines (a CREATE TABLE body, an op.create_table( block) into one logical line. A trailing
// backslash is psql's line continuation.
function joinStatements(lines) {
  const out = [];
  let cur = null, depth = 0, cont = false;
  for (const raw of lines) {
    const text = cont ? `${cur || ''} ${raw.trim()}` : raw.trim();
    depth += (text.match(/\(/g) || []).length - (text.match(/\)/g) || []).length;
    cont = /\\$/.test(text);
    if (cont) { cur = text.replace(/\\$/, '').trim(); continue; }
    if (cur !== null) { cur += ` ${text}`; if (depth <= 0) { out.push(cur); cur = null; depth = 0; continue; } continue; }
    if (depth > 0) { cur = text; continue; }
    out.push(text);
  }
  if (cur !== null) out.push(cur);
  return out;
}
const norm = (s) => s.replace(/;+\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const isPy = (file) => /\.(?:py|rb|js|ts|go|java)$/i.test(file || '');
// The added lines of ONE migration file -> { additive: true } | { additive: false, reason }. Comments and blank lines are ignored;
// anything not read as an additive statement (including a statement we only half read) is not additive.
export function migrationAdditive(file, addedLines, removedLines = []) {
  if (!Array.isArray(addedLines)) return { additive: false, reason: 'unreadable diff' };
  const py = isPy(file);
  if (!py) {
    const cut = splitSql(addedLines.filter((l) => !/^\s*$/.test(l)));
    if (cut.error) return { additive: false, reason: cut.error };
    if (!cut.stmts.length) return { additive: true, empty: true };
    const heads = cut.stmts.map((s) => s.toLowerCase());
    // the re-create pattern: DROP POLICY "p" ON t is additive only when a LATER statement CREATEs "p" on t again
    const recreated = (i) => {
      const k = policyKey(policyParts(heads[i]));
      return heads.some((h, j) => j > i && SQL_CREATE_POLICY.test(h) && policyKey(policyParts(h)) === k);
    };
    // the default-grant pattern: REVOKE ... ON t is additive only when every object it names is CREATEd as a table EARLIER in this file
    // (also a sequence of a table or CREATE SEQUENCE earlier, and a function CREATEd earlier)
    const ownTables = (i) => {
      const r = revokeObjects(heads[i]);
      if (!r) return false;
      const earlier = heads.slice(0, i);
      if (r.kind === 'function') {
        const made = earlier.filter((h) => SQL_CREATE_FUNCTION.test(h)).map((h) => fnKey(h.replace(/^create\s+(?:or\s+replace\s+)?function\s+/, '')));
        return r.objs.every((o) => made.includes(fnKey(o)));
      }
      if (r.kind === 'sequence') {
        const made = earlier.flatMap((h) => {
          const t = SQL_CREATE_TABLE.exec(h), q = SQL_CREATE_SEQUENCE.exec(h);
          return t ? tableSequences(h, objectKey(t[1])) : q ? [objectKey(q[1])] : [];
        });
        return r.objs.every((o) => made.includes(objectKey(o)));
      }
      return r.objs.every((o) => earlier.some((h) => SQL_CREATE_TABLE.test(h) && objectKey(SQL_CREATE_TABLE.exec(h)[1]) === objectKey(o)));
    };
    // the trigger pattern: DROP TRIGGER t ON tbl is additive only when a LATER statement CREATEs trigger t on tbl again
    const triggerRecreated = (i) => {
      const k = policyKey(triggerParts(heads[i]));
      return heads.some((h, j) => j > i && SQL_CREATE_TRIGGER.test(h) && policyKey(triggerParts(h)) === k);
    };
    // CREATE OR REPLACE FUNCTION may swap the body of a deployed function (an auth/RLS helper): additive only for a function this
    // file wires to a trigger it creates (a trigger function, re-runnable); a plain CREATE FUNCTION fails on an existing name.
    const usedByTrigger = (i) => {
      const m = SQL_CREATE_FUNCTION.exec(heads[i]);
      if (!m) return false;
      const key = objectKey(m[1]);
      return heads.some((h) => {
        if (!SQL_CREATE_TRIGGER.test(h)) return false;
        const e = /\bexecute\s+(?:function|procedure)\s+((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))*)/.exec(h);
        return !!e && objectKey(e[1]) === key;
      });
    };
    // Making a file re-runnable (owner 2026-10-26, Q238: "making something more safe should be allowed"): the same diff removes this
    // file's own plain CREATE FUNCTION of that name and signature head, so OR REPLACE re-creates what the file already created.
    const ownFunctions = new Set((Array.isArray(removedLines) ? removedLines : []).map((l) => SQL_CREATE_FUNCTION.exec(String(l).trim().toLowerCase().replace(/\s+/g, ' '))).filter((m) => m && !/^create or replace/.test(m[0])).map((m) => objectKey(m[1])));
    const ownReplace = (i) => { const m = SQL_CREATE_FUNCTION.exec(heads[i]); return !!m && ownFunctions.has(objectKey(m[1])); };
    for (let i = 0; i < heads.length; i++) {
      if (/^\s*create\s+or\s+replace\s+function\b/.test(heads[i]) && !usedByTrigger(i) && !ownReplace(i)) return { additive: false, reason: 'CREATE OR REPLACE FUNCTION' };
      const r = sqlAdditive(cut.stmts[i]);
      if (r === true) continue;
      // a null verdict is a statement the file itself redeems: a policy created again later, a REVOKE on tables created earlier
      if (r === null && (SQL_DROP_POLICY.test(heads[i]) ? recreated(i) : SQL_DROP_TRIGGER.test(heads[i]) ? triggerRecreated(i) : ownTables(i))) continue;
      return { additive: false, reason: r ? r.reason : SQL_REVOKE_ON.test(heads[i]) ? 'REVOKE' : SQL_DROP_TRIGGER.test(heads[i]) ? 'DROP TRIGGER' : `DROP POLICY in "${heads[i].slice(0, 80)}"` };
    }
    return { additive: true };
  }
  const stmts = joinStatements(addedLines.filter((l) => !/^\s*$/.test(l)))
    .map((s) => s.replace(/#.*$/, ''))
    .map((s) => norm(s))
    .filter((s) => s.length && !/^#/.test(s));
  if (!stmts.length) return { additive: true, empty: true };
  for (const s of stmts) {
    const head = s.replace(/^[^a-z]*/, '');
    if (PY_ADDITIVE.test(head)) continue;
    if (PY_BOILERPLATE.test(head)) continue;   // module boilerplate around the ops says nothing about their effect
    const op = /^op\.(\w+)/.exec(head);
    if (op && PY_DESTRUCTIVE.test(head)) return { additive: false, reason: op[1] };
    return { additive: false, reason: op ? `not additive: ${head.slice(0, 80)}` : `unreadable statement: ${head.slice(0, 80)}` };
  }
  return { additive: true };
}
// The migration floor of a diff (Q199, narrowed by the owner 2026-10-21): every migration file in `facts.sensitive` must read additive;
// an additive migration merges with no approval or attestation (the session applies it itself first). Destructive or unreadable
// ones are returned. approvedBy / migrationApplied are still accepted and ignored. -> [] (it may merge) | [reasons].
export function migrationReasons(facts, { approvedBy = false, migrationApplied = false } = {}) {
  const files = (facts?.sensitive || []).filter((s) => s.why === 'migration').map((s) => s.file);
  if (!files.length) return [];
  const adds = facts?.migrationAdds || {};
  const removed = facts?.migrationRemoved || {};
  const bad = files.map((file) => [file, migrationAdditive(file, adds[file], removed[file])]).filter(([, v]) => !v.additive);
  if (bad.length) return bad.map(([file, v]) => `migration is destructive: ${v.reason} in ${file}`);
  return [];
}
const MIGRATION_REASON = /^touches a migration: /;

// ---- tables: a table the added code reads that no schema or migration creates ----
// Code that reads or writes a table can merge before any migration creates it, then fail at runtime on a DB that lacks it. The scan
// reads the table names the ADDED lines use and the names the repo's schema / migration files CREATE at the branch tip: nothing else.
const SCHEMA_MAX_FILES = 300, SCHEMA_MAX_BYTES = 2 * 1024 * 1024, SCHEMA_MAX_FILE = 1024 * 1024;
const SCHEMA_REASON_CAP = 5;   // at most this many tables are named, so a big diff cannot flood the reason list
// only JS/TS/Python carry a supabase-style call; tests and docs only talk about tables, they never read one.
const SCHEMA_USE_EXT = /\.(?:m?[jt]sx?|py)$/i;
const SCHEMA_SKIP_FILE = /(?:^|\/)(?:tests?|__tests__)\/|(?:_test\.py|\.(?:test|spec)\.[cm]?[jt]sx?)$/i;
// .table('x') / .from("x"), and SQL inside a code string only when schema-qualified: an unqualified FROM in prose or in a JS
// `from` clause is far too common to read as a table (import x from 'a.b' included).
const USE_CALL = /(?<!\b(?:Buffer|Array|Uint\d+Array|Int\d+Array|Float\d+Array|Object|Observable|Symbol)\s*)\.(?:table|from)\s*\(\s*(['"])([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\1/g;
const USE_SQL = /\b(?:from|into|update|join)\s+([A-Za-z_]\w*\s*\.\s*[A-Za-z_]\w*)/gi;
// "users" and "public.users" are one object; any other schema is not this repo's (auth.users, storage.objects live outside it).
const tableKey = (name) => {
  const p = String(name || '').replace(/["'`]/g, '').toLowerCase().split('.').map((s) => s.trim()).filter(Boolean);
  if (!p.length) return null;
  if (p.length === 1) return `public.${p[0]}`;
  return p[0] === 'public' ? `public.${p.slice(1).join('.')}` : null;
};
// The table names one added line of code reads or writes -> [names as written].
export function usedTables(line) {
  const s = String(line || '');
  const calls = [...s.matchAll(USE_CALL)].map((m) => m[2].replace(/\s+/g, ''));
  const sql = [...s.matchAll(USE_SQL)].map((m) => m[1].replace(/\s+/g, ''));
  return [...new Set([...calls, ...sql])];
}
// CREATE TABLE [IF NOT EXISTS] [schema.]name and CREATE [OR REPLACE] [MATERIALIZED] VIEW [IF NOT EXISTS] [schema.]name; a commented-out
// line creates nothing.
const CREATE_OBJECT = /^\s*create\s+(?:or\s+replace\s+)?(?:(?:temp(?:orary)?|unlogged|global|local|materialized)\s+)*(?:table|view)\s+(?:if\s+not\s+exists\s+)?([^\s(]+)/i;
export function createdTables(sql) {
  const names = new Set();
  for (const line of String(sql || '').split('\n')) {
    const m = CREATE_OBJECT.exec(line.replace(/\/\*.*?\*\//g, ' ').replace(/--.*$/, ''));
    if (m) names.add(m[1]);
  }
  return [...names];
}
// The tables the repo's schema and migration files create, read at <sha> with ls-tree / show so nothing is checked out. A schema path
// that has no file in that tree is not a schema path.
// -> { dirs, tables }
async function schemaTables(repo, sha, paths) {
  const dirs = [], tables = new Set();
  if (!sha) return { dirs, tables: [] };
  let budget = SCHEMA_MAX_BYTES;
  for (const p of Array.isArray(paths) ? paths : []) {
    const ls = await git(repo, ['ls-tree', '-r', '--name-only', sha, '--', p]);
    const files = (ls.code === 0 ? ls.out.split('\n') : []).filter((f) => f && /\.sql$/i.test(f));
    if (!files.length) continue;
    dirs.push(p);
    for (const f of files.slice(0, SCHEMA_MAX_FILES)) {
      if (budget <= 0) break;
      const show = await git(repo, ['show', `${sha}:${f}`], { max: Math.min(budget, SCHEMA_MAX_FILE) });
      if (show.code !== 0 || show.truncated || show.timedOut) continue;
      budget -= show.out.length;
      for (const n of createdTables(show.out)) tables.add(n);
    }
  }
  return { dirs, tables: [...tables] };
}
// A table the added code uses that nothing in the repo creates -> reasons. [] when the repo has none of the schemaPaths (most repos:
// the check does not apply), and a non-public schema (auth.users, storage.objects) is never this repo's table to require.
export function schemaReasons(facts, { schemaIgnore = [] } = {}) {
  if (!facts?.schemaDirs?.length) return [];
  const ignore = new Set((Array.isArray(schemaIgnore) ? schemaIgnore : []).map(tableKey).filter(Boolean));
  const known = new Set((facts.knownTables || []).map(tableKey).filter(Boolean));
  const said = new Set();
  const reasons = [];
  for (const name of facts.tableUses || []) {
    const key = tableKey(name);
    if (!key || known.has(key) || ignore.has(key) || said.has(key)) continue;
    said.add(key);
    reasons.push(`uses table "${name}" that no schema or migration creates`);
    if (reasons.length >= SCHEMA_REASON_CAP) break;
  }
  return reasons;
}

// Files, docs-only, sensitive paths / content and binaries of a diff spec ("a...b"). -> { error } | { facts }. A scan that cannot
// read the whole diff sets scanError (fails closed in the floors). Migration files keep their ADDED lines (migrationAdds) so the
// lane can classify them by effect instead of by path (Q199).
export async function scanRange(repo, spec, conventionFiles = MERGE_DEFAULTS.mergeConventionFiles) {
  const out = { files: [], docsOnly: false, sensitive: [], scanError: null, binary: [], migrationAdds: {}, migrationRemoved: {}, tableUses: [] };
  const names2 = await git(repo, ['diff', '--name-only', '-z', spec]);
  if (names2.code !== 0) return { error: `git diff failed: ${names2.err || 'unknown'}` };
  out.files = names2.out.split('\0').filter(Boolean);
  const real = out.files.filter((f) => !isConvention(f, conventionFiles));
  out.docsOnly = real.length > 0 ? real.every(isDocFile) : out.files.length > 0;
  for (const f of out.files) { const why = sensitivePath(f); if (why) out.sensitive.push({ file: f, why }); }
  // added lines only, capped at 2 MB; an unreadable, timed-out or truncated scan fails closed (mergeFloor)
  const diff = await git(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', spec], { max: 2 * 1024 * 1024 });
  if (diff.code !== 0 || diff.truncated || diff.timedOut) out.scanError = diff.truncated ? 'larger than 2 MB' : diff.err || 'unreadable';
  let file = null, codeFile = false;
  const uses = new Set();
  for (const line of diff.out.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); codeFile = !!(file && SCHEMA_USE_EXT.test(file) && !isDocFile(file) && !SCHEMA_SKIP_FILE.test(file)); continue; }
    const bin = /^Binary files (.*) and (.*) differ$/.exec(line);
    if (bin) { if (bin[1] === '/dev/null') { const nf = bin[2].replace(/^b\//, ''); if (!DOC_IMAGE.test(nf)) out.binary.push(nf); } continue; }
    if (line.startsWith('-') && !line.startsWith('--- ') && file && sensitivePath(file) === 'migration') {
      const rl = out.migrationRemoved[file] || (out.migrationRemoved[file] = []);
      if (rl.length < MIG_LINE_CAP) rl.push(line.slice(1));
      continue;
    }
    if (!line.startsWith('+')) continue;
    const added = line.slice(1);
    if (file && sensitivePath(file) === 'migration') {
      const lines = out.migrationAdds[file] || (out.migrationAdds[file] = []);
      // a migration file with more added lines than we read is treated as unreadable, never as additive
      if (lines.length < MIG_LINE_CAP) lines.push(added); else out.migrationAdds[file] = null;
    }
    if (codeFile) for (const n of usedTables(added)) uses.add(n);
    for (const [re, label] of SENSITIVE_CONTENT) {
      if (re.test(line) && !out.sensitive.some((s) => s.file === file && s.why === 'secret-content')) out.sensitive.push({ file, why: 'secret-content', what: label });
    }
  }
  out.tableUses = [...uses];
  return { facts: out };
}

export async function gitFacts({ cwd, branch, branchSha = null, target, remote = 'origin', conventionFiles = MERGE_DEFAULTS.mergeConventionFiles, schemaPaths = MERGE_DEFAULTS.schemaPaths } = {}) {
  const fail = (error) => ({ ok: false, error, repo: null, repoName: null, repoNames: [], branch: branch || null, target: target || null, branchSha: null, targetSha: null, targetShaLocal: null, alreadyMerged: false, conflicts: [], conventionOnly: false, files: [], docsOnly: false, sensitive: [], scanError: null, binary: [], tableUses: [], schemaDirs: [], knownTables: [] });
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
  const base = { ok: true, repo, repoName, repoNames: names, branch: bName, target: tName, branchSha: null, targetSha: null, targetShaLocal: null, alreadyMerged: false, conflicts: [], conventionOnly: false, files: [], docsOnly: false, sensitive: [], scanError: null, binary: [], tableUses: [], schemaDirs: [], knownTables: [] };
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
  // what the repo creates, read at the branch tip (the tree those files have once the branch merges): ls-tree / show, no checkout
  const sch = await schemaTables(repo, out.branchSha, schemaPaths);
  out.schemaDirs = sch.dirs;
  out.knownTables = sch.tables;
  return out;
}

export const SENS_TEXT = { secret: 'a secret/credential path', migration: 'a migration', sudoers: 'sudoers', systemd: 'a systemd unit', deploy: 'a CI/deploy/infra path', 'secret-content': 'secret-looking content' };
// Reasons to escalate; empty = the manager may proceed.
export function mergeFloor(facts, ev, { optOut = [], conventionFiles = MERGE_DEFAULTS.mergeConventionFiles, approveInfra = false, schemaIgnore = [] } = {}) {
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
  for (const s of facts.sensitive || []) if (!(approveInfra && s.why === 'deploy')) reasons.push(`touches ${SENS_TEXT[s.why] || 'a sensitive path'}: ${s.file}`);
  if (facts.scanError) reasons.push('diff too large or unreadable to scan');
  for (const f of facts.binary || []) reasons.push(`adds a binary file: ${f}`);
  for (const r of schemaReasons(facts, { schemaIgnore })) reasons.push(r);
  return reasons;
}

// The manager's own rating when Jev is not available (the floor already passed). A deliberate constant, not a measurement: 0.9 with explicit
// green tests or a docs-only change, 0.8 otherwise, against mergeMinConfidence 0.85 (docs/REFERENCE.md, "Jev unavailable"). Raise the minimum to stop it.
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
  const facts = await gitFacts({ cwd, branch: ask.branch, target: ask.target, conventionFiles: cfg.mergeConventionFiles, schemaPaths: cfg.schemaPaths });
  // test evidence comes from the session's closing text (a question reports nothing); a given value is vouched for by the caller (merge-eval.js --tests)
  const tests = testsGiven || testEvidence(evidenceText ?? text, { branch: facts.branch });
  const question = `Merge ${facts.branch || ask.branch || 'the branch'} into ${facts.target || ask.target || 'the target'}?`;
  const reasons = mergeFloor(facts, tests, { optOut: cfg.mergeOptOut, conventionFiles: cfg.mergeConventionFiles, schemaIgnore: cfg.schemaIgnore });
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
    // the lane is the only merger (AGENTS.md, round 13): the session asks for it, it never merges or pushes the target itself
    const how = `Request it with \`integrate request ${merge.branch}\`; the integration lane merges and tests it and lands it on ${merge.target}. Do not merge it yourself.`;
    add('merge', `Merge: yes - the manager evaluated ${r}${merge.branch} -> ${merge.target}: ${merge.rationale}. ${how}`, `Merge: yes - the manager evaluated ${r}${merge.branch} -> ${merge.target}. ${how}`);
  }
  if (push) {
    const r = push.repo ? push.repo + ' ' : '';
    const land = merge && push.dest === merge.target ? 'The integration lane pushes it with the merge.' : 'Push it now.';   // a push of the merge target is the lane's, not the session's
    add('push', `Push: yes - ${r}${push.branch} -> origin/${push.dest}: ${push.rationale}. ${land}`, `Push: yes - ${r}${push.branch} -> origin/${push.dest}. ${land}`);
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
