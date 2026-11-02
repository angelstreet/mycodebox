// Progress watch (owner, 2026-11-02; DeepSeek review P3). A session that never stops is never classified by stall.js, and
// health-watch.js sees processes, not work: a session looping on one tool call, or "working" for an hour with nothing to show,
// burned its plan window and held its device lease unseen (the manual's §8 row "a session loops" was advice, not code).
// Token-free poller (10 min) over the live agent sessions (same targets as rules-watch), two rules, no model call:
//   loop:        in the session's Claude transcript tail, 4 of the last 10 tool calls are the same tool with the same input, or
//                4 of the last 10 tool results carry the same error text.
//   no-progress: `working` for >= quietMin (60) with no busy child process (a tracked job), no commit and no tracked-file change in
//                its checkout since it started working, and no transcript line newer than transcriptQuietMin (20) (a session
//                without a transcript, Codex / MiniMax, is judged on the other three).
// One feed event `<session>:no-progress` (kind `no-progress`, `items` = the evidence, `progress` = {kind, workingMin, ...}) per
// session per cooldownH (2), plus `GET /api/progress-watch` and a line in scripts/manager-status-scan.sh. Nothing is typed: the
// manager judges (never Esc; Jev's `stop` point with the evidence; one nudge or an owner item with the cost so far).
// manager.json `progressWatch`: "live" (default) | "dry" (journal only, no event) | "off". State progress-watch.json, journal progress-watch.jsonl.
import { readFile, writeFile, appendFile, mkdir, stat, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

export const POLL_MS = 10 * 60 * 1000;
export const QUIET_MIN = 60;
export const TRANSCRIPT_QUIET_MIN = 20;
export const COOLDOWN_H = 2;
export const LOOP_WINDOW = 10;
export const LOOP_REPEATS = 4;
const TAIL_BYTES = 262144;

// Pure. Transcript records (parsed JSONL, oldest first) -> { kind: 'loop', what, times } | null.
// A tool call is identical when the tool name and the JSON of its input match; a result is identical by its first 160 error chars.
export function loopOf(records) {
  const calls = [], errors = [];
  for (const r of records) {
    const c = r?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === 'tool_use') calls.push(`${b.name}|${stableJson(b.input)}`);
      else if (b?.type === 'tool_result' && b.is_error) errors.push(textOf(b.content).replace(/\s+/g, ' ').trim().slice(0, 160));
    }
  }
  const rep = (list, label) => {
    const last = list.slice(-LOOP_WINDOW), n = new Map();
    for (const x of last) n.set(x, (n.get(x) || 0) + 1);
    const top = [...n.entries()].sort((a, b) => b[1] - a[1])[0];
    return top && top[1] >= LOOP_REPEATS ? { kind: 'loop', what: `${label} ${top[0].slice(0, 120)}`, times: top[1], of: last.length } : null;
  };
  return rep(calls, 'tool call') || rep(errors, 'error');
}

function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}
function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ');
  return '';
}

// Pure. facts of one session -> { kind: 'no-progress', evidence: [string] } | null.
//   { workingMin, busy, lastCommitMin, lastChangeMin, transcriptMin } (minutes ago; null = unknown / none)
export function noProgressOf(f, { quietMin = QUIET_MIN, transcriptQuietMin = TRANSCRIPT_QUIET_MIN } = {}) {
  if (!f || !Number.isFinite(f.workingMin) || f.workingMin < quietMin) return null;
  if (f.busy) return null;
  if (Number.isFinite(f.lastCommitMin) && f.lastCommitMin <= f.workingMin) return null;
  if (Number.isFinite(f.lastChangeMin) && f.lastChangeMin < quietMin) return null;
  if (Number.isFinite(f.transcriptMin) && f.transcriptMin < transcriptQuietMin) return null;
  const ev = [`working for ${Math.round(f.workingMin)} min`, 'no child process running'];
  ev.push(Number.isFinite(f.lastCommitMin) ? `last commit ${Math.round(f.lastCommitMin)} min ago` : 'no commit found');
  ev.push(Number.isFinite(f.lastChangeMin) ? `last file change ${Math.round(f.lastChangeMin)} min ago` : 'no uncommitted change');
  ev.push(Number.isFinite(f.transcriptMin) ? `transcript quiet for ${Math.round(f.transcriptMin)} min` : 'no transcript (not a Claude session)');
  return { kind: 'no-progress', evidence: ev };
}

