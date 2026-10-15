// Rules watch (owner, 2026-10-15: "improve the harness every time something is wrong"). A session reads AGENTS.md once,
// when it starts; when the owner's rules change later it keeps the old ones (a MiniMax session from before the
// 2026-10-14 autonomy rule told the owner to run `git commit / push` because its task doc said "no merge").
// Every 10 min: for each live agent session, the last commit that touched AGENTS.md on its repo's origin/main. Newer
// than the session's agent process and not told yet -> one message, only while the session is idle, to re-read it.
// Switch: manager.json `rulesWatch` "live" (default) | "dry" (journal only) | "off". Journal: rules-watch.jsonl.
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const POLL_MS = 10 * 60 * 1000;
const MAX_SENDS_PER_TICK = 6;   // circuit breaker

// Pure. targets: [{ name, cwd, startedAt, working }]; rules: Map repoKey -> { hash, at (ms), subject } | null;
// repoOf: Map cwd -> repoKey; told: { name: hash }. -> [{ name, hash, rules }] to message now, oldest first.
export function plan({ targets, rules, repoOf, told }) {
  const out = [];
  for (const t of targets) {
    const r = rules.get(repoOf.get(t.cwd));
    if (!r || !t.startedAt || r.at <= t.startedAt) continue;   // the session started after the change: it read the new rules
    if (told[t.name] === r.hash || t.working) continue;
    out.push({ name: t.name, hash: r.hash, rules: r });
  }
  return out.slice(0, MAX_SENDS_PER_TICK);
}

export function message(r) {
  return [
    `AGENTS.md on origin/main changed after this session started (${r.hash.slice(0, 9)}, ${new Date(r.at).toISOString().slice(0, 16)}Z: ${r.subject}).`,
    'Its dated owner rules win over your task doc, handover and brief where they differ. For example, since 2026-10-14 you commit, push, merge your own tested work and deploy by the normal procedure yourself, and you never hand the owner commands to run.',
    'Read it now (git show origin/main:AGENTS.md), adjust what you are doing, then continue. End with a STATUS line.',
  ].join(' ');
}

export function createRulesWatch({ stateDir, git, listTargets, send, record = async () => {}, mode = () => 'live', now = Date.now, pollMs = POLL_MS, log = console } = {}) {
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
      const todo = plan({ targets, rules, repoOf, told: st.told });
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
      if (sent.length) await record({ key: 'rules-watch:told', title: `AGENTS.md changed: ${sent.length} session(s) told to re-read it`, body: sent.join(', '), url: '/', priority: 'default' });
      return (last = { at: now(), mode: m, stale: todo.map((p) => p.name), sent });
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
