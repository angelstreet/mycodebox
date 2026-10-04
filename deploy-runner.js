// Deploy runner (TASK-44 phase 7). The registry (`vpt-lease deploy ...` on proxmox) holds the queue; this module polls
// it, and, only when `deployRunner` is on in manager.json, starts the oldest approved request whose resources are free
// and runs update_core.sh for it over ssh. Agents never run update_core themselves; they request and wait.
//
// Env map: $GHOSTY_STATE_DIR/deploy-envs.json (not in the repo), created with defaults on first run:
//   { "<env>": { "ssh": "<host>", "cmd": "bash update_core.sh", "health": "<optional remote command, exit 0 = healthy>" } }
// Test-only entry shape: { "argv": ["bash", "-c", "..."] } runs locally instead of ssh (env vars VPT_DEPLOY_REF/SCOPE set).
// Registry: ssh proxmox '~/bin/vpt-lease ...' by default; DEPLOY_REGISTRY='["python3","/path/vpt-lease"]' runs it locally.
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile, stat, open } from 'node:fs/promises';
import { createWriteStream, openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_ENVS = {
  'node1-vpt': { ssh: 'proxmox', cmd: 'bash update_core.sh' },
  'node3-qualiai': { ssh: 'proxmox3', cmd: 'bash update_core.sh' },
};
export const RUNNER_AGENT = 'manager:deploy';
export const DEFAULT_ORPHAN_IDLE_MS = 10 * 60 * 1000;
const SCOPE_FLAGS = { frontend: ['--frontend'], host: ['--host'], server: ['--server'], full: [] };   // update_core.sh: none = everything
const SAFE = /^[A-Za-z0-9_.\/:@=+-]+$/;
const shq = (s) => (SAFE.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
// What a finished deploy of scope A already deployed: a full deploy contains every part; the others only themselves.
export const covers = (a, b) => a === 'full' || a === b;
export const flagsFor = (scope) => SCOPE_FLAGS[scope] || null;
// full and host deploys never wait for a leased host: update_core.sh drops it (--skip-leased) and reports
// SKIPPED_HOSTS=a,b, which becomes a catch-up request. A request with `hosts` (the catch-up) deploys only those.
const skipsLeased = (d) => d.scope === 'full' || d.scope === 'host';
const HOST_NAME = /^[A-Za-z0-9_.-]+$/;
export const extraFlagsFor = (d) => [
  ...(skipsLeased(d) ? ['--skip-leased'] : []),
  ...(d.scope === 'host' && d.hosts?.length ? ['--hosts', d.hosts.join(',')] : []),
];
export const SKIPPED_RE = /^SKIPPED_HOSTS=(\S*)\s*$/;
export const parseSkipped = (lines) => {
  const hit = [...lines].reverse().map((l) => l.match(SKIPPED_RE)).find(Boolean);
  return hit ? hit[1].split(',').map((h) => h.trim()).filter((h) => HOST_NAME.test(h)) : [];
};
// Which queued requests does finishing `d` also finish? Same env + ref and a covered scope; a request limited to
// `hosts` is only covered when d is unrestricted or lists all of them.
export const mergeable = (d, x) => x.id !== d.id && x.env === d.env && x.state === 'queued' && x.ref === d.ref && covers(d.scope, x.scope)
  && (!d.hosts?.length || (x.scope === 'host' && !!x.hosts?.length && x.hosts.every((h) => d.hosts.includes(h))));
export const VERSION_RE = /\bversion\s*[:=]?\s*(v?\d+\.\d+\.\d+[\w.+-]*)/i;

function defaultRegistry() {
  const custom = process.env.DEPLOY_REGISTRY;
  const argvPrefix = custom ? JSON.parse(custom) : null;
  // returns {code, stdout, stderr}
  return (args, { stdin, timeout = 15000 } = {}) => new Promise((resolve) => {
    const [cmd, ...pre] = argvPrefix || ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'proxmox'];
    const argv = argvPrefix ? [...pre, ...args] : [...pre, `~/bin/vpt-lease ${args.map(shq).join(' ')}`];
    const child = execFile(cmd, argv, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 255) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    if (stdin != null) child.stdin.end(stdin); else child.stdin.end();
  });
}

// A deploy must survive a restart of this process, so the deploy child is detached: own session (setsid), output to
// `<deploys>/<id>.run` through a file descriptor, never a pipe through ghosty. A tiny sh wrapper writes its exit code
// to `<id>.exit` (atomic mv); we write the wrapper pid to `<id>.pid`. A restarted runner re-adopts from these files:
// they must not be deleted. systemd must also leave the child alone on stop: the unit needs KillMode=process.
const WRAP = '"$@"; rc=$?; echo $rc > "$0.tmp" && mv "$0.tmp" "$0"; exit $rc';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const pidFile = (dir, id) => join(dir, `${id}.pid`);
const exitFile = (dir, id) => join(dir, `${id}.exit`);
const readInt = async (f) => { try { const n = parseInt(await readFile(f, 'utf8'), 10); return Number.isFinite(n) ? n : null; } catch { return null; } };
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

// Follows a detached deploy: copies new bytes of `<id>.run` to onLine, until the exit file appears or the pid is gone.
// Resolves {code, timedOut}. The consumed offset is kept in `<id>.off` so an adopting runner does not repeat lines.
export function followDetached(dir, id, { onLine, timeoutMs, pollMs = 1000, pid }) {
  return new Promise((resolve) => {
    let off = 0, buf = '', timedOut = false, done = false, busy = false, t = null;
    const started = Date.now();
    const runFile = join(dir, `${id}.run`), offFile = join(dir, `${id}.off`);
    const drain = async () => {
      let fh;
      try {
        fh = await open(runFile, 'r');
        const size = (await fh.stat()).size;
        if (size > off) {
          const b = Buffer.alloc(size - off); await fh.read(b, 0, b.length, off);
          off = size; buf += b.toString('utf8'); let i;
          while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
          await writeFile(offFile, String(off)).catch(() => {});
        }
      } catch {} finally { await fh?.close().catch(() => {}); }
    };
    const check = async () => {
      if (done || busy) return;
      busy = true;
      try {
        await drain();
        let code = await readInt(exitFile(dir, id));
        if (code == null && !alive(pid)) { await nap(300); code = await readInt(exitFile(dir, id)); if (code == null) code = 255; }
        if (code != null) {
          await drain(); if (buf) { onLine(buf); buf = ''; }
          done = true; clearInterval(t);
          return resolve({ code, timedOut });
        }
        if (!timedOut && Date.now() - started > timeoutMs) {
          timedOut = true;
          try { process.kill(-pid, 'SIGTERM'); } catch {}
          setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 5000).unref();
        }
      } finally { busy = false; }
    };
    readInt(offFile).then((n) => { off = n || 0; t = setInterval(check, pollMs); check(); });
  });
}