// Default evidence readers (injectable for tests).
const sh = (cmd, args, cwd) => new Promise((resolve) => execFile(cmd, args, { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1 << 20 }, (e, out) => resolve(e ? '' : String(out || ''))));
// { lastCommitAt: ms|null, lastChangeAt: ms|null } of a checkout: the newest commit on HEAD and the newest mtime of a changed tracked / untracked path.
export async function gitEvidence(cwd) {
  if (!cwd) return { lastCommitAt: null, lastChangeAt: null };
  const ct = Number((await sh('git', ['log', '-1', '--format=%ct'], cwd)).trim());
  const porcelain = await sh('git', ['status', '--porcelain', '-z', '--untracked-files=normal'], cwd);
  let lastChangeAt = null;
  for (const entry of porcelain.split('\0').filter(Boolean).slice(0, 200)) {
    const p = entry.slice(3);
    try { const m = (await stat(join(cwd, p))).mtimeMs; if (lastChangeAt == null || m > lastChangeAt) lastChangeAt = m; } catch { /* deleted */ }
  }
  return { lastCommitAt: Number.isFinite(ct) && ct > 0 ? ct * 1000 : null, lastChangeAt };
}
// { mtime: ms, records: [...] } of a transcript's tail, or null when unreadable.
export async function transcriptTail(file) {
  if (!file) return null;
  let h = null;
  try {
    h = await open(file);
    const { size, mtimeMs } = await h.stat();
    const len = Math.min(size, TAIL_BYTES);
    const b = Buffer.alloc(len);
    await h.read(b, 0, len, size - len);
    const records = [];
    for (const l of b.toString('utf8').split('\n').slice(len === size ? 0 : 1)) { if (!l) continue; try { records.push(JSON.parse(l)); } catch { /* cut line */ } }
    return { mtime: mtimeMs, records };
  } catch { return null; } finally { try { await h?.close(); } catch { /* closed */ } }
}

