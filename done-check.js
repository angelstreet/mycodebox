// Done check (owner/manager, 2026-10-15): a session's "STATUS: done" is checked against git, not trusted. TASK59 said
// "shipped, nothing pending" with 7 commits that were never on main. Every 5 min, for each idle session whose last STATUS
// is done: commits on its checkout (and on the branches / worktrees its closing text names) that are not on origin/main (equivalent patches count as merged; VERSION.txt-only
// stamps ignored) and uncommitted tracked files. A mismatch gets one feed line and one message to the session (while it
// is idle and the host is not busy), once per finding. Switch: manager.json `doneCheck` "live" (default) | "dry" | "off".
// Journal: done-check.jsonl.
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const POLL_MS = 5 * 60 * 1000;
const FETCH_EVERY_MS = 30 * 60 * 1000;
const MAX_NUDGES_PER_TICK = 2;
const MAX_LOAD_PER_CORE = 1.5, MIN_RAM_AVAIL_PCT = 20;
const IGNORED = ['VERSION.txt'];   // build stamps a hook rewrites on every commit

// Pure. facts: one checkout's { branch, notOnMain: [{sha, subject}], uncommitted: [path], where? }, or a list of them
// (the session's folder plus the branches / worktrees it names) -> a finding, or null when git agrees with "done".
export function finding(facts) {
  const list = (Array.isArray(facts) ? facts : [facts]).filter(Boolean);
  const parts = [];
  for (const f of list) {
    const at = f.where ? ` in ${f.where}` : '';
    if (f.notOnMain.length) parts.push(`${f.notOnMain.length} commit(s) on ${f.branch || 'HEAD'}${at} not on main (${f.notOnMain.slice(0, 3).map((c) => c.sha).join(', ')})`);
    if (f.uncommitted?.length) parts.push(`${f.uncommitted.length} uncommitted file(s)${at} (${f.uncommitted.slice(0, 3).join(', ')})`);
  }
  return parts.length ? { text: parts.join('; '), sig: createHash('sha1').update(JSON.stringify(list.map((f) => [f.branch, f.where, f.notOnMain.map((c) => c.sha), f.uncommitted]))).digest('hex').slice(0, 12) } : null;
}

