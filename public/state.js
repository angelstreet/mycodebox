// Display state helpers (TASK-44 phase 7): shared by the top-bar summary,
// the status filter, and the per-session badges / sorting.
//
// A session blocked on a deploy shows as 'deploy' (violet) when its status has
// `deployWait`, except when it is already 'waiting' (a live needs-you prompt
// always wins) or 'offline'. Pure: no globals, no DOM, used from app.js and
// unit-tested in test/state.test.js.

export const STATE_RANK = { waiting: 0, deploy: 1, done: 2, working: 3, idle: 4, offline: 5 };
export const STATE_LABEL = { working: 'working', waiting: 'needs you', deploy: 'waiting deploy', done: 'done', idle: 'idle', offline: 'offline' };

// Display state of one session given its raw status row.
export function displayState(status) {
  const s = (status && status.state) || 'offline';
  // 'waiting deploy' (violet) only for a deploy that is really queued or has a waiter in the lease registry; a session that merely
  // SAID it waits for one (a regex on its own text, kind 'said') keeps its real state, so it cannot flip purple <-> red
  const real = status && status.deployWait && status.deployWait.kind !== 'said';
  return real && s !== 'waiting' && s !== 'offline' ? 'deploy' : s;
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