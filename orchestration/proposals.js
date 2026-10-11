// Approval-gated improvement proposals from a V2 scorecard (docs/v2/SCORING.md "Proposals"). generateProposals is pure: it
// reads the scorecard, runs the shadow router on recorded tasks with current vs proposed inputs and returns data.
// recordProposals only records: one informational V2 task per proposal, parked in awaiting_approval with an approval
// request, plus a line in the append-only decision journal. There is no code path here, or anywhere, that applies a
// proposal: approving one records the owner's decision; a person makes any change in a separate, reviewed task.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { dirname, join } from 'node:path';
import { route, DEFAULT_WEIGHTS } from './router.js';
import { RISK_CLASSES } from './task-contract.js';
import { deadControllerIntents, pidAlive } from './goal-loop.js';

export const JOURNAL_SCHEMA = 'mycodebox.v2.journal/1';
export const PROPOSAL_ACTOR = 'v2-score';
// Documented thresholds (SCORING.md). A rule fires only on groups with at least `min_settled` settled tasks.
export const PROPOSAL_THRESHOLDS = Object.freeze({
  min_settled: 5,               // the router's own minimum history
  demote_verified_rate: 0.5,    // below: propose excluding the model from routing
  low_first_pass_rate: 0.5,     // overall below: propose more quality weight
  high_verified_rate: 0.9,      // overall at or above, with first pass >= high_first_pass and known cost: propose more cost weight
  high_first_pass_rate: 0.8,
  weight_step: 0.1,
  defects_per_task: 0.5,        // reviewer rejects per settled task: propose a developer prompt change
  rework_per_task: 1.5,         // repair/replan rounds per settled task: propose a harness change
  interventions_per_task: 1,    // owner approvals + resumes per settled task: propose a policy/harness review
});

const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 12);
const atLeast = (risk, floor) => (RISK_CLASSES.indexOf(risk) >= RISK_CLASSES.indexOf(floor) ? risk : floor);
const round2 = (x) => Math.round(x * 100) / 100;

function normWeights(w) {
  const s = Object.values(w).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, round2(v / s)]));
}

// Routes every recorded task twice (shadow mode: nothing starts) and lists the tasks whose choice differs.
export function shadowDiff(tasks, { registry, now, current = {}, proposed = {} }) {
  const changed = [];
  let evaluated = 0, errors = 0;
  for (const t of tasks) {
    let a, b;
    try {
      a = route(t, { registry, now, mode: 'shadow', history: current.history || {}, weights: current.weights || null, exclude: current.exclude || [] });
      b = route(t, { registry, now, mode: 'shadow', history: proposed.history || {}, weights: proposed.weights || null, exclude: proposed.exclude || [] });
    } catch { errors += 1; continue; }
    evaluated += 1;
    if (a.choice !== b.choice) changed.push({ task_id: t.task_id, current: a.choice ?? 'needs_owner', proposed: b.choice ?? 'needs_owner' });
  }
  return { evaluated, errors, changed };
}

function proposal(kind, { title, rationale, change, evidence_refs, risk_class = 'medium', shadow = null, text = null }) {
  const proposal_id = `${kind}-${hash({ kind, change, text })}`;
  return { proposal_id, kind, title, rationale, change, text, evidence_refs, risk_class: atLeast(risk_class, 'medium'), shadow,
    applies_itself: false, how_to_apply: 'nothing applies this: if the owner approves, a person makes the change in a separate reviewed task' };
}

const refsOf = (sc, pred) => sc.runs.filter((r) => r.settled && pred(r)).map((r) => `task:${r.task_id}`).slice(0, 20);
const isDev = (g) => (r) => `${r.developer.runtime}:${r.developer.model}` === g.key;

