// Integration lane outcomes (round 13, brief B): the texts, and the `notify(request, event)` the lane calls on every transition.
// A final state becomes (1) a feed notice (kind 'integration'), (2) a manager event, (3) one line typed into the requesting codebox session when it is
// stopped (done, no draft, no menu) through the guarded send (by 'integration'). A mac: session gets (1) and (2) only: the Mac hook channel answers stops.
// The same text wakes a session whose STATUS names the request (own-jobs.js), so the two paths never disagree.
//
// request (lane): { id, repo, branch, target, session, deployScope, deployed { id, version, env, scope }, state, sha, reason, tail,
//                    endedAt (ISO, on final), createdAt/startedAt/updatedAt (ISO), live { step, tail } (while running) };
// the session side reads different names — `normRequest(r)` maps the lane shape onto the names below.
export const FINAL_STATES = ['merged', 'deployed', 'returned', 'merged_ci_red', 'deploy_failed', 'cancelled'];
export const isFinal = (state) => FINAL_STATES.includes(state);

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const sha12 = (sha) => String(sha || '').slice(0, 12);
const toMs = (s) => { const n = Date.parse(String(s || '')); return Number.isFinite(n) ? n : null; };
// the first lines of the failing output: a few non-empty lines, bounded
export function tailLines(tail, { lines = 5, chars = 500 } = {}) {
  const t = (Array.isArray(tail) ? tail.join('\n') : String(tail ?? '')).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).slice(0, lines).join('\n');
  return t.length > chars ? `${t.slice(0, chars - 1)}…` : t;
}
const where = (r) => `${one(r.branch) || '?'} into ${one(r.target) || 'the target'}${r.sha ? ` at ${sha12(r.sha)}` : ''}`;

// The lane stores some fields under one name and the session side reads them under another (round 13 brief B review).
// Map the lane shape onto the names the session / own-jobs / view expect; do not overwrite a value the caller already set.
export function normRequest(r) {
  if (!r || typeof r !== 'object') return r;
  const out = { ...r };
  // deploy scope: the lane stores `deployScope` (and clears `deploy`); the session reads `deploy`.
  if (out.deploy == null) out.deploy = out.deployScope ?? null;
  // deployed version / env: only set when the deploy actually completed (the lane sets `deployed = { id, version, env, scope }`).
  if (out.version == null) out.version = out.deployed?.version ?? null;
  if (out.env == null) out.env = out.deployed?.env ?? null;
  // finishedAt: number (ms) when endedAt is set, otherwise null — the view / own-jobs read it as a number or null.
  out.finishedAt = out.finishedAt == null ? (out.endedAt ? toMs(out.endedAt) : null) : out.finishedAt;
  // timestamps: ISO -> ms (numbers, so fmtAgo and sort compare).
  for (const k of ['createdAt', 'startedAt', 'updatedAt']) {
    if (typeof out[k] === 'string') out[k] = toMs(out[k]);
  }
  // live output: `r.tail` is '' while running; the running step's output lives in `r.live.tail`.
  if (out.state === 'running' && out.live && typeof out.live.tail === 'string') out.tail = out.live.tail;
  return out;
}

// -> the line for the session (and the own-job wake), or null when the state is not final
export function integrationText(r) {
  if (!r || !isFinal(r.state)) return null;
  const n = normRequest(r);
  const id = one(n.id);
  const reason = one(n.reason) || 'no reason recorded';
  const rollback = n.rollback ? ` Rollback: ${one(n.rollback)}` : '';
  const sd = n.selfDeploy && typeof n.selfDeploy === 'object' ? n.selfDeploy : null;
  switch (n.state) {
    case 'merged': return `Integration ${id}: merged ${where(n)}.`;
    case 'deployed': if (sd) return `Integration ${id}: merged ${where(n)}, deployed live ghosty at ${sha12(sd.newSha)} (was ${sha12(sd.prevSha)}).${rollback}`;
      return `Integration ${id}: merged ${where(n)}, deployed ${one(n.version) || 'the new version'} to ${one(n.env) || 'the environment'}.`;
    case 'returned': {
      const t = tailLines(n.tail);
      return `Integration ${id} returned: ${reason.replace(/[.\s]+$/, '')}. Fix it on your branch and run integrate request again.${t ? `\n${t}` : ''}`;
    }
    case 'merged_ci_red': return `Integration ${id}: merged ${where(n)} but CI is red (${reason.replace(/[.\s]+$/, '')}). The merge stays on ${one(n.target) || 'the target'}; the manager decides, do not revert it yourself.`;
    case 'deploy_failed': return `Integration ${id}: merged ${where(n)} but the ${sd ? 'live ghosty ' : ''}deploy failed (${reason.replace(/[.\s]+$/, '')}). The manager decides what happens next.${rollback}`;
    case 'cancelled': return `Integration ${id} cancelled.`;
    default: return null;
  }
}

