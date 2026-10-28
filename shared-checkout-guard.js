// Shared-checkout guard (owner, 2026-10-28: "some agents still don't use a worktree"). Every minute, for each shared checkout
// (manager.json `sharedCheckouts`, default ~/ghosty-sessions and ~/virtualpytest): `git status --porcelain` not empty, a branch
// other than main checked out, or commits on HEAD that origin/main does not have. Any of them means someone works in the shared
// checkout instead of a worktree. Surface: GET /api/shared-checkouts, a manager event `<checkout>:shared-checkout-dirty` once
// per change set (paths + mtimes + the sessions whose launch cwd is that checkout and that started before the newest mtime),
// and each such session told once per change set (silent form, like overlap-guard). Read-only: it never cleans, resets,
// stashes or switches the checkout. A change set must be seen on two consecutive ticks first, so the lane's own short
// ff-merge or a deploy snapshot does not raise it. Switch: manager.json `sharedCheckoutGuard` "live" (default) | "dry" | "off".
// State shared-checkout-guard.json, journal shared-checkout-guard.jsonl in the state dir.
import { readFile, writeFile, appendFile, mkdir, lstat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parseStatus } from './overlap-guard.js';

export const POLL_MS = 60 * 1000;
const MAX_LOAD_PER_CORE = 1.5, MIN_RAM_AVAIL_PCT = 20;
export const TAG = '[shared-checkout-guard: no reply needed]';

export const expandHome = (p, home) => String(p).replace(/^~(?=\/|$)/, home);

// Pure. facts: { branch, ahead, status: Map path -> M|A|D }. -> [reason] (empty = clean).
export function problemsOf({ branch, ahead, status }) {
  const out = [];
  if (status.size) out.push(`${status.size} uncommitted path(s)`);
  if (branch && branch !== 'main') out.push(`branch ${branch} checked out`);
  if (ahead > 0) out.push(`${ahead} commit(s) not on origin/main`);
  return out;
}
export function signatureOf({ branch, ahead, status }) {
  return createHash('sha1').update(JSON.stringify([branch, ahead, [...status].sort()])).digest('hex').slice(0, 12);
}

export function message({ checkout, reasons, paths }) {
  const list = paths.slice(0, 5).join(', ') + (paths.length > 5 ? ` (+${paths.length - 5} more)` : '');
  return [
    `${TAG} The shared checkout ${checkout} is not clean: ${reasons.join('; ')}${list ? ` (${list})` : ''}. You started there and may be the cause.`,
    'Rule: one agent = one worktree. First command: `git worktree list`; create or reuse your worktree; work only there. Move any change of yours out of the shared checkout into your worktree (do not reset or clean it for others).',
    'Do not stop your work for this. If you were idle with nothing pending, write only `STATUS: acknowledged`. If you are waiting on a job, repeat your existing STATUS line unchanged.',
  ].join(' ');
}

