// GL11 / T11: one task, one set of acceptance checks, four execution paths: the real Claude Code and Codex adapters
// driving stub CLIs (temp executables that speak each CLI's JSON stream), a runtime that reports native subagents
// and delegates inside its own run, and the ordinary mycodebox worker it falls back to when that runtime is down.
// Every path must end in the same verified acceptance: evidence on the exact head SHA plus an independent verdict.
// No real provider is called; the stubs only write files in the task worktree and print synthetic usage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAdapter as claudeAdapter } from '../orchestration/adapters/claude.js';
import { createAdapter as codexAdapter } from '../orchestration/adapters/codex.js';
import { createAdapter as fakeAdapter } from '../orchestration/adapters/fake.js';
import { sandbox, world, devRuns, loopDecisions, GOOD, BAD, APPROVE } from './fixtures/v2-world.js';

const sb = sandbox('v2-acc-xprov-');
const caps = ['text', 'code', 'tools', 'resume', 'cancel'];
const REGISTRY = { version: 1, as_of: '2026-10-11', models: [
  { runtime: 'claude', provider: 'anthropic', model: 'stub-claude', tier: 'strong', capabilities: caps, efforts: ['low', 'medium', 'high'], context_tokens: 200000, latency_ms: 1 },
  { runtime: 'codex', provider: 'openai', model: 'stub-codex', tier: 'strong', capabilities: caps, efforts: ['low', 'medium', 'high'], context_tokens: 200000, latency_ms: 1 },
  { runtime: 'fake', provider: 'fake', model: 'native', tier: 'strong', capabilities: [...caps, 'native_subagents'], efforts: ['low', 'medium', 'high'], context_tokens: 200000, latency_ms: 1, test_only: true },
  { runtime: 'fake', provider: 'fake', model: 'worker', tier: 'standard', capabilities: caps, efforts: ['low', 'medium', 'high'], context_tokens: 200000, latency_ms: 1, test_only: true },
  { runtime: 'fake', provider: 'fake', model: 'rev', tier: 'standard', capabilities: caps, efforts: ['low', 'medium', 'high'], context_tokens: 100000, latency_ms: 10000, test_only: true },
] };

