// Provider-neutral role profiles and prompt templates (GOAL_LOOP_CONTRACT "Role delegation and ownership").
// A role is a logical duty, never a model: the router picks the runtime/model, the goal loop enforces the allowed
// actions. Prompts carry the goal contract and structured feedback only; they never grant a permission.

const freeze = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.freeze({ id: k, ...v,
  allowed_actions: Object.freeze([...v.allowed_actions]), forbidden_actions: Object.freeze([...v.forbidden_actions]) })])));

// Classes the goal loop never lets a role perform on its own; approval_policy can only add to these.
const NEVER = ['merge_protected', 'push_shared', 'deploy', 'credentials', 'destructive', 'host_maintenance', 'money', 'customer'];

export const ROLES = freeze({
  manager: { description: 'Deterministic state machine: selects and supervises runs; LLM consultants recommend only.',
    writes: 'task_store', allowed_actions: ['read', 'inspect', 'route', 'dispatch', 'cancel', 'record_decision'], forbidden_actions: NEVER },
  planner: { description: 'Drafts the approach, task graph and tests; no writes to shared branches.',
    writes: 'none', allowed_actions: ['read', 'inspect', 'propose_plan'], forbidden_actions: [...NEVER, 'edit'] },
  developer: { description: 'Implements in its own isolated worktree within scope; hands off a commit SHA, never merges.',
    writes: 'task_worktree', allowed_actions: ['read', 'inspect', 'edit', 'test'], forbidden_actions: NEVER },
  tester: { description: 'Independent tester/verifier: runs deterministic checks and reviews evidence in its own checkout.',
    writes: 'none', allowed_actions: ['read', 'inspect', 'test', 'review'], forbidden_actions: [...NEVER, 'edit'] },
  security: { description: 'Reviews elevated-risk changes and release gates.',
    writes: 'none', allowed_actions: ['read', 'inspect', 'review'], forbidden_actions: [...NEVER, 'edit'] },
  integration: { description: 'Owns the integration lease, assembled commit and full gates; merges/pushes only with approval.',
    writes: 'integration_worktree', allowed_actions: ['read', 'inspect', 'test', 'integrate'], forbidden_actions: NEVER.filter((c) => !['merge_protected', 'push_shared'].includes(c)) },
  'system-operations': { description: 'Owns resource/service incidents; only preauthorized reversible recovery.',
    writes: 'none', allowed_actions: ['read', 'inspect', 'pause_admission', 'throttle_concurrency', 'request_safe_restart'], forbidden_actions: NEVER },
});
// The verifier is the tester role under its contract name.
export const roleOf = (id) => ROLES[id === 'verifier' ? 'tester' : id] || null;
export const mayPerform = (role, cls) => { const r = roleOf(role); return !!r && r.allowed_actions.includes(cls) && !r.forbidden_actions.includes(cls); };

// Reviewer rubric: each item is judged against the original requirements and the recorded evidence, not the
// maker's description. Prose findings are advisory; only the deterministic checks count as tests.
export const REVIEW_RUBRIC = Object.freeze([
  { id: 'meets_goal', text: 'The diff achieves the stated goal and every definition_of_done item, not just the tests.' },
  { id: 'no_test_gaming', text: 'Tests were not weakened, skipped, special-cased or hard-coded to pass.' },
  { id: 'in_scope', text: 'Changes stay inside the scope; nothing touches excluded paths or prohibited actions.' },
  { id: 'evidence_matches', text: 'The passing evidence is on this exact SHA and covers the acceptance checks.' },
  { id: 'safe', text: 'No secrets, permission changes, destructive operations or external effects were introduced.' },
]);

