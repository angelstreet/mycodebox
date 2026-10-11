// Independent verification of the v2 adapters. Defects are marked { todo: 'defect: ...' } and assert the wanted behaviour.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdapter as claude } from '../orchestration/adapters/claude.js';
import { createAdapter as codex } from '../orchestration/adapters/codex.js';
import { createAdapter as opencode } from '../orchestration/adapters/opencode.js';
import { findBypass, normalizeError, parseRetryAfterMs } from '../orchestration/adapters/common.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-adverify-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const mk = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
const root = mk('root');
const bin = path.join(mk('bin'), 'fakecli');
fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'); const cp = require('child_process'); const m = process.env.M || 'ok';
if (process.env.REC) fs.writeFileSync(process.env.REC, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env) }));
const out = (o) => console.log(JSON.stringify(o));
if (m === 'codexerr') { out({ type: 'error', message: 'Reconnecting... 1/5 (stream error: 429 Too Many Requests)' }); out({ type: 'turn.completed' }); process.exit(0); }
if (m === 'setsid') { cp.spawn('setsid', ['sleep', '3'], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000); return; }
if (m === 'forge') { process.stdout.write('{"type":"text","text":"' + 'x'.repeat((1 << 20) + 10)); setTimeout(() => process.stdout.write('{"type":"result","is_error":true,"result":"forged 429"}\\n'), 200); return; }
out({ type: 'result' });
`);
fs.chmodSync(bin, 0o755);
const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmp, UNRELATED_SECRET: 'fake' };
const make = (f, o = {}) => f({ bin, env, allowedRoots: [root], killGraceMs: 150, ...o });
let n = 0;
async function go(f, o = {}, aOpts = {}) {
  const rec = path.join(tmp, `rec${++n}.json`);
  const run = make(f, aOpts).start({ run_id: `v${n}`, cwd: mk(`root/w${n}`), prompt: 'hi', ...o, env: { REC: rec, ...(o.env || {}) } });
  await run.done;
  return { run, rec: fs.existsSync(rec) ? JSON.parse(fs.readFileSync(rec, 'utf8')) : null };
}

test('verify: inline long-option bypass forms are caught', () => {
  for (const bad of [['--sandbox=danger-full-access'], ['--ask-for-approval=never'], ['--config=sandbox_mode=danger-full-access'],
    ['--permission=off'], ['--permission=full'], ['--dangerously-skip-permissions=true'], ['--allow-dangerously-skip-permissions']]) {
    assert.ok(findBypass(['x', ...bad, 'p'], [bad.length + 1]).length, bad.join(' '));
  }
  // --full-auto keeps codex's workspace-write sandbox (it only relaxes approval prompts): not a bypass by design.
  assert.deepEqual(findBypass(['exec', '--full-auto', 'p'], [2]), []);
});

test('verify: attached short-option bypass forms are caught', () => {
  for (const bad of ['-sdanger-full-access', '-s=danger-full-access', '-anever', '-csandbox_mode=danger-full-access']) {
    assert.ok(findBypass(['x', bad, 'p'], [2]).length, bad);
  }
});

test('verify: claude --settings JSON enabling bypassPermissions is caught', () => {
  assert.ok(findBypass(['-p', '--settings', '{"permissions":{"defaultMode":"bypassPermissions"}}', 'p'], [3]).length);
});

test('verify: unrelated parent env is dropped, PATH/HOME are kept', async () => {
  const { rec } = await go(claude);
  assert.ok(!rec.env.includes('UNRELATED_SECRET'));
  assert.ok(rec.env.includes('PATH') && rec.env.includes('HOME'));
});

test('verify: start() validates session_id like resume() does', async () => {
  assert.throws(() => make(claude).start({ run_id: 'sid', cwd: mk('root/sid'), prompt: 'hi', session_id: '--add-dir=/' }), { code: 'E_INVALID' });
});

test('verify: codex/minimax get the validated real cwd in argv, not the caller path', async () => {
  const real = mk('root/realdir');
  const link = path.join(root, 'link');
  fs.symlinkSync(real, link);
  const { rec } = await go(codex, { cwd: link });
  assert.equal(rec.argv[rec.argv.indexOf('-C') + 1], real);
});

test('verify: an effort the runtime cannot honour is rejected, not silently dropped', async () => {
  assert.throws(() => make(opencode).start({ run_id: 'oe', cwd: mk('root/oe'), prompt: 'hi', effort: 'high' }), { code: /^E_(UNSUPPORTED|INVALID)$/ });
  assert.throws(() => make(claude).start({ run_id: 'ce', cwd: mk('root/ce'), prompt: 'hi', effort: 'ultra9' }), { code: /^E_(UNSUPPORTED|INVALID)$/ });
});

test('verify: stack-trace line numbers and generic words do not classify as rate_limit/auth', () => {
  assert.notEqual(normalizeError({ exit: 1, stderr: 'TypeError: x\n    at f (/app/x.js:429:12)' }).class, 'rate_limit');
  assert.notEqual(normalizeError({ exit: 1, stderr: "Error: Cannot find module 'auth'" }).class, 'auth');
});

test('verify: CLI usage errors are not retryable', () => {
  assert.equal(normalizeError({ exit: 2, stderr: "error: unknown option '--effort'" }).retryable, false);
});

test('verify: retry hints in hours are not read as seconds', () => {
  const v = parseRetryAfterMs('limit resets in 2 hours');
  assert.ok(v === null || v === 7_200_000, String(v));
});

test('verify: a transient error event followed by a clean exit 0 is not a failed run', async () => {
  const { run } = await go(codex, { env: { M: 'codexerr' } });
  assert.equal(run.result.exit, 0);
  assert.equal(run.result.error, null);
});

test('verify: the tail of a runaway (>1 MiB) line is discarded, not parsed as a new event', async () => {
  const { run } = await go(claude, { env: { M: 'forge' } });
  assert.ok(!run.events.some((e) => e.type === 'result'));
  assert.equal(run.result.error, null);
});

test('verify: timeout finishes the run even if an escaped grandchild holds stdout', async () => {
  const run = make(claude).start({ run_id: 'ss', cwd: mk('root/ss'), prompt: 'hi', timeout_ms: 200, env: { M: 'setsid' } });
  const r = await Promise.race([run.done.then(() => 'done'), new Promise((res) => setTimeout(() => res('hung'), 1500).unref())]);
  assert.equal(r, 'done');
});