// git(cwd, args) -> stdout. listCheckouts(): [path]. listTargets(): [{ name, cwd, startedAt, working, scriptBusy }].
export function createSharedCheckoutGuard({ stateDir, git, listCheckouts, listTargets, send, record = async () => {}, mode = () => 'live', pressure = () => ({ loadPerCore: 0, ramAvailPct: 100 }), mtimeOf = async (p) => { try { return (await lstat(p)).mtimeMs; } catch { return 0; } }, now = Date.now, pollMs = POLL_MS, log = console } = {}) {
  const stFile = join(stateDir, 'shared-checkout-guard.json');
  const journal = join(stateDir, 'shared-checkout-guard.jsonl');
  let last = { at: 0, mode: 'off', checkouts: [] };
  let timer = null, busy = false;

  async function load() { try { return JSON.parse(await readFile(stFile, 'utf8')); } catch { return { pending: {}, raised: {}, told: {} }; } }
  async function save(st) { await mkdir(stateDir, { recursive: true }); await writeFile(stFile, JSON.stringify(st)); }
  async function note(e) { try { await appendFile(journal, JSON.stringify({ at: new Date(now()).toISOString(), ...e }) + '\n'); } catch {} }

  async function inspect(dir) {
    const g = async (args) => { try { return await git(dir, args); } catch { return ''; } };
    if (!(await g(['rev-parse', '--show-toplevel'])).trim()) return null;
    const branch = (await g(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const ahead = Number((await g(['rev-list', '--count', 'origin/main..HEAD'])).trim()) || 0;
    const status = parseStatus(await g(['status', '--porcelain=v1']));
    const files = [];
    for (const [p, s] of status) files.push({ path: p, status: s, mtime: s === 'D' ? 0 : await mtimeOf(join(dir, p)) });
    return { branch, ahead, status, files };
  }

  async function tick() {
    if (busy) return last;
    busy = true;
    try {
      const m = mode();
      if (m === 'off') return (last = { at: now(), mode: m, checkouts: [] });
      const pr = pressure();
      if (pr.loadPerCore > MAX_LOAD_PER_CORE || pr.ramAvailPct < MIN_RAM_AVAIL_PCT) return (last = { ...last, at: now(), mode: m, held: 'host busy' });
      const dirs = await listCheckouts();
      const targets = await listTargets();
      const st = await load();
      const out = [];
      for (const dir of dirs) {
        const f = await inspect(dir);
        if (!f) continue;
        const reasons = problemsOf(f);
        const key = basename(dir);
        if (!reasons.length) { delete st.pending[dir]; delete st.raised[dir]; out.push({ checkout: dir, clean: true }); continue; }
        const sig = signatureOf(f);
        const newest = Math.max(0, ...f.files.map((x) => x.mtime));
        const cands = targets.filter((t) => t.cwd === dir && (!newest || (t.startedAt || 0) <= newest)).map((t) => t.name);
        const rec = { checkout: dir, clean: false, reasons, branch: f.branch, ahead: f.ahead, sig, files: f.files.slice(0, 50).map((x) => ({ path: x.path, status: x.status, mtime: x.mtime ? new Date(x.mtime).toISOString() : null })), sessions: cands, confirmed: st.pending[dir] === sig };
        out.push(rec);
        if (st.pending[dir] !== sig) { st.pending[dir] = sig; continue; }   // first sighting of this change set: confirm on the next tick
        if (m === 'dry') { await note({ dry: true, checkout: dir, sig, reasons }); continue; }
        if (st.raised[dir] !== sig) {
          st.raised[dir] = sig;
          const paths = f.files.map((x) => x.path);
          await note({ checkout: dir, sig, reasons, paths, sessions: cands });
          await record({ key: `${key}:shared-checkout-dirty`, title: `Shared checkout ${key} is not clean: ${reasons.join('; ')}`,
            body: `sessions started there: ${cands.join(', ') || 'none active'}; newest change ${newest ? new Date(newest).toISOString() : 'n/a'}`, items: paths,
            sharedCheckout: { checkout: dir, reasons, sig, files: rec.files, sessions: cands }, url: '/', priority: 'default' });
        }
        const byName = new Map(targets.map((t) => [t.name, t]));
        for (const me of cands) {
          const tk = `${dir}|${sig}|${me}`, t = byName.get(me);
          if (st.told[tk] || !t || t.working || t.scriptBusy) continue;
          try { await send(me, message({ checkout: dir, reasons, paths: f.files.map((x) => x.path) })); st.told[tk] = true; await note({ told: me, checkout: dir, sig }); }
          catch (e) { log.error?.('[shared-checkout-guard] send', me, e.message); }
        }
      }
      for (const d of Object.keys(st.pending)) if (!dirs.includes(d)) delete st.pending[d];
      const live = new Set(Object.values(st.raised));
      for (const k of Object.keys(st.told)) if (!live.has(k.split('|')[1])) delete st.told[k];
      await save(st);
      return (last = { at: now(), mode: m, checkouts: out });
    } catch (e) {
      log.error?.('[shared-checkout-guard]', e.message);
      return (last = { ...last, at: now(), error: e.message });
    } finally { busy = false; }
  }

  return {
    tick,
    snapshot: () => last,
    start(firstDelayMs = 60 * 1000) { if (timer) return; setTimeout(() => tick(), firstDelayMs).unref?.(); timer = setInterval(() => tick(), pollMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