// deps: listTargets() -> [{ name, cwd, working }] (rules-watch targets); facts(names) -> Map name -> { workingSinceMs, busy: bool, transcript: path|null };
//       record(event), mode() -> live|dry|off; git(cwd), tail(file) for tests; now, pollMs, log.
export function createProgressWatch({ stateDir, listTargets, facts, record = async () => {}, mode = () => 'live', git = gitEvidence, tail = transcriptTail,
  now = Date.now, pollMs = POLL_MS, quietMin = QUIET_MIN, transcriptQuietMin = TRANSCRIPT_QUIET_MIN, cooldownH = COOLDOWN_H, log = console } = {}) {
  const stateFile = stateDir ? join(stateDir, 'progress-watch.json') : null;
  const journal = stateDir ? join(stateDir, 'progress-watch.jsonl') : null;
  let told = new Map(), loaded = false, busy = false, timer = null;
  let snap = { at: null, mode: 'off', checked: 0, found: [], error: null };
  async function load() { loaded = true; if (!stateFile) return; try { told = new Map(Object.entries(JSON.parse(await readFile(stateFile, 'utf8')).told || {})); } catch { /* none yet */ } }
  async function save() { if (!stateFile) return; try { await mkdir(stateDir, { recursive: true }); await writeFile(stateFile, JSON.stringify({ told: Object.fromEntries(told) })); } catch (e) { log.error?.('[progress-watch] save', e.message); } }
  const min = (ms) => (Number.isFinite(ms) && ms != null ? (now() - ms) / 60000 : null);

  async function judge(t, f) {
    const ev = f?.transcript ? await tail(f.transcript) : null;
    const loop = ev ? loopOf(ev.records) : null;
    if (loop) return { kind: 'loop', evidence: [`${loop.what} repeated ${loop.times} times in the last ${loop.of} ${loop.what.startsWith('error') ? 'results' : 'calls'}`], progress: { kind: 'loop', what: loop.what, times: loop.times } };
    if (!t.working || !f?.workingSinceMs) return null;
    const g = await git(t.cwd);
    const facts = { workingMin: min(f.workingSinceMs), busy: !!f.busy, lastCommitMin: min(g.lastCommitAt), lastChangeMin: min(g.lastChangeAt), transcriptMin: ev ? min(ev.mtime) : null };
    const np = noProgressOf(facts, { quietMin, transcriptQuietMin });
    return np ? { kind: 'no-progress', evidence: np.evidence, progress: { kind: 'no-progress', workingMin: Math.round(facts.workingMin), lastCommitMin: facts.lastCommitMin == null ? null : Math.round(facts.lastCommitMin), lastChangeMin: facts.lastChangeMin == null ? null : Math.round(facts.lastChangeMin), transcriptMin: facts.transcriptMin == null ? null : Math.round(facts.transcriptMin) } } : null;
  }

  async function tick() {
    if (busy) return snap;
    busy = true;
    try {
      const m = mode();
      const t = now();
      if (m === 'off') { snap = { at: t, mode: m, checked: 0, found: [], error: null }; return snap; }
      if (!loaded) await load();
      const targets = await listTargets();
      const fm = await facts(targets.map((x) => x.name));
      const found = [];
      let events = 0;
      for (const tg of targets) {
        let r = null;
        try { r = await judge(tg, fm.get(tg.name)); } catch (e) { log.error?.('[progress-watch]', tg.name, e.message); continue; }
        if (!r) continue;
        found.push({ session: tg.name, kind: r.kind, evidence: r.evidence });
        const last = told.get(tg.name) || 0;
        if (t - last < cooldownH * 3600e3) continue;
        const rec = { at: new Date(t).toISOString(), session: tg.name, kind: r.kind, evidence: r.evidence, mode: m };
        if (journal) { try { await mkdir(stateDir, { recursive: true }); await appendFile(journal, JSON.stringify(rec) + '\n'); } catch { /* audit only */ } }
        if (m === 'live') {
          const title = r.kind === 'loop' ? `${tg.name}: repeats the same ${r.progress.what.startsWith('error') ? 'error' : 'tool call'}` : `${tg.name}: no progress for ${r.progress.workingMin} min`;
          const body = `${r.evidence.join('; ')}. Never Esc: judge it (Jev stop point with this evidence), then one nudge to stop and state what it knows, or an owner item with the cost so far.`.slice(0, 300);
          try { await record({ key: `${tg.name}:no-progress`, title, body, url: `/?s=${encodeURIComponent(tg.name)}`, priority: 'default', items: r.evidence.slice(0, 8), progress: r.progress }); events++; }
          catch (e) { log.error?.('[progress-watch] record', e.message); continue; }
        }
        told.set(tg.name, t);
      }
      for (const [k, v] of [...told]) if (t - v > 7 * 86400e3) told.delete(k);
      if (events || found.length) await save();
      snap = { at: t, mode: m, checked: targets.length, found, events, error: null };
      return snap;
    } catch (e) { snap = { ...snap, at: now(), error: e.message }; log.error?.('[progress-watch]', e.message); return snap; } finally { busy = false; }
  }
  return { tick, start() { setTimeout(() => tick(), 3 * 60 * 1000).unref?.(); timer = setInterval(tick, pollMs); timer.unref?.(); }, stop() { if (timer) clearInterval(timer); }, snapshot: () => snap, told };
}
