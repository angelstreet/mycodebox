// Display state helpers (TASK-44 phase 7): shared by the top-bar summary,
// the status filter, and the per-session badges / sorting.
//
// A session blocked on a deploy shows as 'deploy' (violet) when its status has
// `deployWait`, except when it is already 'waiting' (a live needs-you prompt
// always wins) or 'offline'. Pure: no globals, no DOM, used from app.js and
// unit-tested in test/state.test.js.

export const STATE_RANK = { waiting: 0, manager: 1, deploy: 2, done: 3, working: 4, idle: 5, offline: 6 };
export const STATE_LABEL = { working: 'working', waiting: 'needs you', manager: 'manager', deploy: 'waiting deploy', done: 'done', idle: 'idle', offline: 'offline' };

// True when the turn ended but the session still has work coming:
//  - Claude's Stop hook reported background tasks or scheduled crons (status.reporter),
//  - the manager's own background_wait classification, or
//  - the pane footer shows an mcode/Codex background marker (status.paneBackground), or
//  - a script is still driving a `claude -p` / `sleep` child in the pane (status.scriptBusy).
// Display only: status.state is left untouched so the manager / auto-answer logic is unaffected.
// "STATUS: waiting: <its own test run>" asks the owner nothing (waiting for me is green/red, never this): a plain waiting line that names
// no deploy and no owner word is the session's own job, so it reads as working.
const OWNER_WORDS = /\b(?:you|your|owner|approval|approve|decision|decide|go-ahead|answer|permission|input|review|confirm|sign[- ]?off|credentials?|token)\b|\?/i;
const isOwnWait = (stall) => stall.status === 'waiting' && stall.case === 'waiting_deploy' && !stall.deployHint?.id && !OWNER_WORDS.test(stall.question || '');

export function isLoopWaiting(status) {
  if (!status) return false;
  const r = status.reporter;
  return !!(
    (r && (r.backgroundWork > 0 || r.crons > 0)) ||
    (status.stall && (status.stall.case === 'background_wait' || status.stall.case === 'own_job_wait' || isOwnWait(status.stall))) ||
    status.paneBackground ||
    status.scriptBusy
  );
}

// Display state of one session given its raw status row.
export function displayState(status) {
  let s = (status && status.state) || 'offline';
  // "STATUS: needs-manager: <what the manager must do>": the turn is finished but the next step belongs to the AI manager,
  // so it reads as 'manager' (its own LED) instead of the blue 'done'. A live 'waiting' prompt and 'offline' still win.
  if (s !== 'waiting' && s !== 'offline' && status && status.stall && status.stall.case === 'needs_manager') s = 'manager';
  // A finished turn that still waits on a scheduled wakeup (/loop, ScheduleWakeup) or on background tasks is not "done": it shows as working (green)
  if (s === 'done' && isLoopWaiting(status)) s = 'working';
  // A script-wrapped `claude -p` / `sleep` child in the pane means the pane is still doing work, even when the raw
  // state classifier marked it idle. The reporter / paneBackground signals keep the old "idle stays idle" rule
  // (a finished turn waiting on a cron is still not actively working).
  else if (s === 'idle' && status && status.scriptBusy) s = 'working';
  // 'waiting deploy' (violet) only for a deploy that is really queued or has a waiter in the lease registry; a session that merely
  // SAID it waits for one (a regex on its own text, kind 'said') keeps its real state, so it cannot flip purple <-> red
  const real = status && status.deployWait && status.deployWait.kind !== 'said';
  return real && s !== 'waiting' && s !== 'offline' && s !== 'manager' ? 'deploy' : s;
}

// Convenience wrapper used by the page: name + status map -> display state.
export function displayStateOf(name, statusMap) {
  return displayState(statusMap && statusMap[name]);
}

// Push-feed predicate for the bell's unread badge. Routine items stay visible in the panel but don't
// inflate the count: a deploy that simply started or finished is noise; failed/skipped/orphaned deploys,
// approval requests, and non-deploy items (asks, credits, quota, disk, ...) still count. Pure helper used
// from app.js (badge + muted style) and unit-tested in test/state.test.js.
export function isRoutineAlert(item) {
  if (!item || typeof item !== 'object') return false;
  const tag = typeof item.tag === 'string' ? item.tag : '';
  const title = typeof item.title === 'string' ? item.title : '';
  if (!tag.startsWith('ghosty-deploy-')) return false;
  // Real titles: "deploy <env> <scope> started" or "... done", optionally "done (<version>)"; a ", N host(s) skipped" suffix makes it count.
  return /\b(started|done( \([^)]*\))?)$/.test(title);
}