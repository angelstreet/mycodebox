import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAdapter as claude } from '../orchestration/adapters/claude.js';
import { createAdapter as codex } from '../orchestration/adapters/codex.js';
import { createAdapter as minimax } from '../orchestration/adapters/minimax.js';
import { createAdapter as opencode } from '../orchestration/adapters/opencode.js';
import { createAdapter as fake } from '../orchestration/adapters/fake.js';
import { findBypass, normalizeError, createLineParser } from '../orchestration/adapters/common.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-adapters-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const mk = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return fs.realpathSync(d); };
const binDir = mk('bin');
const root = mk('root');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// One fake CLI script, installed under each CLI name; FAKE_MODE selects behaviour, FAKE_OUT records what it saw.
const SCRIPT = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const a = process.argv.slice(2); const name = path.basename(process.argv[1]); const mode = process.env.FAKE_MODE || 'ok';
if (a[0] === '--version') { if (mode === 'badversion') process.exit(3); console.log(name + ' 9.9.9'); process.exit(0); }
if (process.env.FAKE_OUT) fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: a, cwd: process.cwd(), env: Object.keys(process.env) }));
const out = (o) => console.log(JSON.stringify(o));
if (mode === 'rate') { console.error('Error 429: rate limit exceeded. Retry-After: 30'); process.exit(1); }
if (mode === 'ctx') { console.error('prompt is too long: 250000 tokens > maximum context length'); process.exit(1); }
if (mode === 'crashsig') { process.kill(process.pid, 'SIGSEGV'); }
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
if (mode === 'hangterm') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
if (mode === 'child') { const c = cp.spawn('sleep', ['30'], { stdio: 'ignore' }); fs.writeFileSync(process.env.CHILD_PID, String(c.pid)); setInterval(() => {}, 1000); return; }
if (mode === 'late') { setTimeout(() => { fs.writeFileSync(path.join(process.cwd(), 'late.txt'), 'x'); process.exit(0); }, 400); return; }
if (name === 'claude') {
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  console.log('not json at all');
  process.stdout.write('{"type":"assis');
  setTimeout(() => {
    process.stdout.write('tant","message":{"content":[{"type":"text","text":"split"},{"type":"tool_use","name":"Edit"}]}}\\n');
    out({ type: 'result', is_error: false, result: 'done', usage: { input_tokens: 11, output_tokens: 7 }, total_cost_usd: 0.25 });
  }, 30);
} else if (name === 'codex') {
  out({ type: 'thread.started', thread_id: 'thr-1' });
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } });
  out({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3 } });
} else { out({ type: 'text', text: 'hello' }); out({ type: 'result' }); }
`;
const CLIS = { claude, codex, minimax, opencode };
const BIN = { claude: 'claude', codex: 'codex', minimax: 'mcode', opencode: 'opencode' };
for (const b of Object.values(BIN)) { const p = path.join(binDir, b); fs.writeFileSync(p, SCRIPT); fs.chmodSync(p, 0o755); }

const baseEnv = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmp, SECRET_TOKEN: 'fake-secret', AWS_SECRET_ACCESS_KEY: 'fake' };
function adapterFor(name, extra = {}) {
  return CLIS[name]({ bin: path.join(binDir, BIN[name]), env: baseEnv, allowedRoots: [root], killGraceMs: 150, ...extra });
}
let n = 0;
function work() { return mk(`root/w${n++}`); }
async function runCli(name, mode, o = {}, aOpts = {}) {
  const cwd = work();
  const rec = path.join(tmp, `rec${n}.json`);
  const a = adapterFor(name, aOpts);
  const run = a.start({ task_id: 't', run_id: `r${n}`, cwd, prompt: 'hi', env: { FAKE_MODE: mode, FAKE_OUT: rec, ...(o.env || {}) }, ...o });
  await run.done;
  return { a, run, cwd, rec: fs.existsSync(rec) ? JSON.parse(fs.readFileSync(rec, 'utf8')) : null };
}

test('T03 no adapter argv carries a permission/sandbox bypass flag; safe flags present', async () => {
  const expect = {
    claude: ['-p', '--output-format', 'stream-json', '--permission-mode', 'acceptEdits', '--model', 'm1', '--effort', 'high'],
    codex: ['exec', '--json', '-s', 'workspace-write', '-C', '-m', 'm1', '-c', 'model_reasoning_effort="high"'],
    minimax: ['exec', '--cwd', '--output-format', 'stream-json', '--permission', 'smart', '--model', 'm1', '--effort', 'high'],
    opencode: ['run', '--format', 'json', '--model', 'm1'],
  };
  for (const name of Object.keys(CLIS)) {
    const { rec, run } = await runCli(name, 'ok', name === 'opencode' ? { model: 'm1' } : { model: 'm1', effort: 'high' });
    assert.equal(run.result.exit, 0, name);
    assert.deepEqual(findBypass(rec.argv, [rec.argv.length - 1]), [], name);
    for (const f of expect[name]) assert.ok(rec.argv.includes(f), `${name} argv lacks ${f}: ${rec.argv}`);
    assert.equal(rec.argv.at(-1), 'hi');
  }
});

test('T03 bypass guard throws on injected flags in every form; prompt text is not scanned', () => {
  for (const bad of [['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--permission-mode=bypassPermissions'],
    ['-s', 'danger-full-access'], ['--dangerously-bypass-approvals-and-sandbox'], ['--permission', 'off'], ['-a', 'never'], ['--yolo'],
    ['-c', 'sandbox_mode="danger-full-access"']]) {
    assert.ok(findBypass(['x', ...bad, 'p'], [bad.length + 1]).length, bad.join(' '));
  }
  assert.deepEqual(findBypass(['run', '--yolo'], [1]), []); // the prompt may mention anything
  for (const name of Object.keys(CLIS)) {
    const a = adapterFor(name, { extraArgs: ['--dangerously-skip-permissions'] });
    assert.throws(() => a.start({ task_id: 't', run_id: 'g', cwd: work(), prompt: 'hi' }), { code: 'E_BYPASS' }, name);
  }
});

test('T03 cwd must be a real directory inside an allowed root (incl. symlink escape)', () => {
  const a = adapterFor('claude');
  const outside = mk('outside');
  assert.throws(() => a.start({ task_id: 't', cwd: outside, prompt: 'x' }), { code: 'E_CWD' });
  assert.throws(() => a.start({ task_id: 't', cwd: path.join(root, '..', 'outside'), prompt: 'x' }), { code: 'E_CWD' });
  assert.throws(() => a.start({ task_id: 't', cwd: path.join(root, 'nope'), prompt: 'x' }), { code: 'E_CWD' });
  assert.throws(() => a.start({ task_id: 't', cwd: 'relative', prompt: 'x' }), { code: 'E_CWD' });
  const link = path.join(root, 'escape-link');
  fs.symlinkSync(outside, link);
  assert.throws(() => a.start({ task_id: 't', cwd: link, prompt: 'x' }), { code: 'E_CWD' });
  assert.throws(() => adapterFor('claude', { allowedRoots: [] }).start({ task_id: 't', cwd: work(), prompt: 'x' }), { code: 'E_CWD' });
  assert.throws(() => a.start({ task_id: 't', cwd: work(), prompt: 'x', model: '--dangerously-skip-permissions' }), { code: 'E_INVALID' });
});

test('T03 shell metacharacters in the prompt arrive verbatim as one argv element and are not executed', async () => {
  const m1 = path.join(tmp, 'pwned1');
  const m2 = path.join(tmp, 'pwned2');
  const prompt = `$(touch ${m1}) ; touch ${m2} \`touch ${m1}\` "q" 'q' | cat > /dev/null && echo $HOME`;
  for (const name of Object.keys(CLIS)) {
    const { rec } = await runCli(name, 'ok', { prompt });
    assert.equal(rec.argv.at(-1), prompt, name);
    assert.equal(rec.argv.filter((x) => x === prompt).length, 1);
  }
  assert.ok(!fs.existsSync(m1) && !fs.existsSync(m2));
  const { rec } = await runCli('claude', 'ok', { prompt: '--not-a-flag' }); // dash-leading prompt cannot become a flag
  assert.deepEqual(rec.argv.slice(-2), ['--', '--not-a-flag']);
});

