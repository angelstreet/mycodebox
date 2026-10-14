// Push and deploy decisions (round 8, OWNER_DECISIONS §15): like merge-policy.js, the manager decides a session's "push it?" and
// "deploy it?" questions itself when nothing argues against it. Facts come from git (read-only, async, fail closed), the deploy
// queue snapshot, the lease list and the session's closing text; the floor lists reasons to escalate; Jev (or the manager's own
// reasoning) rates what is left. Remaining hard floors stay in stall.js (deletes, credentials, money, customers, migrations,
// force pushes, systemctl / pm2 / sudoers, publishing).
import { basename } from 'node:path';
import { buildRequest } from './router.js';
import { deployHint } from './stall.js';
import { git, repoNames, repoToplevel, scanRange, testEvidence, SENS_TEXT, short, sensitivePath, MERGE_DEFAULTS } from './merge-policy.js';

export const DECIDE_DEFAULTS = { pushDecisions: true, deployDecisions: true, pushMinConfidence: 0.85, deployMinConfidence: 0.85, pushOptOut: [], deployOptOut: [] };

const REF_TOKEN = String.raw`[\w][\w./@+-]*`;
const clean = (t) => String(t || '').replace(/^[`'"(\[]+|[`'"),.;:?!\]]+$/g, '');
const SKIP = new Set(['it', 'this', 'that', 'them', 'these', 'those', 'the', 'a', 'an', 'my', 'our', 'your', 'its', 'branch', 'pr', 'work', 'changes', 'change', 'commit', 'commits', 'everything', 'all', 'now', 'and', 'then', 'to', 'too', 'again', 'after', 'before', 'once', 'when', 'if', 'whether', 'or', 'so', 'first', 'next', 'later', 'up', 'out', 'back', 'yes', 'no', 'origin', 'remote', 'upstream', 'with', 'for', 'on', 'in', 'of', 'at', 'as', 'forward', 'through', 'tags', 'tag', 'safely', 'please', 'there', 'here', 'from', 'only', 'just', 'also', 'both', 'main-line']);

// "push [-u] [origin] <branch> [to [origin/]<dest>]" -> { branch, dest } (null when not named).
export function parsePushAsk(text) {
  const t = String(text || '');
  const tok = String.raw`(${REF_TOKEN}|[\`'"]${REF_TOKEN}[\`'"])`;
  const re = new RegExp(String.raw`\bpush(?:ing)?\b\s+(?:-{1,2}[\w-]+\s+)*(?:origin\s+)?${tok}(?:\s+to\s+(?:the\s+)?(?:origin\/)?${tok})?`, 'ig');
  let m;
  while ((m = re.exec(t))) {
    const branch = clean(m[1]).replace(/^origin\//, '');
    if (!branch || SKIP.has(branch.toLowerCase())) continue;
    const dest = m[2] ? clean(m[2]).replace(/^origin\//, '') : null;
    return { branch, dest: dest && !SKIP.has(dest.toLowerCase()) ? dest : null };
  }
  // "push to main", "push it to origin/main": only filler words between push and "to" ("push and deploy to env-a" names no destination)
  const only = new RegExp(String.raw`\bpush(?:ing)?(?:\s+(?:it|this|that|them|these|the|branch|changes|work|commits?|origin|up|now))*\s+to\s+(?:the\s+)?(?:origin\/)?${tok}`, 'i').exec(t);
  const dest = only ? clean(only[1]).replace(/^origin\//, '') : null;
  return { branch: null, dest: dest && !SKIP.has(dest.toLowerCase()) ? dest : null };
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
  const facts = { ok: false, repo: null, repoName: null, branch: bName, dest: dName, branchSha: null, remoteSha: null, ahead: 0, files: [], docsOnly: false, sensitive: [], binary: [], scanError: null, afterMerge: !!afterMerge };
  const done = (verdict, why, decision, tests, extra = {}) => ({ verdict, reasons: verdict === 'push' ? [] : why, rationale: verdict === 'push' ? extra.rationale : why.join('; '),
    question: `Push ${facts.branch || bName || 'the branch'} to origin/${facts.dest || dName || facts.branch || 'its branch'}?`, facts, tests: tests || { state: 'unknown', explicit: false, quote: '' }, decision });
  const esc = (why, tests) => done('escalate', Array.isArray(why) ? why : [why], { source: 'floor', choice: 'escalate', confidence: 1, decision_id: null }, tests);
  if (!cwd) return esc('no working directory');
  const repo = await repoToplevel(cwd);
  if (!repo) return esc('not a git repository');
  const names = await repoNames(repo);
  facts.repo = repo; facts.repoName = basename(repo);
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
    // the merge evaluation already covered the branch (tests, sensitive paths); only origin/<target> must be an ancestor of the merged result
    facts.ahead = Math.max(facts.ahead, 1);
    const tests = afterMerge.tests || { state: 'unknown', explicit: false, quote: '' };
    const r = await rate('push', 'push', { jev, jevFacts: { session, repo: facts.repoName, branch: bName, dest: dName, ahead: facts.ahead, after_merge: true, floor_reasons: [] }, session, min: cfg.pushMinConfidence, reasoning: afterMerge.decision?.confidence >= cfg.pushMinConfidence ? 0.9 : 0.8 });
    if (r.escalate) return done('escalate', [r.escalate], r.decision, tests);
    facts.docsOnly = !!afterMerge.facts?.docsOnly;
    return done('push', [], r.decision, tests, { rationale: `lands the merge of ${afterMerge.branch} approved in this reply; ${hasRemote ? `fast-forward of origin/${dName}` : 'new remote branch'}` });
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
    tests.state === 'green' ? `tests green${tests.quote ? ` (${tests.quote.slice(0, 80)})` : ''}` : 'docs/test-only change', `${facts.files.length} file${facts.files.length === 1 ? '' : 's'}${facts.docsOnly ? ' (docs-only)' : ''}`];
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

// The latest deployed commit/ref per relevant target of `env` from the "deployed now" ledger.
export function lastDeployed(deploys, env, scope) {
  const per = deploys?.deployed?.[env] || {};
  return (TARGETS[scope] || TARGETS.full).map((t) => ({ target: t, ...(per[t] || {}) })).filter((x) => x.commit || x.ref);
}
export const rollbackText = (env, scope, last) => {
  const p = last?.[0];
  const prev = p ? (p.commit ? `${p.ref ? p.ref + '@' : ''}${String(p.commit).slice(0, 12)}` : p.ref) : null;
  return `Rollback: request a deploy of ${prev || 'the previous release'} to ${env} (${scope}).`;
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
  if (!facts.env) {
    const named = names.filter((n) => new RegExp(String.raw`(?<![\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\w-])`, 'i').test(t)).sort((a, b) => b.length - a.length);
    facts.env = named[0] || (names.length === 1 ? names[0] : null);
  }
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
  if (optedOut(cfg.deployOptOut, repo, rnames)) return esc(`repo ${facts.repoName} is opted out of manager deploy decisions`);
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
  // tests: green on the ref, or green on the session's branch and that branch is in the ref (or merged by this very reply)
  const ev = evidenceText ?? text;
  let tests = testsGiven || testEvidence(ev, { branch: ref });
  if (tests.state === 'green') facts.evidence = `tests green on ${ref}`;
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
  for (const p of facts.previous) {
    if (!p.commit || !(await resolves(repo, p.commit))) continue;
    const d = await git(repo, ['diff', '--name-only', '-z', `${p.commit}..${refGit}`]);
    if (d.code !== 0) return esc(`cannot list the changed files (${d.err || 'git diff failed'})`, tests);
    for (const f of d.out.split('\0').filter(Boolean)) changed.add(f);
    ranged = true;
  }
  if (!ranged || afterMerge) {
    if (!sBranch) return esc('cannot tell what would be deployed (no deployed commit known, no session branch)', tests);
    const spec = afterMerge ? `${refGit}...refs/heads/${sBranch}` : `${refGit}...refs/heads/${sBranch}`;
    const d = await git(repo, ['diff', '--name-only', '-z', spec]);
    if (d.code !== 0) return esc(`cannot list the changed files (${d.err || 'git diff failed'})`, tests);
    for (const f of d.out.split('\0').filter(Boolean)) changed.add(f);
  }
  const mig = [...changed].filter((f) => MIGRATION_RE.test(f) || sensitivePath(f) === 'migration');
  if (mig.length) return esc(`contains a database migration: ${mig.slice(0, 3).join(', ')}`, tests);
  facts.files = changed.size; facts.ok = true;
  const strong = tests.explicit;
  const r = await rate('deploy', 'deploy', { jev, jevFacts: { session, repo: facts.repoName, env: facts.env, scope: facts.scope, ref, tests: tests.state, tests_quote: tests.quote, files: changed.size, leases_blocking: 0, floor_reasons: [] }, session, min: cfg.deployMinConfidence, reasoning: strong ? 0.9 : 0.8 });
  if (r.escalate) return done('escalate', [r.escalate], r.decision, tests);
  return done('deploy', [], r.decision, tests, { rationale: `${facts.evidence}; no other agent's lease on ${facts.env}; no database change in ${changed.size} file${changed.size === 1 ? '' : 's'}` });
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