// One stub, installed as `claude` and `codex`. Each run takes the next step from STUB_PLAN (a JSON list of
// { files, usage }) and prints that CLI's stream format. It never reads the network or anything outside its cwd.
const STUB = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const name = path.basename(process.argv[1]); const a = process.argv.slice(2);
if (a[0] === '--version') { console.log(name + ' 0.0.0-stub'); process.exit(0); }
const plan = process.env.CLAUDE_CODE_STUB_PLAN || process.env.CODEX_STUB_PLAN;
const counter = plan + '.n'; const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(n + 1));
const steps = JSON.parse(fs.readFileSync(plan, 'utf8')); const s = steps[Math.min(n, steps.length - 1)];
fs.appendFileSync(plan + '.argv', JSON.stringify(a.slice(0, -1)) + '\\n');
for (const [f, c] of Object.entries(s.files)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); }
const out = (o) => console.log(JSON.stringify(o));
if (name === 'claude') {
  out({ type: 'system', subtype: 'init', session_id: 'stub-session-' + n });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }, { type: 'text', text: 'Done. All tests pass.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: s.usage.input, output_tokens: s.usage.output }, total_cost_usd: s.usage.usd });
} else {
  out({ type: 'thread.started', thread_id: 'stub-thread-' + n });
  out({ type: 'item.completed', item: { type: 'file_change' } });
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'Done. All tests pass.' } });
  out({ type: 'turn.completed', usage: { input_tokens: s.usage.input, output_tokens: s.usage.output } });
}
`;
const binDir = sb.dir('bin');
for (const b of ['claude', 'codex']) { fs.writeFileSync(path.join(binDir, b), STUB); fs.chmodSync(path.join(binDir, b), 0o755); }
const src = (body) => ({ 'src/math.js': `export const add = ${body};\n` });
const plan = (steps) => { const f = path.join(sb.dir('plan'), 'plan.json'); fs.writeFileSync(f, JSON.stringify(steps)); return f; };
const CLAUDE_PLAN = plan([{ files: src('(a, b) => a - b'), usage: { input: 1200, output: 300, usd: 0.012 } }, { files: src('(a, b) => a + b'), usage: { input: 1500, output: 320, usd: 0.015 } }]);
const CODEX_PLAN = plan([{ files: src('(a, b) => a - b'), usage: { input: 900, output: 200 } }, { files: src('(a, b) => a + b'), usage: { input: 950, output: 210 } }]);

// A runtime with native subagents: the parent run delegates to two children inside its own process; the children's
// files are the only artifact, and the parent's "all tests pass" text is just text.
const nativeRun = (childBody) => [
  { op: 'emit', event: { type: 'subagent', action: 'spawn', id: 'child-1', task: 'implement add' } },
  { op: 'write', path: 'src/math.js', content: `export const add = ${childBody};\n` },
  { op: 'usage', input_tokens: 300, output_tokens: 50 },
  { op: 'emit', event: { type: 'subagent', action: 'spawn', id: 'child-2', task: 'review add' } },
  { op: 'usage', input_tokens: 200, output_tokens: 40 },
  { op: 'emit', event: { type: 'text', text: 'Both subagents report success. All tests pass.' } },
];
function nativeAdapter(roots) {
  const a = fakeAdapter({ allowedRoots: roots, scripts: [nativeRun('(a, b) => a - b'), nativeRun('(a, b) => a + b')] });
  return { ...a, async probeCapabilities() { return { ...(await a.probeCapabilities()), models: null, features: { resume: true, cancel: true, json_output: true, native_subagents: true, vision: false } }; } };
}

const PATHS = {
  claude: { allow: ['stub-claude', 'rev'], adapters: ({ wtRoot, reviewRoot }) => ({
    claude: claudeAdapter({ bin: path.join(binDir, 'claude'), env: { PATH: process.env.PATH, HOME: sb.HOME, CLAUDE_CODE_STUB_PLAN: CLAUDE_PLAN },
    allowedRoots: [wtRoot] }),
    'fake:rev': fakeAdapter({ allowedRoots: [reviewRoot], scripts: [APPROVE] }) }) },
  codex: { allow: ['stub-codex', 'rev'], adapters: ({ wtRoot, reviewRoot }) => ({
    codex: codexAdapter({ bin: path.join(binDir, 'codex'), env: { PATH: process.env.PATH, HOME: sb.HOME, CODEX_STUB_PLAN: CODEX_PLAN },
    allowedRoots: [wtRoot] }),
    'fake:rev': fakeAdapter({ allowedRoots: [reviewRoot], scripts: [APPROVE] }) }) },
  native: { allow: ['native', 'rev'], adapters: ({ wtRoot, reviewRoot }) => ({
    fake: nativeAdapter([wtRoot]), 'fake:native': nativeAdapter([wtRoot]), 'fake:rev': fakeAdapter({ allowedRoots: [reviewRoot], scripts: [APPROVE] }) }) },
  // The native runtime is down (its binary is gone): the loop falls back to an ordinary worker inside the allowlist.
  fallback: { allow: ['native', 'worker', 'rev'], adapters: ({ wtRoot, reviewRoot }) => ({
    'fake:native': fakeAdapter({ allowedRoots: [wtRoot], script: [{ op: 'stderr', text: 'native-agent: command not found' }, { op: 'exit', code: 127 }] }),
    'fake:worker': fakeAdapter({ allowedRoots: [wtRoot], scripts: [BAD, GOOD] }), 'fake:rev': fakeAdapter({ allowedRoots: [reviewRoot], scripts: [APPROVE] }) }) },
};

async function runPath(name) {
  const p = PATHS[name];
  const env = world(sb, { registry: REGISTRY, adapters: p.adapters });
  const task = await env.submit({ model_allowlist: p.allow });
  const r = await env.loop.run(task.task_id);
  const v = await env.view(task.task_id);
  return { env, v, r, runs: devRuns(env, task.task_id), reviews: devRuns(env, task.task_id, 'reviewer') };
}
// What "accepted" proved, independent of who did the work.
const acceptance = (v) => ({
  outcome: v.outcome, checks: v.acceptance_checks.map((c) => ({ id: c.id, command: c.command, expect: c.expect, required: c.required })),
  definition_of_done: v.definition_of_done,
  passing_on_head: v.acceptance_checks.filter((c) => c.required).map((c) => v.evidence.some((e) => e.check_id === c.id && e.sha === v.head_sha && e.exit === c.expect.exit)),
  independent_approve_on_head: v.verdicts.some((x) => x.sha === v.head_sha && x.verdict === 'approve' && !v.usage.some((u) => u.run_id?.includes('.run') && `${u.runtime}:${u.model}` === x.actor.id)),
  failing_before_head: v.evidence.some((e) => e.sha !== v.head_sha && e.exit !== 0),
});

test('GL11/T11: real Claude and Codex adapters (stub CLIs), a native-subagent runtime and the ordinary-worker fallback all satisfy the identical acceptance checks', async () => {
  const out = {};
  for (const name of Object.keys(PATHS)) out[name] = await runPath(name);
  for (const [name, o] of Object.entries(out)) assert.equal(o.v.status, 'accepted', `${name}: ${o.r.note} ${JSON.stringify(o.env.events(o.v.task_id).filter((e) => e.kind === 'tool.failed').map((e) => e.payload))}`);
  const ref = acceptance(out.claude.v);
  assert.deepEqual(ref.passing_on_head, [true]);
  assert.equal(ref.independent_approve_on_head, true);
  assert.equal(ref.failing_before_head, true, 'each path first produced a failing SHA and was repaired');
  for (const name of ['codex', 'native', 'fallback']) assert.deepEqual(acceptance(out[name].v), ref, `${name} meets the same acceptance as claude`);

  // Who did the work differs; how it was proven does not.
  assert.deepEqual(out.claude.runs.map((x) => x.entry), ['claude:stub-claude', 'claude:stub-claude']);
  assert.deepEqual(out.codex.runs.map((x) => x.entry), ['codex:stub-codex', 'codex:stub-codex']);
  assert.deepEqual(out.native.runs.map((x) => x.entry), ['fake:native', 'fake:native']);
  assert.deepEqual(out.fallback.runs.map((x) => x.entry), ['fake:native', 'fake:worker', 'fake:worker']);
  for (const o of Object.values(out)) assert.deepEqual(o.reviews.map((x) => x.entry), ['fake:rev'], 'the reviewer is never a developer runtime');
  // The fallback is a recorded decision inside the allowlist, not a silent switch.
  const fb = loopDecisions(out.fallback.v, 'provider_fallback');
  assert.equal(fb.length, 1);
  assert.equal(fb[0].chosen, 'switch to a compatible runtime');
  assert.match(fb[0].loop.next.reason, /fake:worker/);

  // Native delegation: the parent said "all tests pass" on its first run; the checks said otherwise and won.
  const nv = out.native.v;
  const firstSha = nv.evidence[0].sha;
  assert.notEqual(firstSha, nv.head_sha);
  assert.ok(nv.evidence.filter((e) => e.sha === firstSha).every((e) => e.exit !== 0), 'textual success claim did not count');
  assert.ok(!nv.verdicts.some((x) => x.sha === firstSha), 'a failing SHA is never even reviewed');
  // Children inherit the parent's budget accounting: their usage is the run's usage.
  assert.deepEqual(nv.usage.filter((u) => u.run_id.includes('.run')).map((u) => [u.input_tokens, u.output_tokens]), [[500, 90], [500, 90]]);

  // Real adapters: argv kept the safe permission flags, usage parsed from each CLI's stream, unknown cost stays null.
  const cu = out.claude.v.usage.filter((u) => u.runtime === 'claude');
  assert.deepEqual(cu.map((u) => [u.input_tokens, u.output_tokens, u.usd]), [[1200, 300, 0.012], [1500, 320, 0.015]]);
  const xu = out.codex.v.usage.filter((u) => u.runtime === 'codex');
  assert.deepEqual(xu.map((u) => [u.input_tokens, u.output_tokens, u.usd]), [[900, 200, null], [950, 210, null]]);
  assert.equal(out.codex.v.usage_totals.usd, null, 'codex reports no cost: unknown, not $0');
  const argvOf = (f) => fs.readFileSync(`${f}.argv`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const a of argvOf(CLAUDE_PLAN)) assert.deepEqual(a.slice(0, 6), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
  for (const a of argvOf(CODEX_PLAN)) assert.deepEqual(a.slice(0, 4), ['exec', '--json', '-s', 'workspace-write']);
  for (const a of [...argvOf(CLAUDE_PLAN), ...argvOf(CODEX_PLAN)]) assert.ok(!a.some((x) => /dangerously|bypass|danger-full-access/i.test(x)), a.join(' '));
});