test('env: unrelated secrets are not passed; explicit env and provider keys are', async () => {
  const { rec } = await runCli('claude', 'ok', {}, { env: { ...baseEnv, ANTHROPIC_API_KEY: 'fake-key' } });
  assert.ok(!rec.env.includes('SECRET_TOKEN') && !rec.env.includes('AWS_SECRET_ACCESS_KEY'));
  assert.ok(rec.env.includes('ANTHROPIC_API_KEY') && rec.env.includes('FAKE_MODE') && rec.env.includes('PATH'));
  const c = await runCli('codex', 'ok', {}, { env: { ...baseEnv, ANTHROPIC_API_KEY: 'fake-key' } });
  assert.ok(!c.rec.env.includes('ANTHROPIC_API_KEY'));
});

test('JSONL: partial and garbage lines tolerated; events normalized; session captured', async () => {
  const { run } = await runCli('claude', 'ok');
  const types = run.events.map((e) => e.type);
  assert.ok(types.includes('unparsed') && types.includes('started'));
  assert.ok(run.events.some((e) => e.type === 'text' && e.text === 'split'));
  assert.ok(run.events.some((e) => e.type === 'tool_use' && e.name === 'Edit'));
  assert.equal(types.at(-1), 'exit');
  assert.equal(run.session_id.length > 0, true);
  const got = [];
  const lp = createLineParser((l) => got.push(l));
  lp.write('{"a":'); lp.write('1}\n\n{"b"'); lp.end();
  assert.deepEqual(got, ['{"a":1}', '{"b"']);
  const seen = [];
  for await (const e of (await runCli('codex', 'ok')).a.observe(run)) seen.push(e.type); // replayable
  assert.equal(seen.at(-1), 'exit');
});

