#!/usr/bin/env node
// Daily check (scripts/daily-checks.js protocol; the runner adds it by itself, no config entry needed): installed copies of repo scripts.
// `integrate` is installed as a plain COPY in ~/.local/bin; the Oct 21 copy stayed 12 days behind scripts/integrate, so new wording
// ("keep working, do not end your turn") never reached the sessions. This compares each installed copy with the repo version (sha256) and
// reports DRIFT with the exact fix command. A symlink into the repo is always current. A missing copy is listed ("missing") but is not a
// finding: not every box installs every script. The Mac's copy (~/.local/bin/integrate there) cannot be read from here.
// Prints ONE JSON object on the last line: { summary, report, findings, results }.
import { readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
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
function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

export function render({ results, findings }) {
  const report = results.map((r) => `- ${r.name}: ${r.status.toUpperCase()}${r.status === 'drift' ? ` — fix: \`${r.fix}\`` : r.status === 'missing' ? ` (${r.installed} is not installed on this box)` : ''}`).join('\n');
  const drift = results.filter((r) => r.status === 'drift').length;
  return { summary: drift ? `${drift} installed script copy(ies) drifted from the repo` : `${results.length} installed script(s) checked, no drift`, report, findings, results };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(render(checkCopies({ repoRoot }))));
}
