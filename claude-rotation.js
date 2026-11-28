// Ordinary Claude sessions keep their conversation when a limit stops them. Keep marking separate from retrying:
// a no-account result must be reconsidered after a reset without extending the original limit mark.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_ID, ID_RE, hasLogin, nextReset } from './claude-accounts.js';

export const RETRY_MS = 5 * 60e3;
export const START_MS = 30e3;   // allow the new pane to replace the old capture and receive its delayed continue
export const CONTINUE_MS = 15e3;

export function createClaudeRotation({ file = null, accounts, swap, sendContinue, isPaused = () => false, notice = () => {}, record = async () => {}, refresh = () => accounts.refresh(), now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms).unref(), log = console.error }) {
  const stops = new Map(), running = new Set(), scheduled = new Set();
  // A service restart must not turn the old stop into a new mark and postpone its reset.
  if (file) {
    try {
      for (const [name, s] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
        if (/^[A-Za-z0-9_.-]{1,40}$/.test(name) && typeof s?.from === 'string' && ID_RE.test(s.from) && Number.isFinite(s.retryAt)) stops.set(name, { ...s, done: s.done === true });
      }
    } catch { /* first run or unreadable state: the visible stop can still be recovered */ }
  }
  function save() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(stops)), { mode: 0o600 });
    renameSync(tmp, file);
  }
  function queueContinue(name, stop) {
    if (!stop.done || stop.continued || scheduled.has(name)) return;
    scheduled.add(name);
    schedule(async () => {
      scheduled.delete(name);
      if (stops.get(name) !== stop) return;
      try { if (!isPaused(name)) await sendContinue(name); }
      catch (e) { log('[claude-accounts] continue', e.message); }
      stop.continued = true;
      try { save(); } catch (e) { log('[claude-accounts] save continuation', e.message); }
    }, Math.max(0, (stop.continueAt || now()) - now()));
  }
  async function tick(name, row, { limitStop = false, paused = false, lines = [] } = {}) {
    if (running.has(name)) return { action: 'running' };
    let stop = stops.get(name);
    if (stop?.done) queueContinue(name, stop);
    if (stop?.done && (!stop.continued || now() < stop.retryAt)) return { action: 'starting' };
    if (!limitStop || row.agent !== 'claude') { if (stops.delete(name)) save(); return { action: 'none' }; }
    const from = row.claudeAccount || DEFAULT_ID;
    if (stop?.from === from && stop.done) return { action: 'handled' };
    running.add(name);
    try {
      if (!stop || stop.from !== from) {
        stop = { from, retryAt: 0, told: null, done: false };
        // Save the sighting only after its mark succeeds, so a write failure can be retried.
        await accounts.markExhausted(from, { reason: `usage limit stop in ${name}`, confirmed: true,
          window: /weekly limit/i.test(lines.join('\n')) ? 'week' : /5-hour limit/i.test(lines.join('\n')) ? '5h' : null });
        stops.set(name, stop);
        save();
      }
      await refresh();
      const view = accounts.view(), label = (id) => accounts.byId(id)?.label || id;
      // Prefer another account; if its own window reset first, restart the stopped conversation on that account.
      const free = view.accounts.filter((a) => !a.exhausted && hasLogin(a));
      const to = (free.find((a) => a.id !== from) || free.find((a) => a.id === from))?.id;
      const reset = nextReset(view.accounts.filter(hasLogin), now());
      const off = paused ? 'paused' : !view.autoSwapSessions ? 'automatic switch is off' : null;
      if (!to || off) {
        const key = off || `none:${reset}`;
        if (stop.told !== key) {
          await notice({ title: to ? `${name} hit the ${label(from)} limit` : `Every Claude account is used up: ${name} waits`,
            body: to ? `${label(to)} has headroom; not switched (${off}). Use "Switch account" on the card.`
              : `Next reset: ${reset ? new Date(reset).toISOString() : 'unknown'}. The session resumes automatically when an account has room.`,
            url: `/?s=${encodeURIComponent(name)}`, tag: 'claude-account' });
          stop.told = key;
          save();
        }
        return { action: off ? 'off' : 'no-account', reset };
      }
      if (now() < stop.retryAt) return { action: 'cooldown' };
      try {
        await swap(name, to, { limitStop: true });
      } catch (e) {
        stop.retryAt = now() + RETRY_MS;
        save();
        await notice({ title: `${name} hit the ${label(from)} limit, switch failed`, body: `to ${label(to)}: ${String(e.message).slice(0, 250)}`, url: `/?s=${encodeURIComponent(name)}`, tag: 'claude-account' });
        return { action: 'failed', to };
      }
      stop.done = true;
      stop.retryAt = now() + START_MS;
      stop.continueAt = now() + CONTINUE_MS;
      save();
      queueContinue(name, stop);
      await record({ key: `health:claude-account-swap:${name}`, kind: 'health', title: `session moved to ${label(to)}: ${name}`, body: `${label(from)} hit its usage limit; same conversation resumed on ${label(to)}` });
      return { action: 'swap', to };
    } finally { running.delete(name); }
  }
  return { tick };
}