test('usage: reported -> numbers; not reported -> null, never 0', async () => {
  const c = await runCli('claude', 'ok');
  assert.deepEqual(c.a.collectUsage(c.run), { input_tokens: 11, output_tokens: 7, usd: 0.25, incomplete: false });
  const x = await runCli('codex', 'ok');
  assert.deepEqual(x.a.collectUsage(x.run), { input_tokens: 5, output_tokens: 3, usd: null, incomplete: false });
  const m = await runCli('minimax', 'ok');
  assert.deepEqual(m.a.collectUsage(m.run), { input_tokens: null, output_tokens: null, usd: null, incomplete: false });
});

test('raw output only in the run artifact dir, never in cwd', async () => {
  const artifactDir = mk('artifacts');
  const { run, cwd } = await runCli('claude', 'ok', {}, { artifactDir });
  const raw = fs.readFileSync(path.join(artifactDir, run.run_id, 'stdout.log'), 'utf8');
  assert.match(raw, /not json at all/);
  assert.deepEqual(fs.readdirSync(cwd), []);
  assert.ok(!JSON.stringify(run.events).includes('not json at all'));
});

test('T11 probe: not installed -> unavailable; failing --version -> unknown; ok -> version', async () => {
  const a = opencode({ bin: path.join(binDir, 'no-such-opencode'), env: baseEnv });
  const p = await a.probeCapabilities();
  assert.equal(p.available, false);
  assert.equal(p.version, null);
  assert.equal(p.features.resume, false);
  const ok = await adapterFor('claude').probeCapabilities();
  assert.equal(ok.available, true);
  assert.equal(ok.version, '9.9.9');
  assert.equal(ok.features.resume, true);
  assert.equal(ok.models, null); // unknown is null, not []
});

test('T11 probe: ambiguous failure -> unknown (non-zero --version exit, hang)', async () => {
  const cp = await import('node:child_process');
  const viaMode = (mode) => (bin, args, o) => cp.spawn(bin, args, { ...o, env: { ...o.env, FAKE_MODE: mode } });
  assert.equal((await adapterFor('claude', { spawn: viaMode('badversion') }).probeCapabilities()).available, 'unknown');
  const hang = `#!/bin/sh\nsleep 30\n`;
  const p = path.join(binDir, 'hangver'); fs.writeFileSync(p, hang); fs.chmodSync(p, 0o755);
  const t0 = Date.now();
  const r = await claude({ bin: p, env: baseEnv, probeTimeoutMs: 200 }).probeCapabilities();
  assert.equal(r.available, 'unknown');
  assert.ok(Date.now() - t0 < 3000);
});

