// scripts/cloud-start names the model of a cloud session: Sonnet unless -m (owner 2026-11-28). git and tmux are stubs: nothing leaves the host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/cloud-start', import.meta.url));

function run(t, args) {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-start-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = (name, body) => writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('git', 'case "$1 $2" in "rev-parse --abbrev-ref") echo b ;; "rev-parse HEAD") echo abc ;; "ls-remote origin") printf "abc\\tr\\n" ;; *) echo https://example.invalid/repo.git ;; esac');
  stub('tmux', 'case "$3" in new-session) for a; do last=$a; done; printf "%s" "$last" > "$STUB_DIR/cmd" ;; capture-pane) echo "View: https://claude.ai/code/session_FAKE1" ;; esac');
  const r = spawnSync('bash', [SCRIPT, '-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_DIR: dir, GHOSTY_STATE_DIR: dir, MYCODEBOX_SESSION: 'test' } });
  let cmd = null;
  try { cmd = readFileSync(join(dir, 'cmd'), 'utf8'); } catch { /* refused before a start */ }
  return { ...r, cmd, dir };
}

test('cloud-start starts on Sonnet by default', (t) => {
  const r = run(t, ['-t', 'task']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.cmd, /^claude --model sonnet --cloud /);
});

test('cloud-start -m wins', (t) => {
  assert.match(run(t, ['-m', 'opus', '-t', 'task']).cmd, /^claude --model opus --cloud /);
});

test('cloud-start refuses a model name that is not an id', (t) => {
  const r = run(t, ['-m', 'x; touch y', '-t', 'task']);
  assert.equal(r.status, 2);
  assert.equal(r.cmd, null);
});

// Security review 2026-11-28: the log line is JSON-encoded, the label is the lane's cloud-<label>, the file is private.
test('cloud-start refuses a bad label and a task that starts with -', (t) => {
  for (const args of [['-l', 'x"y', '-t', 'task'], ['-l', 'a b', '-t', 'task'], ['-t', '--dangerously-skip-permissions']]) {
    const r = run(t, args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.cmd, null);
  }
});

test('cloud-start logs one valid JSON line, mode 600, whatever the task holds', (t) => {
  const task = 'fix "quotes" \\ back\tslash';
  const r = run(t, ['-l', 'fix-foo', '-t', task]);
  assert.equal(r.status, 0, r.stderr);
  const f = join(r.dir, 'cloud-sessions.jsonl');
  const line = JSON.parse(readFileSync(f, 'utf8').trim());
  assert.equal(line.task, task);
  assert.equal(line.label, 'fix-foo');
  assert.equal(line.id, 'session_FAKE1');
  assert.equal(statSync(f).mode & 0o777, 0o600);
});
