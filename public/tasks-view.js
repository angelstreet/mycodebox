// Tasks view (V2, opt-in): pure HTML builders for the list and the detail of GET /api/v2/tasks. No DOM, no fetch, so the
// rules that matter are unit-testable: only an accepted task is ever labelled "done"; waiting, needs-owner and unknown are
// distinct, and unknown usage is shown as "unknown", never 0.
import { icon } from './icons.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const words = (s) => String(s || '').replace(/_/g, ' ');
const shortSha = (s) => (s ? String(s).slice(0, 12) : 'none');

// -> { cls, label, ico }. `done` is returned only for outcome === 'done' (state accepted); a task whose log could not be
// read, or with an unconfirmed external effect, is `unknown`, whatever else it says.
export function badgeOf(t) {
  if (t.store_error || t.outcome === 'unknown' || t.state === 'unknown_external_effect') return { cls: 'unknown', label: 'unknown', ico: 'help' };
  if (t.outcome === 'done') return { cls: 'done', label: 'done (accepted)', ico: 'check' };
  if (t.outcome === 'needs_owner') return { cls: 'owner', label: 'needs owner', ico: 'alert' };
  if (t.outcome === 'waiting') return { cls: 'wait', label: 'waiting', ico: 'timer' };
  if (t.outcome === 'unrecoverable') return { cls: 'fail', label: 'failed', ico: 'x' };
  if (t.outcome === 'cancelled') return { cls: 'cancel', label: 'cancelled', ico: 'x' };
  return { cls: 'open', label: words(t.state), ico: 'loader' };
}
export const badgeHtml = (t) => { const b = badgeOf(t); return `<span class="tk-badge ${b.cls}">${icon(b.ico, 12)}<span>${esc(b.label)}</span></span>`; };

export const isTerminal = (t) => ['accepted', 'failed_unrecoverable', 'cancelled'].includes(t.state);

const delivLabel = (t) => (t.delivery && t.state === 'accepted' ? t.delivery.label : null);

// The cross-task approval queue: every pending owner request, on top of the list.
export function queueHtml(approvals) {
  if (!approvals?.length) return '';
  return `<section class="tk-queue" aria-label="Needs owner: pending approvals"><h3 class="tk-h">${icon('alert', 14)} Needs owner (${approvals.length})</h3>${approvals.map((a) => `
    <button class="tk-row owner" data-tk-open="${esc(a.task_id)}" data-tk-queue aria-label="${esc(`Pending approval on ${a.task_id}: ${a.question}`)}">
      <span class="tk-goal">${esc(a.question)}</span><span class="tk-next">${esc(a.goal)}</span>
      <span class="tk-when">covers ${a.classes?.length ? esc(a.classes.join(', ')) : 'no action class'} &middot; ${esc(a.task_id)}</span></button>`).join('')}</section>`;
}

export function listHtml(tasks, approvals = []) {
  const q = queueHtml(approvals);
  if (!tasks.length) return `${q}<div class="sheet-empty">no V2 tasks yet. Create one with New task.</div>`;
  return q + tasks.map((t) => `<button class="tk-row ${badgeOf(t).cls}" data-tk-open="${esc(t.task_id)}" aria-label="${esc(`${t.title || t.goal} - ${badgeOf(t).label}${delivLabel(t) ? ` - ${delivLabel(t)}` : ''}`)}">
    <span class="tk-top">${badgeHtml(t)}${delivLabel(t) ? `<span class="tk-deliv">${esc(delivLabel(t))}</span>` : ''}<span class="tk-id">${esc(t.task_id)}</span></span>
    <span class="tk-goal">${esc(t.title || t.goal)}</span>
    <span class="tk-next">next: ${esc(t.next_action ?? 'none (finished)')}</span>
    <span class="tk-when">${esc(t.state)} &middot; updated ${esc(t.updated_at || '?')}</span></button>`).join('');
}

const tokens = (v) => (v === null || v === undefined ? 'unknown' : Number(v).toLocaleString('en-US'));
const usd = (v) => (v === null || v === undefined ? 'unknown' : `$${Number(v).toFixed(4)}`);

const sec = (title, inner) => `<section class="tk-sec"><h3 class="tk-h">${esc(title)}</h3>${inner}</section>`;
const dim = (s) => `<div class="tk-dim">${esc(s)}</div>`;