const list = (xs) => (xs?.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');
const scopeText = (s) => (typeof s === 'string' ? s : JSON.stringify(s));
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}\n[... ${t.length - n} more chars truncated]` : t; };

function contractBlock(task) {
  return [
    `GOAL: ${task.goal}`,
    `SCOPE: ${scopeText(task.scope)}`,
    `DEFINITION OF DONE:\n${list(task.definition_of_done)}`,
    `ACCEPTANCE CHECKS (run by the controller on your committed SHA, not by your say-so):\n${list((task.acceptance_checks || []).map((c) => `${c.id}: ${c.command.join(' ')} -> exit ${c.expect.exit}${c.required ? ' (required)' : ''}`))}`,
    `PROHIBITED ACTIONS (never do these; ask instead):\n${list([...(task.prohibited_actions || []), ...(task.approval_policy?.requires || []).map((c) => `${c} (needs owner approval)`)])}`,
    `EXCLUDED PATHS:\n${list(task.excluded_paths)}`,
  ].join('\n\n');
}

// feedback: { kind, signature, checks: [{ check_id, exit, failures: [{ test, error_class, message }], output_tail }],
//             findings: [{ id, message }], note } from the previous iteration, or null on the first run.
export function developerPrompt({ task, strategy = {}, feedback = null, summary = null, worktree = null }) {
  const parts = [
    'ROLE: developer. You work only inside the current directory (your isolated task worktree). Edit files to reach the goal.',
    'Do not merge, push, deploy, delete outside the worktree, touch credentials or change permissions. If such an action seems',
    'necessary, stop and describe it; the controller will ask the owner. The controller commits your changes and verifies them.',
    contractBlock(task),
  ];
  if (worktree) parts.push(`WORKTREE: branch ${worktree.branch}`);
  if (strategy.plan_rev > 0) parts.push(`PLAN REVISION ${strategy.plan_rev}: the previous approach did not converge. Choose a different approach; do not repeat the last change.`);
  if (strategy.harness === 'focused') parts.push('HARNESS: focused. First reproduce the failing check with the smallest test, then fix the cause. Full failing output is included below.');
  if (strategy.compact && summary) parts.push(`CONTEXT SUMMARY (fresh run, earlier context compacted):\n${clip(summary, 4000)}`);
  if (feedback) parts.push(`STRUCTURED FEEDBACK FROM THE LAST ITERATION (fix the cause, not the symptom):\n${clip(JSON.stringify(feedback, null, 1), strategy.harness === 'focused' ? 16000 : 6000)}`);
  return parts.join('\n\n');
}

// The reviewer answers with one JSON object; anything else is treated as "evaluator unavailable", never as approval.
export function reviewerPrompt({ task, sha, diff, evidence = [], rubric = REVIEW_RUBRIC, role = 'reviewer', strict = false }) {
  return [
    role === 'security'
      ? 'ROLE: independent security reviewer. You did not write this change. Review it for secrets, permission changes, destructive or external effects and scope violations.'
      : 'ROLE: independent reviewer. You did not write this change. Review the diff and evidence against the original requirements.',
    'You may not edit files. Your verdict is advisory evidence; the deterministic checks are the tests.',
    contractBlock(task),
    `CANDIDATE SHA: ${sha}`,
    `EVIDENCE ON THIS SHA:\n${list(evidence.map((e) => `${e.check_id}: exit ${e.exit === null ? 'unknown' : e.exit} (${e.command.join(' ')})`))}`,
    EVIDENCE_NOTE,
    `RUBRIC:\n${list(rubric.map((r) => `${r.id}: ${r.text}`))}`,
    `DIFF (base..candidate):\n${clip(diff, 20000)}`,
    'ANSWER with exactly one JSON object on the last line: {"verdict":"approve"|"reject","findings":[{"id":"<rubric id>","severity":"blocker"|"minor","message":"..."}]}',
    ...(strict ? ['STRICT FORMAT: earlier answers had no parseable verdict. Output ONLY that JSON object, nothing else. A reject needs at least one finding.'] : []),
  ].join('\n\n');
}

// Reviewer sandboxes may refuse the child processes the checks need (e.g. codex read-only: spawn EPERM, lost output).
export const EVIDENCE_NOTE = 'The exits above were recorded by the controller running each check on this exact SHA outside your sandbox. '
  + 'You may re-run checks to inspect, but a check that cannot run in your sandbox (spawn refused, no output, or "check error ... Not a test result") '
  + 'is not evidence against the change: judge evidence_matches on the recorded exits and the diff. A real test failure you reproduce is still evidence. '
  + 'A passing recorded exit does not make a change legitimate: still reject diffs that special-case tests, weaken or bypass checks, or tamper with assert/test machinery.';

// Last JSON object in the run's text/result events carrying a valid verdict, else null (= unavailable).
export function parseReviewerVerdict(events = []) {
  const texts = events.filter((e) => typeof e?.text === 'string' && ['text', 'result'].includes(e.type)).map((e) => e.text);
  for (const t of texts.reverse()) {
    const lines = t.trim().split('\n').reverse();
    for (const l of [t.trim(), ...lines]) {
      if (!l.trim().startsWith('{')) continue;
      try {
        const v = JSON.parse(l.trim());
        if (!['approve', 'reject'].includes(v?.verdict) || !Array.isArray(v.findings)) continue;
        const findings = v.findings.filter((f) => f && typeof f === 'object').map((f) => ({
          id: String(f.id ?? 'unspecified').slice(0, 64), severity: f.severity === 'minor' ? 'minor' : 'blocker', message: String(f.message ?? '').slice(0, 2000) }));
        // A reject without a finding cannot be acted on; an approve listing blockers contradicts itself. Both: unavailable.
        if (v.verdict === 'reject' && !findings.length) continue;
        if (v.verdict === 'approve' && findings.some((f) => f.severity === 'blocker')) continue;
        return { verdict: v.verdict, findings };
      } catch { /* not JSON, keep looking */ }
    }
  }
  return null;
}
