// Rules watch (owner, 2026-10-15: "improve the harness every time something is wrong"). A session reads AGENTS.md once,
// when it starts; when the owner's rules change later it keeps the old ones (a MiniMax session from before the
// 2026-10-14 autonomy rule told the owner to run `git commit / push` because its task doc said "no merge").
// Every 10 min: for each live agent session, the last commit that touched AGENTS.md on its repo's origin/main. Newer
// than the session's agent process and not told yet -> one message, only while the session is idle, to re-read it.
// Switch: manager.json `rulesWatch` "live" (default) | "dry" (journal only) | "off". Journal: rules-watch.jsonl.
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const POLL_MS = 10 * 60 * 1000;
const MAX_SENDS_PER_TICK = 2;   // a message can wake an idle session into work: 6 per check woke 22 in 30 min and swapped codebox to load 130 (2026-10-15)
// No message while the host is busy: load1 per core above this, or less RAM available than this %.
const MAX_LOAD_PER_CORE = 1.5, MIN_RAM_AVAIL_PCT = 20;

// Pure. targets: [{ name, cwd, startedAt, working, scriptBusy }]; rules: Map repoKey -> { hash, at (ms), subject } | null;
// repoOf: Map cwd -> repoKey; told: { name: hash }. -> { send: [{ name, hash, rules }] (oldest first, capped),
//   skipScript: [name] } — `skipScript` is the subset that would have been told but were
//   skipped because a script is driving the pane (claude -p / mcode exec / sleep under bash);
//   `tick` logs and journals those so the owner can see why a stale session was held.
export function plan({ targets, rules, repoOf, told }) {
  const send = [], skipScript = [];
  for (const t of targets) {
    const r = rules.get(repoOf.get(t.cwd));
    if (!r || !t.startedAt || r.at <= t.startedAt) continue;   // the session started after the change: it read the new rules
    if (told[t.name] === r.hash || t.working) continue;
    if (t.scriptBusy) { skipScript.push(t.name); continue; }    // a script is driving the pane; typing would land in its terminal input
    send.push({ name: t.name, hash: r.hash, rules: r });
  }
  return { send: send.slice(0, MAX_SENDS_PER_TICK), skipScript };
}

// One shape for the cited commit, shared by the message and the feed title: short hash, ISO minute, subject.
// The owner must be able to see at a glance that today's line cites the same commit as yesterday's.
export function stamp(r) {
  return `${r.hash.slice(0, 9)}, ${new Date(r.at).toISOString().slice(0, 16)}Z: ${r.subject}`;
}

// Tag at the start: the reply to this message is an acknowledgement, never a question for the manager (4 false wakes in 40 min,
// 2026-10-28). manager-events.js drops asks / waiting events whose text is only that acknowledgement (isRulesAck).
export const TAG = '[rules-watch: no reply needed]';
export function message(r) {
  return [
    `${TAG} AGENTS.md on origin/main changed after this session started (${stamp(r)}).`,
    'Its dated owner rules win over your task doc, handover and brief where they differ. For example, since 2026-10-14 you commit, push, merge your own tested work and deploy by the normal procedure yourself, and you never hand the owner commands to run. Since 2026-10-28 a bug outside your scope is fixed or filed with `found-bug`, and a `STATUS: done` line ends with `bugs: none | fixed <what> | reported <id>`.',
    'Read it now (git show origin/main:AGENTS.md) and carry on with what you were doing. Do not answer this message and do not ask anything about it. If you were idle with nothing pending, start nothing new: write only `STATUS: acknowledged`. If you are waiting on a job, repeat your existing STATUS line unchanged.',
  ].join(' ');
}

// pressure(): { loadPerCore, ramAvailPct } of the host.
export function createRulesWatch({ stateDir, git, listTargets, send, record = async () => {}, mode = () => 'live', pressure = () => ({ loadPerCore: 0, ramAvailPct: 100 }), now = Date.now, pollMs = POLL_MS, log = console } = {}) {
  const stFile = join(stateDir, 'rules-watch.json');
  const journal = join(stateDir, 'rules-watch.jsonl');
  let last = { at: 0, mode: 'off', stale: [], sent: [] };
  let timer = null, busy = false;

  async function load() { try { return JSON.parse(await readFile(stFile, 'utf8')); } catch { return { told: {} }; } }
  async function save(st) { await mkdir(stateDir, { recursive: true }); await writeFile(stFile, JSON.stringify(st)); }
  async function note(e) { try { await appendFile(journal, JSON.stringify({ at: new Date(now()).toISOString(), ...e }) + '\n'); } catch {} }

  async function tick() {
    if (busy) return last;
    busy = true;
    try {
      const m = mode();
      if (m === 'off') return (last = { at: now(), mode: m, stale: [], sent: [] });
      const pr = pressure();
      if (pr.loadPerCore > MAX_LOAD_PER_CORE || pr.ramAvailPct < MIN_RAM_AVAIL_PCT) {
        return (last = { at: now(), mode: m, stale: last.stale, sent: [], held: `host busy (load ${pr.loadPerCore.toFixed(1)}/core, RAM ${pr.ramAvailPct.toFixed(0)}% available)` });
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
      const { send: todo, skipScript } = plan({ targets, rules, repoOf, told: st.told });
      for (const n of skipScript) {
        log.warn?.('[rules-watch] skipped: script pane', n);
        await note({ skipped: 'script pane', session: n });
      }
      const sent = [];
      for (const p of todo) {
        if (m === 'dry') { await note({ dry: true, session: p.name, hash: p.hash }); continue; }
        try {
          await send(p.name, message(p.rules));
          st.told[p.name] = p.hash; sent.push(p.name);
          await note({ session: p.name, hash: p.hash });
        } catch (e) { log.error?.('[rules-watch] send', p.name, e.message); }
      }
      await save(st);
      if (sent.length) {
        // The title must not claim a change happened: the same unchanged commit is re-delivered every time a
        // session restarts, and "AGENTS.md changed" made the owner go looking for an edit that never came (2026-10-23).
        const cited = new Map();                       // sent sessions only, one entry per distinct commit
        for (const p of todo) if (sent.includes(p.name)) cited.set(p.rules.hash, p.rules);
        const where = [...cited.values()].map(stamp).join('; ');
        await record({ key: 'rules-watch:told', title: `AGENTS.md is newer than ${sent.length} session(s) - told to re-read (${where})`, body: sent.join(', '), url: '/', priority: 'default' });
      }
      return (last = { at: now(), mode: m, stale: todo.map((p) => p.name), sent, skipped: skipScript });
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
