// V2 Integration Agent controller (spec §12.3, docs/v2/ARCHITECTURE.md §11; T24-T31, T39, GL09/GL10/GL12).
// Deterministic executor: validates handoffs against the store (exact-SHA evidence + independent verdict), holds
// `repo:<r>:integration` + `repo:<r>:<target>`, merges reviewed branches sequentially in a fresh worktree cut from
// the CURRENT remote target, gates the exact merge SHA, and only then, with remote CI 'success' and an owner
// approval for that very SHA, updates the remote with a compare-and-swap push right after a fence check.
// Every remote mutation is recorded attempted -> confirmed | failed | possibly_applied; an uncertain push is
// resolved by reading the remote, never by pushing again. Nothing here ever reports success it did not observe.
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { canTransition } from './task-contract.js';
import { actorKey } from './store.js';
import { loadPolicy as realLoadPolicy, checkAction } from './policy.js';
import { createCiGates, gatesFromPolicy, remoteStatus, ciPasses } from './ci-gates.js';

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REF_RE = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// Task ids become ref components (refs/v2int/src/<id>): git ref rules on top of the store's id rules.
const TASK_REF_RE = /^(?!.*\.\.)(?!.*\.lock$)(?!.*\.$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Task states from which a handoff may (re-)enter integration; `waiting` is a parked retryable block (D-007).
const ENTRY_STATES = ['evaluating', 'integrating', 'waiting', 'awaiting_approval', 'unknown_external_effect'];
const coded = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });
// Identity is the store's: actor id only, normalized and case-folded; a role alone identifies nobody.
export const actorId = actorKey;
// Remote URLs may carry credentials (https://user:token@host): never let them into events, alerts or manifests.
export const redact = (t) => String(t).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1***@');
const errText = (e) => redact(String(e?.stderr || e?.message || e).trim()).slice(0, 300);
const RETRYABLE_GIT = new Set(['E_GIT', 'E_TIMEOUT']);
const MISSING_REF = /couldn't find remote ref|unknown revision|not a valid object name|not a valid commit name|bad revision|no such ref/i;
// Lease resource for a target branch: main keeps its own namespace, every other branch uses D-008.
export const targetResource = (repo, target) => (target === 'main' ? `repo:${repo}:main` : `repo:${repo}:branch:${target}`);

// ---- git runner -----------------------------------------------------------------------------------

