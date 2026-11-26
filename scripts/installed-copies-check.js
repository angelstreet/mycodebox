#!/usr/bin/env node
// Daily check (scripts/daily-checks.js protocol; the runner adds it by itself, no config entry needed): installed copies of repo scripts.
// `integrate` is installed as a plain COPY in ~/.local/bin; the Oct 21 copy stayed 12 days behind scripts/integrate, so new wording
// ("keep working, do not end your turn") never reached the sessions. This compares each installed copy with the repo version (sha256) and
// reports DRIFT with the exact fix command. A symlink into the repo is always current. A missing copy is listed ("missing") but is not a
// finding: not every box installs every script. Also the systemd/ unit templates against /etc/systemd/system (checkUnits). The Mac's copy (~/.local/bin/integrate there) cannot be read from here.
// Prints ONE JSON object on the last line: { summary, report, findings, results }.
import { readFileSync, lstatSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// repo: path inside the checkout; installed: path under $HOME
export const ENTRIES = [
  { name: 'integrate', repo: 'scripts/integrate', installed: '.local/bin/integrate' },
  { name: 'found-bug', repo: 'scripts/found-bug', installed: '.local/bin/found-bug' },
  { name: 'cbsession', repo: 'scripts/cbsession', installed: '.local/bin/cbsession' },
];
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// -> { results: [{ name, status: 'ok'|'drift'|'missing'|'symlink'|'repo-missing', fix? }], findings }
export function checkCopies({ repoRoot, home = homedir(), entries = ENTRIES } = {}) {
  const results = [], findings = [];
  for (const e of entries) {
    const repoFile = resolve(repoRoot, e.repo), inst = join(home, e.installed);
    let status, fix;
    if (!existsSync(repoFile)) status = 'repo-missing';
    else if (!existsSync(inst) && !isLink(inst)) status = 'missing';
    else if (isLink(inst)) { try { status = realpathSync(inst) === realpathSync(repoFile) ? 'symlink' : (sha(inst) === sha(repoFile) ? 'ok' : 'drift'); } catch { status = 'drift'; } }
    else status = sha(inst) === sha(repoFile) ? 'ok' : 'drift';
    if (status === 'drift') {
      fix = `cp ${repoFile} ${inst}`;
      findings.push({ key: `installed-copy:drift:${e.name}`, title: `Installed ${e.name} differs from the repo script`, body: `DRIFT: ${inst} is not ${repoFile}. Fix: ${fix}`, priority: 'high' });
    }
    results.push({ name: e.name, installed: inst, repo: repoFile, status, ...(fix ? { fix } : {}) });
  }
  return { results, findings };
}
// The Mac's copy of scripts/mac-stop-hook.sh cannot be read from here: the hook sends its own sha256 with every stop (remote-stops.js writes
// <state>/remote-hooks-seen.json { machine: { hook_sha, at } }). A machine seen in the last 14 days with another sha than the repo's is DRIFT.
export function checkMacHooks({ repoRoot, stateDir, now = Date.now(), maxAgeMs = 14 * 864e5 } = {}) {
  const results = [], findings = [];
  let want; try { want = sha(resolve(repoRoot, 'scripts/mac-stop-hook.sh')); } catch { return { results, findings }; }
  let seen = {}; try { seen = JSON.parse(readFileSync(join(stateDir, 'remote-hooks-seen.json'), 'utf8')) || {}; } catch { return { results, findings }; }
  for (const [machine, e] of Object.entries(seen)) {
    const age = now - Date.parse(e.at);
    if (!(age <= maxAgeMs)) continue;
    const status = e.hook_sha === want ? 'ok' : 'drift';   // a null hook_sha is a hook older than the sha reporting: drift too
    results.push({ name: `mac-stop-hook@${machine}`, installed: 'Mac: ~/.local/bin or the path in ~/.claude/settings.json hooks.Stop', repo: 'scripts/mac-stop-hook.sh', status, ...(status === 'drift' ? { fix: 'copy scripts/mac-stop-hook.sh to the Mac again (docs/MAC-HOOK.md "Update")' } : {}) });
    if (status === 'drift') findings.push({ key: `installed-copy:drift:mac-stop-hook:${machine}`, title: `Mac ${machine}: the Stop hook differs from the repo script`, body: `DRIFT: the hook on ${machine} (last stop ${e.at}) is not scripts/mac-stop-hook.sh. Fix: copy the repo script to the Mac (docs/MAC-HOOK.md "Update").`, priority: 'high' });
  }
  return { results, findings };
}
// Unit templates in systemd/ against /etc/systemd/system (2026-11-26: a merged CPUWeight=20 for health-watch sat uninstalled for
// 2 days, and nothing said so). Report only: installing stays a root step. Per unit, every setting line of the template (comments
// dropped, <user>/<uid> filled in) must appear in the installed unit or one of its <unit>.d/*.conf drop-ins; lines only on the host
// (local ports, env files) are fine, and an Environment= variable the host sets to another value is local config. A unit not installed is "missing", not a finding: a box installs only what it needs.
export function unitLines(text, vars = {}) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith(';') && !l.startsWith('['))
    .map((l) => l.replace(/<(user|uid)>/g, (m, k) => vars[k] ?? m));
}
export function checkUnits({ repoRoot, etc = process.env.GHOSTY_SYSTEMD_DIR || '/etc/systemd/system', vars = { user: userInfo().username, uid: String(process.getuid?.() ?? '') } } = {}) {
  const results = [], findings = [];
  let names = []; try { names = readdirSync(join(repoRoot, 'systemd')).filter((n) => /\.(service|slice|timer|socket|path)$/.test(n)).sort(); } catch { return { results, findings }; }
  for (const n of names) {
    const inst = join(etc, n);
    if (!existsSync(inst)) { results.push({ name: `unit ${n}`, installed: inst, repo: `systemd/${n}`, status: 'missing' }); continue; }
    let host = unitLines(readFileSync(inst, 'utf8'));
    try { for (const f of readdirSync(`${inst}.d`).filter((f) => f.endsWith('.conf')).sort()) host = host.concat(unitLines(readFileSync(join(`${inst}.d`, f), 'utf8'))); } catch {}
    const have = new Set(host);
    // Environment= values are local config (the template's HOST=127.0.0.1 is the safe default, a box binds its own): only an unset variable drifts.
    const envName = (l) => (l.match(/^Environment=["']?([A-Za-z_][A-Za-z0-9_]*)=/) || [])[1];
    const hostEnv = new Set(host.map(envName).filter(Boolean));
    const miss = unitLines(readFileSync(join(repoRoot, 'systemd', n), 'utf8'), vars).filter((l) => !have.has(l) && !(envName(l) && hostEnv.has(envName(l))));
    if (!miss.length) { results.push({ name: `unit ${n}`, installed: inst, repo: `systemd/${n}`, status: 'ok' }); continue; }
    const diff = miss.map((l) => { const k = l.split('=')[0]; const h = host.filter((x) => x.split('=')[0] === k); return `${l} (host: ${h.length ? h.join(' | ') : 'not set'})`; });
    const fix = `review, then: sudo install -m 644 <filled-in systemd/${n}> ${inst} && sudo systemctl daemon-reload (or change the repo template if the host is right)`;
    results.push({ name: `unit ${n}`, installed: inst, repo: `systemd/${n}`, status: 'drift', diff, fix });
    findings.push({ key: `installed-copy:unit:${n}`, title: `Installed unit ${n} differs from systemd/${n}`, body: `DRIFT: ${diff.join('; ')}. Fix: ${fix}`, priority: 'medium' });
  }
  return { results, findings };
}
function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

export function render({ results, findings }) {
  const report = results.map((r) => `- ${r.name}: ${r.status.toUpperCase()}${r.status === 'drift' ? `${r.diff ? ` — ${r.diff.join('; ')}` : ''} — fix: \`${r.fix}\`` : r.status === 'missing' ? ` (${r.installed} is not installed on this box)` : ''}`).join('\n');
  const drift = results.filter((r) => r.status === 'drift').length;
  return { summary: drift ? `${drift} installed script copy(ies) / unit(s) drifted from the repo` : `${results.length} installed script(s) and unit(s) checked, no drift`, report, findings, results };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const a = checkCopies({ repoRoot }), b = checkMacHooks({ repoRoot, stateDir: process.env.GHOSTY_STATE_DIR || join(homedir(), '.local/state/ghosty') }), c = checkUnits({ repoRoot });
  console.log(JSON.stringify(render({ results: [...a.results, ...b.results, ...c.results], findings: [...a.findings, ...b.findings, ...c.findings] })));
}
