#!/usr/bin/env node
// manager-runs.jsonl CLI: the scorecard counts MiniMax worker tokens by these windows, so the manager agent
// (or any worker that delegates a coding task to MiniMax in a worktree) opens the window before the run and
// closes it after.
//
//   node scripts/manager-run.js start --kind minimax --worktree <abs path> --task <text>
//   node scripts/manager-run.js end   <id> [--verdict accepted|fixed|rejected]
//
// Append-only file: `start` writes {id, kind, worktree, task, startedAt, by}; `end` writes {id, endedAt, verdict?}.
// Readers (scorecard.foldRuns) merge by id and treat an unmatched start as still running (endedAt = null).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';

const STATE_DIR = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
const FILE = join(STATE_DIR, 'manager-runs.jsonl');

function parseArgs(argv) {
  const out = { _: [], opts: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; out.opts[k] = v; }
    else out._.push(a);
  }
  return out;
}

async function readLines() {
  try { return (await fs.readFile(FILE, 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

async function append(rec) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.appendFile(FILE, JSON.stringify(rec) + '\n');
}

async function cmdStart(opts) {
  const kind = opts.kind || 'minimax';
  if (!['minimax', 'gate', 'other'].includes(kind)) throw new Error(`--kind must be one of minimax|gate|other, got "${kind}"`);
  const worktree = opts.worktree;
  if (!worktree) throw new Error('--worktree <abs path> required');
  if (!worktree.startsWith('/')) throw new Error(`--worktree must be an absolute path, got "${worktree}"`);
  const task = opts.task || null;
  const id = randomUUID();
  const rec = { id, kind, worktree, task, startedAt: Date.now(), by: opts.by || 'manager-agent' };
  await append(rec);
  process.stdout.write(id + '\n');
}

async function cmdEnd(id, opts) {
  if (!id) throw new Error('run id required');
  const endedAt = Date.now();
  const verdict = opts.verdict || null;
  if (verdict && !['accepted', 'fixed', 'rejected'].includes(verdict)) throw new Error(`--verdict must be one of accepted|fixed|rejected, got "${verdict}"`);
  await append({ id, endedAt, verdict });
  process.stdout.write(JSON.stringify({ id, endedAt, verdict }) + '\n');
}

async function cmdList() {
  const lines = await readLines();
  // fold by id (mirror of foldRuns in scorecard.js; here we just give a chronological log so the user can read it)
  process.stdout.write(JSON.stringify(lines, null, 1) + '\n');
}

const HELP = `usage:
  node scripts/manager-run.js start --kind minimax --worktree <abs path> --task <text> [--by owner]
  node scripts/manager-run.js end   <id> [--verdict accepted|fixed|rejected]
  node scripts/manager-run.js list
`;

async function main() {
  const argv = process.argv;
  if (argv.length < 3 || argv[2] === '--help' || argv[2] === '-h') { process.stdout.write(HELP); return; }
  const { _: cmd, opts } = parseArgs(argv);
  try {
    if (cmd[0] === 'start') await cmdStart(opts);
    else if (cmd[0] === 'end') await cmdEnd(cmd[1], opts);
    else if (cmd[0] === 'list') await cmdList();
    else { process.stderr.write(HELP); process.exit(2); }
  } catch (e) { process.stderr.write(e.message + '\n'); process.exit(1); }
}

main();