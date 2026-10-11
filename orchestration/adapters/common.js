// Shared adapter machinery: guarded spawn, cwd/env validation, run lifecycle, error taxonomy.
// Side effects (spawn, fs, clock) are injected; defaults bind the real ones.
import { spawn as nodeSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchWarnings } from '../../launch-config.js';

export function coded(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}
export const unsupported = (adapter, op) => coded('E_UNSUPPORTED', `${adapter}: ${op} is not supported`);

// ---- permission / sandbox bypass guard -------------------------------------------------------
// Element-wise on argv (never on the prompt, which is free text). Aligned with launch-config launchWarnings.
const BYPASS_SINGLE = /^--(?:allow-)?dangerously-[\w-]+$|^--yolo$|^--auto$|^--bypass-[\w-]+$/;
const BYPASS_PAIRS = [
  [/^--permission-mode$/, /^bypassPermissions$/],
  [/^--permission$/, /^(?:off|full)$/],
  [/^(?:-s|--sandbox)$/, /^danger-full-access$/],
  [/^(?:-a|--ask-for-approval)$/, /^never$/],
  [/^(?:-c|--config)$/, /(?:sandbox_mode|sandbox)\s*=\s*["']?danger-full-access|approval_policy\s*=\s*["']?never|bypassPermissions/],
  // Inline JSON only: a settings *file* path cannot be inspected here (residual risk, see below).
  [/^--settings$/, /bypassPermissions|"defaultMode"\s*:\s*"bypass|skipDangerousModePermissionPrompt/],
];
// Residual risk the guard cannot see (only reachable through the injected `extraArgs`, which callers must vet):
// `--profile`/config files that relax the sandbox, `--add-dir /`, an unscoped `--allowedTools Bash`, settings files.

export function findBypass(argv, skip = []) {
  const skipSet = new Set(skip);
  const flagged = [];
  argv.forEach((el, i) => {
    if (skipSet.has(i) || typeof el !== 'string') return;
    let flag = el;
    let inlineVal = null;
    if (el.startsWith('--') && el.includes('=')) {
      flag = el.slice(0, el.indexOf('='));
      inlineVal = el.slice(el.indexOf('=') + 1);
    } else if (/^-[A-Za-z]./.test(el)) { // attached short option: -sVALUE, -s=VALUE
      flag = el.slice(0, 2);
      inlineVal = el.slice(2).replace(/^=/, '');
    }
    if (BYPASS_SINGLE.test(flag)) flagged.push(el);
    for (const [fre, vre] of BYPASS_PAIRS) {
      if (!fre.test(flag)) continue;
      const val = inlineVal ?? (typeof argv[i + 1] === 'string' ? argv[i + 1] : '');
      if (vre.test(val)) flagged.push(`${flag} ${val}`);
    }
  });
  const rest = argv.filter((_, i) => !skipSet.has(i));
  // launchWarnings is advisory and also flags --full-auto for owner review; it keeps codex's workspace-write sandbox,
  // so the hard guard does not refuse it (D-011).
  if (!flagged.length && launchWarnings({ AGENT_CMD_CLAUDE: rest.filter((x) => x !== '--full-auto').join(' ') }).length) flagged.push('launch-config pattern');
  return flagged;
}

export function assertNoBypass(argv, skip = []) {
  const f = findBypass(argv, skip);
  if (f.length) throw coded('E_BYPASS', `refusing permission/sandbox bypass in argv: ${f.join(', ')}`);
}

// ---- cwd and env -----------------------------------------------------------------------------
const inside = (root, p) => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export function validateCwd(cwd, allowedRoots, fs = nodeFs) {
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0') || !path.isAbsolute(cwd)) throw coded('E_CWD', 'cwd must be an absolute path');
  let real;
  try { real = fs.realpathSync(cwd); } catch { throw coded('E_CWD', 'cwd does not exist'); }
  if (!fs.statSync(real).isDirectory()) throw coded('E_CWD', 'cwd is not a directory');
  const roots = [];
  for (const r of allowedRoots || []) { try { roots.push(fs.realpathSync(r)); } catch { /* missing root allows nothing */ } }
  if (!roots.length) throw coded('E_CWD', 'no allowed roots configured');
  if (!roots.some((r) => inside(r, real))) throw coded('E_CWD', 'cwd is outside the allowed roots');
  return real;
}

const BASE_ENV = /^(?:PATH|HOME|LANG|LC_ALL|LC_CTYPE|TERM|TMPDIR|USER|LOGNAME|TZ|XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME|(?:HTTPS?|NO)_PROXY|(?:https?|no)_proxy)$/;

// Allowlist, never a denylist: unrelated secrets in the parent env must not reach a worker.
export function buildEnv(source, allow = [], explicit = {}) {
  const out = {};
  for (const [k, v] of Object.entries(source || {})) {
    if (typeof v !== 'string') continue;
    if (BASE_ENV.test(k) || allow.some((a) => (a instanceof RegExp ? a.test(k) : a === k))) out[k] = v;
  }
  // Explicit env is trusted for names, not for code-loading hooks.
  for (const [k, v] of Object.entries(explicit || {})) if (typeof v === 'string' && !/^(?:NODE_OPTIONS|LD_.*|DYLD_.*)$/.test(k)) out[k] = v;
  return out;
}

export function resolveBin(bin, name, env, fs = nodeFs) {
  if (bin) return bin;
  if (env?.HOME) {
    const p = path.join(env.HOME, '.local', 'bin', name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* fall through to PATH */ }
  }
  return name;
}

// ---- JSONL ------------------------------------------------------------------------------------
export function createLineParser(onLine, maxLine = 1 << 20) {
  let buf = '';
  let discarding = false; // inside the tail of a runaway line: never parse it as a new line
  return {
    write(chunk) {
      let data = chunk;
      if (discarding) {
        const nl = data.indexOf('\n');
        if (nl < 0) return;
        discarding = false;
        data = data.slice(nl + 1);
      }
      buf += data;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
      if (buf.length > maxLine) { onLine(buf.slice(0, 256)); buf = ''; discarding = true; }
    },
    end() { if (buf.trim() && !discarding) onLine(buf); buf = ''; },
  };
}

export function parseJsonLine(line) {
  const t = line.trim();
  if (t[0] !== '{') return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export function usageFrom(o) {
  if (!o || typeof o !== 'object') return null;
  const u = o.usage || o.token_usage || o.tokens || null;
  const input = u ? num(u.input_tokens ?? u.prompt_tokens ?? u.input) : null;
  const output = u ? num(u.output_tokens ?? u.completion_tokens ?? u.output) : null;
  const usd = num(o.total_cost_usd ?? o.cost_usd ?? o.usd ?? u?.cost_usd);
  if (input === null && output === null && usd === null) return null;
  return { input_tokens: input, output_tokens: output, usd };
}

// Fallback parser for CLIs whose stream format is not verified: map what is recognisable, keep the rest as 'event'.
export function genericParse(o) {
  const t = String(o.type ?? o.event ?? '');
  const sid = o.session_id ?? o.sessionId ?? o.thread_id ?? null;
  const text = typeof o.text === 'string' ? o.text : typeof o.content === 'string' ? o.content : typeof o.message === 'string' ? o.message : null;
  const usage = usageFrom(o);
  let events;
  if (/error/i.test(t)) events = [{ type: 'error', text }];
  else if (/tool/i.test(t)) events = [{ type: 'tool_use', name: typeof o.name === 'string' ? o.name : null }];
  else if (/^(?:result|done|complete|finish)/i.test(t)) events = [{ type: 'result', ok: !o.is_error, text }];
  else if (/text|message|assistant/i.test(t) && text !== null) events = [{ type: 'text', text }];
  else if (/start|init|session/i.test(t)) events = [{ type: 'started', session_id: sid }];
  else events = [{ type: 'event', kind: t || null }];
  return { events, usage, session_id: sid, error_text: events[0].type === 'error' ? text : null };
}

// ---- error taxonomy ---------------------------------------------------------------------------
const RETRYABLE = { rate_limit: true, timeout: true };

export function parseRetryAfterMs(text, nowMs = null) {
  const m = /(?:retry[-_ ]?after|try again in|retry in|resets? in)\D{0,3}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)?\b/i.exec(text || '');
  if (m) {
    const n = Number(m[1]);
    const u = (m[2] || 's').toLowerCase();
    const mult = /^(?:ms|milli)/.test(u) ? 1 : /^(?:m|min)/.test(u) ? 60000 : /^(?:h)/.test(u) ? 3600000 : /^d/.test(u) ? 86400000 : 1000; // bare number = seconds
    return Math.round(n * mult);
  }
  // codex: "try again at 3:45 PM" in local wall-clock time; best effort, null when it does not parse.
  const t = /try again at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text || '');
  if (t && nowMs !== null) {
    let h = Number(t[1]);
    const min = Number(t[2]);
    if (t[3]) h = (h % 12) + (t[3].toLowerCase() === 'pm' ? 12 : 0);
    if (h > 23 || min > 59) return null;
    const d = new Date(nowMs);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return d.getTime() - nowMs;
  }
  return null;
}

export function normalizeError(input, nowMs = null) {
  const i = input || {};
  const text = `${i.stderr ?? ''}\n${i.message ?? ''}`;
  let cls;
  let retry_after_ms = null;
  if (i.timed_out) cls = 'timeout';
  else if (i.code === 'ENOENT' || i.exit === 127 || (i.code === 'EACCES' && /^spawn/.test(i.syscall || '')) || /command not found|not installed|executable file not found/i.test(text)) cls = 'unavailable';
  else if (/rate[ _-]?limit|\bHTTP[ /]*429\b|\b429 too many requests|status(?: code)?[:= ]+429|\berror[: ]+429\b|too many requests|overloaded(?:_error)?\b|(?:usage|quota|credit)s? (?:limit|exceeded|exhausted)|exceeded your (?:current )?quota|hit your usage limit|insufficient_quota|rate_limit_error/i.test(text)) { cls = 'rate_limit'; retry_after_ms = parseRetryAfterMs(text, nowMs) ?? (Number.isFinite(i.retry_after_ms) ? i.retry_after_ms : null); }
  else if (/context (?:length|window)|too long|token limit|maximum context|context_length_exceeded|exceeds? the (?:maximum|context)/i.test(text)) cls = 'context_overflow';
  else if (/\bHTTP[ /]*401\b|\b401 unauthori[sz]ed|status(?: code)?[:= ]+401|unauthori[sz]ed|not logged in|please (?:log ?in|run .{0,20}login)|authentication (?:failed|error|required)|invalid (?:api[ _-]?key|x-api-key)|invalid_api_key|\bauthentication_error|\bProviderAuthError\b/i.test(text)) cls = 'auth';
  else if (/permission denied|approval (?:required|denied)|requires approval|operation not permitted|\beacces\b|status(?: code)?[:= ]+403|HTTP[ /]*403/i.test(text)) cls = 'permission';
  else if (i.signal || (typeof i.exit === 'number' && i.exit !== 0)) cls = 'crash';
  else cls = 'unknown';
  // crash is retryable only for signal deaths (OOM/SEGV/KILL); a plain non-zero exit is usually deterministic.
  return { class: cls, retryable: !!RETRYABLE[cls] || (cls === 'crash' && !!i.signal), retry_after_ms };
}

// ---- run lifecycle ----------------------------------------------------------------------------
const ctls = new WeakMap();
const ID = /^[\w.-]+$/;
const MAX_EVENTS = 50000;

export function createRunCore({ adapter, task_id, run_id, cwd, artifact_dir, fs = nodeFs, now = Date.now, timeout_ms, usageMode = 'last' }) {
  if (!ID.test(String(run_id)) || run_id === '.' || run_id === '..') throw coded('E_INVALID', 'run_id must match [\\w.-]+');
  if (timeout_ms !== undefined && timeout_ms !== null && !(Number.isFinite(timeout_ms) && timeout_ms > 0)) throw coded('E_INVALID', 'timeout_ms must be a positive number');
  const run = {
    run_id, task_id, adapter, cwd, pid: null, session_id: null, started_at: now(), ended_at: null,
    artifact_dir: artifact_dir || null, events: [], usage: { input_tokens: null, output_tokens: null, usd: null },
    result: null, cancelled: false, timed_out: false, usage_incomplete: false, pgid: null,
  };
  let resolveDone;
  Object.defineProperty(run, 'done', { value: new Promise((r) => { resolveDone = r; }), enumerable: false });
  const c = { overCap: 0, waiters: [], errorTexts: [], stderr: '', finished: false, kill: () => {}, timer: null, seq: 0, artifactFailed: false };
  ctls.set(run, c);
  if (run.artifact_dir) fs.mkdirSync(run.artifact_dir, { recursive: true, mode: 0o700 });

  const wake = () => { const w = c.waiters.splice(0); w.forEach((r) => r()); };
  const core = {
    run, ctl: c,
    push(ev) {
      if (c.finished || (run.cancelled && ev.type !== 'exit')) return; // no events after cancel except the final exit
      // Over the cap, junk is dropped but terminal facts (result, error) are always kept.
      if (run.events.length >= MAX_EVENTS && (ev.type !== 'result' && ev.type !== 'error' || ++c.overCap > 100)) { run.dropped_events = (run.dropped_events || 0) + 1; return; }
      run.events.push({ seq: c.seq++, at: now(), run_id, ...ev });
      wake();
    },
    raw(stream, text) {
      if (!run.artifact_dir || run.cancelled || c.finished) return;
      try { fs.appendFileSync(path.join(run.artifact_dir, `${stream}.log`), text, { mode: 0o600 }); } catch {
        if (!c.artifactFailed) { c.artifactFailed = true; core.push({ type: 'artifact_error' }); }
      }
    },
    noteStderr(text) { if (!run.cancelled) c.stderr = (c.stderr + text).slice(-65536); },
    noteError(text) { if (text && c.errorTexts.length < 20) c.errorTexts.push(String(text).slice(0, 2000)); },
    noteHint(h) { if (Number.isFinite(h)) c.retryHint = h; },
    addUsage(u, mode = usageMode) {
      if (!u) return;
      if (u.incomplete) run.usage_incomplete = true;
      for (const k of ['input_tokens', 'output_tokens', 'usd']) {
        if (u[k] === null || u[k] === undefined) continue;
        run.usage[k] = mode === 'sum' && run.usage[k] !== null ? run.usage[k] + u[k] : u[k];
      }
    },
    setKill(fn) { c.kill = fn; },
    cancel() {
      if (c.finished) return;
      run.cancelled = true;
      c.kill('cancel');
    },
    finish({ exit = null, signal = null, spawn_error = null } = {}) {
      if (c.finished) return;
      if (c.timer) clearTimeout(c.timer);
      c.kill('final'); // always sweep the process group: a background child must not edit the tree after done
      const errText = c.errorTexts.join('\n');
      let error = null;
      if (run.timed_out) error = normalizeError({ timed_out: true });
      else if (run.cancelled) error = null;
      else if (spawn_error) error = normalizeError({ code: spawn_error.code, syscall: spawn_error.syscall, message: spawn_error.message });
      // An error *event* alongside exit 0 (e.g. a transient reconnect notice) is not a failed run; the event stays visible.
      else if ((exit !== 0 && exit !== null) || signal) error = normalizeError({ exit, signal, stderr: `${c.stderr}\n${errText}`, retry_after_ms: c.retryHint }, now());
      const result = { exit, signal, timed_out: run.timed_out, cancelled: run.cancelled, error };
      run.events.push({ seq: c.seq++, at: now(), run_id, type: 'exit', ...result });
      c.finished = true;
      run.result = result;
      run.ended_at = now();
      wake();
      resolveDone(result);
    },
  };
  if (timeout_ms) {
    c.timer = setTimeout(() => { run.timed_out = true; c.kill('timeout'); }, timeout_ms);
    c.timer.unref?.();
  }
  return core;
}

export function observeRun(run) {
  const c = ctls.get(run);
  if (!c) throw coded('E_INVALID', 'unknown run');
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          for (;;) {
            if (i < run.events.length) return { value: run.events[i++], done: false };
            if (c.finished) return { value: undefined, done: true };
            await new Promise((r) => c.waiters.push(r));
          }
        },
      };
    },
  };
}