test('T11 unsupported ops throw E_UNSUPPORTED', () => {
  const o = adapterFor('opencode');
  assert.throws(() => o.resume({ session_id: 'abc' }), { code: 'E_UNSUPPORTED' });
  for (const name of Object.keys(CLIS)) assert.throws(() => adapterFor(name).send({}, 'x'), { code: 'E_UNSUPPORTED' }, name);
  assert.throws(() => fake().send({}, 'x'), { code: 'E_UNSUPPORTED' });
});

test('resume maps to each CLI session flag', async () => {
  const c = adapterFor('claude');
  const cwd = work();
  const rec = path.join(tmp, 'resume-claude.json');
  const run = c.resume({ session_id: 'sess-9', task_id: 't', run_id: 'rc', cwd, env: { FAKE_OUT: rec } });
  await run.done;
  const argv = JSON.parse(fs.readFileSync(rec, 'utf8')).argv;
  assert.deepEqual(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2), ['--resume', 'sess-9']);
  assert.ok(!argv.includes('--session-id'));
  const x = await (async () => { const r = path.join(tmp, 'resume-codex.json'); const run2 = adapterFor('codex').resume({ session_id: 'thr-9', task_id: 't', run_id: 'rx', cwd: work(), env: { FAKE_OUT: r } }); await run2.done; return JSON.parse(fs.readFileSync(r, 'utf8')).argv; })();
  assert.equal(x[x.indexOf('resume') + 1], 'thr-9');
  const r3 = path.join(tmp, 'resume-mm.json');
  const run3 = adapterFor('minimax').resume({ session_id: 'mm-9', task_id: 't', run_id: 'rm', cwd: work(), env: { FAKE_OUT: r3 } });
  await run3.done;
  const mm = JSON.parse(fs.readFileSync(r3, 'utf8')).argv;
  assert.equal(mm[mm.indexOf('--session') + 1], 'mm-9');
  assert.throws(() => c.resume({}), { code: 'E_INVALID' });
});

test('T12 429 stderr -> rate_limit with retry_after_ms, retryable', async () => {
  const { run } = await runCli('codex', 'rate');
  assert.deepEqual(run.result.error, { class: 'rate_limit', retryable: true, retry_after_ms: 30000 });
  assert.equal(run.events.at(-1).error.class, 'rate_limit');
});

test('error taxonomy table', () => {
  const cls = (i) => normalizeError(i).class;
  assert.equal(normalizeError({ exit: 1, stderr: 'overloaded_error, try again in 2 minutes' }).retry_after_ms, 120000);
  assert.equal(normalizeError({ exit: 1, stderr: 'quota exceeded' }).class, 'rate_limit');
  assert.equal(normalizeError({ exit: 1, stderr: 'rate limit' }).retry_after_ms, null);
  assert.equal(cls({ exit: 1, stderr: 'maximum context length exceeded' }), 'context_overflow');
  assert.equal(cls({ exit: 1, stderr: 'input is too long' }), 'context_overflow');
  assert.equal(cls({ code: 'ENOENT' }), 'unavailable');
  assert.equal(cls({ exit: 127, stderr: '' }), 'unavailable');
  assert.equal(cls({ exit: 1, stderr: '401 Unauthorized' }), 'auth');
  assert.equal(cls({ exit: 1, stderr: 'please login first' }), 'auth');
  assert.equal(cls({ exit: 1, stderr: 'Permission denied' }), 'permission');
  assert.equal(cls({ exit: 1, stderr: 'approval required' }), 'permission');
  assert.equal(cls({ signal: 'SIGSEGV' }), 'crash');
  assert.equal(cls({ exit: 2, stderr: 'weird' }), 'crash');
  assert.equal(cls({ timed_out: true, exit: null, stderr: '429' }), 'timeout');
  assert.equal(cls({}), 'unknown');
  assert.equal(cls(new Error('boom')), 'unknown');
  assert.equal(cls(Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })), 'unavailable');
  assert.equal(normalizeError({ exit: 1, stderr: 'x' }).retryable, false); // plain non-zero exit: deterministic
  assert.equal(normalizeError({ signal: 'SIGKILL' }).retryable, true); // signal death (OOM/SEGV)
  assert.equal(normalizeError({ exit: 1, stderr: '401' }).retryable, false);
});

