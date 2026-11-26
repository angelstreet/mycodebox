// Rules watch (owner, 2026-10-15: "improve the harness every time something is wrong"). A session reads AGENTS.md once,
// when it starts; when the owner's rules change later it keeps the old ones (a MiniMax session from before the
// 2026-10-14 autonomy rule told the owner to run `git commit / push` because its task doc said "no merge").
// Every 10 min: for each live agent session, the last commit that touched AGENTS.md on its repo's origin/main. Newer
// than the session's agent process and not noted yet -> one note to re-read it, parked for its next real turn
// (session-notes.js). Nothing is typed: a wake only to answer "acknowledged" re-read the whole context (2026-11-26).
// Switch: manager.json `rulesWatch` "live" (default) | "dry" (journal only) | "off". Journal: rules-watch.jsonl.
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const POLL_MS = 10 * 60 * 1000;
// No git fetch while the host is busy: load1 per core above this, or less RAM available than this %.
const MAX_LOAD_PER_CORE = 1.5, MIN_RAM_AVAIL_PCT = 20;

// Pure. targets: [{ name, cwd, startedAt }]; rules: Map repoKey -> { hash, at (ms), subject } | null; repoOf: Map cwd -> repoKey;
// told: { name: hash }. -> { note: [{ name, hash, rules }], current: [name] } — `current` started after the last change, so a
// note still parked for that name (an earlier process) is stale. Busy or idle does not matter: nothing is typed.
export function plan({ targets, rules, repoOf, told }) {
  const note = [], current = [];
  for (const t of targets) {
    const r = rules.get(repoOf.get(t.cwd));
    if (!r || !t.startedAt) continue;
    if (r.at <= t.startedAt) { current.push(t.name); continue; }   // the session started after the change: it read the new rules
    if (told[t.name] !== r.hash) note.push({ name: t.name, hash: r.hash, rules: r });
  }
  return { note, current };
}

// One shape for the cited commit, shared by the message and the feed title: short hash, ISO minute, subject.
// The owner must be able to see at a glance that today's line cites the same commit as yesterday's.
export function stamp(r) {
  return `${r.hash.slice(0, 9)}, ${new Date(r.at).toISOString().slice(0, 16)}Z: ${r.subject}`;
}

export const NOTE_KEY = 'rules-watch';
export const TAG = '[rules-watch: no reply needed]';
export function message(r) {
  return [
    `${TAG} Note, not a task: AGENTS.md on origin/main changed after this session started (${stamp(r)}).`,
    'Its dated owner rules win over your task doc, handover and brief where they differ. Read it before you commit, integrate or end this turn (git show origin/main:AGENTS.md).',
    'Do not reply to this note and do not mention it: do what the message it came with asks.',
  ].join(' ');
}

// pressure(): { loadPerCore, ramAvailPct } of the host.
export function createRulesWatch({ stateDir, git, listTargets, park, unpark = () => {}, record = async () => {}, mode = () => 'live', pressure = () => ({ loadPerCore: 0, ramAvailPct: 100 }), now = Date.now, pollMs = POLL_MS, log = console } = {}) {
  const stFile = join(stateDir, 'rules-watch.json');
  const journal = join(stateDir, 'rules-watch.jsonl');
  let last = { at: 0, mode: 'off', stale: [], noted: [] };
  let timer = null, busy = false;

  async function load() { try { return JSON.parse(await readFile(stFile, 'utf8')); } catch { return { told: {} }; } }
  async function save(st) { await mkdir(stateDir, { recursive: true }); await writeFile(stFile, JSON.stringify(st)); }
  async function note(e) { try { await appendFile(journal, JSON.stringify({ at: new Date(now()).toISOString(), ...e }) + '\n'); } catch {} }

  async function tick() {
    if (busy) return last;
    busy = true;
    try {
      const m = mode();
      if (m === 'off') return (last = { at: now(), mode: m, stale: [], noted: [] });
      const pr = pressure();
      if (pr.loadPerCore > MAX_LOAD_PER_CORE || pr.ramAvailPct < MIN_RAM_AVAIL_PCT) {
        return (last = { at: now(), mode: m, stale: last.stale, noted: [], held: `host busy (load ${pr.loadPerCore.toFixed(1)}/core, RAM ${pr.ramAvailPct.toFixed(0)}% available)` });
      }
      const targets = await listTargets();
      const repoOf = new Map(), rules = new Map(), fetched = new Set();
      for (const t of targets) {
        if (!t.cwd || repoOf.has(t.cwd)) continue;
        let key = null;
        try { key = (await git(t.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(); } catch {}
        repoOf.set(t.cwd, key);
        if (!key || rules.has(key)) continue;
        if (!fetched.has(key)) { fetched.add(key); try { await git(t.cwd, ['fetch', '-q', 'origin', 'main']); } catch {} }
        try {
          const out = (await git(t.cwd, ['log', '-1', '--format=%H%x09%ct%x09%s', 'origin/main', '--', 'AGENTS.md'])).trim();
          const [hash, ct, subject] = out.split('\t');
          rules.set(key, hash ? { hash, at: Number(ct) * 1000, subject: subject || '' } : null);
        } catch { rules.set(key, null); }
      }
      const st = await load();
      const live = new Set(targets.map((t) => t.name));
      for (const n of Object.keys(st.told)) if (!live.has(n)) delete st.told[n];
      const { note: todo, current } = plan({ targets, rules, repoOf, told: st.told });
      const noted = [];
      if (m === 'live') for (const n of current) await unpark(n, NOTE_KEY);
      for (const p of todo) {
        if (m === 'dry') { await note({ dry: true, session: p.name, hash: p.hash }); continue; }
        try {
          await park(p.name, NOTE_KEY, message(p.rules));
          st.told[p.name] = p.hash; noted.push(p.name);
          await note({ session: p.name, hash: p.hash, parked: true });
        } catch (e) { log.error?.('[rules-watch] note', p.name, e.message); }
      }
      await save(st);
      if (noted.length) {
        // The title must not claim a change happened: the same unchanged commit is noted again every time a
        // session restarts, and "AGENTS.md changed" made the owner go looking for an edit that never came (2026-10-23).
        const cited = new Map();                       // noted sessions only, one entry per distinct commit
        for (const p of todo) if (noted.includes(p.name)) cited.set(p.rules.hash, p.rules);
        const where = [...cited.values()].map(stamp).join('; ');
        await record({ key: 'rules-watch:told', title: `AGENTS.md is newer than ${noted.length} session(s) - note for their next turn (${where})`, body: noted.join(', '), url: '/', priority: 'default' });
      }
      return (last = { at: now(), mode: m, stale: todo.map((p) => p.name), noted });
    } catch (e) {
      log.error?.('[rules-watch]', e.message);
      return (last = { ...last, at: now(), error: e.message });
    } finally { busy = false; }
  }

  return {
    tick,
    snapshot: () => last,
    start(firstDelayMs = 3 * 60 * 1000) { if (timer) return; setTimeout(() => tick(), firstDelayMs).unref?.(); timer = setInterval(() => tick(), pollMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
