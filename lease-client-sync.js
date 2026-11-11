// Keeps the installed vpt-lease clients equal to this checkout's scripts/vpt-lease (owner 2026-11-11; bug-fb46a741: the copies on codebox and
// on the registry host were old, so fixes merged to main did not run). Runs once when the dashboard starts from the live checkout on main with
// scripts/vpt-lease unmodified, i.e. after every self-deploy: the normal deploy path installs the client too. For each target whose sha256
// differs: back up (<target>.bak-<UTC stamp>), write <target>.new.<pid>, check it parses (python3), chmod 755, rename over the target (atomic;
// a waiter already running keeps the file it started with). Targets: the local ~/bin/vpt-lease, and the registry host's copy over ssh
// (VPT_LEASE_SSH_TARGET / VPT_LEASE_REMOTE_CMD from ~/.config/vpt-lease/config). Journal: <state>/lease-client-sync.jsonl; a failure
// becomes a manager event. Rollback: mv <target>.bak-<stamp> <target>. GHOSTY_LEASE_CLIENT_SYNC=off disables it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// a remote path that starts with ~/ stays relative to the remote home (quoted, ~ would not expand)
const remotePath = (p) => (p.startsWith('~/') ? `"$HOME"/${shq(p.slice(2))}` : shq(p));

// Parse the client's KEY=VALUE config (the same file scripts/vpt-lease reads). Unknown keys are ignored; values are never logged.
export function readClientConfig(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && (m[1] === 'VPT_LEASE_SSH_TARGET' || m[1] === 'VPT_LEASE_REMOTE_CMD' || m[1] === 'VPT_LEASE_MODE')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// The shell script that installs stdin as `target` on the remote side; prints the new sha256 last.
export function remoteInstallScript(target, stamp) {
  const t = remotePath(target);
  return [
    'set -e', `t=${t}`, 'n="$t.new.$$"', 'mkdir -p "$(dirname "$t")"', 'cat > "$n"',
    'python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$n" || { rm -f "$n"; echo "syntax check failed" >&2; exit 3; }',
    `[ -e "$t" ] && cp -p "$t" "$t.bak-${stamp}"`, 'chmod 755 "$n"', 'mv -f "$n" "$t"', 'sha256sum "$t" | cut -d" " -f1',
  ].join('\n');
}

const run = (cmd, args, { input, timeoutMs = 30000 } = {}) => new Promise((resolve) => {
  const c = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  if (input != null) c.stdin.end(input); else c.stdin.end();
});

export function createLeaseClientSync({ root, stateDir, home = os.homedir(), exec = run, record = async () => {}, log = console, now = () => new Date(), enabled = () => process.env.GHOSTY_LEASE_CLIENT_SYNC !== 'off' } = {}) {
  const repoFile = path.join(root, 'scripts', 'vpt-lease');
  const journal = (line) => { try { fs.mkdirSync(stateDir, { recursive: true }); fs.appendFileSync(path.join(stateDir, 'lease-client-sync.jsonl'), JSON.stringify(line) + '\n'); } catch { /* audit only */ } };

  // Only the live checkout on main with an unmodified client installs: a worktree or a dev server never does.
  async function eligible() {
    const b = await exec('git', ['-C', root, 'symbolic-ref', '--short', '-q', 'HEAD']);
    if (b.code !== 0 || b.stdout.trim() !== 'main') return 'not on main';
    const d = await exec('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--', 'scripts/vpt-lease']);
    return d.code === 0 ? null : 'scripts/vpt-lease has local changes';
  }

  async function syncLocal(buf, want, stamp) {
    const t = path.join(home, 'bin', 'vpt-lease');
    let have = null; try { have = sha256(fs.readFileSync(t)); } catch { /* not installed */ }
    if (have === want) return { target: 'local', path: t, state: 'same' };
    const n = `${t}.new.${process.pid}`;
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(n, buf, { mode: 0o755 });
    const chk = await exec('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', n]);
    if (chk.code !== 0) { fs.rmSync(n, { force: true }); return { target: 'local', path: t, state: 'failed', error: 'syntax check failed' }; }
    if (have) fs.copyFileSync(t, `${t}.bak-${stamp}`);
    fs.renameSync(n, t);
    const got = sha256(fs.readFileSync(t));
    return { target: 'local', path: t, state: got === want ? 'installed' : 'failed', from: have, to: got, backup: have ? `${t}.bak-${stamp}` : null };
  }

  async function syncRemote(buf, want, stamp, cfg) {
    const host = cfg.VPT_LEASE_SSH_TARGET;
    const target = cfg.VPT_LEASE_REMOTE_CMD || '~/bin/vpt-lease';
    if (!/^[\w~./-]+$/.test(target)) return { target: 'registry', state: 'skipped', error: 'VPT_LEASE_REMOTE_CMD is not a plain path' };
    const ssh = (script, input) => exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, script], { input });
    const cur = await ssh(`sha256sum ${remotePath(target)} 2>/dev/null | cut -d" " -f1`);
    if (cur.code === 255) return { target: 'registry', path: target, state: 'failed', error: 'ssh unreachable' };
    const have = cur.stdout.trim() || null;
    if (have === want) return { target: 'registry', path: target, state: 'same' };
    const r = await ssh(remoteInstallScript(target, stamp), buf);
    const got = r.stdout.trim().split('\n').pop();
    if (r.code !== 0 || got !== want) return { target: 'registry', path: target, state: 'failed', error: (r.stderr || `exit ${r.code}`).trim().slice(0, 200) };
    return { target: 'registry', path: target, state: 'installed', from: have, to: got, backup: have ? `${target}.bak-${stamp}` : null };
  }

  async function sync() {
    if (!enabled()) return { skipped: 'off' };
    const why = await eligible();
    if (why) return { skipped: why };
    const buf = fs.readFileSync(repoFile);
    const want = sha256(buf);
    const stamp = now().toISOString().replace(/[-:]/g, '').slice(0, 15);
    let cfg = {}; try { cfg = readClientConfig(fs.readFileSync(path.join(home, '.config', 'vpt-lease', 'config'), 'utf8')); } catch { /* none */ }
    const results = [];
    try { results.push(await syncLocal(buf, want, stamp)); } catch (e) { results.push({ target: 'local', state: 'failed', error: e.message }); }
    if (cfg.VPT_LEASE_SSH_TARGET) { try { results.push(await syncRemote(buf, want, stamp, cfg)); } catch (e) { results.push({ target: 'registry', state: 'failed', error: e.message }); } }
    for (const r of results) {
      if (r.state === 'same') continue;
      journal({ at: now().toISOString(), want, ...r });
      log.log?.(`[lease-client-sync] ${r.target} ${r.path || ''}: ${r.state}${r.error ? ` (${r.error})` : ''}`);
      if (r.state === 'failed') await record({ key: 'lease:client-sync', title: `vpt-lease client not updated on ${r.target}`, body: `The installed client (${r.path || r.target}) differs from scripts/vpt-lease and the install failed: ${r.error || 'unknown'}. It keeps the old copy.`, priority: 'default', url: '/?leases=1' }).catch(() => {});
    }
    return { want, results };
  }
  return { sync, eligible };
}
