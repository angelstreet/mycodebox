// V2 CI gates (spec §12.3 step 4-5, T24/T28/T29): run the project's gate commands on the exact integration SHA
// with fresh temporary state, and read the remote CI verdict for that SHA. Local green never replaces remote CI:
// only a remote 'success' for the same SHA passes.
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn as realSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const CI_STATUSES = Object.freeze(['success', 'failure', 'pending', 'missing', 'unknown']);
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const isArgv = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s !== '');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  : JSON.stringify(v));

// Gate list from project policy: `ci_gates: [{ id, command }]`, else the single `test_command`. [] = nothing to
// run, which callers must treat as "no local verification", never as a pass.
export function gatesFromPolicy(policy) {
  const p = policy?.ok === true ? policy.policy : policy;
  if (Array.isArray(p?.ci_gates)) return p.ci_gates.filter((g) => g && ID_RE.test(g.id ?? '') && isArgv(g.command)).map((g) => ({ id: g.id, command: [...g.command] }));
  return isArgv(p?.test_command) ? [{ id: 'test', command: [...p.test_command] }] : [];
}

// Anything that is not a recognized status for the very SHA asked about is 'unknown'.
export function normalizeCiStatus(v, sha) {
  const s = typeof v === 'string' ? v : v && typeof v === 'object' ? v.status : null;
  if (v && typeof v === 'object' && v.sha !== undefined && v.sha !== sha) return 'unknown';
  return CI_STATUSES.includes(s) ? s : 'unknown';
}
export const ciPasses = (status) => status === 'success';

// remoteCi.status(sha) is injected; a throw or a timeout is 'unknown' (fail closed).
export async function remoteStatus(remoteCi, sha, { timeoutMs = 30_000 } = {}) {
  if (!remoteCi || typeof remoteCi.status !== 'function') return { status: 'missing', sha, reason: 'no remote CI configured' };
  let t;
  try {
    const raw = await Promise.race([Promise.resolve().then(() => remoteCi.status(sha)),
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error('remote CI status timeout')), timeoutMs); })]);
    return { status: normalizeCiStatus(raw, sha), sha, raw: typeof raw === 'object' && raw ? { ...raw } : raw };
  } catch (e) {
    return { status: 'unknown', sha, reason: String(e?.message || e).slice(0, 200) };
  } finally { clearTimeout(t); }
}

// What the gate's environment looks like, minus per-run temp paths: same hash = comparable runs.
export function envFingerprint({ command, env, versions = process.versions, platform = process.platform, arch = process.arch }) {
  const vars = Object.fromEntries(Object.entries(env).filter(([k]) => !['GHOSTY_STATE_DIR', 'HOME', 'TMPDIR'].includes(k)));
  return sha256(stable({ command, vars, node: versions.node, platform, arch }));
}

export function createCiGates({
  fs = realFs, spawn = realSpawn, git, now = () => Date.now(), tmpRoot = tmpdir(), artifactsDir, baseEnv,
  timeoutMs = 30 * 60_000, actor = { role: 'integration', id: 'ci-gates' },
} = {}) {
  if (typeof git !== 'function') throw Object.assign(new Error('ci-gates: git runner required'), { code: 'E_CONFIG' });
  if (!artifactsDir) throw Object.assign(new Error('ci-gates: artifactsDir required'), { code: 'E_CONFIG' });
  const envBase = baseEnv || { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' };

  function runOne(command, { cwd, env, timeout }) {
    return new Promise((resolve) => {
      const chunks = [];
      let timedOut = false, child;
      const started = now();
      try { child = spawn(command[0], command.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { resolve({ exit: null, error: String(e?.message || e), output: Buffer.alloc(0), duration_ms: 0 }); return; }
      const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
      child.stdout?.on('data', (d) => chunks.push(d));
      child.stderr?.on('data', (d) => chunks.push(d));
      let spawnErr = null;
      child.on('error', (e) => { spawnErr = e; });
      child.on('close', (code) => {
        clearTimeout(t);
        // Killed, crashed or unspawnable: exit is unknown (null), never 0.
        const exit = timedOut || spawnErr || code === null ? null : code;
        resolve({ exit, timedOut, error: spawnErr ? String(spawnErr.message) : timedOut ? 'timeout' : null,
          output: Buffer.concat(chunks), duration_ms: Math.max(0, now() - started) });
      });
    });
  }

  const head = async (cwd) => (await git(['rev-parse', 'HEAD'], { cwd })).trim();
  const trackedDirty = async (cwd) => (await git(['status', '--porcelain=v1', '--untracked-files=no'], { cwd })).trim() !== '';

  // -> { ok, sha, evidence[], invalidated: null | reason }. ok only when every gate exits 0 and the tree stayed at
  // `sha` throughout: evidence is about the exact commit or it is not evidence.
  async function run({ cwd, sha, gates, env: extraEnv = {}, timeout = timeoutMs }) {
    if (!SHA_RE.test(sha ?? '')) throw Object.assign(new Error('ci-gates: full sha required'), { code: 'E_INVALID' });
    const evidence = [];
    if (!Array.isArray(gates) || !gates.length) return { ok: false, sha, evidence, invalidated: null, reason: 'no gates configured' };
    if ((await head(cwd)) !== sha || await trackedDirty(cwd)) return { ok: false, sha, evidence, invalidated: 'worktree is not clean at the expected sha before gates' };
    const outDir = join(artifactsDir, sha);
    fs.mkdirSync(outDir, { recursive: true });
    for (const g of gates) {
      if (!ID_RE.test(g?.id ?? '') || !isArgv(g?.command)) throw Object.assign(new Error(`ci-gates: invalid gate ${g?.id}`), { code: 'E_INVALID' });
      const stateDir = fs.mkdtempSync(join(tmpRoot, 'v2-gate-state-'));
      const homeDir = fs.mkdtempSync(join(tmpRoot, 'v2-gate-home-'));
      const env = { ...envBase, ...extraEnv, CI: '1', GHOSTY_STATE_DIR: stateDir, HOME: homeDir };
      const ts = new Date(now()).toISOString();
      let r;
      try { r = await runOne(g.command, { cwd, env, timeout }); }
      finally { for (const d of [stateDir, homeDir]) fs.rmSync(d, { recursive: true, force: true }); }
      const artifact = join(outDir, `${g.id.replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
      fs.writeFileSync(artifact, r.output);
      const ev = { check_id: g.id, sha, command: [...g.command], exit: r.exit, duration_ms: r.duration_ms, ts,
        env_fingerprint: envFingerprint({ command: g.command, env }), artifact, artifact_digest: `sha256:${sha256(r.output)}`,
        error: r.error, actor };
      evidence.push(ev);
      // A gate that moved HEAD or edited tracked files tested something else than `sha`.
      if ((await head(cwd)) !== sha || await trackedDirty(cwd)) return { ok: false, sha, evidence, invalidated: `gate ${g.id} changed the worktree` };
      if (r.exit !== 0) return { ok: false, sha, evidence, invalidated: null, reason: `gate ${g.id} exit ${r.exit}` };
    }
    return { ok: true, sha, evidence, invalidated: null };
  }

  return { run };
}