// Runs the deploy command. Streams every output line to onLine; resolves {code, timedOut}.
// kind 'deploy' is detached (survives a restart, see above); the short health check stays a plain piped child.
function defaultRun(env, { ref, scope, flags, remoteCmd, onLine, timeoutMs, kind = 'deploy', id = '', dir, followPollMs }) {
  if (kind === 'deploy' && dir) {
    mkdirSync(dir, { recursive: true });
    const argv = env.argv || ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', env.ssh, remoteCmd];
    let fd;
    try { fd = openSync(join(dir, `${id}.run`), 'a'); } catch (e) { onLine(`spawn error: ${e.message}`); return Promise.resolve({ code: 255, timedOut: false }); }
    const child = spawn('sh', ['-c', WRAP, exitFile(dir, id), ...argv], {
      detached: true, stdio: ['ignore', fd, fd],
      env: env.argv ? { ...process.env, VPT_DEPLOY_REF: ref, VPT_DEPLOY_SCOPE: scope, VPT_DEPLOY_KIND: kind, VPT_DEPLOY_ID: id } : process.env,
    });
    closeSync(fd);
    child.unref();
    return new Promise((resolve) => {
      child.on('error', (e) => { onLine(`spawn error: ${e.message}`); resolve({ code: 255, timedOut: false }); });
      if (!child.pid) return;
      writeFile(pidFile(dir, id), String(child.pid)).then(() => followDetached(dir, id, { onLine, timeoutMs, pollMs: followPollMs, pid: child.pid })).then(resolve);
    });
  }
  return new Promise((resolve) => {
    let child;
    if (env.argv) {
      child = spawn(env.argv[0], env.argv.slice(1), { env: { ...process.env, VPT_DEPLOY_REF: ref, VPT_DEPLOY_SCOPE: scope, VPT_DEPLOY_KIND: kind, VPT_DEPLOY_ID: id }, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', env.ssh, remoteCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, timeoutMs);
    let buf = '';
    const feed = (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } };
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.on('error', (e) => { clearTimeout(timer); onLine(`spawn error: ${e.message}`); resolve({ code: 255, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); if (buf) onLine(buf); resolve({ code: code ?? 255, timedOut }); });
  });
}

export function createDeployRunner({
  stateDir, alert = () => {}, onChange = () => {}, isEnabled = () => false,
  registry = defaultRegistry(), run = defaultRun, timeoutMs = 45 * 60 * 1000, pollMs = 30000,
  orphanIdleMs = DEFAULT_ORPHAN_IDLE_MS, followPollMs = 1000, follow = followDetached, log = console,
} = {}) {
  const envsFile = join(stateDir, 'deploy-envs.json');
  const logDir = join(stateDir, 'deploys');
  let envs = {};
  let snap = { ok: false, error: 'not polled yet', deploys: [], lastRef: {}, deployed: {}, at: 0 };
  const running = new Map();          // env -> deploy id this process is running
  const seenAwaiting = new Set();
  const handledOrphans = new Set();   // ids already finished as orphaned (alert once per id)
  let first = true, ticking = false, timer = null, lastJson = '';

  async function loadEnvs() {
    try { envs = JSON.parse(await readFile(envsFile, 'utf8')); }
    catch {
      envs = DEFAULT_ENVS;
      try { await mkdir(stateDir, { recursive: true }); await writeFile(envsFile, JSON.stringify(DEFAULT_ENVS, null, 2)); } catch {}
    }
  }
  const reg = async (args, opts) => registry(args, opts);

  function lastRefs(deploys) {
    const out = {};
    for (const d of deploys.filter((x) => x.state === 'done').sort((a, b) => (a.finished || 0) - (b.finished || 0))) out[d.env] = { ref: d.ref, version: d.version || '', at: d.finished || 0 };
    return out;
  }

  async function poll() {
    const r = await reg(['deploy', 'list', '--json']);
    if (r.code !== 0) { snap = { ...snap, ok: false, error: (r.stderr || `exit ${r.code}`).trim().slice(0, 200), at: Date.now() }; return null; }
    let j; try { j = JSON.parse(r.stdout); } catch { snap = { ...snap, ok: false, error: 'bad registry output', at: Date.now() }; return null; }
    const deploys = j.deploys || [];
    snap = { ok: true, error: '', deploys, lastRef: lastRefs(deploys), deployed: await pollDeployed(), at: Date.now() };
    return deploys;
  }

  // "Deployed now": per env, per target {version, ref, commit, at, agent, lastAttempt?} from `vpt-lease deploy last --json`.
  // Best effort: an old registry without the ledger keeps the previous value instead of failing the poll.
  async function pollDeployed() {
    try {
      const r = await reg(['deploy', 'last', '--json']);
      if (r.code !== 0) return snap.deployed || {};
      return JSON.parse(r.stdout).envs || {};
    } catch { return snap.deployed || {}; }
  }

  async function logTail(id, n = 200) {
    try { return (await readFile(join(logDir, `${id}.log`), 'utf8')).split('\n').slice(-n - 1).join('\n').trimEnd(); } catch { return ''; }
  }

  // If the runner process restarts mid-deploy, the in-memory `running` map is lost but the registry entry stays
  // "running" until its 90 min expiry, blocking the env queue. Finish it as failed once the log has been idle for
  // `orphanIdleMs` (or since `started` when the log is missing). Once per id: `handledOrphans` prevents retries.
  async function finishOrphan(d) {
    if (handledOrphans.has(d.id)) return;
    const logFile = join(logDir, `${d.id}.log`);
    let idleSince;
    try { idleSince = (await stat(logFile)).mtimeMs; }
    catch { if (d.started != null) idleSince = Number(d.started); else return; }
    if (!Number.isFinite(idleSince)) return;
    if (idleSince < 1e12) idleSince *= 1000;                 // registry `started` is unix seconds
    if (Date.now() - idleSince < orphanIdleMs) return;
    handledOrphans.add(d.id);
    const tail = await logTail(d.id, 40);
    const note = '# orphaned: runner restarted mid-deploy, finished by the runner';
    const stdin = `${note}\n${tail}`;
    try { await mkdir(logDir, { recursive: true }); await appendFile(logFile, note + '\n'); } catch (e) { log.error?.('[deploy] orphan log append', e.message); }
    const fin = await reg(['deploy', 'finish', d.id, '--status', 'failed', '--tail-stdin'], { stdin });
    if (fin.code !== 0) log.error?.(`[deploy] finish orphan ${d.id} failed: ${fin.stderr}`);
    alert(`deploy:${d.id}:orphan`, {
      title: `deploy ${d.env} ${d.scope} orphaned`,
      body: `runner restarted mid-deploy; finished as failed`,
      priority: 'high', ntfyTags: 'warning', tag: `ghosty-deploy-${d.id}`, url: '/?deploys=1',
    }, 0);
  }

  async function runDeploy(d, deploys, adopt = null) {
    const flags = flagsFor(d.scope);
    const envCfg = envs[d.env];
    await mkdir(logDir, { recursive: true });
    const out = createWriteStream(join(logDir, `${d.id}.log`), { flags: 'a' });
    const lines = [];
    if (adopt) { try { lines.push(...(await readFile(join(logDir, `${d.id}.log`), 'utf8')).split('\n').filter(Boolean).slice(-400)); } catch {} }
    const onLine = (l) => { lines.push(l); if (lines.length > 400) lines.shift(); out.write(l + '\n'); };
    // Requests for the same env + ref that this deploy covers are finished with its result.
    let merged = deploys.filter((x) => mergeable(d, x));
    if (adopt) onLine(`# runner restarted: re-adopted running deploy (wrapper pid ${adopt.pid})`);
    else onLine(`# deploy ${d.id} ${d.env} scope=${d.scope} ref=${d.ref}${d.hosts?.length ? ` hosts=${d.hosts.join(',')}` : ''} requested by ${d.agent}${merged.length ? ` (+${merged.length} merged)` : ''}`);
    if (!adopt) alert(`deploy:${d.id}:start`, { title: `deploy ${d.env} ${d.scope} started`, body: `${d.ref} for ${d.agent}`, priority: 'default', ntfyTags: 'rocket', tag: `ghosty-deploy-${d.id}`, url: '/?deploys=1' }, 0);
    let status = 'failed', rc = null, timedOut = false;
    try {
      const remoteCmd = `VPT_LEASE_AGENT=${RUNNER_AGENT} VPT_DEPLOY_ID=${d.id} ${envCfg.cmd || 'bash update_core.sh'} ${[d.ref, ...flags, ...extraFlagsFor(d)].map(shq).join(' ')}`;
      if (adopt) ({ code: rc, timedOut } = await follow(logDir, d.id, { onLine, timeoutMs, pollMs: followPollMs, pid: adopt.pid }));
      else ({ code: rc, timedOut } = await run(envCfg, { dir: logDir, followPollMs, id: d.id, ref: d.ref, scope: d.scope, flags, remoteCmd, onLine, timeoutMs }));
      if (timedOut) onLine(`# TIMEOUT after ${Math.round(timeoutMs / 60000)} min, killed`);
      else onLine(`# update_core exit ${rc}`);
      status = rc === 0 && !timedOut ? 'done' : 'failed';
      if (status === 'done') {
        if (envCfg.health) {
          const h = await run(envCfg, { ref: d.ref, scope: d.scope, flags: [], remoteCmd: envCfg.health, onLine, timeoutMs: 120000, kind: 'health' });
          onLine(`# health check exit ${h.code}`);
          if (h.code !== 0) status = 'failed';
        } else onLine('# health check: none configured for this env (update_core exit code only)');
      }
    } catch (e) { onLine(`# runner error: ${e.message}`); }
    const skipped = parseSkipped(lines);
    if (skipped.length) {
      onLine(`# skipped (leased): ${skipped.join(',')} — catch-up deploy queued`);
      // a queued request for a skipped host (or any unrestricted host request) must not be closed by this run
      merged = merged.filter((m) => m.scope !== 'host' || (m.hosts?.length && !m.hosts.some((h) => skipped.includes(h))));
    }
    const version = [...lines].reverse().map((l) => l.match(VERSION_RE)?.[1]).find(Boolean) || '';
    await new Promise((r) => out.end(r));
    const tail = lines.slice(-40).join('\n');
    const fin = await reg(['deploy', 'finish', d.id, '--status', status, ...(version ? ['--version', version] : []),
      ...(skipped.length ? ['--skipped-hosts', skipped.join(',')] : []), '--tail-stdin'], { stdin: tail });
    if (fin.code !== 0) log.error?.(`[deploy] finish ${d.id} failed: ${fin.stderr}`);
    for (const m of merged) await reg(['deploy', 'finish', m.id, '--status', status, '--coalesced-into', d.id, ...(version ? ['--version', version] : []), '--tail-stdin'], { stdin: tail });
    if (skipped.length) {
      const q = await reg(['deploy', 'request', d.env, '--scope', 'host', '--ref', d.ref, '--agent', RUNNER_AGENT, '--approved',
        '--hosts', skipped.join(','), '--purpose', `catch-up: hosts skipped by ${d.id} (leased): ${skipped.join(',')}`]);
      if (q.code !== 0) log.error?.(`[deploy] catch-up request for ${d.id} failed: ${q.stderr}`);
      else onLine(`# catch-up request ${q.stdout.trim()} for ${skipped.join(',')}`);
    }
    running.delete(d.env);
    alert(`deploy:${d.id}:${status}`, {
      title: `deploy ${d.env} ${d.scope} ${status}${version ? ` (${version})` : ''}${skipped.length ? `, ${skipped.length} host(s) skipped` : ''}`,
      body: status === 'done' ? `${d.ref} for ${d.agent}; waiters released${skipped.length ? `; skipped (leased): ${skipped.join(',')}` : ''}` : lines.slice(-4).join('\n'),
      priority: status === 'done' ? 'default' : 'high', ntfyTags: status === 'done' ? 'white_check_mark' : 'x', tag: `ghosty-deploy-${d.id}`, url: '/?deploys=1',
    }, 0);
    await tick();      // next queued one, without waiting for the poll
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await loadEnvs();
      const deploys = await poll();
      if (deploys) {
        for (const d of deploys) {
          // Runner ON is the owner's standing approval (2026-10-04: "if no lease, deploy all"):
          // an unapproved request is approved here and then waits only for its leases.
          if (d.state === 'awaiting-approval' && isEnabled()) {
            const r = await reg(['deploy', 'approve', d.id]);
            if (r.code === 0) { d.state = 'queued'; log.info?.(`[deploy] auto-approved ${d.id} (runner on)`); continue; }
          }
          if (d.state === 'awaiting-approval' && !seenAwaiting.has(d.id)) {
            seenAwaiting.add(d.id);
            if (!first) alert(`deploy:${d.id}:approve`, { title: `deploy needs approval: ${d.env} ${d.scope}`, body: `${d.ref} requested by ${d.agent}${d.purpose ? ` — ${d.purpose}` : ''}`, priority: 'high', ntfyTags: 'warning', tag: `ghosty-deploy-${d.id}`, url: '/?deploys=1' }, 0);
          }
        }
        first = false;
        // Re-adopt: registry says running + runner == us + this process lost it (restart), but the detached wrapper is
        // still alive or left an exit file: follow it to the end (same finish path). Neither file = the orphan sweep.
        for (const d of deploys) {
          if (d.state !== 'running' || d.runner !== RUNNER_AGENT || running.has(d.env) || !envs[d.env]) continue;
          const pid = await readInt(pidFile(logDir, d.id));
          const exited = (await readInt(exitFile(logDir, d.id))) != null;
          if (pid == null || !(exited || alive(pid))) continue;
          running.set(d.env, d.id);
          log.info?.(`[deploy] re-adopted ${d.id} (pid ${pid}${exited ? ', already exited' : ''})`);
          runDeploy(d, deploys, { pid }).catch((e) => { running.delete(d.env); log.error?.('[deploy] adopt', e.message); });
        }
        // Detect orphans: registry says running + runner == us, but this process no longer tracks it. Skip ones
        // owned by `running`. Gated by `if (deploys)` above so a poll failure does nothing.
        for (const d of deploys) {
          if (d.state !== 'running' || d.runner !== RUNNER_AGENT) continue;
          if (running.get(d.env) === d.id) continue;
          if (!envs[d.env]) continue;                 // not an env this runner owns (another runner's log is not here)
          try { await finishOrphan(d); } catch (e) { log.error?.('[deploy] orphan', e.message); }
        }
        if (isEnabled()) {
          for (const env of Object.keys(envs)) {
            if (running.has(env) || deploys.some((d) => d.env === env && d.state === 'running')) continue;
            const queue = deploys.filter((d) => d.env === env && d.state === 'queued' && flagsFor(d.scope)).sort((a, b) => a.created - b.created);
            for (const d of queue) {
              const r = await reg(['deploy', 'start', d.id, ...(skipsLeased(d) ? ['--skip-leased'] : [])]);
              if (r.code === 3) continue;                 // resources busy: try a narrower request behind it
              if (r.code !== 0) { log.error?.(`[deploy] start ${d.id}: ${r.stderr}`); continue; }
              running.set(env, d.id);
              runDeploy(d, deploys).catch((e) => { running.delete(env); log.error?.('[deploy] run', e.message); });
              break;
            }
          }
        }
      }
    } catch (e) { log.error?.('[deploy] tick', e.message); }
    finally { ticking = false; }
    const j = JSON.stringify([snap.ok, snap.error, snap.deploys.map((d) => [d.id, d.state]), snap.deployed, [...running]]);
    if (j !== lastJson) { lastJson = j; onChange(snapshot()); }
  }

  function snapshot() { return { ...snap, enabled: !!isEnabled(), running: Object.fromEntries(running), envs: Object.keys(envs) }; }

  async function act(id, what) {          // approve | cancel
    if (!/^[0-9a-f]{1,16}$/.test(id)) return { ok: false, status: 400, error: 'bad id' };
    const r = await reg(['deploy', what, id]);
    if (r.code !== 0) return { ok: false, status: r.code === 1 ? 409 : 502, error: (r.stderr || r.stdout).trim() || `exit ${r.code}` };
    tick();
    return { ok: true };
  }

  return {
    tick, snapshot, act, logTail,
    start() { tick(); timer = setInterval(tick, pollMs); timer.unref?.(); },
    stop() { clearInterval(timer); },
    _running: running,
  };
}
