// The manager moves to another Claude account (owner 2026-11-26). It is never parked like a worker (claudeLimitTick): its state is
// in files, so it is restarted fresh through scripts/manager-fresh.sh, on a usage-limit stop, or while idle on an account at the
// exhaustion threshold. No account free: the owner is alerted with the next reset, and the move happens by itself once one frees up.
import { hasLogin, nextReset, DEFAULT_ID } from './claude-accounts.js';

export const RETRY_MS = 10 * 60e3;        // after a restart (done or failed): time for the new pane to show up
export const BUSY_RETRY_MS = 60e3;        // manager-fresh found it not idle (exit 3, nothing touched)
const NOT_IDLE_EXIT = 3;
const IDLE = ['done', 'idle', 'waiting'];

export const parisTime = (ms) => (ms ? `${new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/Paris', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} Paris` : 'unknown');

// restart(session, env) -> exit code of manager-fresh.sh. alert(key, {title, body}). record(event) = manager event / feed line.
export function createManagerRotation({ accounts, restart, alert, record = async () => {}, refresh = () => accounts.refresh(), loggedIn = hasLogin, now = Date.now, log = console.error }) {
  const marked = new Map();     // session -> account whose stop on screen is already marked
  const nextTry = new Map();    // session -> ms
  const running = new Map();    // session -> the restart in flight
  const told = new Map();       // session -> the "no account" alert already sent

  // One poll of one manager pane. row: its board status; limitStop: the pane shows a usage-limit stop.
  async function tick(session, row, { limitStop = false, paused = false } = {}) {
    if (!limitStop) marked.delete(session);
    if (running.has(session)) return { action: 'running' };
    const from = row.claudeAccount;
    if (!from) return { action: 'none' };   // no claude process: manager-watch.sh relaunches a dead manager
    if (limitStop && marked.get(session) !== from) {
      marked.set(session, from);
      await accounts.markExhausted(from, { reason: `usage limit stop in ${session}`, confirmed: true });
      await refresh();
    }
    const view = accounts.view();
    const of = (id) => view.accounts.find((a) => a.id === id);
    if (!limitStop && !of(from)?.exhausted) { told.delete(session); return { action: 'none' }; }
    if (!limitStop && !(IDLE.includes(row.state) && !row.stall?.draft)) return { action: 'busy' };
    const label = (id) => of(id)?.label || id;
    const to = view.accounts.find((a) => !a.exhausted && loggedIn(a))?.id || null;   // the stopped one counts again once its window reset
    const off = paused ? 'the manager is paused' : !view.autoSwapSessions ? 'automatic switch is off' : null;
    if (!to || off) {
      const reset = nextReset(view.accounts, now());
      const key = off || `none:${reset}`;
      if (told.get(session) !== key) {
        told.set(session, key);
        await alert(`claude-account:manager-stuck:${session}`, to
          ? { title: `${session} is ${limitStop ? 'stopped on' : 'at'} the ${label(from)} limit, not switched`, body: `${off}. ${label(to)} has headroom.` }
          : { title: `Every Claude account is used up: ${session} waits`, body: `Next reset: ${parisTime(reset)}. ${session} restarts by itself then.` });
      }
      return { action: to ? 'off' : 'no-account', reset };
    }
    told.delete(session);
    if (now() < (nextTry.get(session) || 0)) return { action: 'cooldown' };
    const why = `${label(from)} ${limitStop ? 'hit its usage limit' : `is used up (${of(from).why})`}`;
    const env = { MANAGER_FRESH_SESSION: session, MANAGER_FRESH_ACCOUNT: to, MANAGER_FRESH_WAIT_TRIES: '1', MANAGER_FRESH_REASON: `Claude account switch to ${to}: ${from} is at its limit`, MANAGER_FRESH_LIMIT: limitStop ? '1' : '' };
    // Not awaited: the script takes up to a minute and calls this server back.
    const job = (async () => {
      let code = 1;
      try { code = await restart(session, env); } catch (e) { log('[manager-rotation]', e.message); }
      nextTry.set(session, now() + (code === NOT_IDLE_EXIT ? BUSY_RETRY_MS : RETRY_MS));
      if (code === 0) {
        await record({ key: `health:claude-account-swap:${session}`, kind: 'health', title: `${session} restarted on ${label(to)}`, body: `${why}; fresh session on ${label(to)} (${to === DEFAULT_ID ? 'default' : to})` });
      } else if (code !== NOT_IDLE_EXIT) {
        await alert(`claude-account:manager-failed:${session}`, { title: `${session}: switch to ${label(to)} failed`, body: `${why}; manager-fresh.sh exit ${code}. Retried in ${RETRY_MS / 60e3} min.` });
      }
      return code;
    })().catch((e) => log('[manager-rotation]', e.message)).finally(() => running.delete(session));
    running.set(session, job);
    return { action: 'restart', to, job };
  }
  return { tick };
}