// Pure. Branch names and absolute / ~ paths a closing text names (candidates only; git decides which exist).
export function namedRefs(text, home = '') {
  const t = String(text || '');
  const paths = [...new Set((t.match(/(?:~|\/home\/[\w.-]+)\/[\w.\/-]+/g) || []).map((x) => x.replace(/^~/, home).replace(/[.,;:)]+$/, '')))].slice(0, 5);
  const words = [...new Set((t.match(/\b[a-z][\w.-]*[\/-][\w.\/-]*[\w]\b/gi) || []).filter((w) => !w.includes('//') && !/^(?:origin\/)?(?:main|master|HEAD)$/.test(w) && w.length <= 80))].slice(0, 12);
  return { paths, branches: words.map((w) => w.replace(/^origin\//, '')) };
}

export function message(f) {
  return `Done check: your STATUS says done, but git disagrees: ${f.text}. Finish it the normal way (commit, merge to main when the merge evaluation passes, push, deploy if needed), or reply with one line saying why it stays as is. End with a STATUS line.`;
}

// Parse `git status --porcelain --untracked-files=no` lines into paths, minus ignored stamps.
export function uncommittedOf(porcelain) {
  return String(porcelain || '').split('\n').filter(Boolean).map((l) => l.slice(3).split(' -> ').pop().trim()).filter((p) => p && !IGNORED.includes(p));
}

export function createDoneCheck({
  stateDir, git, listDone, send, record = async () => {}, mode = () => 'live', home = process.env.HOME || '',
  pressure = () => ({ loadPerCore: 0, ramAvailPct: 100 }), now = Date.now, pollMs = POLL_MS, log = console,
} = {}) {
  const stFile = join(stateDir, 'done-check.json');
  const journal = join(stateDir, 'done-check.jsonl');
  const fetchedAt = new Map();   // repo common dir -> ms
  let last = { at: 0, mode: 'off', checked: 0, findings: [] };
  let timer = null, busy = false;

  async function load() { try { return JSON.parse(await readFile(stFile, 'utf8')); } catch { return { told: {} }; } }
  async function save(st) { await mkdir(stateDir, { recursive: true }); await writeFile(stFile, JSON.stringify(st)); }
  async function note(e) { try { await appendFile(journal, JSON.stringify({ at: new Date(now()).toISOString(), ...e }) + '\n'); } catch {} }

  // Commits of a ref not on base (equivalent patches count as merged, stamps ignored). Content that reached main through
  // other commits (a squash, a resolved cherry-pick) counts as merged too: a trial merge into base that is clean and
  // leaves base's tree unchanged means there is nothing left to land.
  async function notOnMainOf(cwd, base, ref) {
    const log = await git(cwd, ['log', '--format=%h%x09%s', '--no-merges', '--cherry-pick', '--right-only', `${base}...${ref}`, '--', '.', ...IGNORED.map((p) => `:(exclude)${p}`)]).catch(() => '');
    const commits = log.split('\n').filter(Boolean).map((l) => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t') }; });
    if (!commits.length) return commits;
    try {
      const merged = (await git(cwd, ['merge-tree', '--write-tree', base, ref])).split('\n')[0].trim();
      const changed = (await git(cwd, ['diff', '--name-only', base, merged, '--', '.', ...IGNORED.map((p) => `:(exclude)${p}`)])).trim();
      if (merged && !changed) return [];
    } catch {}   // a conflicting trial merge exits non-zero: the commits stand
    return commits;
  }

  // The session's folder, plus the branches and worktree paths its closing text names that exist in that repo.
  async function allFactsOf(cwd, text) {
    const own = await factsOf(cwd);
    if (!own) return [];
    const out = [own];
    const { paths, branches } = namedRefs(text, home);
    for (const p of paths) {
      if (p === cwd) continue;
      const f = await factsOf(p).catch(() => null);
      if (f && (f.notOnMain.length || f.uncommitted.length)) out.push({ ...f, where: p });
    }
    for (const b of branches) {
      if (b === own.branch) continue;
      let ref = null;
      for (const r of [`refs/heads/${b}`, `refs/remotes/origin/${b}`]) { try { await git(cwd, ['rev-parse', '-q', '--verify', r]); ref = r; break; } catch {} }
      if (!ref) continue;
      const notOnMain = await notOnMainOf(cwd, own.base, ref);
      if (notOnMain.length) out.push({ branch: b, notOnMain, uncommitted: [] });
    }
    return out;
  }

  // Git facts of a checkout, or null (not a repo, no origin/main).
  async function factsOf(cwd) {
    let common;
    try { common = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(); } catch { return null; }
    if (now() - (fetchedAt.get(common) || 0) > FETCH_EVERY_MS) { fetchedAt.set(common, now()); try { await git(cwd, ['fetch', '-q', 'origin']); } catch {} }
    let base = null;
    for (const b of ['origin/main', 'origin/master']) { try { await git(cwd, ['rev-parse', '-q', '--verify', b]); base = b; break; } catch {} }
    if (!base) return null;
    const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
    const notOnMain = await notOnMainOf(cwd, base, 'HEAD');
    const uncommitted = uncommittedOf(await git(cwd, ['status', '--porcelain', '--untracked-files=no']).catch(() => ''));
    return { branch: branch === 'HEAD' ? null : branch, base, notOnMain, uncommitted };
  }

  async function tick() {
    if (busy) return last;
    busy = true;
    try {
      const m = mode();
      if (m === 'off') return (last = { at: now(), mode: m, checked: 0, findings: [] });
      const sessions = await listDone();
      const st = await load();
      const live = new Set(sessions.map((s) => s.name));
      for (const n of Object.keys(st.told)) if (!live.has(n)) delete st.told[n];
      const findings = [];
      for (const s of sessions) {
        const f = finding(await allFactsOf(s.cwd, s.text));
        if (f) findings.push({ name: s.name, working: s.working, ...f });
      }
      const pr = pressure();
      const quiet = pr.loadPerCore <= MAX_LOAD_PER_CORE && pr.ramAvailPct >= MIN_RAM_AVAIL_PCT;
      let nudged = 0;
      for (const f of findings) {
        if (st.told[f.name] === f.sig || f.working) continue;
        if (m === 'dry') { await note({ dry: true, session: f.name, finding: f.text }); continue; }
        if (!quiet || nudged >= MAX_NUDGES_PER_TICK) continue;   // a later tick tells it
        try {
          await send(f.name, message(f));
          st.told[f.name] = f.sig; nudged++;
          await note({ session: f.name, finding: f.text });
          await record({ key: `done-check:${f.name}`, title: `${f.name} said done, git disagrees`, body: f.text, url: '/', priority: 'default' });
        } catch (e) { log.error?.('[done-check] send', f.name, e.message); }
      }
      await save(st);
      return (last = { at: now(), mode: m, checked: sessions.length, findings: findings.map(({ name, text }) => ({ name, text })), held: quiet ? null : 'host busy' });
    } catch (e) {
      log.error?.('[done-check]', e.message);
      return (last = { ...last, at: now(), error: e.message });
    } finally { busy = false; }
  }

  return {
    tick,
    snapshot: () => last,
    start(firstDelayMs = 4 * 60 * 1000) { if (timer) return; setTimeout(() => tick(), firstDelayMs).unref?.(); timer = setInterval(() => tick(), pollMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