test('context overflow, crash by signal, missing binary classified from a real run', async () => {
  assert.equal((await runCli('claude', 'ctx')).run.result.error.class, 'context_overflow');
  const s = (await runCli('claude', 'crashsig')).run;
  assert.equal(s.result.error.class, 'crash');
  assert.ok(s.result.signal);
  const a = claude({ bin: path.join(binDir, 'missing'), env: baseEnv, allowedRoots: [root] });
  const run = a.start({ task_id: 't', run_id: 'miss', cwd: work(), prompt: 'x' });
  await run.done;
  assert.equal(run.result.error.class, 'unavailable');
});

test('T12 timeout kills the process group and reports class timeout', async () => {
  const pidFile = path.join(tmp, 'child.pid');
  const cwd = work();
  const a = adapterFor('claude');
  const run = a.start({ task_id: 't', run_id: 'to', cwd, prompt: 'x', timeout_ms: 250, env: { FAKE_MODE: 'child', CHILD_PID: pidFile } });
  const pid = run.pid;
  await run.done;
  assert.equal(run.result.timed_out, true);
  assert.equal(run.result.error.class, 'timeout');
  assert.equal(run.result.error.retryable, true);
  assert.ok(!alive(pid));
  assert.ok(!alive(Number(fs.readFileSync(pidFile, 'utf8'))), 'grandchild in the process group is gone too');
});

test('T14 cancel during spawn: acknowledged, process gone, no later writes', async () => {
  const cwd = work();
  const run = adapterFor('claude').start({ task_id: 't', run_id: 'cx', cwd, prompt: 'x', env: { FAKE_MODE: 'late' } });
  const pid = run.pid;
  const ack = await adapterFor('claude').cancel(run); // cancel immediately, before the child produced anything
  assert.equal(ack.acknowledged, true);
  assert.equal(run.result.cancelled, true);
  assert.equal(run.result.error, null);
  assert.ok(!alive(pid));
  await sleep(600);
  assert.ok(!fs.existsSync(path.join(cwd, 'late.txt')), 'killed runtime wrote after cancel');
  assert.deepEqual((await adapterFor('claude').cancel(run)).already_finished, true); // idempotent
});

test('T14 cancel escalates to SIGKILL when SIGTERM is ignored; events stop after cancel', async () => {
  const a = adapterFor('claude');
  const run = a.start({ task_id: 't', run_id: 'ck', cwd: work(), prompt: 'x', env: { FAKE_MODE: 'hangterm' } });
  await sleep(150);
  const pid = run.pid;
  const t0 = Date.now();
  assert.equal((await a.cancel(run)).acknowledged, true);
  assert.ok(!alive(pid));
  assert.ok(Date.now() - t0 < 3000);
  const count = run.events.length;
  await sleep(100);
  assert.equal(run.events.length, count);
  assert.equal(run.events.at(-1).type, 'exit');
});

// ---- fake runtime ------------------------------------------------------------------------------
const fakeFor = (extra = {}) => fake({ allowedRoots: [root], ...extra });

test('fake: failing then fixed implementation across two starts', async () => {
  const a = fakeFor({ scripts: [
    [{ op: 'write', path: 'src/impl.js', content: 'bad' }, { op: 'usage', input_tokens: 10, output_tokens: 2, usd: 0.01 }, { op: 'emit', event: { type: 'text', text: 'v1' } }],
    [{ op: 'write', path: 'src/impl.js', content: 'good' }, { op: 'usage', input_tokens: 1, output_tokens: 1 }],
  ] });
  const cwd = work();
  const r1 = a.start({ task_id: 't', cwd, prompt: 'x' });
  await r1.done;
  assert.equal(fs.readFileSync(path.join(cwd, 'src/impl.js'), 'utf8'), 'bad');
  assert.deepEqual(a.collectUsage(r1), { input_tokens: 10, output_tokens: 2, usd: 0.01, incomplete: false });
  const r2 = a.start({ task_id: 't', cwd, prompt: 'x' });
  const seen = [];
  for await (const e of a.observe(r2)) seen.push(e.type);
  assert.equal(fs.readFileSync(path.join(cwd, 'src/impl.js'), 'utf8'), 'good');
  assert.equal(seen.at(-1), 'exit');
  assert.deepEqual(a.collectUsage(r2), { input_tokens: 1, output_tokens: 1, usd: null, incomplete: false });
});