// the title / body / priority of the feed notice and the manager event
export function integrationNotice(r) {
  const n = normRequest(r);
  const id = one(n.id), what = `${one(n.branch) || '?'} -> ${one(n.target) || '?'}`;
  const title = {
    merged: `Integration ${id} merged: ${what}`, deployed: `Integration ${id} deployed: ${what}`, returned: `Integration ${id} returned: ${what}`,
    merged_ci_red: `Integration ${id} merged, CI red: ${what}`, deploy_failed: `Integration ${id} merged, deploy failed: ${what}`, cancelled: `Integration ${id} cancelled: ${what}`,
  }[n.state] || `Integration ${id}: ${n.state}`;
  const t = n.state === 'returned' ? tailLines(n.tail, { lines: 3, chars: 240 }) : '';
  const body = [integrationText(r)?.split('\n')[0], t].filter(Boolean).join('\n').slice(0, 600);
  return { title: title.slice(0, 160), body, priority: n.state === 'merged_ci_red' || n.state === 'deploy_failed' ? 'high' : 'default' };
}

// deps: { status: (session) => { state, stall } | undefined, isRemote: (session) => bool, canSend: (status) => bool, send: (session, text) => Promise,
//         feed: (item) => void, managerEvent: (event) => Promise, afterSend: (session, request) => void, log }
export function createIntegrationNotify({ status = () => undefined, isRemote = () => false, canSend = () => false, send = async () => {}, feed = () => {}, managerEvent = async () => {}, afterSend = () => {}, log = () => {} } = {}) {
  const done = new Set();   // `${id}:${state}`: a transition is told once per process
  return async function notify(request, event = {}) {
    try {
      if (!request || !isFinal(request.state)) return { told: false };
      const key = `${request.id}:${request.state}`;
      if (done.has(key)) return { told: false, dup: true };
      done.add(key);
      if (done.size > 2000) done.delete(done.values().next().value);
      const session = request.session ? String(request.session) : '';
      const n = integrationNotice(request);
      const url = session ? `/?s=${encodeURIComponent(session)}` : '/?integration=1';
      try { feed({ title: n.title, body: n.body, url: '/?integration=1', tag: `integration-${request.id}`, priority: n.priority, kind: 'integration' }); } catch (e) { log({ type: 'integration_feed_failed', id: request.id, error: e.message }); }
      await Promise.resolve(managerEvent({ key: `integration:${request.id}:${request.state}`, title: n.title, body: n.body, url, priority: n.priority, ...(session ? { session } : {}) })).catch((e) => log({ type: 'integration_event_failed', id: request.id, error: e.message }));
      let sent = false, why = 'no session';
      if (request.state === 'cancelled') why = 'cancelled (the session asked for it)';
      else if (session) {
        if (isRemote(session)) why = 'remote session (feed and manager only)';
        else {
          const st = status(session);
          if (!st) why = 'session not listed';
          else if (!canSend(st)) why = 'session not stopped (own-job wake or the next stop covers it)';
          else {
            await send(session, integrationText(request));
            sent = true; why = 'sent';
            try { afterSend(session, request); } catch { /* best effort */ }
          }
        }
      }
      log({ type: 'integration_notify', id: request.id, state: request.state, session: session || null, sent, why, event: event?.kind || null });
      return { told: true, sent, why };
    } catch (e) {
      log({ type: 'integration_notify_failed', id: request?.id, error: String(e?.message || e).slice(0, 200) });
      return { told: false, error: e.message };
    }
  };
}
