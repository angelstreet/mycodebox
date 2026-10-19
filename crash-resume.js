// Strict crash detection and in-place resume. Keep this module pure except for the injected tick IO.

const AGENTS = new Set(['claude', 'codex', 'minimax']);
const JOB_RE = /line \d+: +\d+ (Aborted|Segmentation fault|Killed)\s/;
const REMOTE_RE = /(?:--remote-control|-n)(?:=|\s+)(['"]?)([A-Za-z0-9_.-]+)\1/;
const MODEL_RE = /--model(?:=|\s+)(['"]?)([A-Za-z0-9_.\[\]-]+)\1/;
const DEFAULT_INTERVAL = 30 * 60 * 1000;

export function crashLineOf(lines) {
  const tail = (Array.isArray(lines) ? lines : []).filter((x) => String(x || '').trim()).slice(-3);
  for (let i = tail.length - 1; i >= 0; i--) {
    if (JOB_RE.test(tail[i])) return tail[i];
  }
  return null;
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
  const crash = parseCrashCommand(crashLineOf(state.lines), state.tmuxName || state.name);
  if (!crash) return { ok: false, reason: 'no-exact-job-message' };
  if (lastResumeAt != null && now - lastResumeAt < intervalMs) return { ok: false, reason: 'throttled' };
  const command = buildCrashResumeCommand({ base: state.base, crash, model: state.model, claudeSessionId: state.claudeSessionId });
  return command ? { ok: true, command, crash } : { ok: false, reason: 'missing-resume-data' };
}

export function createCrashResumer({ getState, sendText, sendEnter, record, managerSessions = () => [], now = Date.now, intervalMs = DEFAULT_INTERVAL } = {}) {
  const absent = new Map(), resumed = new Map(), closed = new Set();
  const recordClose = (name, reason) => { closed.add(name); record?.({ key: `health:session-closed:${name}`, kind: 'health', title: `session closed: ${name}`, body: String(reason || 'closed').slice(0, 120) }); };
  async function tick(names) {
    const out = [];
    for (const name of names || []) {
      const state = await getState(name);
      if (!state) continue;
      const n = state.agent && AGENTS.has(state.agent) ? 0 : (absent.get(name) || 0) + 1;
      absent.set(name, n);
      const d = decideCrashResume({ state, consecutiveNoAgent: n, managerSessions: managerSessions(), closed: closed.has(name), lastResumeAt: resumed.get(name), now: now(), intervalMs });
      out.push({ name, ...d });
      if (!d.ok) continue;
      await sendText(name, d.command);
      await sendEnter(name);
      resumed.set(name, now());
      await record?.({ key: `health:session-crash-resumed:${name}`, kind: 'health', title: `session crash resumed: ${name}`, body: `name=${d.crash.name} command=${d.command}` });
    }
    return out;
  }
  return { tick, recordClose, decide: decideCrashResume };
}

export const CRASH_RESUME_DEFAULTS = { MIN_INTERVAL_MS: DEFAULT_INTERVAL };
