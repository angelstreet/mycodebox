// Integration lane outcomes (round 13, brief B): the texts, and the `notify(request, event)` the lane calls on every transition.
// A final state becomes (1) a feed notice (kind 'integration'), (2) a manager event, (3) one line typed into the requesting codebox session when it is
// stopped (done, no draft, no menu) through the guarded send (by 'integration'). A mac: session gets (1) and (2) only: the Mac hook channel answers stops.
// The same text wakes a session whose STATUS names the request (own-jobs.js), so the two paths never disagree.
//
// request (lane): { id, repo, branch, target, session, state, sha, reason, tail, version, env, deploy }; unknown fields are ignored.
export const FINAL_STATES = ['merged', 'deployed', 'returned', 'merged_ci_red', 'deploy_failed', 'cancelled'];
export const isFinal = (state) => FINAL_STATES.includes(state);

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const sha12 = (sha) => String(sha || '').slice(0, 12);
// the first lines of the failing output: a few non-empty lines, bounded
export function tailLines(tail, { lines = 5, chars = 500 } = {}) {
  const t = (Array.isArray(tail) ? tail.join('\n') : String(tail ?? '')).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).slice(0, lines).join('\n');
  return t.length > chars ? `${t.slice(0, chars - 1)}…` : t;
}
const where = (r) => `${one(r.branch) || '?'} into ${one(r.target) || 'the target'}${r.sha ? ` at ${sha12(r.sha)}` : ''}`;

// -> the line for the session (and the own-job wake), or null when the state is not final
export function integrationText(r) {
  if (!r || !isFinal(r.state)) return null;
  const id = one(r.id);
  const reason = one(r.reason) || 'no reason recorded';
  switch (r.state) {
    case 'merged': return `Integration ${id}: merged ${where(r)}.`;
    case 'deployed': return `Integration ${id}: merged ${where(r)}, deployed ${one(r.version) || 'the new version'} to ${one(r.env) || 'the environment'}.`;
    case 'returned': {
      const t = tailLines(r.tail);
      return `Integration ${id} returned: ${reason.replace(/[.\s]+$/, '')}. Fix it on your branch and run integrate request again.${t ? `\n${t}` : ''}`;
    }
    case 'merged_ci_red': return `Integration ${id}: merged ${where(r)} but CI is red (${reason.replace(/[.\s]+$/, '')}). The merge stays on ${one(r.target) || 'the target'}; the manager decides, do not revert it yourself.`;
    case 'deploy_failed': return `Integration ${id}: merged ${where(r)} but the deploy failed (${reason.replace(/[.\s]+$/, '')}). The manager decides what happens next.`;
    case 'cancelled': return `Integration ${id} cancelled.`;
    default: return null;
  }
}

// the title / body / priority of the feed notice and the manager event
export function integrationNotice(r) {
  const id = one(r.id), what = `${one(r.branch) || '?'} -> ${one(r.target) || '?'}`;
  const title = {
    merged: `Integration ${id} merged: ${what}`, deployed: `Integration ${id} deployed: ${what}`, returned: `Integration ${id} returned: ${what}`,
    merged_ci_red: `Integration ${id} merged, CI red: ${what}`, deploy_failed: `Integration ${id} merged, deploy failed: ${what}`, cancelled: `Integration ${id} cancelled: ${what}`,
  }[r.state] || `Integration ${id}: ${r.state}`;
  const t = r.state === 'returned' ? tailLines(r.tail, { lines: 3, chars: 240 }) : '';
  const body = [integrationText(r)?.split('\n')[0], t].filter(Boolean).join('\n').slice(0, 600);
  return { title: title.slice(0, 160), body, priority: r.state === 'merged_ci_red' || r.state === 'deploy_failed' ? 'high' : 'default' };
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
      log({ type: 'integration_notify', id: request.id, state: request.state, session: session || null, sent, why, event: event?.type || null });
      return { told: true, sent, why };
    } catch (e) {
      log({ type: 'integration_notify_failed', id: request?.id, error: String(e?.message || e).slice(0, 200) });
      return { told: false, error: e.message };
    }
  };
}
