#!/usr/bin/env node
// Opt-in REAL-provider smoke of the V2 goal loop (spec Phase 3/7: live smoke only with opt-in and recorded cost).
//   V2_LIVE_SMOKE=claude|codex|minimax|opencode node scripts/v2-live-smoke.js
// Spends real quota: one trivial task (write hello.txt with a fixed line) in a disposable git repo under the system
// temp dir, never inside this checkout. Developer = the chosen real CLI through its V2 adapter (normal permission
// mode, cheapest settings: claude-haiku-4-5 with --max-budget-usd 0.10; codex default model, low effort; minimax
// default model). Reviewer = a scripted fake (approve), so only the developer run costs anything. The acceptance
// check is a deterministic `node -e` on the committed SHA. Prints one JSON object: runtime, model, tokens, cost
// (unknown stays null), outcome. No model output is printed or kept. minimax: set MCODE_NODE_DIR to a Node 24 bin dir
// when the default node is 23.x (mcode 0.6.3 refuses it; see docs/v2/RUNTIME_FORMATS.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTaskStore } from '../orchestration/store.js';
import { createWorktrees } from '../orchestration/worktrees.js';
import { createLeaseAuthority, fileBackend } from '../orchestration/lease-authority.js';
import { createRegistry } from '../orchestration/model-registry.js';
import { createVerifier } from '../orchestration/verifier.js';
import { createGoalLoop } from '../orchestration/goal-loop.js';
import { createIntake } from '../orchestration/intake.js';
import { route as realRoute } from '../orchestration/router.js';
import { createAdapter as fakeAdapter } from '../orchestration/adapters/fake.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WHICH = process.env.V2_LIVE_SMOKE;
const PROFILES = {
  claude: { module: '../orchestration/adapters/claude.js', model: 'claude-haiku-4-5', provider: 'anthropic', efforts: ['low', 'medium'], effort: null, extraArgs: ['--max-budget-usd', '0.10'], passModel: true },
  codex: { module: '../orchestration/adapters/codex.js', model: 'default', provider: 'openai', efforts: ['low'], effort: 'low', extraArgs: [], passModel: false },
  opencode: { module: '../orchestration/adapters/opencode.js', model: 'opencode/big-pickle', provider: 'multi', efforts: [], effort: null, extraArgs: [], passModel: true }, // free model; cost is reported by the CLI
  minimax: { module: '../orchestration/adapters/minimax.js', model: 'default', provider: 'minimax', efforts: [], effort: null, extraArgs: [], passModel: false },
};
const LINE = 'hello from mycodebox v2';
const CHECK = ['node', '-e', `const s=require('fs').readFileSync('hello.txt','utf8');process.exit(s.trim()===${JSON.stringify(LINE)}?0:1)`];