// -> { proposals: [...] }. registry: a loaded registry (read only). tasks: recorded task specs (taskSpecsOf).
export function generateProposals(sc, { registry, tasks = [], now = () => Date.now(), currentHistory = {}, currentWeights = null, routerHistory = null, thresholds = PROPOSAL_THRESHOLDS } = {}) {
  const T = { ...PROPOSAL_THRESHOLDS, ...thresholds };
  const out = [];
  const shadow = (proposed) => (registry ? shadowDiff(tasks, { registry, now, current: { history: currentHistory, weights: currentWeights }, proposed: { history: currentHistory, weights: currentWeights, ...proposed } }) : null);
  const big = sc.by_model.filter((g) => g.settled >= T.min_settled && g.runtime !== 'unknown');

  // (i) router history from the scorecard, when it carries a meaningful entry and differs from what is in use.
  const hist = routerHistory || {};
  const meaningful = Object.entries(hist).filter(([, h]) => h.attempts >= T.min_settled);
  if (meaningful.length && JSON.stringify(hist) !== JSON.stringify(currentHistory)) {
    out.push(proposal('router_history', { title: `Use observed history for ${meaningful.length} model(s) in routing`,
      rationale: `The scorecard has at least ${T.min_settled} settled tasks for ${meaningful.map(([k]) => k).join(', ')}; the router would rank them on observed verified rate, errors, latency and cost instead of tier priors.`,
      change: { history: hist }, evidence_refs: meaningful.map(([k]) => `scorecard:by_model:${k}`), shadow: shadow({ history: hist }) }));
  }

  // (i) router weights: two documented rules over all settled tasks.
  const all = sc.by_model.reduce((a, g) => ({ settled: a.settled + g.settled, verified: a.verified + g.verified, fp: a.fp + g.first_pass, unknownCost: a.unknownCost + g.cost.spend_unknown_tasks }), { settled: 0, verified: 0, fp: 0, unknownCost: 0 });
  if (all.settled >= T.min_settled) {
    const base = { ...(currentWeights || DEFAULT_WEIGHTS) };
    const fpRate = all.fp / all.settled, vRate = all.verified / all.settled;
    let w = null, why = null;
    if (fpRate < T.low_first_pass_rate) { w = normWeights({ ...base, quality: base.quality + T.weight_step, cost: Math.max(0, base.cost - T.weight_step) }); why = `first-pass acceptance is ${Math.round(fpRate * 100)}% (< ${T.low_first_pass_rate * 100}%): weight quality more, cost less`; }
    else if (vRate >= T.high_verified_rate && fpRate >= T.high_first_pass_rate && !all.unknownCost) { w = normWeights({ ...base, cost: base.cost + T.weight_step, quality: Math.max(0, base.quality - T.weight_step) }); why = `verified ${Math.round(vRate * 100)}% and first pass ${Math.round(fpRate * 100)}% with known cost: cost can weigh more`; }
    if (w && JSON.stringify(w) !== JSON.stringify(base)) {
      out.push(proposal('router_weights', { title: 'Adjust router weights', rationale: `${why} (over ${all.settled} settled tasks).`, change: { weights: w, from: base },
        evidence_refs: ['scorecard:by_model'], shadow: shadow({ weights: w }) }));
    }
  }

  // (i) model registry: a model that fails most of its settled tasks is proposed for exclusion (evaluated with exclude).
  for (const g of big) {
    if (g.verified_rate === null || g.verified_rate >= T.demote_verified_rate) continue;
    out.push(proposal('model_registry', { title: `Exclude ${g.key} from routing`, risk_class: 'high',
      rationale: `${g.key} verified ${g.verified} of ${g.settled} settled tasks (${Math.round(g.verified_rate * 100)}% < ${T.demote_verified_rate * 100}%).`,
      change: { exclude: [g.key], file: 'orchestration/models.json or the project policy model_allowlist' }, evidence_refs: refsOf(sc, isDev(g)), shadow: shadow({ exclude: [g.key] }) }));
  }

  // (ii) role prompt and harness: text only.
  for (const g of big) {
    const dpt = g.reviewer_defects.caught / g.settled;
    if (dpt >= T.defects_per_task) {
      out.push(proposal('role_prompt', { title: `Developer prompt: self-review before handing ${g.key} work to the reviewer`,
        rationale: `The independent reviewer rejected ${g.key} work ${g.reviewer_defects.caught} time(s) over ${g.settled} settled tasks (${round2(dpt)} per task).`,
        text: 'Add to developerPrompt (orchestration/roles.js): before finishing, re-read the goal and definition of done, run the acceptance checks, and list how each reviewer finding category from earlier rejects is addressed.',
        change: { file: 'orchestration/roles.js', role: 'developer', model: g.key }, evidence_refs: refsOf(sc, (r) => isDev(g)(r) && r.reviewer_defects.caught > 0) }));
    }
    const rpt = g.rework.per_settled_task;
    if (rpt !== null && rpt >= T.rework_per_task) {
      out.push(proposal('harness', { title: `Harness: focused repair strategy for ${g.key}`,
        rationale: `${g.key} needed ${g.rework.rounds} repair/replan rounds over ${g.settled} settled tasks (${round2(rpt)} per task).`,
        text: 'Start repairs for this model with the focused harness (larger structured feedback, failing tests first) and ask for a plan before the first edit.',
        change: { file: 'orchestration/goal-loop.js strategy selection', model: g.key }, evidence_refs: refsOf(sc, (r) => isDev(g)(r) && r.rework_rounds > 0) }));
    }
    const ipt = g.owner_interventions.per_settled_task;
    if (ipt !== null && ipt >= T.interventions_per_task) {
      out.push(proposal('harness', { title: `Review owner approvals hit by ${g.key} tasks`,
        rationale: `${g.key} tasks needed ${g.owner_interventions.interventions} owner interventions over ${g.settled} settled tasks (${round2(ipt)} per task).`,
        text: 'Review which approval classes these tasks hit; if they are routine for the project, the owner may widen the project policy allowlist in a reviewed change. Mandatory classes stay mandatory.',
        change: { file: 'project policy (owner-edited)', model: g.key }, evidence_refs: refsOf(sc, (r) => isDev(g)(r) && r.owner.interventions > 0) }));
    }
  }
  return { proposals: out };
}

