// Live check after a self-deploy (token audit 2026-11-28): the lane says "deployed live ... restart scheduled" before the restart
// runs, and nothing looked afterwards. Two usage/ fixes were merged and "deployed" yet ran nowhere for hours: the usage tailer is
// its own unit and was never restarted. This checks each self-deploy once its safe-restart waiter has exited: every unit that runs
// the changed code (ghosty-sessions always, ghosty-usage when the tailer's paths changed) must have started after the restart
// was scheduled. A unit still on old code, or a failed restart, becomes ONE high manager item per request. A unit that is not
// installed here is skipped (not a failure). State: <stateDir>/integration/restart-check.json { <id>: { at, ok } } (pruned).
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { WRITER_PATHS } from './usage/code-version.js';

export const FILE_NAME = 'restart-check.json';
export const MAX_AGE_MS = 24 * 3600e3;   // older self-deploys are never checked (and their state entries are pruned)

const touches = (paths, list) => paths.some((p) => list.some((w) => (w.endsWith('/') ? p.startsWith(w) : p === w)));
// Pure: the units a merge must have restarted.
export function unitsFor(changed) {
  const u = ['ghosty-sessions'];
  if (touches(changed || [], WRITER_PATHS)) u.push('ghosty-usage');
  return u;
}

// Pure: exitCode = the waiter's exit (number) ; starts = { unit: ms | null (not installed) } ; restartAt = ms.
// -> { ok, units: [{ unit, startedAt, ok }], reason }
export function verdict({ exitCode, starts, restartAt }) {
  const units = Object.entries(starts).map(([unit, t]) => ({ unit, startedAt: Number.isFinite(t) ? new Date(t).toISOString() : null, ok: Number.isFinite(t) ? t > restartAt : null }));
  const stale = units.filter((u) => u.ok === false).map((u) => u.unit);
  if (exitCode !== 0) return { ok: false, units, reason: `safe-restart exited ${exitCode}${stale.length ? `; still on old code: ${stale.join(', ')}` : ''}` };
  if (stale.length) return { ok: false, units, reason: `still on old code: ${stale.join(', ')} (started before the restart was scheduled)` };
  return { ok: true, units, reason: '' };
}

// listDeployed() -> lane.list({ state: 'deployed' }) ; getReq(id) -> lane.get(id) ; changedPaths(live, from, to) -> [paths] ;
// unitStartMs(unit) -> ms | null ; readExit(file) -> { code, at } | number | null (null = waiter still running / no file; at = the
// exit file's mtime). startedAt = this process start (ms): a waiter that exited before it ran its restart unwatched, so the
// request is recorded `ok: null, unwatched: true` (no item, never logged live) instead of being judged after the fact.
export function createRestartCheck({ stateDir, listDeployed, getReq = () => null, changedPaths, unitStartMs, readExit, managerItem = () => {},
  startedAt = null, now = Date.now, fs = fsp, log = console } = {}) {
  const file = join(stateDir, 'integration', FILE_NAME);
  let done = null, busy = false;
  async function load() { try { const j = JSON.parse(await fs.readFile(file, 'utf8')); done = j && typeof j === 'object' ? j : {}; } catch { done = {}; } }
  async function tick() {
    if (busy) return [];
    busy = true;
    const out = [];
    try {
      if (!done) await load();
      const t = now();
      for (const r of (await listDeployed()) || []) {
        const sd = r?.selfDeploy, at = Date.parse(sd?.restartAt);
        if (!sd || done[r.id] || !Number.isFinite(at) || t - at > MAX_AGE_MS) continue;
        if (sd.restart !== 'scheduled' && sd.restart !== 'coalesced') continue;
        const exitFile = sd.restart === 'scheduled' ? sd.exit : getReq(sd.restartWaiter)?.selfDeploy?.exit;
        const ex = exitFile ? await readExit(exitFile) : null;
        const exitCode = ex !== null && typeof ex === 'object' ? ex.code : ex, exitAt = ex !== null && typeof ex === 'object' ? ex.at : null;
        if (!Number.isInteger(exitCode)) continue;                         // the waiter has not finished: look again next tick
        if (Number.isFinite(startedAt) && Number.isFinite(exitAt) && exitAt < startedAt) {
          done[r.id] = { at: t, ok: null, unwatched: true };               // finished before this process: not watched, not judged
          out.push({ id: r.id, ok: null, unwatched: true, units: [], reason: 'restart finished before this check started' });
          continue;
        }
        let changed = [];
        try { changed = await changedPaths(sd.live, sd.prevSha, sd.expectedSha || sd.newSha); } catch { /* unknown: the base units only */ }
        const starts = {};
        for (const u of unitsFor(changed)) { try { starts[u] = await unitStartMs(u); } catch { starts[u] = null; } }
        const v = verdict({ exitCode, starts, restartAt: at });
        done[r.id] = { at: t, ok: v.ok };
        out.push({ id: r.id, ...v });
        if (!v.ok) {
          try {
            await managerItem({ key: `integration:${r.id}:not-live`, priority: 'high', url: '/?integration=1',
              title: `Integration ${r.id}: merged but not live (${v.reason})`.slice(0, 200),
              body: `${String(sd.newSha || '').slice(0, 12)} merged and pulled, but ${v.reason}. ${v.units.map((u) => `${u.unit} started ${u.startedAt || 'n/a'}`).join('; ')}; restart scheduled ${sd.restartAt}. Fix: scripts/safe-restart.sh; log ${exitFile.replace(/\.exit$/, '.log')}`.slice(0, 300) });
          } catch (e) { log.error?.('[restart-check] manager item', e.message); }
        } else log.log?.('[restart-check] live', r.id, v.units.map((u) => u.unit).join(','));
      }
      for (const [id, e] of Object.entries(done)) if (!Number.isFinite(e?.at) || t - e.at > 2 * MAX_AGE_MS) delete done[id];
      if (out.length) { await fs.mkdir(join(stateDir, 'integration'), { recursive: true }); await fs.writeFile(file, JSON.stringify(done)); }
    } catch (e) { log.error?.('[restart-check]', e.message); }
    finally { busy = false; }
    return out;
  }
  return { tick };
}
