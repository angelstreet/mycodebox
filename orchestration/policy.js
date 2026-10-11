// V2 project policy (docs/v2/ARCHITECTURE.md §4): `.ai/project.json`, read-only to agents, re-read at the
// start of every run. checkAction is the hard floor under every model choice: missing policy, prohibited
// actions, approval classes and the manager's forbidden-topic matcher win over task text and model output.
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { forbiddenMatch, FORBIDDEN_RE, normalizeSplits } from '../stall.js';
import { MANDATORY_APPROVAL, RISK_CLASSES } from './task-contract.js';

export const POLICY_PATH = join('.ai', 'project.json');
// Actions that cannot change anything; they skip task-text approval (a task about deploys may still be read).
export const READ_ONLY_CLASSES = Object.freeze(['read', 'inspect']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStrArr = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '');
const isArgv = (v) => isStrArr(v) && v.length > 0;

export function validatePolicy(p) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (!isObj(p)) return [{ path: '', message: 'policy must be a JSON object' }];
  if (p.schema_version !== 1) err('schema_version', 'must be 1');
  if (typeof p.project_id !== 'string' || !p.project_id) err('project_id', 'non-empty string');
  if (!isArgv(p.test_command)) err('test_command', 'argv array');
  if (!isObj(p.allowlists)) err('allowlists', 'object');
  else {
    const a = p.allowlists;
    if (!(Array.isArray(a.commands) && a.commands.every(isArgv))) err('allowlists.commands', 'array of argv prefixes');
    if (!isStrArr(a.paths)) err('allowlists.paths', 'array of repo-relative path prefixes');
    for (const k of ['runtimes', 'models']) if (a[k] !== null && a[k] !== undefined && !isStrArr(a[k])) err(`allowlists.${k}`, 'array or null');
  }
  for (const k of ['excluded_paths', 'protected_paths', 'prohibited_actions', 'protected_branches', 'denied_args']) if (p[k] !== undefined && !isStrArr(p[k])) err(k, 'array of strings');
  if (!isObj(p.approval_policy) || !isStrArr(p.approval_policy.requires)) err('approval_policy.requires', 'array of action classes');
  if (p.default_risk_class !== undefined && !RISK_CLASSES.includes(p.default_risk_class)) err('default_risk_class', RISK_CLASSES.join('|'));
  return errors;
}

// -> { ok, policy } | { ok:false, code:'E_POLICY_MISSING'|'E_POLICY_INVALID', errors }. Never throws.
export function loadPolicy(repoDir, { fs = realFs } = {}) {
  const path = join(repoDir, POLICY_PATH);
  let text;
  try { text = fs.readFileSync(path, 'utf8'); } catch (e) {
    const missing = e.code === 'ENOENT' || e.code === 'ENOTDIR';
    return { ok: false, code: missing ? 'E_POLICY_MISSING' : 'E_POLICY_INVALID', errors: [{ path: POLICY_PATH, message: missing ? 'not found' : e.message }] };
  }
  let policy;
  try { policy = JSON.parse(text); } catch (e) { return { ok: false, code: 'E_POLICY_INVALID', errors: [{ path: POLICY_PATH, message: `JSON: ${e.message}` }] }; }
  const errors = validatePolicy(policy);
  if (errors.length) return { ok: false, code: 'E_POLICY_INVALID', errors };
  // The mandatory approval classes cannot be configured away.
  policy.approval_policy.requires = [...new Set([...MANDATORY_APPROVAL, ...policy.approval_policy.requires])];
  return { ok: true, policy };
}

// What a refused policy turns into for the task (T01): never run, ask the owner to fix the policy.
export const clarificationFor = (r) => ({ to: 'awaiting_approval', reason: r.code,
  question: `Project policy ${POLICY_PATH} is ${r.code === 'E_POLICY_MISSING' ? 'missing' : 'invalid'}; add or fix it before this task can run.`,
  errors: r.errors });

// ---- text classification ----------------------------------------------------------------------------

const ZERO_WIDTH = /[­᠎​-‏⁠-⁤﻿]/g;
export const HOMOGLYPH = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ⅼ: 'l', ı: 'i' };
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

// Spellings an author might use to slip a restricted action past a plain regex. Every variant is matched;
// extra variants can only add matches (fail closed), never remove one.
export function textVariants(text) {
  const base = String(text ?? '').normalize('NFKC').replace(ZERO_WIDTH, '')
    .replace(/[^\x00-\x7F]/g, (c) => HOMOGLYPH[c.toLowerCase()] ?? c);
  const spaced = base.replace(/\b(?:[A-Za-z0-9][ ._*\-\u2013\u2014]{1,3}){2,}[A-Za-z0-9]\b/g, (m) => m.replace(/[ ._*\-\u2013\u2014]/g, ''));   // d e p l o y
  const joined = spaced.replace(/([A-Za-z])[._*\-\u2013\u2014]+(?=[A-Za-z])/g, '$1');                                              // de-ploy, de–ploy
  const leet = joined.replace(/[013457@$]/g, (c) => LEET[c]);                                                         // d3pl0y
  return [...new Set([base, spaced, joined, leet, normalizeSplits(base)])];   // "mer ge into main": rejoined in context
}