export async function cancelRun(run) {
  const c = ctls.get(run);
  if (!c) throw coded('E_INVALID', 'unknown run');
  if (c.finished) return { acknowledged: true, already_finished: true };
  run.cancelled = true;
  c.kill('cancel');
  await run.done;
  return { acknowledged: true, already_finished: false };
}

export function collectUsage(run) {
  return { input_tokens: run.usage.input_tokens ?? null, output_tokens: run.usage.output_tokens ?? null, usd: run.usage.usd ?? null, incomplete: run.usage_incomplete === true };
}

// ---- process-backed run -----------------------------------------------------------------------
export function spawnRun({ spawnFn = nodeSpawn, bin, argv, skip = [], cwd, allowedRoots, env, fs = nodeFs, now, parse, usageMode, killGraceMs = 2000, exitGraceMs = 500, meta }) {
  assertNoBypass(argv, skip);
  const realCwd = validateCwd(cwd, allowedRoots, fs);
  const core = createRunCore({ ...meta, cwd: realCwd, fs, now, usageMode });
  const { run } = core;
  if (meta.session_id) run.session_id = meta.session_id;

  let child;
  try {
    child = spawnFn(bin, argv, { cwd: realCwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false });
  } catch (e) {
    queueMicrotask(() => core.finish({ spawn_error: e }));
    return run;
  }
  run.pid = child.pid ?? null;
  run.pgid = run.pid; // detached => leader of its own group; recorded so crash recovery can sweep orphans
  if (run.artifact_dir && run.pid) { try { fs.writeFileSync(path.join(run.artifact_dir, 'process.json'), JSON.stringify({ pid: run.pid, pgid: run.pgid, started_at: run.started_at }), { mode: 0o600 }); } catch { /* best effort */ } }
  let escalate = null;
  const killGroup = (sig) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } }
  };
  core.setKill((why) => {
    if (why === 'final') { killGroup('SIGKILL'); if (escalate) clearTimeout(escalate); return; }
    killGroup('SIGTERM');
    if (escalate) clearTimeout(escalate);
    escalate = setTimeout(() => killGroup('SIGKILL'), killGraceMs);
    escalate.unref?.();
  });

  const lines = createLineParser((line) => {
    core.raw('stdout', line + '\n');
    const obj = parseJsonLine(line);
    if (!obj) { core.push({ type: 'unparsed', bytes: Buffer.byteLength(line) }); return; }
    let r;
    try { r = parse(obj, now()); } catch { r = genericParse(obj); }
    if (r.session_id && !run.session_id) run.session_id = String(r.session_id);
    core.addUsage(r.usage);
    core.noteError(r.error_text);
    core.noteHint(r.retry_after_ms);
    for (const ev of r.events) core.push(ev);
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d) => lines.write(d));
  child.stdout?.on('end', () => lines.end());
  child.stderr?.on('data', (d) => { core.raw('stderr', d); core.noteStderr(d); });
  child.on('error', (e) => core.finish({ spawn_error: e }));
  child.on('close', (code, signal) => { lines.end(); core.finish({ exit: code, signal }); });
  // An escaped grandchild (setsid) can hold the pipes open forever: after the leader exits, wait briefly, then cut stdio.
  child.on('exit', (code, signal) => {
    const t = setTimeout(() => {
      child.stdout?.destroy(); child.stderr?.destroy();
      lines.end(); core.finish({ exit: code, signal });
    }, exitGraceMs);
    t.unref?.();
  });
  core.push({ type: 'spawned', pid: run.pid });
  return run;
}