export function newFormHtml() {
  return `<form class="tk-new" data-tk-form>
    <label class="flab" for="tkGoal">Goal (an outcome you can check)</label>
    <textarea class="sheet-ta" id="tkGoal" name="goal" rows="3" maxlength="4000" required></textarea>
    <label class="flab" for="tkRepo">Repository path <span class="dim">(absolute)</span></label>
    <input class="sheet-in" id="tkRepo" name="repository" autocomplete="off" placeholder="/path/to/repo">
    <label class="flab" for="tkCheck">Acceptance check <span class="dim">(one argument per line; empty = the project's test command)</span></label>
    <textarea class="sheet-ta" id="tkCheck" name="check" rows="2" placeholder="npm&#10;test"></textarea>
    <div class="tk-note">Creating a task records it. Nothing runs until the goal loop is started explicitly.</div>
    <div class="tk-actions"><button class="sbtn primary" type="submit">Create task</button><button class="sbtn" type="button" data-tk-cancel-new>Cancel</button></div>
    <div class="tk-err" data-tk-err role="alert"></div></form>`;
}

export function detailHtml(t) {
  const pa = t.pending_approval;
  const head = `<div class="tk-dhead">${badgeHtml(t)}<span class="tk-id">${esc(t.task_id)}</span></div>
    <div class="tk-goal big">${esc(t.goal)}</div>
    <div class="tk-next"><b>Next action:</b> ${esc(t.next_action ?? 'none (finished)')}</div>
    <div class="tk-when">state ${esc(t.state)} &middot; outcome ${esc(words(t.outcome))} &middot; head ${esc(shortSha(t.head_sha))} &middot; base ${esc(shortSha(t.base_sha))}${t.branch ? ` &middot; branch ${esc(t.branch)}` : ''}</div>${t.state === 'accepted' && t.delivery ? `<div class="tk-deliv">${esc(t.delivery.label)}</div>` : ''}`;
  const approval = pa ? `<section class="tk-sec tk-approval" aria-label="Pending approval"><h3 class="tk-h">${icon('alert', 14)} Approval request</h3>
    <div>${esc(pa.question)}</div>
    <div class="tk-dim">covers: ${pa.classes.length ? esc(pa.classes.join(', ')) : 'no action class'} &middot; head ${esc(shortSha(pa.sha))} &middot; request ${esc(pa.action_id)}</div>
    <div class="tk-actions"><button class="sbtn primary" data-tk-approve data-aid="${esc(pa.action_id)}" data-sha="${esc(pa.sha || '')}">Approve this request</button>
    <button class="sbtn danger" data-tk-deny data-aid="${esc(pa.action_id)}" data-sha="${esc(pa.sha || '')}">Deny</button></div></section>` : '';
  const dod = sec('Definition of done', `<ul class="tk-ul">${t.definition_of_done.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`);
  const checks = sec('Acceptance checks and evidence', t.acceptance_checks.map((c) => {
    const e = c.latest_evidence;
    const stat = { passing_on_head: 'passing on the current head', failing_on_head: 'failing on the current head', stale_sha: 'evidence is for an older SHA', no_evidence: 'no evidence yet' }[c.status];
    return `<div class="tk-check ${esc(c.status)}"><div><b>${esc(c.id)}</b> ${c.required ? '' : '<span class="tk-dim">(optional)</span> '}<code>${esc(c.command.join(' '))}</code></div>
      <div class="tk-dim">${esc(stat)}${e ? ` &middot; sha ${esc(shortSha(e.sha))} &middot; exit ${e.exit === null ? 'unknown' : esc(e.exit)}${e.duration_ms != null ? ` &middot; ${esc(e.duration_ms)} ms` : ''}${e.artifact ? ` &middot; ${esc(e.artifact)}` : ''}` : ''}</div></div>`;
  }).join(''));
  const verdicts = sec('Independent verdicts', t.verdicts.length ? t.verdicts.map((v) => `<div class="tk-check"><b>${esc(v.verdict)}</b> by ${esc(v.actor?.id ?? v.actor)} on ${esc(shortSha(v.sha))}${v.current ? '' : ' (older SHA)'}${v.findings?.length ? `<div class="tk-dim">${esc(v.findings.join('; '))}</div>` : ''}</div>`).join('') : dim('no verdict yet'));
  const decisions = sec('Decisions', t.decisions.length ? t.decisions.map((d) => `<details class="tk-dec"><summary>${esc(d.kind)}: ${esc(d.chosen)}</summary>
    <div><b>Question:</b> ${esc(d.question)}</div><div><b>Rationale:</b> ${esc(d.rationale)}</div>
    <div><b>Evidence:</b> ${esc((d.evidence || []).join('; '))}</div><div class="tk-dim">by ${esc(d.actor?.role ?? '?')} &middot; ${esc(d.ts || '')}${d.alternatives.length ? ` &middot; alternatives: ${esc(d.alternatives.join(' | '))}` : ''}</div></details>`).join('') : dim('no decision recorded'));
  const u = t.usage;
  const usage = sec('Usage and cost', `<div class="tk-usage"><span>input tokens ${esc(tokens(u.input_tokens))}</span><span>output tokens ${esc(tokens(u.output_tokens))}</span><span>cost ${esc(usd(u.usd))}</span></div>
    ${u.incomplete ? dim('partial: the runtime reported incomplete usage, so these totals are a lower bound') : ''}
    ${u.unknown.length ? dim(`unknown fields stay unknown, never 0: ${u.unknown.join(', ')}`) : ''}
    ${u.records.map((r) => `<div class="tk-dim">${esc(r.runtime ?? 'runtime unknown')} / ${esc(r.model ?? 'model unknown')}: in ${esc(tokens(r.input_tokens))}, out ${esc(tokens(r.output_tokens))}, ${esc(usd(r.usd))}${r.incomplete ? ' (partial)' : ''}</div>`).join('')}`);
  const refs = sec('Leases, effects, incidents', `<div class="tk-dim">resources: ${t.leases.resources.length ? esc(t.leases.resources.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join(', ')) : 'none'}</div>
    <div class="tk-dim">effects: ${t.leases.effects.length ? esc(t.leases.effects.map((e) => `${e.kind || e.effect_id} ${e.phase}`).join(', ')) : 'none'}</div>
    <div class="tk-dim">incidents: ${t.incidents.length ? esc(t.incidents.join(', ')) : 'none linked'}</div>`);
  const hist = sec('History', t.history.length ? `<ol class="tk-ol">${t.history.map((h) => `<li>${esc(h.from)} &rarr; ${esc(h.to)}${h.reason ? ` &middot; ${esc(h.reason)}` : ''} <span class="tk-dim">${esc(h.actor ?? '')} ${esc(h.ts || '')}</span></li>`).join('')}</ol>` : dim('no transitions yet'));
  const dl = t.state === 'accepted' && t.delivery ? t.delivery : null;
  const deliv = dl ? sec('Delivery', `<div>${esc(dl.label)}</div>${dl.requested && !dl.integrated ? dim('integration was requested and has not happened') : ''}`) : '';
  const runs = sec('Runs', (t.runs || []).length ? t.runs.map((r) => `<div class="tk-check"><b>${esc(r.role)}</b> ${esc(r.runtime ?? 'runtime unknown')} / ${esc(r.model ?? 'model unknown')}${r.effort ? ` / effort ${esc(r.effort)}` : ''}
    <div class="tk-dim">${esc(r.outcome)} &middot; ${esc(r.started_at || 'start unknown')} &rarr; ${esc(r.ended_at || (r.outcome === 'running' ? 'running' : 'end unknown'))}${r.usage ? ` &middot; in ${esc(tokens(r.usage.input_tokens))}, out ${esc(tokens(r.usage.output_tokens))}, ${esc(usd(r.usage.usd))}${r.usage.incomplete ? ' (partial)' : ''}` : ' &middot; usage unknown'}</div></div>`).join('') : dim('no run recorded yet'));
  const ro = t.roles || { developers: [], reviewers: [] };
  const roles = sec('Roles', `<div class="tk-dim">developer: ${ro.developers.length ? esc(ro.developers.join(', ')) : 'none recorded'}</div><div class="tk-dim">reviewer: ${ro.reviewers.length ? esc(ro.reviewers.join(', ')) : 'none yet'}</div>`);
  const al = t.allowed_actions;
  const allowed = al ? sec('Allowed actions', `<div class="tk-dim">source: ${esc(al.source)}</div>
    <div class="tk-dim">needs owner approval: ${esc(al.approval_required.join(', ') || 'none')}</div>
    <div class="tk-dim">prohibited: ${esc(al.prohibited_actions.join(', ') || 'none listed')}</div>
    <div class="tk-dim">commands: ${al.allowed_commands ? esc(al.allowed_commands.join('; ') || 'none') : 'unknown until a run reads the policy'}</div>
    <div class="tk-dim">paths: ${al.allowed_paths ? esc(al.allowed_paths.join(', ') || 'none') : 'unknown until a run reads the policy'}</div>`) : '';
  const kids = t.children || [];
  const graph = t.parent_task_id || kids.length ? sec('Task graph', `${t.parent_task_id ? `<div class="tk-dim">parent: <button class="sbtn" data-tk-open="${esc(t.parent_task_id)}">${esc(t.parent_task_id)}</button></div>` : ''}${kids.map((c) => `<div class="tk-dim">child: <button class="sbtn" data-tk-open="${esc(c.task_id)}">${esc(c.task_id)}</button> ${esc(c.state)} &middot; ${esc(c.goal)}</div>`).join('')}`) : '';
  const cancel = isTerminal(t) ? '' : `<div class="tk-actions"><button class="sbtn danger" data-tk-cancel data-id="${esc(t.task_id)}">Cancel task</button></div>`;
  return head + approval + dod + checks + verdicts + decisions + runs + roles + allowed + graph + deliv + usage + refs + hist + cancel;
}