// One space splitting a word ("de ploy", "dep loy"): adjacent tokens joined in pairs and triples. Checked one
// candidate at a time so an innocent join can only add a match, never hide one.
function splitJoins(text) {
  // Join characters inside a token ("de-", "de_pl") are dropped so a split plus a join char still rejoins.
  const t = String(text).split(/[\s\u2013\u2014]+/).map((x) => x.replace(/[._*\-\u2013\u2014]/g, '')).filter(Boolean);
  const out = [];
  for (let i = 0; i < t.length - 1; i++) { out.push(t[i] + t[i + 1]); if (i < t.length - 2) out.push(t[i] + t[i + 1] + t[i + 2]); }
  return out;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// V2 additions on top of the manager's list, for action classes the manager never had to name.
const V2_EXTRA = [
  [/\bprod(?:uction)?\b/i, 'deploy'],
  [/\bship(?:s|ped|ping)?\b[^.\n]{0,20}\b(?:live|prod)\b|\bgo(?:es|ing)? live\b/i, 'deploy'],
  [/\brotat(?:e|ing|ion)\b[^.\n]{0,30}\bkeys?\b/i, 'credentials'],
  [/\b(?:npm|yarn|pnpm) publish\b|\bpublish(?:es|ed|ing)? (?:the )?(?:package|release|crate|gem)\b/i, 'push_shared'],
];
const DEFAULT_PROTECTED = ['main', 'master', 'trunk'];
const branchRules = (branches) => {
  const names = [...new Set([...DEFAULT_PROTECTED, ...(branches || [])])].map(escapeRe).join('|');
  return [[new RegExp(`\\b(?:merg(?:e|es|ed|ing)|rebas(?:e|es|ed|ing))\\b[^.\\n]{0,30}\\b(?:${names})\\b`, 'i'), 'merge_protected'],
    [new RegExp(`\\bpush(?:es|ed|ing)?\\b[^.\\n]{0,30}\\b(?:${names})\\b`, 'i'), 'merge_protected']];
};
// Maps the manager matcher's hit to an action class; keep in step with FORBIDDEN_PARTS in stall.js
// (a hit no row maps still needs approval, as the generic forbidden_topic class).
const TOPIC_CLASS = [
  [/deploy|update_core|rollout|ship|release|promote|go(?:ing)? live|terraform|kill|upgrade|alter|modify/i, 'deploy'],
  [/systemctl|pm2|restart/i, 'host_maintenance'],
  [/merge|rebase/i, 'merge_protected'],
  [/push|publish/i, 'push_shared'],
  [/reset --hard|hard[- ]?reset|delet|remov|\brm\b|drop|prune|truncate|migrat|wip(?:e|ing)|overwrit/i, 'destructive'],
  [/\.env|credential|password|passphrase|secret|token|bearer|api[_ -]?key|ssh key|private key|revok|rotat/i, 'credentials'],
  [/money|pay|purchase|buy|billing|invoice|credit|card|charg|refund|transfer|funds/i, 'money'],
  [/customer|client/i, 'customer'],
];

// -> [{ topic, class }] for every restricted topic named in the text, under any variant spelling.
// protectedBranches: the policy's protected_branches, added to main/master/trunk.
// Every hit counts, not only the first: "deploy the token from .env" needs both a deploy and a credentials grant.
const ALL_HITS = new RegExp(FORBIDDEN_RE.source, 'gi');
const hitsOf = (t) => {
  const hits = [...String(t).matchAll(ALL_HITS)].map((x) => x[0]);
  const extra = forbiddenMatch(t);   // also covers the private GHOSTY_FORBIDDEN_EXTRA list
  return extra && !hits.includes(extra) ? [...hits, extra] : hits;
};
const classOf = (m) => TOPIC_CLASS.find(([re]) => re.test(m))?.[1] ?? 'forbidden_topic';

export function restrictedTopics(text, { protectedBranches } = {}) {
  const out = new Map();
  const extra = [...V2_EXTRA, ...branchRules(protectedBranches)];
  const variants = textVariants(text);
  for (const j of variants.flatMap(splitJoins)) {
    for (const m of hitsOf(j)) { const cls = classOf(m); if (!out.has(cls)) out.set(cls, { topic: m, class: cls }); }
  }
  for (const v of variants) {
    for (const m of hitsOf(v)) {
      const cls = classOf(m);
      out.set(cls, { topic: m, class: cls });
      if (cls === 'push_shared' && /\bmain\b/i.test(m)) out.set('merge_protected', { topic: m, class: 'merge_protected' });
    }
    for (const [re, cls] of extra) { const x = v.match(re); if (x && !out.has(cls)) out.set(cls, { topic: x[0], class: cls }); }
  }
  return [...out.values()];
}

// ---- checkAction ------------------------------------------------------------------------------------

const taskText = (t) => [t?.goal, typeof t?.scope === 'string' ? t.scope : JSON.stringify(t?.scope ?? ''), ...(t?.definition_of_done || [])]
  .filter(Boolean).join('\n');
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
const under = (path, prefix) => { const a = norm(path), b = norm(prefix); return b === '' || b === '.' || a === b || a.startsWith(`${b}/`); };
const argvAllowed = (argv, allow) => allow.some((pre) => pre.length <= argv.length && pre.every((s, i) => s === argv[i]));

// action: { class, argv?, paths?, text?, runtime?, model? }. The executor derives `class` from the operation it
// is about to perform, never from model output. Anything else on it (a model's "approved: true", a confidence,
// a verdict) is deliberately ignored: only policy and recorded approvals can authorize.
// -> { allow, needs_approval, reason, classes }
export function checkAction(policy, task, action = {}) {
  const deny = (needs_approval, reason, classes = []) => ({ allow: false, needs_approval, reason, classes });
  const p = policy?.ok === true ? policy.policy : policy;
  const perrs = p?.ok === false ? [{ message: p.code }] : validatePolicy(p);
  if (perrs.length) return deny(true, `project policy missing or invalid (${policy?.code || 'E_POLICY_INVALID'}): owner clarification required`);
  const cls = typeof action.class === 'string' && action.class ? action.class : null;
  if (!cls) return deny(true, 'action has no class');

  const prohibited = new Set([...(p.prohibited_actions || []), ...(task?.prohibited_actions || [])]);
  if (prohibited.has(cls)) return deny(false, `action ${cls} is prohibited`);
  const requires = new Set([...MANDATORY_APPROVAL, ...p.approval_policy.requires, ...(task?.approval_policy?.requires || [])]);
  const readOnly = READ_ONLY_CLASSES.includes(cls);
  const why = [], classes = new Set();
  const need = (c, reason) => { classes.add(c); why.push(reason); };

  if (action.argv !== undefined && !isArgv(action.argv)) return deny(false, 'argv must be a non-empty array of strings');
  if (action.paths !== undefined && !isStrArr(action.paths)) return deny(false, 'paths must be an array of strings');
  if (requires.has(cls)) need(cls, `action class ${cls} requires approval`);
  const actionText = [action.text, action.argv?.join(' '), ...(action.paths || [])].filter(Boolean).join('\n');
  const topicOpts = { protectedBranches: p.protected_branches };
  for (const t of restrictedTopics(actionText, topicOpts)) need(t.class, `action names restricted topic "${t.topic}" (${t.class})`);
  if (!readOnly) for (const t of restrictedTopics(taskText(task), topicOpts)) need(t.class, `task text names restricted topic "${t.topic}" (${t.class})`);
  for (const c of classes) if (prohibited.has(c)) return deny(false, `action falls under prohibited ${c}`, [...classes]);

  // Options that turn an allowlisted read-only command into a writer or an executor (git diff --output, ...).
  const denied = action.argv?.slice(1).find((a) => (p.denied_args || []).some((d) => a === d || a.startsWith(`${d}=`)));
  if (denied) need('denied_argument', `argument ${denied} is denied by project policy`);
  if (action.argv && !argvAllowed(action.argv, p.allowlists.commands)) need('command_not_allowlisted', `command ${action.argv.join(' ')} is not in the project allowlist`);
  for (const path of action.paths || []) {
    if (/(^|[\\/])\.\.([\\/]|$)/.test(path) || /^([\\/]|[A-Za-z]:)/.test(path)) return deny(false, `path ${path} escapes the repository`);
    if ([...(p.excluded_paths || []), ...(task?.excluded_paths || [])].some((x) => under(path, x))) return deny(false, `path ${path} is excluded`);
    if (!p.allowlists.paths.some((x) => under(path, x))) need('path_not_allowlisted', `path ${path} is outside the allowlist`);
    if (!readOnly && (p.protected_paths || []).some((x) => under(path, x))) need('protected_path', `path ${path} is read-only to agents`);
  }
  for (const k of ['runtime', 'model']) {
    if (action[k] === undefined) continue;
    // The project list is a floor: a task list can only narrow it, never admit something the project excludes.
    for (const list of [p.allowlists[`${k}s`], task?.[`${k}_allowlist`]]) {
      if (Array.isArray(list) && !list.includes(action[k])) { need(`${k}_not_allowlisted`, `${k} ${action[k]} is not allowlisted`); break; }
    }
  }
  return why.length ? deny(true, why.join('; '), [...classes]) : { allow: true, needs_approval: false, reason: 'allowed by project policy', classes: [] };
}
