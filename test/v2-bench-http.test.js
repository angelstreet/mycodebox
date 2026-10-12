// scripts/v2-bench-http.js in --fake mode: the benchmark suite driven through the HTTP API of a real disposable server
// child (GHOSTY_V2=1, temp state/work root, loopback port, private tmux socket, scripted fake adapter). Offline.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { runBench, parseArgs } from '../scripts/v2-bench.js';
import { spendOf, registryDoc } from '../scripts/v2-bench-http.js';
import { validateManifest } from '../orchestration/scorecard.js';
import { profileFor, entryOf } from '../scripts/v2-bench.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-bench-http-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sockets = () => fs.readdirSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`)).filter((f) => f.startsWith('v2bench-'));

test('http driver: done, forbidden -> awaiting_approval, impossible -> waiting_no_progress through a real server; nothing left behind', async () => {
  const before = (() => { try { return sockets(); } catch { return []; } })();
  const servers = () => execFileSync('ps', ['-eo', 'args']).toString().split('\n').filter((l) => /^node server\.js/.test(l)).length;
  const serversBefore = servers();
  const out = path.join(TMP, 'out');
  const lines = [];
  const { manifest } = await runBench({ http: true, fake: true, out, tasks: 'fix-failing-test,forbidden-merge-deploy,impossible-contradiction', max_usd: 3, task_usd: 1,
    fake_overrides: { 'impossible-contradiction': 'hang' }, agent_timeout_min: 0.0005, run_timeout_min: 2, poll_ms: 100, log: (l) => lines.push(l) });
  assert.equal(validateManifest(manifest).ok, true);
  assert.equal(manifest.driver, 'http');
  assert.equal(manifest.schema, 'mycodebox.v2.bench-run/1');
  const by = Object.fromEntries(manifest.runs.map((r) => [r.bench_task_id, r]));
  assert.equal(by['fix-failing-test'].outcome, 'done');
  assert.equal(by['forbidden-merge-deploy'].outcome, 'awaiting_approval');
  assert.equal(by['forbidden-merge-deploy'].never_done_ok, true);
  assert.equal(by['impossible-contradiction'].outcome, 'waiting_no_progress');
  for (const r of manifest.runs) {
    assert.equal(r.outcome_correct, true, `${r.bench_task_id}: ${r.outcome} ${r.error}`);
    assert.equal(r.driver, 'http');
    assert.equal(r.main_unchanged, true);
    assert.match(r.task_id, /^[A-Za-z0-9]/);
  }
  // The reviewer is read back from the server, not assumed.
  const d = by['fix-failing-test'];
  assert.equal(d.reviewer_as_planned, true);
  assert.deepEqual(d.reviewer_actual, ['fake:fake-review']);
  assert.deepEqual(d.developer_actual, ['fake:fake-dev']);
  assert.ok(d.developer_runs >= 1 && d.reviewer_runs >= 1);
  assert.equal(d.usd, d.usd_known);
  assert.ok(by['impossible-contradiction'].developer_runs >= 3);
  // The store is the server's own, next to the manifest, and the scorer can read it.
  assert.equal(manifest.store_dir, 'state/v2');
  const sc = spawnSync(process.execPath, ['scripts/v2-score.js', '--tool-score', '--suite', path.join(out, 'manifest.json'), '--store', path.join(out, 'state', 'v2')], { encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '..') });
  assert.equal(sc.status, 0, sc.stderr);
  const ts = JSON.parse(sc.stdout);
  assert.ok(JSON.stringify(ts).includes('fix-failing-test') || ts.runs_scored > 0 || ts.coverage != null, sc.stdout.slice(0, 300));
  assert.ok(fs.existsSync(path.join(out, 'server.log')));
  // Server child and its private tmux server are gone.
  assert.deepEqual(sockets().filter((s) => !before.includes(s)), [], 'private tmux socket left behind');
  const ps = execFileSync('ps', ['-eo', 'args']).toString();
  assert.ok(!/v2bench-[0-9a-f]{8}/.test(ps), 'tmux server left running');
  assert.equal(servers(), serversBefore, 'server child left running');
  assert.ok(fs.existsSync(path.join(out, 'state')) && fs.readdirSync(out).includes('manifest.json'));
});

test('http driver: options, fake needs the two scripted entries, real-mode registry keeps harness entry ids', () => {
  const o = parseArgs(['--http', '--fake', '--concurrency', '2', '--poll-ms', '200']);
  assert.equal(o.http, true); assert.equal(o.concurrency, 2); assert.equal(o.poll_ms, 200);
  assert.throws(() => parseArgs(['--runtimes', 'codex', '--concurrency', '0']), /concurrency/);
  assert.equal(parseArgs(['--runtimes', 'codex']).concurrency, 1);
  const profiles = new Map(['claude:haiku', 'codex', 'opencode'].map((s) => { const p = profileFor(s); return [entryOf(p), p]; }));
  const doc = registryDoc(profiles);
  assert.deepEqual(doc.models.map((m) => `${m.runtime}:${m.model}`).sort(), ['claude:claude-haiku-4-5', 'codex:default', 'opencode:opencode/big-pickle']);
  assert.equal(doc.models.find((m) => m.runtime === 'opencode').free, true);
  const sp = spendOf([{ runtime: 'codex', model: 'default', usd: null }, { runtime: 'claude', model: 'claude-haiku-4-5', usd: 0.02 }], (id) => (id === 'codex:default' ? 0.3 : null));
  assert.deepEqual([sp.known_usd, sp.estimated_usd, sp.unknown, sp.usd], [0.02, 0.3, true, null]);
  return assert.rejects(runBench({ http: true, fake: true, runtimes: ['other-dev'], out: path.join(TMP, 'x'), max_usd: 1 }), /fake-dev and fake-review/);
});
