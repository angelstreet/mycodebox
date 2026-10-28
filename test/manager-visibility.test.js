// manager-status-scan.sh and manager-wake-summary.sh: the manager must see every blocked session and every event of a wake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';

const SC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const home = tmp('mvis-');
const bin = path.join(home, 'bin'), panes = path.join(home, 'panes'); fs.mkdirSync(bin); fs.mkdirSync(panes);
// a fake tmux: list-sessions prints the files of panes/, capture-pane -t <s>: prints panes/<s>
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
case "$1" in
  list-sessions) ls ${panes} ;;
  capture-pane) while [ $# -gt 0 ]; do [ "$1" = "-t" ] && t="$2"; shift; done; cat "${panes}/\${t%:}" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
const pane = (n, text) => fs.writeFileSync(path.join(panes, n), text);
const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, PORT: '1' };
pane('worker-a', 'work\nSTATUS: needs-manager: merge decision for fix/x\n$ \n');
pane('worker-b', 'STATUS: needs-manager: old question\nmore\nSTATUS: working: tests\n');          // a later STATUS wins: not flagged
pane('worker-c', 'STATUS: blocked: waiting for lease\n');
pane('worker-d', '  - STATUS: ready-for-gate: branch pushed\n');
pane('worker-e', 'STATUS: needs-owner: which database?\n');
pane('worker-f', 'no status here, but the word blocked\n');
pane('worker-g', 'STATUS: working: fine\n');

test('status scan: prints sessions whose LAST STATUS needs attention, exit 0', () => {
  const r = spawnSync('bash', [path.join(SC, 'manager-status-scan.sh')], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'worker-a: STATUS: needs-manager: merge decision for fix/x',
    'worker-c: STATUS: blocked: waiting for lease',
    'worker-d: - STATUS: ready-for-gate: branch pushed',
    'worker-e: STATUS: needs-owner: which database?',
  ]);
});

test('status scan --json: a JSON array; no tmux server still exits 0 with []', () => {
  const r = spawnSync('bash', [path.join(SC, 'manager-status-scan.sh'), '--json'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const a = JSON.parse(r.stdout);
  assert.deepEqual(a.map((x) => x.session), ['worker-a', 'worker-c', 'worker-d', 'worker-e']);
  assert.match(a[0].status, /needs-manager/);
  const empty = path.join(home, 'bin-empty'); fs.mkdirSync(empty);
  fs.writeFileSync(path.join(empty, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });      // "no server running"
  const none = spawnSync('bash', [path.join(SC, 'manager-status-scan.sh'), '--json'], { env: { PATH: `${empty}:/usr/bin:/bin`, HOME: home, PORT: '1' }, encoding: 'utf8' });
  assert.equal(none.status, 0); assert.deepEqual(JSON.parse(none.stdout), []);
});

test('wake summary: every event on its own line, needs-manager / asks / hold flagged, nothing truncated', () => {
  const evs = [];
  for (let i = 0; i < 12; i++) evs.push({ k: `k${i}`, l: { at: `2026-10-22T10:00:${String(i).padStart(2, '0')}Z`, kind: i === 3 ? 'asks' : i === 5 ? 'hold' : 'lease', session: `s${i}`, title: `title ${i}`, body: i === 7 ? 'STATUS: needs-manager: pick' : 'x', jev: i === 3 ? { pick: 'merge' } : undefined } });
  evs.push({ at: '2026-10-22T11:00:00Z', kind: 'health', session: 'h', title: 'raw event without wrapper' });   // unwrapped events too
  const f = path.join(home, 'wake.jsonl'); fs.writeFileSync(f, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r = spawnSync('bash', [path.join(SC, 'manager-wake-summary.sh'), f], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 13);
  assert.match(lines[3], /^!! 2026-10-22T10:00:03Z \| asks \| s3 \| title 3 \| jev merge$/);
  assert.match(lines[5], /^!! .*\| hold \|/);
  assert.match(lines[7], /^!! /);
  assert.match(lines[0], /^ {3}2026.*\| lease \| s0 \| title 0 \| jev -$/);
  assert.match(lines[12], /raw event without wrapper/);
  assert.equal(lines.filter((l) => l.startsWith('!!')).length, 3);
  assert.equal(spawnSync('bash', [path.join(SC, 'manager-wake-summary.sh')], { env, encoding: 'utf8' }).status, 2);
});

test('manager-fresh kick text names both scripts and the never-idle rule', () => {
  const src = fs.readFileSync(path.join(SC, 'manager-fresh.sh'), 'utf8');
  assert.match(src, /read ALL events \(scripts\/manager-wake-summary\.sh\) and run scripts\/manager-status-scan\.sh in every hourly sweep; a session whose last STATUS is needs-manager\/needs-owner\/blocked is never "idle"/);
});