// `<bin> --version`: false on ENOENT, 'unknown' on ambiguous failure, true with a version string otherwise.
export function probeVersion({ spawnFn = nodeSpawn, bin, env, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let child;
    const end = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); };
    const t = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      end({ available: 'unknown', version: null });
    }, timeoutMs);
    try {
      child = spawnFn(bin, ['--version'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false });
    } catch (e) { end({ available: e.code === 'ENOENT' ? false : 'unknown', version: null }); return; }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', () => {});
    child.on('error', (e) => end({ available: e.code === 'ENOENT' ? false : 'unknown', version: null }));
    child.on('close', (code) => {
      const v = /\d+\.\d+\.\d+[\w.+-]*/.exec(out);
      end(code === 0 && v ? { available: true, version: v[0] } : { available: 'unknown', version: null });
    });
  });
}

// ---- CLI adapter factory ----------------------------------------------------------------------
const SAFE_VAL = /^[\w][\w./:@=+-]*$/;
export function makeCliAdapter(spec) {
  return function createAdapter(opts = {}) {
    const {
      spawn = nodeSpawn, env = process.env, now = Date.now, bin, allowedRoots = [], artifactDir = null,
      extraArgs = [], killGraceMs = 2000, exitGraceMs = 500, probeTimeoutMs = 3000, fs = nodeFs, randomId = randomUUID,
    } = opts;
    const binPath = resolveBin(bin, spec.defaultBin, env, fs);

    function begin(o, resumeId) {
      if (!o || typeof o.prompt !== 'string' || !o.prompt) throw coded('E_INVALID', 'prompt required');
      for (const k of ['model', 'effort', 'session_id']) if (o[k] != null && (typeof o[k] !== 'string' || !SAFE_VAL.test(o[k]))) throw coded('E_INVALID', `${k} has an unsafe value`);
      if (o.effort != null) {
        if (spec.noEffort) throw unsupported(spec.id, 'effort');
        if (spec.efforts && !spec.efforts.includes(o.effort)) throw coded('E_INVALID', `effort must be one of ${spec.efforts.join(',')}`);
      }
      const realCwd = validateCwd(o.cwd, allowedRoots, fs); // argv gets the validated path, not the caller's (symlink) one
      const run_id = o.run_id || randomId();
      const head = spec.head({ ...o, cwd: realCwd, resume_id: resumeId || null, session_id: o.session_id || (spec.ownSessionId && !resumeId ? randomUUID() : null) });
      const dash = o.prompt.startsWith('-') ? ['--'] : [];
      const argv = [...head.args, ...extraArgs, ...dash, o.prompt];
      return spawnRun({
        spawnFn: spawn, bin: binPath, argv, skip: [argv.length - 1], cwd: realCwd, allowedRoots, fs, now,
        env: buildEnv(env, spec.envAllow, o.env), parse: spec.parse, usageMode: spec.usageMode, killGraceMs, exitGraceMs,
        meta: {
          adapter: spec.id, task_id: o.task_id ?? null, run_id, artifact_dir: o.artifact_dir || (artifactDir ? path.join(artifactDir, String(run_id)) : null),
          timeout_ms: o.timeout_ms, session_id: head.session_id || resumeId || null,
        },
      });
    }

    return {
      id: spec.id,
      provider_ids: spec.provider_ids,
      async probeCapabilities() {
        const p = await probeVersion({ spawnFn: spawn, bin: binPath, env: buildEnv(env, spec.envAllow), timeoutMs: probeTimeoutMs });
        return { available: p.available, version: p.version, models: null, efforts: spec.efforts ?? null, features: { ...spec.features } };
      },
      start: (o) => begin(o, null),
      observe: observeRun,
      send() { throw unsupported(spec.id, 'send'); },
      cancel: cancelRun,
      collectUsage,
      normalizeError,
      resume(ref) {
        if (!spec.resume) throw unsupported(spec.id, 'resume');
        const sid = ref?.session_id;
        if (typeof sid !== 'string' || !SAFE_VAL.test(sid)) throw coded('E_INVALID', 'resume needs a valid session_id');
        return begin({ ...ref, prompt: ref.prompt || 'continue' }, sid);
      },
    };
  };
}