test('fake: 429, context overflow, crash, hang->timeout', async () => {
  const cwd = work();
  const a = fakeFor();
  const go = async (script, o = {}) => { const r = a.start({ task_id: 't', cwd, prompt: 'x', script, ...o }); await r.done; return r; };
  assert.deepEqual((await go([{ op: 'stderr', text: '429 rate limit. retry-after: 5' }, { op: 'exit', code: 1 }])).result.error, { class: 'rate_limit', retryable: true, retry_after_ms: 5000 });
  assert.equal((await go([{ op: 'stderr', text: 'context length exceeded' }, { op: 'exit', code: 1 }])).result.error.class, 'context_overflow');
  assert.equal((await go([{ op: 'exit', code: 139 }])).result.error.class, 'crash');
  const t = await go([{ op: 'hang' }], { timeout_ms: 100 });
  assert.equal(t.result.error.class, 'timeout');
  assert.equal((await go([])).result.error, null);
  assert.equal(a.collectUsage(await go([])).usd, null);
});

test('T14 fake: cancel during spawn -> acknowledged, no later writes', async () => {
  const cwd = work();
  const a = fakeFor();
  const run = a.start({ task_id: 't', cwd, prompt: 'x', script: [{ op: 'delay', ms: 200 }, { op: 'write', path: 'late.txt', content: 'x' }, { op: 'emit', event: { type: 'text', text: 'late' } }] });
  assert.equal((await a.cancel(run)).acknowledged, true);
  await sleep(400);
  assert.ok(!fs.existsSync(path.join(cwd, 'late.txt')));
  assert.ok(!run.events.some((e) => e.type === 'text'));
  const h = a.start({ task_id: 't', cwd, prompt: 'x', script: [{ op: 'hang' }, { op: 'write', path: 'late2.txt', content: 'x' }] });
  await sleep(50);
  await a.cancel(h);
  await sleep(100);
  assert.ok(!fs.existsSync(path.join(cwd, 'late2.txt')));
});

test('fake: cwd validated, script writes cannot escape cwd', async () => {
  const a = fakeFor();
  assert.throws(() => a.start({ task_id: 't', cwd: mk('outside2'), prompt: 'x' }), { code: 'E_CWD' });
  const cwd = work();
  const r = a.start({ task_id: 't', cwd, prompt: 'x', script: [{ op: 'write', path: '../escape.txt', content: 'x' }] });
  await r.done;
  assert.ok(!fs.existsSync(path.join(cwd, '..', 'escape.txt')));
  assert.equal(r.result.exit, 1);
});

// ---- parser calibration: synthetic events with the shapes recorded in docs/v2/RUNTIME_FORMATS.md --------------
const fixCli = path.join(binDir, 'fixture-cli');
fs.writeFileSync(fixCli, `#!/usr/bin/env node
const fs = require('fs');
for (const l of JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'))) console.log(JSON.stringify(l));
process.exit(Number(process.env.FIX_EXIT || 0));
`);
fs.chmodSync(fixCli, 0o755);
async function fixture(factory, lines, exit = 0, aOpts = {}) {
  const f = path.join(tmp, `fix${n++}.json`);
  fs.writeFileSync(f, JSON.stringify(lines));
  const stdio0 = [];
  const cp = await import('node:child_process');
  const a = factory({ bin: fixCli, env: baseEnv, allowedRoots: [root], spawn: (b, args, o) => { stdio0.push(o.stdio[0]); return cp.spawn(b, args, o); }, ...aOpts });
  const run = a.start({ task_id: 't', run_id: `fx${n}`, cwd: work(), prompt: 'x', env: { FIXTURE: f, FIX_EXIT: String(exit) } });
  await run.done;
  return { a, run, stdio0 };
}

