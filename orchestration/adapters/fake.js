// Scriptable in-process runtime for E2E. A script is an array of steps run in order:
//   {op:'write', path, content}   write a file under cwd (path may not escape cwd)
//   {op:'emit', event:{type,...}} emit a normalized event      {op:'usage', input_tokens, output_tokens, usd}
//   {op:'stderr', text}           stderr text (feeds error classification)   {op:'delay', ms}
//   {op:'exit', code}             end the run (default end: exit 0)   {op:'hang'}   block until cancel/timeout
// `scripts` = one script per start (last repeats), `script` = same script every start, start({script}) overrides.
import nodeFs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { coded, unsupported, validateCwd, createRunCore, observeRun, cancelRun, collectUsage, normalizeError } from './common.js';

export function createAdapter(opts = {}) {
  const { now = Date.now, allowedRoots = [], artifactDir = null, fs = nodeFs, randomId = randomUUID, script = null, scripts = null } = opts;
  let starts = 0;

  function begin(o) {
    const steps = o.script ?? (scripts ? scripts[Math.min(starts, scripts.length - 1)] : script) ?? [];
    starts++;
    if (!Array.isArray(steps)) throw coded('E_INVALID', 'script must be an array');
    const realCwd = validateCwd(o.cwd, allowedRoots, fs);
    const run_id = o.run_id || randomId();
    const core = createRunCore({
      adapter: 'fake', task_id: o.task_id ?? null, run_id, cwd: realCwd, fs, now, timeout_ms: o.timeout_ms, usageMode: 'sum',
      artifact_dir: o.artifact_dir || (artifactDir ? path.join(artifactDir, String(run_id)) : null),
    });
    const { run } = core;
    run.session_id = `fake-${run_id}`;
    let timer = null;
    let wakeSleep = null;
    const aborted = () => run.cancelled || run.timed_out;
    core.setKill(() => { if (timer) clearTimeout(timer); wakeSleep?.(); });
    const sleep = (ms) => new Promise((r) => { wakeSleep = r; timer = setTimeout(r, ms); });

    (async () => {
      await Promise.resolve(); // let the caller cancel "during spawn" before the first step
      let exit = 0;
      core.push({ type: 'started', session_id: run.session_id });
      for (const s of steps) {
        if (aborted()) break;
        if (s.op === 'delay') await sleep(Number(s.ms) || 0);
        else if (s.op === 'hang') { while (!aborted()) await sleep(3600_000); }
        if (aborted()) break; // re-check: a delay may have been cut short by cancel
        if (s.op === 'write') {
          const target = path.resolve(realCwd, String(s.path));
          const rel = path.relative(realCwd, target);
          if (rel.startsWith('..') || path.isAbsolute(rel) || !rel) { core.noteError('script write escapes cwd'); exit = 1; break; }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          // Never follow a symlink out of cwd: check the real parent, then open the leaf with O_NOFOLLOW.
          const realParent = fs.realpathSync(path.dirname(target));
          const pr = path.relative(realCwd, realParent);
          if (pr.startsWith('..') || path.isAbsolute(pr)) { core.noteError('script write escapes cwd'); exit = 1; break; }
          try {
            const fd = fs.openSync(path.join(realParent, path.basename(target)), nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_TRUNC | nodeFs.constants.O_NOFOLLOW, 0o644);
            try { fs.writeSync(fd, String(s.content ?? '')); } finally { fs.closeSync(fd); }
          } catch { core.noteError('script write refused'); exit = 1; break; }
          core.push({ type: 'tool_use', name: 'write', path: rel });
        } else if (s.op === 'emit') core.push({ ...s.event });
        else if (s.op === 'usage') core.addUsage({ input_tokens: s.input_tokens ?? null, output_tokens: s.output_tokens ?? null, usd: s.usd ?? null });
        else if (s.op === 'stderr') { core.raw('stderr', String(s.text)); core.noteStderr(String(s.text)); }
        else if (s.op === 'exit') { exit = Number(s.code) || 0; break; }
      }
      core.finish({ exit: aborted() ? null : exit, signal: aborted() ? 'SIGTERM' : null });
    })();
    return run;
  }

  return {
    id: 'fake',
    provider_ids: ['fake'],
    async probeCapabilities() {
      return { available: true, version: 'fake-1', models: ['fake-model'], efforts: ['low', 'medium', 'high'], features: { resume: true, cancel: true, json_output: true, native_subagents: false, vision: false } };
    },
    start: begin,
    observe: observeRun,
    send() { throw unsupported('fake', 'send'); },
    cancel: cancelRun,
    collectUsage,
    normalizeError,
    resume(ref) { return begin({ ...ref, prompt: ref?.prompt || 'continue' }); },
  };
}
export default createAdapter;