// argv only, no shell. Rejects with code E_TIMEOUT (killed; the remote may still have applied it) or E_GIT.
export function createGitRunner({ bin = 'git', env: baseEnv, timeoutMs = 120_000, spawn = realSpawn } = {}) {
  const base = baseEnv || { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', GIT_TERMINAL_PROMPT: '0' };
  return (args, { cwd, env, timeout_ms } = {}) => new Promise((resolve, reject) => {
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) { reject(coded('E_INVALID', 'git argv must be strings')); return; }
    const child = spawn(bin, args, { cwd, env: { ...base, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout_ms ?? timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => { clearTimeout(t); reject(coded('E_GIT', `git ${args[0]}: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(t);
      const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
      if (timedOut) reject(coded('E_TIMEOUT', `git ${args[0]} timed out`, { stdout, stderr }));
      else if (code !== 0) reject(coded('E_GIT', `git ${args[0]} exit ${code}: ${stderr.trim().slice(0, 300)}`, { exit: code, stdout, stderr }));
      else resolve(stdout);
    });
  });
}

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
// A trailing * is a name-prefix glob ("Dockerfile*", "deploy*"); otherwise a path prefix on directory boundaries.
const under = (path, prefix) => { const a = norm(path), b = norm(prefix); return b.endsWith('*') ? a.startsWith(b.slice(0, -1)) : b === '' || b === '.' || a === b || a.startsWith(`${b}/`); };
const scopePaths = (task) => (task?.scope && typeof task.scope === 'object' && Array.isArray(task.scope.paths)
  && task.scope.paths.every((s) => typeof s === 'string') ? task.scope.paths : null);

// ---- controller -----------------------------------------------------------------------------------

export function createIntegrationController({
  store, leases, worktrees, git, ci, approvals, now = () => Date.now(), randomId = () => randomUUID(),
  queue, gates, deploys, repos = {}, owner = 'integration-agent', alert = () => {}, manifestDir, artifactsDir,
  identity = { name: 'mycodebox integration', email: 'integration@example.invalid' }, leaseTtlMs = 30 * 60_000,
  pushTimeoutMs = 60_000, maxRebuilds = 2, batchLimit = 10, loadPolicy = realLoadPolicy, fs = realFs,
} = {}) {
  for (const [k, v] of Object.entries({ store, leases, worktrees, git, queue })) if (!v) throw coded('E_CONFIG', `integration controller: ${k} required`);
  const outDir = manifestDir || join(store.dir, 'integrations');
  const gateRunner = gates || createCiGates({ git, now, artifactsDir: artifactsDir || join(outDir, 'artifacts'), actor: { role: 'integration', id: owner } });
  const actor = { role: 'integration', id: owner, runtime: null, model: null };
  const safeAlert = (kind, detail) => { try { alert({ kind, at: now(), owner, ...detail }); } catch { /* alerting must not break the fail-closed path */ } };
  let evN = 0;
  const evId = (scope) => `ic:${scope}:${++evN}:${randomId()}`;

  function repoCfg(repo) {
    const c = REPO_RE.test(repo ?? '') ? repos[repo] : null;
    if (!c || typeof c.dir !== 'string' || typeof c.remote !== 'string') throw coded('E_REPO', `repo ${repo} is not configured for integration`);
    return c;
  }

  // ---- remote reads -------------------------------------------------------------------------------

  // -> sha | null (branch absent). Throws when the remote cannot be read: unknown is not "absent".
  async function remoteHead(cfg, ref) {
    const out = await git(['ls-remote', cfg.remote, `refs/heads/${ref}`], { cwd: cfg.dir });
    const line = out.split('\n').find((l) => l.endsWith(`\trefs/heads/${ref}`));
    const sha = line ? line.split('\t')[0] : null;
    if (sha !== null && !SHA_RE.test(sha)) throw coded('E_GIT', 'unparseable ls-remote output');
    return sha;
  }
  async function fetchRef(cfg, from, src, dst) {
    await git(['fetch', '--no-tags', '--quiet', from, `+refs/heads/${src}:${dst}`], { cwd: cfg.dir });
    return (await git(['rev-parse', `${dst}^{commit}`], { cwd: cfg.dir })).trim();
  }
  async function isAncestor(cwd, a, b) {
    try { await git(['merge-base', '--is-ancestor', a, b], { cwd }); return true; } catch (e) { if (e.exit === 1) return false; throw e; }
  }

  // ---- store helpers ------------------------------------------------------------------------------

  async function taskEvent(task_id, kind, payload) {
    try { await store.append(task_id, { event_id: evId(task_id), kind, payload }); } catch (e) { safeAlert('store_write_failed', { task_id, kind, error: errText(e) }); throw e; }
  }
  const blocked = (task_id, reason, detail = {}) => taskEvent(task_id, 'task.blocked', { reason, actor, ...detail });
  async function moveTask(task_id, to, reason) {
    const t = await store.get(task_id);
    if (!t || t.status === to) return t?.status ?? null;
    if (!canTransition(t.status, to)) { await blocked(task_id, `cannot move ${t.status} -> ${to}`, { wanted: to, why: reason }); return t.status; }
    await store.transition(task_id, to, { reason, actor });
    return to;
  }
  // D-007: a retryable block after a task entered integration parks it in `waiting` with a structured wake
  // condition (what has to change before a retry makes sense); the queue item stays parked, the audit event stays.
  async function park(task_id, reason, wake, detail = {}) {
    await blocked(task_id, reason, { wake, ...detail });
    const t = await store.get(task_id);
    if (t && ['integrating', 'unknown_external_effect'].includes(t.status)) await moveTask(task_id, 'waiting', `${reason}: wake on ${wake.kind}`);
  }
  const decide = (task_id, d) => store.recordDecision(task_id, {
    kind: d.kind, question: d.question, alternatives: d.alternatives, chosen: d.chosen, evidence: d.evidence?.length ? d.evidence : [d.question],
    expected_effect: d.expected_effect, rationale: d.rationale, actor, confidence: null, policy_ref: d.policy_ref ?? null,
    reversible: d.reversible ?? false, rollback: d.rollback ?? null,
  });

  // ---- handoff validation (§12.3 step 1) ----------------------------------------------------------

  // -> { ok, errors[], facts: { task, source_sha, changed[] } }. Facts come from the store and git, never from the
  // handoff's own claims: the handoff only names what to look at.
  async function validateHandoff(h, { fetch = true } = {}) {
    const errors = [];
    const e = (m) => errors.push(m);
    if (!h || typeof h !== 'object') return { ok: false, errors: ['handoff must be an object'] };
    if (typeof h.task_id !== 'string' || !TASK_REF_RE.test(h.task_id)) e('task_id required, usable as a git ref component');
    if (!REPO_RE.test(h.repo ?? '') || !repos[h.repo]) e('repo is not configured for integration');
    if (!REF_RE.test(h.target ?? '')) e('target branch invalid');
    if (!REF_RE.test(h.source_branch ?? '')) e('source_branch invalid');
    if (!SHA_RE.test(h.source_sha ?? '')) e('source_sha must be a full commit sha');
    if (!SHA_RE.test(h.base_sha ?? '')) e('base_sha must be a full commit sha');
    if (!actorId(h.developer)) e('developer actor with a stable id required');
    if (!Array.isArray(h.diff_scope) || !h.diff_scope.every((p) => typeof p === 'string' && p)) e('diff_scope must list the changed paths');
    // Fetch sources only from the configured remote or an explicit allowlist: no transport helpers, no argv.
    if (h.source_repo !== undefined) {
      const c = repos[h.repo];
      const ok = typeof h.source_repo === 'string' && c && (h.source_repo === c.remote || (Array.isArray(c.source_remotes) && c.source_remotes.includes(h.source_repo)));
      if (!ok) e('source_repo is not the configured remote or an allowlisted source remote');
    }
    if (errors.length) return { ok: false, errors };

    const task = await store.get(h.task_id);
    if (!task) return { ok: false, errors: [`task ${h.task_id} not found`] };
    if (!ENTRY_STATES.includes(task.status)) e(`task is ${task.status}; integration needs ${ENTRY_STATES.join('|')}`);
    if (task.head_sha !== h.source_sha) e(`task head ${task.head_sha} is not the handed-off sha ${h.source_sha}: stale handoff`);
    // Test evidence: every required acceptance check passed on this exact sha (GL12: older shas do not count).
    for (const c of task.acceptance_checks.filter((x) => x.required)) {
      if (!task.evidence.some((ev) => ev.check_id === c.id && ev.sha === h.source_sha && ev.exit === c.expect.exit)) e(`missing passing evidence for required check ${c.id} on ${h.source_sha}`);
    }
    // Independence from the store's own record of who produced the sha (setHead actor); handoff.developer is
    // caller-supplied and only kept as provenance.
    const ind = await store.independence(h.task_id, h.source_sha);
    if (!ind.ok) for (const r of ind.reasons) e(`independence: ${r}`);
    const allowed = scopePaths(task);
    if (!allowed) e('task scope is not machine-checkable: task.scope.paths required');
    if (errors.length || !fetch) return { ok: !errors.length, errors, facts: { task } };

    // Git facts: the branch really is at that sha, the base is its ancestor, the diff stays in scope.
    const cfg = repoCfg(h.repo);
    let changed = [];
    try {
      const src = await fetchRef(cfg, h.source_repo || cfg.remote, h.source_branch, `refs/v2int/src/${h.task_id}`);
      if (src !== h.source_sha) e(`source branch ${h.source_branch} is at ${src}, not the handed-off ${h.source_sha}`);
      else {
        if (!(await isAncestor(cfg.dir, h.base_sha, h.source_sha))) e(`base_sha ${h.base_sha} is not an ancestor of ${h.source_sha}`);
        const tgt = await fetchRef(cfg, cfg.remote, h.target, `refs/v2int/target/${h.target}`);
        const mb = (await git(['merge-base', tgt, h.source_sha], { cwd: cfg.dir })).trim();
        changed = (await git(['diff', '--name-only', '--no-renames', mb, h.source_sha], { cwd: cfg.dir })).split('\n').filter(Boolean);
      }
    } catch (err) {
      // A network blip is not a verdict on the handoff: retryable, never a final rejection.
      // A missing ref is a verdict, though: retrying a deleted branch forever helps no one.
      if (RETRYABLE_GIT.has(err.code) && !MISSING_REF.test(errText(err))) return { ok: false, retryable: true, errors: [...errors, `git: ${errText(err)}`], facts: { task } };
      e(`git: ${errText(err)}`);
    }
    for (const f of changed) {
      if (!h.diff_scope.some((p) => under(f, p))) e(`changed path ${f} is not in the declared diff_scope`);
      if (!allowed.some((p) => under(f, p))) e(`changed path ${f} is outside the task scope`);
      if ((task.excluded_paths || []).some((p) => under(f, p))) e(`changed path ${f} is excluded for this task`);
    }
    return { ok: !errors.length, errors, facts: { task, source_sha: h.source_sha, changed } };
  }

  async function submit(handoff, { idempotencyKey } = {}) {
    const v = await validateHandoff(handoff);
    if (!v.ok) {
      if (v.retryable) return { ok: false, code: 'E_RETRYABLE', errors: v.errors };
      if (v.facts?.task) await blocked(handoff.task_id, 'handoff_rejected', { errors: v.errors });
      return { ok: false, code: 'E_HANDOFF_INVALID', errors: v.errors };
    }
    const item = await queue.enqueue({ ...handoff }, { idempotencyKey: idempotencyKey ?? `${handoff.task_id}:${handoff.source_sha}:${handoff.target}` });
    return { ok: true, item };
  }

  // ---- approvals (T31, GL09) ----------------------------------------------------------------------

  // Valid only for this exact repo, action, sha and target, unexpired. A model's say-so or a quiet owner never counts.
  async function approvalFor({ action, sha, target, repo, task_ids }) {
    let a = null;
    try { a = approvals ? await approvals.check({ action, sha, target, repo, task_ids, actor: owner }) : null; } catch { a = null; }
    const ok = !!a && a.ok !== false && typeof a.approval_ref === 'string' && a.approval_ref !== '' && a.sha === sha
      && a.action === action && a.target === target && a.repo === repo && (a.expires_at == null || a.expires_at > now());
    return ok ? { ok: true, approval_ref: a.approval_ref, approved_by: a.approved_by ?? null }
      : { ok: false, reason: !approvals ? 'no approval service configured' : !a || a.ok === false ? (a?.reason || 'no approval') : 'approval does not match this repo/action/sha/target or expired' };
  }

  // ---- reconciliation of uncertain effects (T30, store recovery) ------------------------------------

  // Effect keys are `<kind>:<repo>:refs/heads/<ref>:<sha>` so the remote can be asked what really happened. Only
  // effects this controller wrote (effect_id `int-...`) with a well-formed key are reconciled; others stay open.
  const EFFECT_ID_RE = /^int-[A-Za-z0-9._-]+:r\d+(?::cand)?:[A-Za-z0-9._-]+:(?:merge|push)$/;
  function parseKey(k) {
    const parts = String(k).split(':');
    if (parts.length !== 4) return null;
    const [kind, repo, full, sha] = parts;
    const ref = full.startsWith('refs/heads/') ? full.slice(11) : null;
    if (!['merge', 'push'].includes(kind) || !REPO_RE.test(repo) || !repos[repo] || !ref || !REF_RE.test(ref) || !SHA_RE.test(sha)) return null;
    return { kind, repo, ref, sha };
  }
  // Read-only: what the remote says about one effect key. -> 'confirmed' | 'failed' | null (key not ours, or the
  // remote cannot be read: unknown stays unknown). Used by reconcileTask and by the goal-loop delivery bridge.
  async function effectState(key, scope = 'probe') {
    const k = parseKey(key);
    if (!k) return null;
    const { repo, ref, sha } = k;
    try {
      const cfg = repoCfg(repo);
      const remote = await remoteHead(cfg, ref);
      if (remote === sha) return 'confirmed';
      if (!remote) return 'failed';
      await fetchRef(cfg, cfg.remote, ref, `refs/v2int/reconcile/${scope}`);
      return (await git(['cat-file', '-e', `${sha}^{commit}`], { cwd: cfg.dir }).then(() => true, () => false))
        && await isAncestor(cfg.dir, sha, remote) ? 'confirmed' : 'failed';
    } catch { return null; }
  }
  async function reconcileTask(task_id) {
    const t = await store.get(task_id);
    const open = (t?.effects || []).filter((x) => x.phase === 'attempted' || x.phase === 'possibly_applied');
    let merged = false;
    for (const eff of open) {
      const k = EFFECT_ID_RE.test(eff.effect_id) ? parseKey(eff.idempotency_key) : null;
      if (!k) return { ok: false, unresolved: eff.effect_id, reason: 'not an integration effect this controller can reconcile' };
      const phase = await effectState(eff.idempotency_key, task_id);
      if (!phase) return { ok: false, unresolved: eff.effect_id };
      await store.recordEffect(task_id, { effect_id: eff.effect_id, idempotency_key: eff.idempotency_key, kind: eff.kind, phase });
      if (phase === 'confirmed' && k.kind === 'merge') merged = true;
    }
    return { ok: true, merged };
  }

  // ---- the remote mutation itself (T27, T30) --------------------------------------------------------

  // CAS push of `sha` to refs/heads/<ref>, expecting `expected` (null = must not exist). Returns
  // { phase: 'confirmed'|'failed'|'possibly_applied', moved?: boolean }.
  async function casPush({ cfg, repo, ref, sha, expected, kind, task_ids, scope, fence, effects }) {
    const key = `${kind}:${repo}:refs/heads/${ref}:${sha}`;
    const recorded = [];
    for (const task_id of task_ids) {
      const effect_id = `${scope}:${task_id}:${kind}`;
      try {
        await store.recordEffect(task_id, { effect_id, idempotency_key: key, kind, phase: 'attempted' });
        recorded.push({ task_id, effect_id });
      } catch (e) {
        if (e.code !== 'E_EFFECT_DUPLICATE') throw e;   // already confirmed for this exact sha: never push twice
      }
    }
    const settle = async (phase) => {
      for (const r of recorded) await store.recordEffect(r.task_id, { effect_id: r.effect_id, idempotency_key: key, kind, phase });
      effects.push({ kind, ref, sha, expected, phase, effect_ids: recorded.map((r) => r.effect_id) });
    };
    if (!recorded.length) {   // every task already has this exact update confirmed: never push it a second time
      const remote = await remoteHead(cfg, ref).catch(() => undefined);
      effects.push({ kind, ref, sha, expected, phase: remote === sha ? 'confirmed' : 'not_repeated', effect_ids: [], already: true });
      return remote === sha ? { phase: 'confirmed' } : { phase: 'failed', moved: false, error: 'already confirmed once; remote no longer at it: owner review' };
    }
    try { await fence.check(); }   // last check, immediately before the mutation
    catch (e) { await settle('failed'); throw e; }
    let pushErr = null;
    try {
      await git(['push', '--porcelain', `--force-with-lease=refs/heads/${ref}:${expected ?? ''}`, cfg.remote, `${sha}:refs/heads/${ref}`],
        { cwd: cfg.dir, timeout_ms: pushTimeoutMs });
    } catch (e) { pushErr = e; }
    // Whatever the push said, the remote is the truth. Read it before deciding anything, and never re-push here.
    let remote;
    try { remote = await remoteHead(cfg, ref); } catch { remote = undefined; }
    if (remote === sha) { await settle('confirmed'); return { phase: 'confirmed', uncertain_response: !!pushErr }; }
    if (remote === undefined) {
      await settle('possibly_applied');
      safeAlert('push_uncertain', { repo, ref, sha, error: pushErr ? errText(pushErr) : 'remote unreadable after push' });
      return { phase: 'possibly_applied' };
    }
    if (remote && remote !== expected) {
      // Moved by someone else: ours may have landed underneath it.
      let ours = false;
      try { await fetchRef(cfg, cfg.remote, ref, `refs/v2int/reconcile/${scope}`); ours = await isAncestor(cfg.dir, sha, remote); } catch { ours = false; }
      if (ours) { await settle('confirmed'); return { phase: 'confirmed', uncertain_response: !!pushErr }; }
      await settle('failed');
      return { phase: 'failed', moved: true, error: pushErr ? errText(pushErr) : 'remote moved' };
    }
    await settle('failed');   // remote still at expected: not applied
    return { phase: 'failed', moved: false, error: pushErr ? errText(pushErr) : 'push reported success but remote unchanged' };
  }

  // ---- one integration run --------------------------------------------------------------------------

  function writeManifest(m) {
    fs.mkdirSync(outDir, { recursive: true });
    const path = join(outDir, `${m.integration_id}.json`);
    if (fs.existsSync(path)) throw coded('E_EXISTS', `manifest ${m.integration_id} already written`);   // immutable
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(m, null, 1)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, path);
    return path;
  }

  async function runNext(repo, target) {
    if (!REPO_RE.test(repo ?? '') || !REF_RE.test(target ?? '')) throw coded('E_INVALID', 'repo/target invalid');
    const cfg = repoCfg(repo);
    const pending = await queue.peek(repo, target, { limit: batchLimit });
    if (!pending.length) return { outcome: 'empty' };
    const integration_id = `int-${randomId()}`;
    try { await queue.start(pending.map((x) => x.item_id), { owner }); }
    catch (e) { if (e.code === 'E_BUSY') return { outcome: 'busy', reason: e.message }; throw e; }

    const m = { schema_version: 1, integration_id, repo, target, owner, started_at: new Date(now()).toISOString(),
      items: pending.map((x) => ({ item_id: x.item_id, task_id: x.task_id,
        source_branch: x.handoff.source_branch, source_sha: x.handoff.source_sha, base_sha: x.handoff.base_sha,
        claimed_developer: actorId(x.handoff.developer) })), leases: [], rounds: [], effects: [], approvals: [], outcome: null };
    const itemState = new Map(pending.map((x) => [x.item_id, null]));
    const finishItem = async (it, state, reason, detail) => { itemState.set(it.item_id, state); await queue.finish(it.item_id, state, { reason, detail }); };
    let res;
    try {
      res = await integrate({ cfg, repo, target, integration_id, items: pending, m, finishItem });
    } catch (e) {
      // Unexpected failure: a task with an unresolved remote effect is unknown, everything else is blocked.
      res = { outcome: 'error', reason: errText(e) };
      safeAlert('integration_error', { integration_id, repo, target, error: errText(e) });
      for (const it of pending) {
        if (itemState.get(it.item_id)) continue;
        const t = await store.get(it.task_id).catch(() => null);
        const open = (t?.effects || []).some((x) => x.phase === 'attempted' || x.phase === 'possibly_applied');
        if (open) { res.outcome = 'unknown_external_effect'; await moveTask(it.task_id, 'unknown_external_effect', `integration error: ${res.reason}`).catch(() => {}); }
        else await park(it.task_id, 'integration_error', { kind: 'retry', repo, target }, { integration_id, error: res.reason }).catch(() => {});
        await finishItem(it, open ? 'unknown' : 'blocked', res.reason).catch(() => {});
      }
    }
    for (const it of pending) {
      if (itemState.get(it.item_id)) continue;
      const st = res.outcome === 'unknown_external_effect' ? 'unknown' : 'blocked';
      await queue.finish(it.item_id, st, { reason: res.reason ?? res.outcome });
      itemState.set(it.item_id, st);
    }
    m.outcome = res.outcome;
    m.reason = res.reason ?? null;
    m.finished_at = new Date(now()).toISOString();
    m.item_states = Object.fromEntries(itemState);
    let manifest_path = null;
    try { manifest_path = writeManifest(m); } catch (e) { safeAlert('manifest_write_failed', { integration_id, error: errText(e) }); }
    return { ...res, integration_id, manifest_path, manifest: m, items: Object.fromEntries(itemState) };
  }

  async function integrate({ cfg, repo, target, integration_id, items, m, finishItem }) {
    // 0. Uncertain effects from an earlier run are resolved against the remote before anything else.
    let live = [];
    for (const it of items) {
      const t = await store.get(it.task_id);
      if (t?.status === 'unknown_external_effect') {
        const r = await reconcileTask(it.task_id);
        if (!r.ok) { await finishItem(it, 'unknown', 'effect still unresolved'); continue; }
        if (r.merged) {
          await moveTask(it.task_id, 'integrating', 'reconciled: merge confirmed on remote');
          await moveTask(it.task_id, 'release_verifying', 'merge confirmed on remote');
          await finishItem(it, 'merged', 'reconciled');
          continue;
        }
      }
      live.push(it);
    }
    if (!live.length) return { outcome: 'reconciled', reason: 'earlier effects resolved against the remote' };

    // 1. Fresh validation: evidence, verdict, branch position and scope may have changed since submit (GL12).
    const valid = [];
    let retry = 0;
    for (const it of live) {
      const v = await validateHandoff(it.handoff);
      if (v.ok) {
        const ind = await store.independence(it.task_id, it.handoff.source_sha);
        it.developers = ind.developers;
        const mi = m.items.find((x) => x.item_id === it.item_id); if (mi) { mi.developers = ind.developers; mi.verifiers = ind.approvers; }
        valid.push({ ...it, changed: v.facts.changed }); continue;
      }
      if (v.retryable) {
        await blocked(it.task_id, 'git_unavailable', { errors: v.errors, integration_id, wake: { kind: 'remote_reachable', repo } });
        await finishItem(it, 'blocked', 'git unavailable during validation', { errors: v.errors });
        retry++;
        continue;
      }
      await blocked(it.task_id, 'handoff_rejected', { errors: v.errors, integration_id });
      await finishItem(it, 'rejected', 'handoff invalid', { errors: v.errors });
    }
    if (!valid.length) return retry ? { outcome: 'blocked', reason: 'git unavailable during validation' } : { outcome: 'rejected', reason: 'no valid handoff' };
    const taskIds = () => valid.filter((x) => !x.out).map((x) => x.task_id);

    // 2. Deployment in progress? Unknown is not idle.
    let dep = 'unknown';
    try { dep = deploys ? await deploys.status({ repo, target }) : 'unknown'; } catch { dep = 'unknown'; }
    if (dep !== 'idle') {
      const reason = dep === 'active' ? 'deploy_in_progress' : 'deploy_state_unknown';
      if (dep !== 'active') safeAlert('deploy_state_unknown', { repo, target, integration_id });
      for (const it of valid) { await blocked(it.task_id, reason, { integration_id }); await finishItem(it, 'blocked', reason); }
      return { outcome: 'blocked', reason };
    }

    // 3. Leases: integration lane and target branch, all-or-nothing in canonical order. No lease, no mutation.
    const resources = [`repo:${repo}:integration`, targetResource(repo, target)];
    const lr = await leases.withLeases(resources, { owner, task_id: integration_id, ttl_ms: leaseTtlMs, scope: 'integration' },
      async (fence) => {
        m.leases = fence.leases.map((l) => ({ resource: l.resource, token: l.token, lease_id: l.lease_id }));
        for (const it of valid) await moveTask(it.task_id, 'integrating', `integration ${integration_id}`);
        try { return await underLease({ cfg, repo, target, integration_id, valid, m, fence, finishItem, taskIds }); }
        catch (e) {
          if (!['E_FENCED', 'E_EXPIRED', 'E_UNAVAILABLE'].includes(e.code)) throw e;
          // T27: the lease went away mid-run; a stale executor stops before its next protected action.
          safeAlert('lease_lost', { integration_id, repo, target, code: e.code });
          for (const t of taskIds()) await park(t, 'lease_lost', { kind: 'lease_free', resource: targetResource(repo, target) }, { code: e.code, integration_id });
          return { outcome: 'lease_lost', reason: e.code };
        }
      });
    if (lr.ok) return lr.value;
    if (lr.code === 'E_HELD') {
      for (const it of valid) await finishItem(it, 'queued', 'lane busy: lease held by another integrator');
      return { outcome: 'busy', reason: 'E_HELD', holder: lr.holder ?? null };
    }
    // T26: unavailable/invalid authority blocks and alerts; it is never read as "free".
    safeAlert('integration_blocked_lease', { integration_id, repo, target, code: lr.code });
    for (const it of valid) { await blocked(it.task_id, 'lease_unavailable', { code: lr.code, integration_id }); await finishItem(it, 'blocked', `lease ${lr.code}`); }
    return { outcome: 'blocked', reason: `lease ${lr.code}` };
  }

  async function underLease({ cfg, repo, target, integration_id, valid, m, fence, finishItem, taskIds }) {
    for (let round = 0; ; round++) {
      const r = await buildRound({ cfg, repo, target, integration_id, round, valid, m, fence, finishItem, taskIds });
      if (r.outcome !== 'invalidated') return r;
      for (const t of taskIds()) {
        await decide(t, { kind: 'integration.invalidate', question: 'Tested integration SHA is no longer what would be merged',
          alternatives: [{ option: 'rebuild and rerun all gates', pros: ['evidence matches the merged commit'], cons: ['time'] },
            { option: 'merge the tested SHA anyway', pros: ['faster'], cons: ['untested combination reaches the target'] }],
          chosen: round < maxRebuilds ? 'rebuild and rerun all gates' : 'stop and wait', evidence: [r.reason],
          expected_effect: 'gates and CI are re-evaluated on the new integration SHA', rationale: 'stale green tests are not evidence (T28, GL12)',
          reversible: true, rollback: 'none needed: nothing was pushed' });
      }
      if (round >= maxRebuilds) {
        for (const t of taskIds()) await park(t, 'target_unstable', { kind: 'target_stable', repo, target }, { integration_id, rounds: round + 1 });
        return { outcome: 'blocked', reason: `target kept moving: ${r.reason}` };
      }
    }
  }

  async function buildRound({ cfg, repo, target, integration_id, round, valid, m, fence, finishItem, taskIds }) {
    const rec = { round, target_sha: null, merges: [], conflicts: [], integration_sha: null, gates: null, remote_ci: null, invalidated: null };
    m.rounds.push(rec);
    const scope = `${integration_id}:r${round}`;

    // Fresh worktree from the CURRENT remote target sha (never a cached one).
    await fence.check();
    const targetSha = await remoteHead(cfg, target);
    if (!targetSha) return { outcome: 'blocked', reason: `target ${target} not found on remote` };
    const fetched = await fetchRef(cfg, cfg.remote, target, `refs/v2int/target/${target}`);
    if (fetched !== targetSha) return { outcome: 'invalidated', reason: 'target moved during fetch' };
    rec.target_sha = targetSha;
    // F8: a source already contained in the target (merged elsewhere, or by us before a crash) needs no new merge
    // and no approval: there is nothing left to push for it.
    for (const it of valid.filter((x) => !x.out)) {
      if (!(await isAncestor(cfg.dir, it.handoff.source_sha, targetSha))) continue;
      await moveTask(it.task_id, 'release_verifying', `source ${it.handoff.source_sha} already in ${target}@${targetSha}`);
      await finishItem(it, 'merged', 'already_in_target', { target_sha: targetSha }); it.out = true;
    }
    if (!taskIds().length) { m.target_sha_before = targetSha; return { outcome: 'already_merged', target_sha_before: targetSha }; }
    const wt = await worktrees.create({ repo: cfg.dir, task_id: `${integration_id}-r${round}`, base_sha: targetSha, owner });
    rec.worktree_branch = wt.branch;
    // The worktree directory is retained as evidence (no automatic removal), but its lease is not held past the round.
    try { return await inWorktree({ cfg, repo, target, integration_id, valid, m, fence, finishItem, taskIds, rec, scope, targetSha, wt }); }
    finally { try { await leases.release(wt.lease); } catch { /* expires by ttl */ } }
  }

  async function inWorktree({ cfg, repo, target, integration_id, valid, m, fence, finishItem, taskIds, rec, scope, targetSha, wt }) {
    // Project policy comes from the target, not from a developer branch (agents cannot widen their own rules).
    const pol = loadPolicy(wt.path);
    if (!pol.ok) {
      for (const it of valid.filter((x) => !x.out)) {
        await moveTask(it.task_id, 'awaiting_approval', `project policy ${pol.code}: owner clarification required`);
        await finishItem(it, 'awaiting_approval', pol.code); it.out = true;
      }
      return { outcome: 'awaiting_approval', reason: pol.code };
    }
    const policy = pol.policy;
    if (!Array.isArray(policy.protected_branches)) {
      for (const it of valid.filter((x) => !x.out)) { await moveTask(it.task_id, 'awaiting_approval', 'protected branch config unknown'); await finishItem(it, 'awaiting_approval', 'protected_branches missing'); it.out = true; }
      return { outcome: 'awaiting_approval', reason: 'protected branch config unknown' };
    }
    const mergeClass = policy.protected_branches.includes(target) ? 'merge_protected' : 'push_shared';

    // Sequential merges. A conflict goes back to its developer with the files; no side is ever picked for them.
    const when = (it) => `@${Math.floor(Date.parse(it.enqueued_at) / 1000)} +0000`;
    for (const it of valid.filter((x) => !x.out)) {
      const touchesProtected = (it.changed || []).filter((f) => (policy.protected_paths || []).some((p) => under(f, p)));
      if (touchesProtected.length) {
        await moveTask(it.task_id, 'awaiting_approval', `changes protected paths: ${touchesProtected.join(', ')}`);
        await finishItem(it, 'awaiting_approval', 'protected_path', { files: touchesProtected }); it.out = true;
        continue;
      }
      const task = await store.get(it.task_id);
      const excluded = (it.changed || []).filter((f) => [...(policy.excluded_paths || []), ...(task.excluded_paths || [])].some((p) => under(f, p)));
      if (excluded.length) {
        await moveTask(it.task_id, 'repair', `changes excluded paths: ${excluded.join(', ')}`);
        await finishItem(it, 'returned', 'excluded_path', { files: excluded }); it.out = true;
        continue;
      }
      const outside = (it.changed || []).filter((f) => !policy.allowlists.paths.some((p) => under(f, p)));
      if (outside.length) {
        await moveTask(it.task_id, 'awaiting_approval', `changes paths outside the project allowlist: ${outside.join(', ')}`);
        await finishItem(it, 'awaiting_approval', 'path_not_allowlisted', { files: outside }); it.out = true;
        continue;
      }
      const verdict = checkAction(policy, task, { class: mergeClass, paths: it.changed || [] });
      if (!verdict.allow && !verdict.needs_approval) {
        await moveTask(it.task_id, 'awaiting_approval', `policy refuses ${mergeClass}: ${verdict.reason}`);
        await finishItem(it, 'rejected', 'prohibited by policy', { reason: verdict.reason }); it.out = true;
        continue;
      }
      await fence.check();
      // Deterministic identity, dates and message: the same target + sources rebuild the same SHA, so an approval
      // or a CI result for it stays meaningful across reruns, and any upstream change yields a new SHA.
      const msg = `Integrate ${it.task_id} from ${it.handoff.source_branch}\n\nSource: ${it.handoff.source_sha}\nQueue-item: ${it.item_id}\n`;
      const env = { GIT_AUTHOR_DATE: when(it), GIT_COMMITTER_DATE: when(it) };
      try {
        await git(['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, '-c', 'commit.gpgsign=false',
          'merge', '--no-ff', '--no-edit', '-m', msg, it.handoff.source_sha], { cwd: wt.path, env });
        const sha = (await git(['rev-parse', 'HEAD'], { cwd: wt.path })).trim();
        rec.merges.push({ item_id: it.item_id, task_id: it.task_id, source_sha: it.handoff.source_sha, merge_sha: sha });
      } catch (e) {
        const files = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd: wt.path }).catch(() => '')).split('\n').filter(Boolean);
        await git(['merge', '--abort'], { cwd: wt.path }).catch(() => {});
        if (!files.length) throw e;   // not a content conflict: unexpected, handled as error
        rec.conflicts.push({ item_id: it.item_id, task_id: it.task_id, files });
        await decide(it.task_id, { kind: 'integration.conflict', question: `Merge of ${it.handoff.source_sha} into ${target} conflicts`,
          alternatives: [{ option: 'return to developer', pros: ['the author resolves the contract'], cons: ['another loop'] },
            { option: 'pick ours/theirs automatically', pros: ['fast'], cons: ['silently drops one side of a contract'] }],
          chosen: 'return to developer', evidence: files, expected_effect: 'developer rebases onto the current target and re-hands off',
          rationale: 'never auto-pick a side of a conflict (§12.3 step 3)', reversible: true, rollback: 're-submit the handoff after repair' });
        await moveTask(it.task_id, 'repair', `merge conflict with ${target}@${targetSha.slice(0, 12)}: ${files.join(', ')}`);
        await finishItem(it, 'returned', 'merge_conflict', { files, target_sha: targetSha }); it.out = true;
      }
    }
    if (!taskIds().length) return { outcome: rec.conflicts.length ? 'conflict' : 'returned', reason: 'nothing left to integrate' };
    const sha = (await git(['rev-parse', 'HEAD'], { cwd: wt.path })).trim();
    rec.integration_sha = sha;

    // Gates on the exact integration sha with fresh temp state (T24).
    const gl = gatesFromPolicy(policy);
    if (!gl.length) {
      for (const t of taskIds()) await park(t, 'no_gates_configured', { kind: 'policy_change', repo }, { integration_id });
      return { outcome: 'blocked', reason: 'no gates configured: local verification cannot be claimed' };
    }
    await fence.renew();   // long step ahead; renew only succeeds for the current holder
    // Heartbeat while gates run; a failed renew is not fatal here, the fence check before every mutation decides.
    const hb = setInterval(() => { fence.renew().catch((e) => safeAlert('lease_renew_failed', { integration_id, code: e.code })); }, Math.max(1000, Math.floor(leaseTtlMs / 3)));
    hb.unref?.();
    let g;
    try { g = await gateRunner.run({ cwd: wt.path, sha, gates: gl }); } finally { clearInterval(hb); }
    rec.gates = g.evidence.map((ev) => ({ ...ev, actor: actorKey(ev.actor) }));
    for (const t of taskIds()) for (const ev of g.evidence) {
      await store.recordEvidence(t, { check_id: `integration:${ev.check_id}`, sha: ev.sha, command: ev.command, exit: ev.exit,
        duration_ms: ev.duration_ms, artifact: `${ev.artifact}#${ev.artifact_digest}`, actor, ts: ev.ts });
    }
    if (g.invalidated) { rec.invalidated = g.invalidated; return { outcome: 'invalidated', reason: g.invalidated }; }
    if (!g.ok) {
      for (const it of valid.filter((x) => !x.out)) {
        await moveTask(it.task_id, 'repair', `integration gates failed on ${sha}: ${g.reason}`);
        await finishItem(it, 'returned', 'gates_failed', { sha, reason: g.reason }); it.out = true;
      }
      return { outcome: 'gates_failed', reason: g.reason, integration_sha: sha };
    }

    // Remote CI on the exact sha (T29). Missing + a configured candidate ref: publish the candidate (approved, fenced).
    let cs = await remoteStatus(ci, sha);
    if (cs.status === 'missing' && cfg.candidate_ref) {
      const ap = await approvalFor({ action: 'push', sha, target: cfg.candidate_ref, repo, task_ids: taskIds() });
      if (!ap.ok) return refuse({ action: 'push', cls: 'push_shared', sha, ref: cfg.candidate_ref, reason: ap.reason, valid, finishItem, integration_id, m, taskIds });
      m.approvals.push({ action: 'push', sha, target: cfg.candidate_ref, approval_ref: ap.approval_ref, approved_by: ap.approved_by });
      const expected = await remoteHead(cfg, cfg.candidate_ref);
      if (expected !== sha) {
        const p = await casPush({ cfg, repo, ref: cfg.candidate_ref, sha, expected, kind: 'push', task_ids: taskIds(), scope: `${scope}:cand`, fence, effects: m.effects });
        if (p.phase === 'possibly_applied') return uncertain({ valid, finishItem, reason: 'candidate push uncertain' });
        if (p.phase !== 'confirmed') {
          for (const t of taskIds()) await park(t, 'candidate_push_failed', { kind: 'retry', repo, target: cfg.candidate_ref }, { sha, error: p.error, integration_id });
          return { outcome: 'blocked', reason: `candidate push failed: ${p.error}` };
        }
      }
      cs = await remoteStatus(ci, sha);
    }
    rec.remote_ci = { status: cs.status, sha, checked_at: new Date(now()).toISOString(), reason: cs.reason ?? null };
    if (!ciPasses(cs.status)) {
      if (cs.status === 'failure') {
        for (const it of valid.filter((x) => !x.out)) {
          await moveTask(it.task_id, 'repair', `remote CI failure on ${sha}`);
          await finishItem(it, 'returned', 'remote_ci_failure', { sha }); it.out = true;
        }
        return { outcome: 'ci_failed', reason: 'remote CI failure', integration_sha: sha };
      }
      // pending / missing / unknown: wait, never merge on local green alone.
      for (const t of taskIds()) await park(t, `remote_ci_${cs.status}`, { kind: 'ci_status', repo, sha }, { sha, integration_id });
      if (cs.status !== 'pending') safeAlert('remote_ci_not_green', { integration_id, sha, status: cs.status });
      return { outcome: 'ci_blocked', reason: `remote CI ${cs.status}`, integration_sha: sha };
    }

    // T28: what was tested must still be what would land: same target sha, same clean integration head.
    const nowTarget = await remoteHead(cfg, target);
    if (nowTarget !== targetSha) { rec.invalidated = `target moved ${targetSha} -> ${nowTarget}`; return { outcome: 'invalidated', reason: rec.invalidated }; }
    const head = (await git(['rev-parse', 'HEAD'], { cwd: wt.path })).trim();
    const dirty = (await git(['status', '--porcelain=v1', '--untracked-files=no'], { cwd: wt.path })).trim();
    if (head !== sha || dirty) { rec.invalidated = 'integration branch changed after tests'; return { outcome: 'invalidated', reason: rec.invalidated }; }

    // T31: owner approval for this exact sha and target, or refuse.
    const ap = await approvalFor({ action: 'merge', sha, target, repo, task_ids: taskIds() });
    if (!ap.ok) return refuse({ action: 'merge', cls: mergeClass, sha, ref: target, reason: ap.reason, valid, finishItem, integration_id, m, taskIds });
    m.approvals.push({ action: 'merge', sha, target, approval_ref: ap.approval_ref, approved_by: ap.approved_by });

    // CI status rechecked right before the mutation: a status can flip between the gate and now.
    const cs2 = await remoteStatus(ci, sha);
    if (!ciPasses(cs2.status)) { for (const t of taskIds()) await park(t, `remote_ci_${cs2.status}`, { kind: 'ci_status', repo, sha }, { sha, integration_id }); return { outcome: 'ci_blocked', reason: `remote CI ${cs2.status} at merge time`, integration_sha: sha }; }

    const p = await casPush({ cfg, repo, ref: target, sha, expected: targetSha, kind: 'merge', task_ids: taskIds(), scope, fence, effects: m.effects });
    if (p.phase === 'possibly_applied') return uncertain({ valid, finishItem, reason: 'push outcome unknown', sha });
    if (p.phase === 'failed') {
      if (p.moved) { rec.invalidated = 'target moved before push (CAS rejected)'; return { outcome: 'invalidated', reason: rec.invalidated }; }
      for (const t of taskIds()) await park(t, 'push_failed', { kind: 'retry', repo, target }, { sha, error: p.error, integration_id });
      return { outcome: 'blocked', reason: `push failed: ${p.error}`, integration_sha: sha };
    }
    rec.pushed = { ref: `refs/heads/${target}`, sha, uncertain_response: !!p.uncertain_response };
    m.integration_sha = sha;
    m.target_sha_before = targetSha;
    m.remote_target_after = sha;
    for (const it of valid.filter((x) => !x.out)) {
      await moveTask(it.task_id, 'release_verifying', `merged into ${target} as ${sha}`);
      await finishItem(it, 'merged', 'merged', { sha, target_sha_before: targetSha }); it.out = true;
    }
    // Integration worktrees are never removed automatically (coordinator rule); only their lease is released.
    await git(['fetch', '--no-tags', '--quiet', cfg.remote, `+refs/heads/${target}:refs/v2int/target/${target}`], { cwd: cfg.dir }).catch(() => {});
    return { outcome: 'merged', integration_sha: sha, target_sha_before: targetSha };
  }

  async function refuse({ action, cls, sha, ref, reason, valid, finishItem, integration_id, m, taskIds }) {
    const required = { action, class: cls, sha, target: ref };
    m.approvals.push({ ...required, approval_ref: null, refused: reason });
    for (const t of taskIds()) {
      await taskEvent(t, 'approval.requested', { actor, required, refused: true, reason, integration_id });
      await moveTask(t, 'awaiting_approval', `${action} of ${sha} to ${ref} needs owner approval (${cls})`);
    }
    for (const it of valid.filter((x) => !x.out)) { await finishItem(it, 'awaiting_approval', `approval required: ${action} ${cls}`, { sha }); it.out = true; }
    return { outcome: 'awaiting_approval', reason, required, integration_sha: sha };
  }

  async function uncertain({ valid, finishItem, reason, sha }) {
    for (const it of valid.filter((x) => !x.out)) {
      await moveTask(it.task_id, 'unknown_external_effect', reason);
      await finishItem(it, 'unknown', reason, sha ? { sha } : undefined); it.out = true;
    }
    return { outcome: 'unknown_external_effect', reason, integration_sha: sha ?? null };
  }

  return { submit, validateHandoff, runNext, reconcileTask, effectState, remoteHead: (repo, ref) => remoteHead(repoCfg(repo), ref) };
}