async function main() {
  const p = PROFILES[WHICH];
  if (!p) {
    process.stderr.write('usage: V2_LIVE_SMOKE=claude|codex|minimax|opencode node scripts/v2-live-smoke.js  (spends real provider quota)\n');
    process.exitCode = 2;
    return;
  }
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-live-smoke-')));
  if (!path.relative(ROOT, tmp).startsWith('..')) throw new Error('refusing to run inside the repository');
  const started = Date.now();
  const out = { schema: 'mycodebox.v2.live-smoke/1', runtime: WHICH, model: p.passModel ? p.model : 'cli default', effort: p.effort, reviewer: 'fake scripted (approve)',
    started_at: new Date(started).toISOString(), cli_version: null, outcome: null, final_state: null, developer_runs: 0, checks: [], usage: [], totals: null, error_classes: [], duration_ms: null };
  try {
    const env = { PATH: process.env.PATH, HOME: os.homedir(), LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const sh = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const git = (a, { cwd } = {}) => Promise.resolve().then(() => execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.ai'), { recursive: true });
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.name', 'Smoke User'); sh(repo, 'config', 'user.email', 'smoke@example.invalid');
    fs.writeFileSync(path.join(repo, 'README.md'), '# smoke\n');
    fs.writeFileSync(path.join(repo, '.ai', 'project.json'), JSON.stringify({ schema_version: 1, project_id: 'live-smoke', test_command: CHECK,
      allowlists: { commands: [['node', '-e']], paths: ['hello.txt'], runtimes: null, models: null }, protected_paths: ['.ai'], approval_policy: { requires: [] } }, null, 1));
    sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'init');
    const wtRoot = path.join(tmp, 'wt'); const reviewRoot = path.join(tmp, 'review');
    for (const d of [wtRoot, reviewRoot, path.join(tmp, 'vtmp')]) fs.mkdirSync(d, { recursive: true });

    const { createAdapter } = await import(p.module);
    const real = createAdapter({ allowedRoots: [wtRoot], extraArgs: p.extraArgs, killGraceMs: 2000, probeTimeoutMs: 15000 });
    out.cli_version = (await real.probeCapabilities()).version;
    // Cheapest settings: drop the registry's placeholder model name where the CLI default is wanted; fixed effort.
    const dev = { ...real, start: (o) => real.start({ ...o, model: p.passModel ? o.model : undefined, effort: p.effort ?? undefined }) };
    const rev = fakeAdapter({ allowedRoots: [reviewRoot], script: [{ op: 'emit', event: { type: 'result', text: JSON.stringify({ verdict: 'approve', findings: [] }) } }] });
    const registry = createRegistry({ version: 1, as_of: '2026-10-11', models: [
      { runtime: WHICH, provider: p.provider, model: p.model, tier: 'light', capabilities: ['text', 'code', 'tools'], efforts: p.efforts, context_tokens: 200000, latency_ms: 10000 },
      { runtime: 'fake', provider: 'fake', model: 'rev', tier: 'standard', capabilities: ['text', 'code', 'tools'], efforts: [], context_tokens: 100000, latency_ms: 1, test_only: true },
    ] });
    const devId = `${WHICH}:${p.model}`;
    // The developer is always the real runtime; the scripted reviewer is only ever picked for the review.
    const route = (task, o) => realRoute(task, { ...o, exclude: (o.exclude || []).includes(devId) ? o.exclude : [...(o.exclude || []), 'fake:rev'] });
    const storeDir = path.join(tmp, 'state', 'v2');
    const store = createTaskStore({ dir: storeDir });
    const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(storeDir, 'leases') }) });
    const loop = createGoalLoop({ store, registry, adapters: { [WHICH]: dev, 'fake:rev': rev }, worktrees: createWorktrees({ root: wtRoot, repoAllowlist: [repo], leases, git }),
      worktreeRoot: wtRoot, verifier: createVerifier({ tmpRoot: path.join(tmp, 'vtmp'), timeoutMs: 30_000 }), reviewRoot, leases, git, allowFake: true, route, runTimeoutMs: 4 * 60_000 });
    const { task } = await createIntake({ store }).createTask({ project_id: 'live-smoke', repository: repo, risk_class: 'low', runtime_capabilities: ['code'],
      goal: `Create a file named hello.txt in the repository root whose entire content is exactly this one line: ${LINE}`,
      acceptance_checks: [{ id: 'hello', command: CHECK, expect: { exit: 0 }, evidence_type: 'exit_code', required: true }] }, { source: 'api', actor_id: 'live-smoke' });
    // Stop at the first state that needs time, quota or the owner: a smoke never waits out a backoff.
    const deadline = Date.now() + 10 * 60_000;
    let r;
    for (;;) {
      r = await loop.step(task.task_id);
      if (r.terminal || ['accepted', 'waiting', 'awaiting_approval', 'failed_unrecoverable', 'cancelled'].includes(r.state) || (!r.transitioned && !r.again) || Date.now() > deadline) break;
    }
    const v = await store.get(task.task_id);
    out.final_state = v.status;
    out.outcome = v.outcome;
    out.developer_runs = v.history.filter((h) => h.to === 'executing').length;
    out.checks = v.evidence.map((e) => ({ check_id: e.check_id, exit: e.exit }));
    out.usage = v.usage.map((u) => ({ role: u.run_id?.includes('.review') ? 'reviewer (fake)' : 'developer', input_tokens: u.input_tokens, output_tokens: u.output_tokens, usd: u.usd, incomplete: u.incomplete ?? null }));
    out.totals = v.usage_totals;   // includes the fake reviewer, whose usage is unknown: totals stay null by design
    const devU = out.usage.filter((u) => u.role === 'developer');
    const sum = (k) => (devU.length && devU.every((u) => typeof u[k] === 'number') ? devU.reduce((a, u) => a + u[k], 0) : null);
    out.developer_totals = { input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), usd: sum('usd') };
    const evs = await store.events(task.task_id);
    out.error_classes = evs.filter((e) => e.kind === 'tool.failed').map((e) => e.payload.error?.class ?? 'unknown');
    out.wait_reason = r.note && v.status !== 'accepted' ? String(r.note).slice(0, 160) : null;
  } catch (e) {
    out.outcome = 'error';
    out.error = String(e?.code || e?.message || e).slice(0, 200);
  } finally {
    out.duration_ms = Date.now() - started;
    if (!process.env.V2_LIVE_SMOKE_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
  process.exitCode = out.outcome === 'done' ? 0 : 1;
}

main();
