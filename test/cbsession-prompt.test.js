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
const handover = path.join(home, 'handover.md'); fs.writeFileSync(handover, '# handover\nGoal: do it.\nDone when:\n1. the check passes with a run id\n');

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
  assert.match(p, /run `integrate request`, then continue, or `STATUS: waiting: integration <id>` if nothing else is left/);
  assert.ok(p.includes('STATUS: waiting: integration <id>'), 'the STATUS line keeps the <id> placeholder');
  assert.match(p, /end the turn with `STATUS: waiting:/, 'the multi-line backtick pair is literal too');
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
test('integrate CLI message says keep working, wait only when nothing else is left (2026-11-01)', async () => {
  const { readFileSync } = await import('node:fs');
  const s = readFileSync(new URL('../scripts/integrate', import.meta.url), 'utf8');
  assert.match(s, /Keep working on anything that does not depend on it; end the turn with STATUS: waiting: integration %s only when nothing else is left\./);
  assert.doesNotMatch(s, /End your turn with: STATUS/);
});

test('every prompt kind (-H, -t, -f) opens with the ship rule in its first lines (owner 2026-11-11)', () => {
  const pf = path.join(home, 'p.md'); fs.writeFileSync(pf, 'do the thing\nDone when:\n1. the check passes with a run id\n');
  for (const [n, args] of [['cbp-s1', ['-H', handover]], ['cbp-s2', ['-t', 'do the thing']], ['cbp-s3', ['-f', pf]]]) {
    const r = run('-x', '-n', n, '-d', work, ...args);
    assert.equal(r.status, 0, r.stderr);
    const top = promptOf(n).split('\n').slice(0, 4).join('\n');
    assert.match(top, /Ship rule[\s\S]*`integrate request <branch> \[--deploy \.\.\.\]`[\s\S]*never ask permission[\s\S]*vpt-headless-verify/);
  }
});

// bug-3ac8b59c: a brief written straight to ~/handovers/<NAME>.prompt.md was truncated to the preamble and no session started.
test('a -f brief that already is ~/handovers/<NAME>.prompt.md keeps its text (bug-3ac8b59c)', () => {
  fs.mkdirSync(path.join(home, 'handovers'), { recursive: true });
  const own = path.join(home, 'handovers', 'cbp-own.prompt.md');
  fs.writeFileSync(own, 'review the thing, read-only\nDone when:\n1. the report exists with a run id\n');
  const r = run('-x', '-n', 'cbp-own', '-d', work, '-f', own);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /input file is output file/);
  const p = promptOf('cbp-own');
  assert.match(p.split('\n')[0], /^Ship rule/);
  assert.match(p, /review the thing, read-only\nDone when:\n1\. the report exists with a run id/);
});

test('the handover prompt has one merge rule: ship through integrate request, never "merge your own tested work" (2026-11-11)', () => {
  const r = run('-x', '-n', 'cbp-m', '-d', work, '-H', handover);
  assert.equal(r.status, 0, r.stderr);
  const p = promptOf('cbp-m');
  assert.doesNotMatch(p, /merge your own tested work/);
  assert.match(p, /ship\s+your own tested work \(commit, push your branch, `integrate request`: the lane merges/);
  assert.match(p, /never\s+merge into the target, push the target or run the deploy script yourself/);
  assert.match(p, /force-push or history rewrites/);
});

// goal first, verification last (owner 2026-11-11, docs/GOAL-RULE.md)
test('cbsession: a handover / prompt file with no checkable Done-when line is refused (exit 2); -D, -A and a -t one-liner start', () => {
  const bare = path.join(home, 'bare.md'); fs.writeFileSync(bare, '# bare\nGoal: do it.\n');
  let r = run('-x', '-n', 'cbg-1', '-d', work, '-H', bare);
  assert.equal(r.status, 2); assert.match(r.stderr, /refused: the brief has no checkable 'Done when:' line/);
  r = run('-x', '-n', 'cbg-2', '-d', work, '-f', bare);
  assert.equal(r.status, 2);
  r = run('-x', '-n', 'cbg-3', '-d', work, '-H', bare, '-D', 'run 7 passes with a report link', '-D', 'bug-1 is resolved', '-T', '90 min');
  assert.equal(r.status, 0, r.stderr);
  const p = promptOf('cbg-3');
  assert.match(p, /\nDone when:\n1\. run 7 passes with a report link\n2\. bug-1 is resolved\n/); assert.match(p, /\nTime box: 90 min\n/);
  r = run('-x', '-n', 'cbg-4', '-d', work, '-f', bare, '-A');
  assert.equal(r.status, 0, r.stderr); assert.match(promptOf('cbg-4'), /1\. The goal is reached, and the result carries evidence another party can open/);
  r = run('-x', '-n', 'cbg-5', '-d', work, '-t', 'Fix the lease thing');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /a -t one-liner has no Done-when line/);
  assert.match(promptOf('cbg-5'), /Time box: [26] h/);
});
test('cbsession: the handover Goal / Done when / Time box lines reach the prompt; a fix name gets 2 h, a feature 6 h; the rule text is in every prompt', () => {
  const h = path.join(home, 'h2.md'); fs.writeFileSync(h, 'Goal: ship it.\nDone when:\n1. merged, integration id\n2. deployed, live sha\n');
  run('-x', '-n', 'bug-cbg-fix', '-d', work, '-H', h); run('-x', '-n', 'cbg-feat', '-d', work, '-H', h);
  assert.match(promptOf('bug-cbg-fix'), /\nTime box: 2 h\n/); assert.match(promptOf('cbg-feat'), /\nTime box: 6 h\n/);
  for (const n of ['bug-cbg-fix', 'cbg-feat']) { const p = promptOf(n); assert.match(p, /\n2\. deployed, live sha\n/); assert.match(p, /\*\*Goal first, verification last/); }
  const r = run('-x', '-n', 'cbg-h3', '-d', work, '-H', h, '-T', '3 h'); assert.match(promptOf('cbg-h3'), /\nTime box: 3 h\n/);
});