test('calibration claude: usage includes cache tokens; allowed rate_limit_event is not an error', async () => {
  const { a, run } = await fixture(claude, [
    { type: 'system', subtype: 'init', session_id: 'sid-1', model: 'm', tools: [] },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 3, estimated_tokens_delta: 3 },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1900000000, rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 999 } }, session_id: 'sid-1' },
    { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.5, usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 4 }, session_id: 'sid-1' },
  ]);
  assert.deepEqual(a.collectUsage(run), { input_tokens: 111, output_tokens: 4, usd: 0.5, incomplete: false });
  assert.equal(run.result.error, null);
  assert.ok(run.events.some((e) => e.type === 'rate_limit' && e.status === 'allowed'));
});

test('calibration claude: rejected rate_limit_event + exit 1 -> rate_limit with retry_after from resetsAt', async () => {
  const resets = Math.floor(Date.now() / 1000) + 600;
  const { run } = await fixture(claude, [
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resets, rateLimitType: 'five_hour' } },
    { type: 'result', subtype: 'error', is_error: true, result: 'blocked' },
  ], 1);
  assert.equal(run.result.error.class, 'rate_limit');
  assert.ok(run.result.error.retry_after_ms > 500_000 && run.result.error.retry_after_ms <= 600_000);
});

test('calibration codex: quota error on stdout -> rate_limit; stdin is ignored; reset time best effort', async () => {
  const lines = [
    { type: 'thread.started', thread_id: 'thr-9' },
    { type: 'turn.started' },
    { type: 'error', message: "You've hit your usage limit. Upgrade or try again at 11:59 PM." },
    { type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade or try again at 11:59 PM." } },
  ];
  const { run, stdio0 } = await fixture(codex, lines, 1);
  assert.deepEqual(stdio0, ['ignore']);
  assert.equal(run.result.error.class, 'rate_limit');
  assert.equal(run.result.error.retryable, true);
  assert.ok(run.result.error.retry_after_ms > 0 && run.result.error.retry_after_ms <= 86_400_000);
  assert.equal(run.session_id, 'thr-9');
  const unparseable = await fixture(codex, [{ type: 'error', message: 'usage limit reached, try again at tomorrow' }], 1);
  assert.equal(unparseable.run.result.error.class, 'rate_limit');
  assert.equal(unparseable.run.result.error.retry_after_ms, null);
});

test('calibration minimax: camelCase usage, usageIncomplete flagged, cost unknown', async () => {
  const env = { runId: 'r', sessionId: 'mm-s1', turnId: 't', schemaVersion: 1 };
  const { a, run } = await fixture(minimax, [
    { ...env, type: 'exec.started', sequence: 1 }, { ...env, type: 'session.started', sequence: 2 },
    { ...env, type: 'item.completed', item: { type: 'agent_message', text: 'OK' } },
    { ...env, type: 'turn.completed', durationMs: 5, model: 'm', usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 10, totalTokens: 35 }, usageIncomplete: true, usageSource: 'provider' },
    { ...env, type: 'exec.completed', result: 'OK' },
  ]);
  assert.deepEqual(a.collectUsage(run), { input_tokens: 30, output_tokens: 5, usd: null, incomplete: true });
  assert.equal(run.session_id, 'mm-s1');
  assert.ok(run.events.some((e) => e.type === 'text' && e.text === 'OK'));
  const clean = await fixture(minimax, [{ ...env, type: 'turn.completed', usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 10, totalTokens: 25 }, usageIncomplete: false }]);
  assert.deepEqual(clean.a.collectUsage(clean.run), { input_tokens: 20, output_tokens: 5, usd: null, incomplete: false });
});

test('verify extras: fake runtime does not follow a symlink out of cwd', async () => {
  const cwd = work();
  const outside = mk('fake-outside');
  fs.symlinkSync(outside, path.join(cwd, 'dir'));
  fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(cwd, 'leaf.txt'));
  const a = fakeFor();
  for (const p of ['dir/f.txt', 'leaf.txt']) await a.start({ task_id: 't', cwd, prompt: 'x', script: [{ op: 'write', path: p, content: 'x' }] }).done;
  assert.deepEqual(fs.readdirSync(outside), []);
});
