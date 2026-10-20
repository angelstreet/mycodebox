// Strict crash detection and in-place resume. Keep this module pure except for the injected tick IO.

const AGENTS = new Set(['claude', 'codex', 'minimax']);
const JOB_RE = /line \d+: +\d+ (Aborted|Segmentation fault|Killed)(?:\s|$)/;
// A RESUMED claude that dies again leaves no wrapper job line: interactive bash only reports "Aborted (core dumped)",
// possibly behind a leftover TUI marker. The text is not unique per crash, so the resumer dedupes these per resume.
const BARE_ABORT_RE = /^\s*(?:[❯>]\s*)?(Aborted|Segmentation fault|Killed)(?:\s*\(core dumped\))?\s*$/;
const REMOTE_RE = /(?:--remote-control|-n)(?:=|\s+)(['"]?)([A-Za-z0-9_.-]+)\1/;
const MODEL_RE = /--model(?:=|\s+)(['"]?)([A-Za-z0-9_.\[\]-]+)\1/;
const DEFAULT_INTERVAL = 30 * 60 * 1000;
const CRASH_LOOP_MAX = 3; // resumes allowed in the window; the next crash inside it needs a human
const CRASH_LOOP_MS = 6 * 60 * 60 * 1000;

// Lines that may follow a crash job line in a dead shell: shell-init/getcwd errors, a prompt (empty or with a command a
// human typed), bash's "command not found" reply, and leftovers of the dead agent's TUI (status bar, rules, update banner).
const GETCWD_RE = /error retrieving current directory/;
const PROMPT_RE = /^(?:\S+@\S+:\S*[$#]|[\w.-]*[$#])(?:\s.*)?$/;
const NOT_FOUND_RE = /^-?(?:ba)?sh: .*command not found$/;
const NOISE_RE = /^(?:[─━\s]+.*─\s*$|\s*⏵⏵.*|.*Update installed.*|.*new task\?.*|\s*\/rc|\s*(?:Opus|Sonnet|Haiku|Fable)\b.*\b5h\b.*)$/;
const CONT_MAX = 4;
const cutRight = (s) => s.replace(/─+$/, '').trimStart().split(/\s{6,}/)[0];
const tolerated = (l) => !l.trim() || GETCWD_RE.test(l) || PROMPT_RE.test(l.trim()) || NOT_FOUND_RE.test(l.trim()) || NOISE_RE.test(l);

// The most recent crash job line, joined across screen wraps, when nothing but tolerated lines follows it. null otherwise.
export function scanCrash(lines) {
  const all = (Array.isArray(lines) ? lines : []).map((x) => String(x ?? ''));
  let j = -1;
  for (let i = all.length - 1; i >= 0; i--) if (JOB_RE.test(all[i])) { j = i; break; }
  if (j < 0) return null;
  const m = all[j].match(JOB_RE);
  let text = all[j].slice(0, m.index + m[0].length) + cutRight(all[j].slice(m.index + m[0].length));
  let k = j + 1;
  // a screen-wrapped job line continues on the next physical lines (until a prompt / error / blank line)
  // (the launch wrapper always ends the command with a closing double quote; a TUI marker line is agent output, not a wrap)
  while (k < all.length && k - j <= CONT_MAX && !/"$/.test(text) && all[k].trim() && !/^[❯●⏺⎿✻>•\s]/.test(all[k]) && !GETCWD_RE.test(all[k]) && !PROMPT_RE.test(all[k].trim()) && !NOISE_RE.test(cutRight(all[k]))) { text += cutRight(all[k]); k++; }
  const rest = all.slice(k);
  if (!rest.every(tolerated)) return null;
  return { line: text, cwdGone: rest.some((l) => GETCWD_RE.test(l)) };
}

export function crashLineOf(lines) {
  return scanCrash(lines)?.line || null;
}

// Bare abort of a resumed agent: the last non-tolerated pane line is "Aborted"/"Killed"/"Segmentation fault" (with or
// without a leftover TUI prompt marker in front, and with the dead agent's status bar cut off on the same line).
// Scanning from the end means only tolerated lines can follow. null otherwise.
export function scanBareAbort(lines) {
  const all = (Array.isArray(lines) ? lines : []).map((x) => String(x ?? ''));
  let j = -1;
  for (let i = all.length - 1; i >= 0; i--) if (!tolerated(all[i])) { j = i; break; }
  if (j < 0) return null;
  const line = cutRight(all[j]).replace(/^[❯>]\s*/, '').trim();
  if (!BARE_ABORT_RE.test(line)) return null;
  const rest = all.slice(j + 1);
  return { line, cwdGone: rest.some((l) => GETCWD_RE.test(l)) };
}

export function parseCrashCommand(line, fallbackName) {
  if (!line || !JOB_RE.test(line)) return null;
  const m = line.match(REMOTE_RE);
  const name = m?.[2] || fallbackName;
  const model = line.match(MODEL_RE)?.[2] || null;
  return { name, model, line };
}

export function buildCrashResumeCommand({ base, crash, model, claudeSessionId } = {}) {
  if (!base || !crash?.name || !claudeSessionId) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(claudeSessionId)) return null;
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const parts = [base];
  const chosenModel = model || crash.model;
  if (chosenModel && !/--model(?:=|\s)/.test(base)) parts.push('--model', chosenModel);
  if (!/--remote-control\b/.test(base)) parts.push('--remote-control', q(crash.name), '-n', q(crash.name));
  parts.push('--resume', claudeSessionId);
  return parts.join(' ');
}

export function decideCrashResume({ state, consecutiveNoAgent = 0, managerSessions = [], closed = false, lastResumeAt, now = Date.now(), intervalMs = DEFAULT_INTERVAL } = {}) {
  if (!state || managerSessions.includes(state.name)) return { ok: false, reason: 'manager-session' };
  if (closed || state.closed) return { ok: false, reason: 'closed' };
  if (state.scriptBusy) return { ok: false, reason: 'script-busy' };
  if (state.input) return { ok: false, reason: 'input-not-empty' };
  if (!state.shellForeground) return { ok: false, reason: 'not-shell' };
  if (state.agent && AGENTS.has(state.agent)) return { ok: false, reason: 'agent-alive' };
  if (consecutiveNoAgent < 2) return { ok: false, reason: 'agent-not-absent-twice' };
  const scan = scanCrash(state.lines);
  // A wrapper job line is proof; otherwise only a bare abort line counts (a resumed agent that died again).
  const bareScan = scan ? null : scanBareAbort(state.lines);
  const crash = scan
    ? parseCrashCommand(scan.line, state.tmuxName || state.name)
    : bareScan && { name: state.tmuxName || state.name, model: state.model || null, line: bareScan.line };
  if (!crash) return { ok: false, reason: 'no-exact-job-message' };
  const bare = !!bareScan;
  // The session's directory is gone (deleted worktree): resuming there would fail or run in the wrong place. Needs the owner/manager.
  if ((scan || bareScan).cwdGone || /\(deleted\)\s*$/.test(state.cwd || '')) return { ok: false, reason: 'cwd-gone', crash, bare };
  if (lastResumeAt != null && now - lastResumeAt < intervalMs) return { ok: false, reason: 'throttled' };
  const command = buildCrashResumeCommand({ base: state.base, crash, model: state.model, claudeSessionId: state.claudeSessionId });
  return command ? { ok: true, command, crash, bare } : { ok: false, reason: 'missing-resume-data', crash, bare };
}

// Claude Code session id of a crashed job, from its transcripts: newest *.jsonl under ~/.claude/projects/<cwd with / and . as ->
// whose tail names the session (agentName/customTitle). The crashed pid's own session file is deleted on abort.
export async function findClaudeSessionId({ name, cwd, projectsDir, fs }) {
  if (!name || !cwd || !projectsDir || !fs) return null;
  const dir = `${projectsDir}/${String(cwd).replace(/ \(deleted\)$/, '').replace(/[/.]/g, '-')}`;
  let files;
  try {
    files = await Promise.all((await fs.readdir(dir)).filter((f) => /^[A-Za-z0-9-]+\.jsonl$/.test(f)).map(async (f) => ({ f, t: (await fs.stat(`${dir}/${f}`)).mtimeMs })));
  } catch { return null; }
  files.sort((a, b) => b.t - a.t);
  const needle = [`"agentName":"${name}"`, `"customTitle":"${name}"`];
  for (const { f } of files.slice(0, 40)) {
    try {
      const tail = await fs.readTail(`${dir}/${f}`, 262144);
      if (needle.some((n) => tail.includes(n))) return f.replace(/\.jsonl$/, '');
    } catch { /* unreadable: next */ }
  }
  return null;
}

export function createCrashResumer({ getState, sendText, sendEnter, record, managerSessions = () => [], now = Date.now, intervalMs = DEFAULT_INTERVAL, resolveSessionId = null } = {}) {
  const absent = new Map(), resumed = new Map(), closed = new Set(), handled = new Map(), crashes = new Map(), looped = new Set();
  // Resumes of this session inside the rolling window: the 4th crash in 6 h is a loop, not something to resume again.
  const hitsIn = (name, t) => (crashes.get(name) || []).filter((x) => t - x < CRASH_LOOP_MS);
  const recordClose = (name, reason) => { closed.add(name); record?.({ key: `health:session-closed:${name}`, kind: 'health', title: `session closed: ${name}`, body: String(reason || 'closed').slice(0, 120) }); };
  // Runs every poll for every session (a pane that was already dead before ghosty started is covered after two polls).
  // Each crash job line is acted on once per session: resumed, or recorded as a manager item.
  async function tick(names) {
    const out = [];
    for (const name of names || []) {
      const state = await getState(name);
      if (!state) continue;
      const n = state.agent && AGENTS.has(state.agent) ? 0 : (absent.get(name) || 0) + 1;
      absent.set(name, n);
      const args = { state, consecutiveNoAgent: n, managerSessions: managerSessions(), closed: closed.has(name), lastResumeAt: resumed.get(name), now: now(), intervalMs };
      let d = decideCrashResume(args);
      if (!d.ok && d.reason === 'missing-resume-data' && resolveSessionId && !state.claudeSessionId) {
        const sid = await resolveSessionId({ name: d.crash?.name || name, cwd: state.cwd }).catch(() => null);
        if (sid) d = decideCrashResume({ ...args, state: { ...state, claudeSessionId: sid } });
      }
      // A bare abort line repeats across crashes, so it is handled once per resume (new key after every resume).
      const key = d.bare ? `bare@${resumed.get(name) ?? 'none'}` : d.crash?.line;
      if (d.crash && (d.ok || d.reason === 'cwd-gone' || d.reason === 'missing-resume-data')) {
        if (handled.get(name) === key) { out.push({ name, ok: false, reason: 'already-handled', crash: d.crash }); continue; }
      }
      // Crash loop: handed to the manager once per window, then the session is left alone until the window passes.
      const t = d.ok ? now() : 0, hits = d.ok ? hitsIn(name, t) : null;
      if (hits && hits.length >= CRASH_LOOP_MAX) {
        out.push({ name, ok: false, reason: 'crash-loop', crash: d.crash, bare: d.bare });
        if (!looped.has(name)) { looped.add(name); await record?.({ key: `health:session-crash-loop:${name}`, kind: 'health', title: `session crash loop, needs manual resume: ${name}`, body: `${hits.length + 1} crashes in 6 h; last: ${d.crash.line}` }); }
        continue;
      }
      out.push({ name, ...d });
      if (d.reason === 'cwd-gone' || d.reason === 'missing-resume-data') {
        handled.set(name, key);
        await record?.({ key: `health:session-crash-needs-owner:${name}`, kind: 'health', title: `session crashed, needs manual resume: ${name}`, body: d.reason === 'cwd-gone' ? `directory ${state.cwd || ''} is gone (deleted worktree): recreate it, then resume ${d.crash.name}` : `no Claude session id found for ${d.crash.name}` });
        continue;
      }
      if (!d.ok) continue;
      handled.set(name, key);
      await sendText(name, d.command);
      await sendEnter(name);
      resumed.set(name, now());
      crashes.set(name, [...hits, t]);
      looped.delete(name);
      await record?.({ key: `health:session-crash-resumed:${name}`, kind: 'health', title: `session crash resumed: ${name}`, body: `name=${d.crash.name} command=${d.command}` });
    }
    return out;
  }
  return { tick, recordClose, decide: decideCrashResume };
}

export const CRASH_RESUME_DEFAULTS = { MIN_INTERVAL_MS: DEFAULT_INTERVAL };
