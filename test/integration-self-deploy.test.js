// The lane's self deploy (deploy.kind 'self'): the repo of the service that runs the lane. A fake live checkout (a clone of
// the throwaway remote), a fake restart launcher and a fake health check; the real restart command runs a fake safe-restart.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createIntegrationLane, createDefaultRun, validateConfig, restartCommand } from '../integration-lane.js';
import { integrationText } from '../integration-notify.js';
import { makeWorld } from './helpers-lane.js';
import { git, commit } from './helpers-git.js';

// package.json type=module like the real repo: node 23.6's --check exits 0 on a broken ES module without it (module-syntax detection)
const BASE = { 'server.js': 'export const up = 1;\n', 'VERSION.txt': '1\n', 'package.json': '{"type":"module"}\n' };
function world() {
  const w = makeWorld({ name: 'self-repo', base: BASE });
  w.live = join(w.root, 'live');
  git(w.root, 'clone', '-q', w.remote, w.live);
  w.liveHead = () => git(w.live, 'rev-parse', 'HEAD').trim();
  return w;
}
const tick = () => new Promise((r) => setTimeout(r, 1));
function mk(w, { stateDir = mkdtempSync(join(tmpdir(), 'lane-self-')), restart, health = async () => true, run, cfg = {}, lane = {} } = {}) {
  const events = [], launches = [];
  const l = createIntegrationLane({ stateDir, config: { repos: { me: w.cfg({ deploy: { kind: 'self', liveCheckout: w.live, restartWaitMin: 0 }, ...cfg }) } },
    notify: (r, e) => events.push({ r, e }), pollMs: 1, sleep: tick, health, ...(run ? { run } : {}),
    restart: async (o) => { launches.push(o); return restart ? restart(o) : { ok: true }; }, ...lane });
  l.start();
  return { lane: l, stateDir, events, launches };
}
const until = async (fn, ms = 120000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); } throw new Error('timed out waiting'); };
const lastRecord = (stateDir, id) => readFileSync(join(stateDir, 'integration', 'requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.id === id).at(-1);

test('merge, pull, check: the request is done, persisted and told BEFORE the restart launcher runs', async () => {
  const w = world(); w.branch('feat', { 'new.js': 'x\n' });
  writeFileSync(join(w.live, 'untracked.log'), 'fine\n');   // untracked files never block a deploy
  const prev = w.liveHead();
  let onDisk = null, told = null;
  const a = mk(w, { restart: () => { onDisk = lastRecord(a.stateDir, id); told = a.events.map((x) => x.e.kind + ':' + x.e.state); return { ok: true }; } });
  const id = a.lane.enqueue({ repo: 'me', branch: 'feat', session: 's1' }).id;
  const r = await a.lane.wait(id, 120000);
  await until(() => a.launches.length);
  assert.equal(onDisk.state, 'deployed'); assert.equal(onDisk.selfDeploy.outcome, 'deployed'); assert.equal(onDisk.selfDeploy.phase, 'done');
  assert.equal(onDisk.selfDeploy.newSha, w.main()); assert.equal(onDisk.selfDeploy.prevSha, prev); assert.match(onDisk.selfDeploy.note, /restart scheduled via safe-restart/);
  assert.ok(told.includes('final:deployed'), `event emitted before launch: ${told}`);
  assert.equal(a.launches.length, 1); assert.equal(a.launches[0].cwd, w.live); assert.equal(a.launches[0].waitMin, 0);
  assert.equal(w.liveHead(), w.main(), 'the live checkout was pulled');
  assert.equal(r.state, 'deployed', JSON.stringify(r)); assert.equal(r.restartError, undefined);
  assert.deepEqual(r.steps.map((s) => s.name).filter((n) => /^(precheck|push|deploy-)/.test(n)), ['precheck', 'push', 'deploy-check', 'deploy-pull', 'deploy-syntax']);
  const text = integrationText(r);
  assert.match(text, new RegExp(`deployed live ghosty at ${w.main().slice(0, 12)} \\(was ${prev.slice(0, 12)}\\), restart scheduled via safe-restart\\.`));
  assert.match(text, new RegExp(`Rollback: git -C ${w.live} reset --hard ${prev.slice(0, 12)}`));
});

test('a restart after done never re-runs the request: a new boot leaves a deployed request alone', async () => {
  const w = world(); w.branch('feat', { 'new.js': 'x\n' });
  const a = mk(w);
  const id = a.lane.enqueue({ repo: 'me', branch: 'feat' }).id;
  await a.lane.wait(id, 120000); await until(() => a.launches.length);
  a.lane.stop(); await a.lane.idle();   // the restart's SIGTERM
  const b = mk(w, { stateDir: a.stateDir });
  await tick(); await b.lane.idle();
  assert.equal(b.launches.length, 0); assert.equal(b.lane.get(id).state, 'deployed'); assert.equal(b.lane.get(id).resumed, undefined);
  assert.equal(b.events.length, 0);
});

test('launching safe-restart fails: restartError recorded, manager item raised, outcome stays deployed', async () => {
  const w = world(); w.branch('feat', { 'new.js': 'x\n' });
  const items = [];
  const m = mk(w, { restart: () => ({ ok: false, error: 'no server running on the tmux socket' }), lane: { managerItem: (e) => items.push(e) } });
  const r = await m.lane.wait(m.lane.enqueue({ repo: 'me', branch: 'feat' }).id, 120000);
  await until(() => items.length);
  assert.equal(r.state, 'deployed');
  const rec = lastRecord(m.stateDir, r.id);
  assert.equal(rec.state, 'deployed'); assert.match(rec.restartError, /no server running/); assert.equal(rec.selfDeploy.outcome, 'deployed');
  assert.match(items[0].title, /restart NOT launched/); assert.equal(items[0].priority, 'high'); assert.match(items[0].body, /safe-restart\.sh/);
});

test('tracked edits in the live checkout: deploy refused with the file list, nothing pulled or restarted, the merge stays', async () => {
  const w = world(); w.branch('feat', { 'new.js': 'x\n' });
  writeFileSync(join(w.live, 'server.js'), 'export const up = 2; // hand edit\n');
  writeFileSync(join(w.live, 'untracked.txt'), 'x\n');
  const prev = w.liveHead();
  const { lane, launches, events } = mk(w);
  const r = await lane.wait(lane.enqueue({ repo: 'me', branch: 'feat' }).id, 120000);
  assert.equal(r.state, 'deploy_failed'); assert.equal(r.selfDeploy.outcome, 'deploy_refused');
  assert.equal(events.at(-1).e.kind, 'final'); assert.equal(events.at(-1).e.state, 'deploy_failed');   // notify turns this into the high-priority manager event
  assert.match(r.reason, /uncommitted changes to tracked files: server\.js$/); assert.doesNotMatch(r.reason, /untracked/);
  assert.equal(w.liveHead(), prev); assert.equal(launches.length, 0); assert.equal(r.rollback, null);
  assert.equal(w.show('main', 'new.js'), 'x\n');
  assert.match(integrationText(r), /merged feat into main .* but the live ghosty deploy failed \(deploy refused/);
});

test('live checkout diverged: pull --ff-only fails, deploy refused, not restarted', async () => {
  const w = world(); w.branch('feat', { 'new.js': 'x\n' });
  commit(w.live, { 'local.js': 'local\n' }, 'a local commit on the live checkout');
  const { lane, launches } = mk(w);
  const r = await lane.wait(lane.enqueue({ repo: 'me', branch: 'feat' }).id, 120000);
  assert.equal(r.state, 'deploy_failed'); assert.equal(r.selfDeploy.outcome, 'deploy_refused');
  assert.match(r.reason, /git pull --ff-only failed/); assert.equal(launches.length, 0);
});

test('a merge whose server.js does not parse is returned before the push', async () => {
  const w = world(); w.branch('feat', { 'server.js': 'export const = ;\n' });
  const before = w.main();
  const { lane, launches } = mk(w);
  const r = await lane.wait(lane.enqueue({ repo: 'me', branch: 'feat' }).id, 120000);
  assert.equal(r.state, 'returned'); assert.match(r.reason, /node --check server\.js failed on the merge/);
  assert.equal(w.main(), before); assert.equal(launches.length, 0);
});

test('node --check fails after the pull: reported loudly, never restarted, rollback line given', async () => {
  const w = world(); w.branch('feat', { 'new.js': 'x\n' });
  const real = createDefaultRun();
  const run = (cmd, o) => (o.cwd === w.live && /--check server\.js/.test(cmd) ? Promise.resolve({ code: 1, out: 'SyntaxError: fake' }) : real(cmd, o));
  const prev = w.liveHead();
  const { lane, launches } = mk(w, { run });
  const r = await lane.wait(lane.enqueue({ repo: 'me', branch: 'feat' }).id, 120000);
  assert.equal(r.state, 'deploy_failed'); assert.equal(r.selfDeploy.outcome, 'check_failed');
  assert.match(r.reason, /node --check server\.js FAILED .*NOT restarted, the service still runs/); assert.match(r.tail, /SyntaxError: fake/);
  assert.equal(launches.length, 0); assert.equal(w.liveHead(), w.main());
  assert.match(r.rollback, new RegExp(`reset --hard ${prev.slice(0, 12)}`));
});

test('lockfile changed: npm ci runs in the live checkout before the check', async () => {
  const w = world(); w.branch('feat', { 'package-lock.json': '{}\n' });
  const real = createDefaultRun(), cmds = [];
  const run = (cmd, o) => { cmds.push([cmd, o.cwd]); return cmd.startsWith('npm ci') ? Promise.resolve({ code: 0, out: '' }) : real(cmd, o); };
  const { lane } = mk(w, { run });
  await lane.wait(lane.enqueue({ repo: 'me', branch: 'feat' }).id, 120000);
  assert.ok(cmds.some(([c, cwd]) => c === 'npm ci --no-audit --no-fund' && cwd === w.live), JSON.stringify(cmds));
});

test('config: kind self needs an absolute or ~/ live checkout; a --deploy scope is ignored (every merge deploys)', async () => {
  const ok = validateConfig({ repos: { me: { clone: '/x', deploy: { kind: 'self', liveCheckout: '~/live-checkout' } } } });
  assert.deepEqual(ok.errors, []); assert.equal(ok.repos.me.deploy.kind, 'self'); assert.match(ok.repos.me.deploy.liveCheckout, /^\/.*\/live-checkout$/);
  assert.equal(ok.repos.me.deploy.restartWaitMin, 10);
  for (const bad of [{ kind: 'self' }, { kind: 'self', liveCheckout: 'rel/path' }, { kind: 'self', liveCheckout: '/a#b' }, { kind: 'self', liveCheckout: '/x', restartWaitMin: 99 }]) {
    assert.equal(validateConfig({ repos: { me: { clone: '/x', deploy: bad } } }).errors.length, 1, JSON.stringify(bad));
  }
  const w = world(); w.branch('feat', { 'new.js': 'x\n' });
  const { lane } = mk(w);
  const q = lane.enqueue({ repo: 'me', branch: 'feat', deploy: 'full' });
  assert.equal(lane.get(q.id).deployScope, null);
  await lane.wait(q.id, 120000);
});

test('the real restart command runs safe-restart.sh in the live checkout and records its output and exit code', () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-restart-'));
  const live = join(root, "live dir"), out = join(root, 'out');
  mkdirSync(join(live, 'scripts'), { recursive: true }); mkdirSync(out);
  writeFileSync(join(live, 'scripts', 'safe-restart.sh'), '#!/bin/sh\necho "args: $*"; echo "cwd: $(pwd)"; echo "NOT restarting: fake guard" >&2; exit 2\n');
  chmodSync(join(live, 'scripts', 'safe-restart.sh'), 0o755);
  const log = join(out, 'r.log'), exit = join(out, 'r.exit');
  execFileSync('sh', ['-c', restartCommand({ cwd: live, waitMin: 7, log, exit })]);
  assert.equal(readFileSync(exit, 'utf8').trim(), '2'); assert.ok(!existsSync(`${exit}.tmp`));
  const text = readFileSync(log, 'utf8');
  assert.match(text, /args: --wait 7/); assert.match(text, /cwd: .*live dir/); assert.match(text, /NOT restarting: fake guard/);
});
