// scripts/merge-eval.js --kind merge|push|deploy: the interactive manager's checks, same evaluations as the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRepo, git } from './helpers-git.js';
import { validateDecision } from '../orchestration/task-contract.js';

const SCRIPT = new URL('../scripts/merge-eval.js', import.meta.url).pathname;
const GREEN = 'Tests: 1826/1826 pass on feat.';
function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', GHOSTY_ENV_FILE: '/nonexistent/.env', ...env }, timeout: 30000 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout: stdout.trim(), stderr, json: (() => { try { return JSON.parse(stdout.trim().split('\n').pop()); } catch { return null; } })() }));
  });
}
const stateDir = (runner = true) => { const d = mkdtempSync(join(tmpdir(), 'meval-state-')); writeFileSync(join(d, 'manager.json'), JSON.stringify({ deployRunner: runner })); writeFileSync(join(d, 'deploy-envs.json'), JSON.stringify({ 'env-a': {}, 'env-b': {} })); return d; };
function withOrigin() {
  const repo = makeRepo();
  const bare = join(mkdtempSync(join(tmpdir(), 'meval-origin-')), 'origin.git');
  git(repo, 'init', '-q', '--bare', bare); git(repo, 'remote', 'add', 'origin', bare); git(repo, 'push', '-q', 'origin', 'main', 'feat'); git(repo, 'fetch', '-q', 'origin');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'more');
  return repo;
}
// a fake `vpt-lease`: DEPLOY_REGISTRY='["node","<file>"]'
function fakeRegistry({ leases = [], deployed = {}, fail = false } = {}) {
  const f = join(mkdtempSync(join(tmpdir(), 'meval-reg-')), 'vpt-lease.mjs');
  writeFileSync(f, `const a = process.argv.slice(2).join(' ');
if (${JSON.stringify(fail)}) { console.error('down'); process.exit(3); }
if (a === 'deploy list --json') console.log(JSON.stringify({ deploys: [], leases: ${JSON.stringify(leases)} }));
else if (a === 'deploy last --json') console.log(JSON.stringify({ now: 1, envs: ${JSON.stringify(deployed)} }));
else { console.error('unknown'); process.exit(2); }
`);
  return JSON.stringify([process.execPath, f]);
}

test('--kind merge stays the default; --kind with a bad value is a usage error', async () => {
  const repo = makeRepo();
  const r = await run(['--repo', repo, '--text', `${GREEN}\n\nmerge feat into main?`, '--session', 's'], { env: { GHOSTY_STATE_DIR: stateDir() } });
  assert.equal(r.json.verdict, 'merge'); assert.equal(r.json.branch, 'feat');
  const bad = await run(['--repo', repo, '--kind', 'nope']);
  assert.equal(bad.code, 2);
});

test('--kind push: verdict, dest, ahead; --journal writes manager-decisions.jsonl', async () => {
  const repo = withOrigin(), dir = stateDir();
  const r = await run(['--repo', repo, '--kind', 'push', '--branch', 'feat', '--text', `${GREEN}\n\nshall I push feat?`, '--session', 'api-worker', '--journal'], { env: { GHOSTY_STATE_DIR: dir } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.verdict, 'push', JSON.stringify(r.json));
  assert.equal(r.json.dest, 'feat'); assert.equal(r.json.ahead, 1);
  const rec = JSON.parse(readFileSync(join(dir, 'manager-decisions.jsonl'), 'utf8').trim());
  assert.equal(rec.kind, 'push'); assert.deepEqual(validateDecision(rec).errors, []);
  const red = await run(['--repo', repo, '--kind', 'push', '--tests', 'red'], { env: { GHOSTY_STATE_DIR: dir } });
  assert.equal(red.json.verdict, 'escalate'); assert.match(red.json.reasons[0], /tests reported red/);
});

test('--kind deploy via the registry: free env -> deploy with a rollback; a lease by another agent -> escalate', async () => {
  const repo = makeRepo(), dir = stateDir();
  const prev = git(repo, 'rev-parse', 'main').trim();
  const reg = fakeRegistry({ deployed: { 'env-a': { server: { ref: 'main', commit: prev } } } });
  const args = ['--repo', repo, '--kind', 'deploy', '--env', 'env-a', '--ref', 'feat', '--branch', 'feat', '--text', GREEN, '--session', 'api-worker', '--journal'];
  const ok = await run(args, { env: { GHOSTY_STATE_DIR: dir, DEPLOY_REGISTRY: reg } });
  assert.equal(ok.json.verdict, 'deploy', JSON.stringify(ok.json));
  assert.equal(ok.json.env, 'env-a'); assert.equal(ok.json.scope, 'full'); assert.equal(ok.json.ref, 'feat');
  assert.equal(ok.json.rollback, `Rollback: request a deploy of ${prev.slice(0, 12)} to env-a (full).`);
  assert.equal(JSON.parse(readFileSync(join(dir, 'manager-decisions.jsonl'), 'utf8').trim()).kind, 'deploy');
  const leased = await run(args.slice(0, -1), { env: { GHOSTY_STATE_DIR: dir, DEPLOY_REGISTRY: fakeRegistry({ leases: [{ id: 'l1', env: 'env-a', resource: '*', agent: 'codebox:other' }] }) } });
  assert.equal(leased.json.verdict, 'escalate'); assert.deepEqual(leased.json.reasons, ['env-a leased by codebox:other (*)']);
  const off = await run(args.slice(0, -1), { env: { GHOSTY_STATE_DIR: stateDir(false), DEPLOY_REGISTRY: reg } });
  assert.match(off.json.reasons[0], /deploy runner off/);
});

test('--kind deploy falls back to the read-only HTTP API; with neither reachable it escalates "deploy queue state unavailable"', async () => {
  const repo = makeRepo(), dir = stateDir();
  const base = git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim();
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/deploys') res.end(JSON.stringify({ ok: true, deploys: [], deployed: { 'env-a': { server: { ref: 'main', commit: base } } }, envs: ['env-a', 'env-b'] }));
    else if (req.url === '/api/leases') res.end(JSON.stringify({ ok: true, leases: [], waiters: [] }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const args = ['--repo', repo, '--kind', 'deploy', '--env', 'env-a', '--ref', 'feat', '--branch', 'feat', '--text', GREEN];
    const viaApi = await run([...args, '--source', 'api', '--server', base], { env: { GHOSTY_STATE_DIR: dir } });
    assert.equal(viaApi.json.verdict, 'deploy', JSON.stringify(viaApi.json));
    assert.deepEqual(seen.sort(), ['GET /api/deploys', 'GET /api/leases']);   // read-only
    const broken = await run(args, { env: { GHOSTY_STATE_DIR: dir, DEPLOY_REGISTRY: fakeRegistry({ fail: true }), GHOSTY_URL: 'http://127.0.0.1:9' } });
    assert.equal(broken.json.verdict, 'escalate');
    assert.match(broken.json.reasons[0], /^deploy queue state unavailable/);
  } finally { srv.close(); }
});
