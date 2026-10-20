// The -H prompt heredoc in scripts/cbsession is unquoted (it interpolates $DIR/$HANDOVER), so any ` ... ` in it was
// run as a command substitution: on 2026-10-20 `integrate request <branch> ...` and `STATUS: waiting: integration <id>`
// executed and reached the session as empty text. These tests render the prompt with -x (dry run: no tmux, no agent)
// and assert the commands survive as literal text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cbsession');
const home = tmp('cbp-');
const work = path.join(home, 'work'); fs.mkdirSync(work);
const handover = path.join(home, 'handover.md'); fs.writeFileSync(handover, '# handover\n');

// tmux shim: records every call and fails, so has-session reports "no session" and nothing can be started.
const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
const tmuxLog = path.join(home, 'tmux.log');
fs.writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${tmuxLog}"\nexit 1\n`, { mode: 0o755 });

const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, GHOSTY_STATE_DIR: path.join(home, 'state') };
const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env });
const promptOf = (name) => fs.readFileSync(path.join(home, 'handovers', `${name}.prompt.md`), 'utf8');

test('the handover prompt keeps the backticked commands as literal text', () => {
  const r = run('-x', '-n', 'cbp-h', '-d', work, '-H', handover);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /command substitution/, 'bash executed something in the prompt heredoc');
  const p = promptOf('cbp-h');
  assert.match(p, /run `integrate request <branch> \[--deploy <scope>\]`/);
  assert.match(p, /run `integrate request`, then `STATUS: waiting: integration <id>`/);
  assert.ok(p.includes('STATUS: waiting: integration <id>'), 'the STATUS line keeps the <id> placeholder');
  assert.match(p, /End the turn with `STATUS: waiting:/, 'the multi-line backtick pair is literal too');
  assert.match(p, new RegExp(`Read the handover: ${handover.replace(/[/.]/g, '\\$&')},`), 'the handover path is interpolated');
  assert.match(p, new RegExp(`Working directory: ${work.replace(/[/.]/g, '\\$&')}\\.`), 'the working directory is interpolated');
});

test('rendering the prompt starts no tmux session', () => {
  const r = run('-x', '-n', 'cbp-x', '-d', work, '-H', handover);
  assert.equal(r.status, 0, r.stderr);
  const calls = (fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8') : '').trim().split('\n').filter(Boolean);
  assert.ok(calls.length > 0 && calls.every((c) => c.startsWith('has-session ')), `only existence checks, no new-session: ${calls}`);
  assert.ok(promptOf('cbp-x').length > 500);
});