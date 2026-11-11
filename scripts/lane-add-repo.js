#!/usr/bin/env node
// Register a repository with the integration lane: validate an entry file, clone the lane clone if missing, and write
// <state>/integration.json atomically (idempotent).  Usage:
//   node scripts/lane-add-repo.js <key> <entry.json> [--origin <git url>] [--state <dir>] [--dry-run]
// e.g. node scripts/lane-add-repo.js website config/integration-repos/website.json --origin git@github.com:AngelStreetCorp/virtualpytest-website.git
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateConfig } from '../integration-lane.js';

export function addRepo({ key, entry, origin, stateDir, dryRun = false }) {
  const file = path.join(stateDir, 'integration.json');
  let cfg = { repos: {} };
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  cfg.repos = cfg.repos || {};
  const next = { ...cfg, repos: { ...cfg.repos, [key]: entry } };
  const { repos, errors } = validateConfig({ repos: { [key]: entry } });
  if (errors.length || !repos[key]) throw new Error(`invalid entry: ${errors.join('; ') || 'dropped'}`);
  const actions = [];
  if (!fs.existsSync(path.join(entry.clone, '.git'))) {
    if (!origin) throw new Error(`clone ${entry.clone} is missing: pass --origin <git url>`);
    actions.push(`clone ${origin} -> ${entry.clone}`);
    if (!dryRun) { fs.mkdirSync(path.dirname(entry.clone), { recursive: true }); execFileSync('git', ['clone', '-q', origin, entry.clone], { stdio: 'inherit' }); }
  }
  if (JSON.stringify(cfg.repos[key]) !== JSON.stringify(entry)) {
    actions.push(`${cfg.repos[key] ? 'update' : 'add'} repos.${key} in ${file}`);
    if (!dryRun) { fs.mkdirSync(stateDir, { recursive: true }); const t = `${file}.tmp${process.pid}`; fs.writeFileSync(t, JSON.stringify(next, null, 2) + '\n'); fs.renameSync(t, file); }
  }
  return actions;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const a = process.argv.slice(2), flag = (n) => { const i = a.indexOf(n); return i < 0 ? null : a[i + 1]; };
  const [key, entryFile] = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--') && a[i - 1] !== '--dry-run'));
  if (!key || !entryFile) { console.error('usage: lane-add-repo.js <key> <entry.json> [--origin url] [--state dir] [--dry-run]'); process.exit(1); }
  try {
    const acts = addRepo({ key, entry: JSON.parse(fs.readFileSync(entryFile, 'utf8')), origin: flag('--origin'),
      stateDir: flag('--state') || process.env.GHOSTY_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'ghosty'), dryRun: a.includes('--dry-run') });
    console.log(acts.length ? acts.join('\n') : `${key} already registered, nothing to do`);
  } catch (e) { console.error(`lane-add-repo: ${e.message}`); process.exit(1); }
}