// Live goal-loop controllers on this store (D-016 intent files): a writer outside the controller must not race one.
export function liveControllers(storeDir, { now = Date.now(), hostname = osHostname(), isAlive = pidAlive, heartbeatMs = 20_000 } = {}) {
  let names = [];
  try { names = readdirSync(storeDir).filter((f) => /^controller\..+\.intent\.json$/.test(f)); } catch { return []; }
  const intents = names.flatMap((f) => { try { return [JSON.parse(readFileSync(join(storeDir, f), 'utf8'))]; } catch { return []; } });
  const dead = new Set(deadControllerIntents(intents, { hostname, isAlive, now, heartbeatMs }));
  return intents.filter((x) => !dead.has(x));
}

const journaled = (path) => {
  if (!existsSync(path)) return new Set();
  return new Set(readFileSync(path, 'utf8').split('\n').flatMap((l) => { try { const j = JSON.parse(l); return j?.kind === 'proposal.recorded' ? [j.proposal_id] : []; } catch { return []; } }));
};

// Records each proposal as an informational V2 task in awaiting_approval with a pending approval request, and journals
// it. Idempotent: the same proposal maps to the same task id, idempotency key and event ids; a replay journals nothing.
// Refuses (E_CONTROLLER_LIVE) while a goal-loop controller is alive on the store; a running server also caches the store in
// memory, so record into a stopped server's store or a copy (SCORING.md).
export async function recordProposals(proposals, { store, intake, base_sha, project_id, journalPath = join(store.dir, 'journal.jsonl'), now = () => Date.now(), actor_id = PROPOSAL_ACTOR, controllers = liveControllers }) {
  if (!store || !intake) throw new Error('recordProposals: store and intake required');
  const live = controllers(store.dir);
  if (live.length) throw Object.assign(new Error(`a goal-loop controller is live on this store (pid ${live.map((x) => x.pid).join(', ')}): stop it or record into a copy`), { code: 'E_CONTROLLER_LIVE' });
  const out = [];
  const inJournal = journaled(journalPath);
  for (const p of proposals) {
    const task_id = `proposal-${p.proposal_id}`.slice(0, 128);
    const journaledBefore = inJournal.has(p.proposal_id);   // the journal decides: a crash after createTask still journals on replay
    const summary = JSON.stringify({ rationale: p.rationale, change: p.change, text: p.text, shadow: p.shadow && { evaluated: p.shadow.evaluated, changed: p.shadow.changed.length } });
    const { task } = await intake.createTask({
      task_id, title: p.title.slice(0, 200), project_id, base_sha, risk_class: atLeast(p.risk_class, 'medium'),
      goal: `Owner decision on a scoring proposal (${p.kind}): ${p.title}. Approving records the decision only; nothing is applied by it.`,
      scope: 'proposal record only; no file, registry, router or policy is changed by recording or approving it',
      acceptance_checks: [{ id: 'owner-review', command: ['node', 'scripts/v2-score.js', '--scorecard'], expect: { exit: 0 }, evidence_type: 'exit_code', required: true }],
      context_summary: summary.slice(0, 4000), handoff_refs: p.evidence_refs.map(String).slice(0, 50),
    }, { source: 'agent', actor_id, idempotencyKey: `proposal:${p.proposal_id}`, template: 'informational' });
    if (task.status === 'created') {
      const req = { k: 0, kind: 'proposal', question: `Approve scoring proposal: ${p.title}?`, classes: [], keys: [`proposal:${p.proposal_id}`], resume_to: null };
      await store.recordDecision(task_id, { decision_id: `proposal-${p.proposal_id}`, kind: 'proposal', question: 'Should this scoring proposal be adopted?',
        alternatives: [{ option: 'ask the owner', pros: ['nothing changes without an explicit decision'], cons: ['waits for the owner'] },
          { option: 'apply automatically', pros: ['faster'], cons: ['not allowed: proposals never apply themselves'] }],
        chosen: 'ask the owner', evidence: p.evidence_refs.length ? p.evidence_refs.map(String) : ['scorecard'], expected_effect: 'awaiting_approval until the owner approves or denies',
        rationale: p.rationale, actor: { role: 'scorer', runtime: null, model: null }, confidence: null, reversible: true,
        rollback: 'deny the request or cancel the task; nothing was applied', loop: { k: 0, patch: { approval: req } } });
      await store.append(task_id, { event_id: `appr-req-${task_id}-0`, kind: 'approval.requested', payload: req });
      await store.transition(task_id, 'awaiting_approval', { reason: req.question, actor: actor_id, event_id: `proposal-${task_id}-to-awaiting_approval` });
    }
    if (!journaledBefore) {
      mkdirSync(dirname(journalPath), { recursive: true });
      appendFileSync(journalPath, `${JSON.stringify({ schema: JOURNAL_SCHEMA, ts: new Date(now()).toISOString(), kind: 'proposal.recorded', proposal_id: p.proposal_id,
        proposal_kind: p.kind, task_id, title: p.title, rationale: p.rationale, evidence_refs: p.evidence_refs, change: p.change, text: p.text,
        shadow: p.shadow && { evaluated: p.shadow.evaluated, errors: p.shadow.errors, changed: p.shadow.changed }, applied: false })}\n`, { flag: 'a' });
    }
    out.push({ proposal_id: p.proposal_id, task_id, created: !journaledBefore });
  }
  return out;
}
