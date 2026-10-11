// T16 (V2 is inert for the existing dashboard unless enabled) and T19 (existing state migration: V2 state lives only
// under $GHOSTY_STATE_DIR/v2, legacy files stay byte-identical, removing v2/ restores the old tree exactly).
// server.js is read as text, never imported. The state dir is a temp dir seeded with synthetic legacy files.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTaskStore, defaultStoreDir } from '../orchestration/store.js';
import { createLeaseAuthority, fileBackend } from '../orchestration/lease-authority.js';
import { createIncidentStore } from '../orchestration/incidents.js';
import { createAdmissionController } from '../orchestration/system-ops.js';
import { createIntegrationQueue } from '../orchestration/integration-queue.js';
import { createLayoutStore } from '../layout.js';
import { spec, clock, SHA_A } from './fixtures/v2-task.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-acc-state-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ---- T16 ----------------------------------------------------------------------------------------------

// Static ESM import graph from a file: `import ... from '<rel>'`, `export ... from '<rel>'`, bare `import '<rel>'`.
function staticImports(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}
function graph(entry) {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const s of staticImports(f)) if (s.startsWith('.')) walk(path.resolve(path.dirname(f), s));
  };
  walk(entry);
  return [...seen].map((f) => path.relative(ROOT, f));
}

test('T16: server.js loads no V2 module at startup: none in its static import graph; any V2 import is dynamic and behind GHOSTY_V2', () => {
  const g = graph(path.join(ROOT, 'server.js'));
  assert.ok(g.length > 10, 'the graph walker found the dashboard modules');
  for (const must of ['manager.js', 'push.js', 'reporter.js', 'layout.js']) assert.ok(g.includes(must), must);
  assert.deepEqual(g.filter((f) => f.startsWith('orchestration/')), [], 'no orchestration module in the static graph of server.js');
  // Dynamic imports of V2 code must sit behind the GHOSTY_V2 switch (looked for in the enclosing lines above).
  const lines = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (!/import\(\s*['"`][^'"`]*orchestration\//.test(l)) return;
    const ctx = lines.slice(Math.max(0, i - 15), i + 1).join('\n');
    assert.match(ctx, /GHOSTY_V2/, `server.js:${i + 1} imports V2 code without a GHOSTY_V2 guard`);
  });
  // The legacy modules the dashboard imports never reach into orchestration/ either (V2 only reads them).
  for (const f of g.filter((x) => !x.startsWith('orchestration/'))) {
    assert.ok(!staticImports(path.join(ROOT, f)).some((s) => s.includes('orchestration/')), `${f} imports V2 code`);
  }
});

test('T16: every V2 module is importable without side effects: no timers, listeners, child processes or files', () => {
  const state = fs.mkdtempSync(path.join(TMP, 'inert-'));
  const mods = [];
  for (const d of ['orchestration', 'orchestration/adapters']) for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith('.js')) mods.push(path.join(ROOT, d, f));
  // A child imports them all and must exit on its own: a timer, server or poller would keep it alive.
  const code = `const mods = ${JSON.stringify(mods)}; for (const m of mods) await import(m);
    const h = process.getActiveResourcesInfo().filter((r) => !['TTYWrap', 'PipeWrap', 'FSReqCallback', 'CloseReq'].includes(r));
    process.stdout.write(JSON.stringify(h));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: state, encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: state, GHOSTY_STATE_DIR: state, LANG: 'C' } });
  assert.deepEqual(JSON.parse(out), [], 'no live handle after importing every V2 module');
  assert.deepEqual(fs.readdirSync(state), [], 'importing wrote nothing to the state dir or cwd');
  assert.ok(mods.length >= 20);
});

// ---- T19 ----------------------------------------------------------------------------------------------

// Synthetic legacy state with the file names the existing modules use (contents are obvious fakes).
const LEGACY = {
  'layout.json': JSON.stringify({ order: ['alpha', 'beta'], pins: ['alpha'], groups: {}, hidden: [] }),
  'layout.json.bak': JSON.stringify({ order: ['alpha'], pins: [], groups: {}, hidden: [] }),
  'sessions.json': JSON.stringify({ alpha: { model: 'fake-model', cwd: '/tmp/example' } }),
  'manager.json': JSON.stringify({ auto: false, budget: 0 }),
  'stalls.jsonl': '{"session":"alpha","kind":"synthetic"}\n',
  'manager-events.jsonl': '{"event":"synthetic"}\n',
  'push-subs.json': '[]',
  'push-feed.json': '{"items":[]}',
  'lease-watch.json': '{"days":{}}',
  'parked.json': '{}',
  'deploys/history.jsonl': '{"deploy":"synthetic"}\n',
};
const hashTree = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isDirectory()) { out[`${rel}/`] = 'dir'; walk(p); continue; }
      const st = fs.statSync(p);
      out[rel] = `${createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${st.mode.toString(8)} ${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
};

test('T19: V2 state lives under $GHOSTY_STATE_DIR/v2 only; legacy files stay byte-identical; removing v2/ restores the old tree exactly', async () => {
  const state = fs.mkdtempSync(path.join(TMP, 'legacy-'));
  for (const [f, c] of Object.entries(LEGACY)) { fs.mkdirSync(path.dirname(path.join(state, f)), { recursive: true }); fs.writeFileSync(path.join(state, f), c); }
  fs.writeFileSync(path.join(state, 'reporter-token'), 'fake-token-for-tests', { mode: 0o600 });
  const old = new Date('2026-01-01T00:00:00Z');
  for (const f of [...Object.keys(LEGACY), 'reporter-token']) fs.utimesSync(path.join(state, f), old, old);
  const before = hashTree(state);
  const layoutBefore = await createLayoutStore({ file: path.join(state, 'layout.json') }).get();

  // The V2 components, wired the way the frozen layout says (store default = $GHOSTY_STATE_DIR/v2), with an fs that
  // records every path the store touches.
  const v2 = defaultStoreDir({ GHOSTY_STATE_DIR: state });
  assert.equal(v2, path.join(state, 'v2'));
  const touched = new Set();
  const spy = new Proxy(fs, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { if (typeof a[0] === 'string') touched.add(a[0]); return t[k](...a); } : t[k]) });
  const store = createTaskStore({ dir: v2, fs: spy, ...clock() });
  await store.init();
  const t = await store.createTask(spec(), { idempotencyKey: 'migration-check' });
  await store.transition(t.task_id, 'clarified', { actor: 'test' });
  await store.recordUsage(t.task_id, { runtime: 'fake', model: 'fake-model', input_tokens: 1, output_tokens: null, usd: null });
  await store.setHead(t.task_id, SHA_A, { actor: { role: 'developer', id: 'dev-1' } });
  const leases = createLeaseAuthority({ backend: fileBackend({ dir: path.join(v2, 'leases') }) });
  const l = await leases.acquire('repo:demo:integration', { owner: 'test', ttl_ms: 1000, scope: 'test' });
  assert.equal(l.ok, true);
  await leases.release(l.lease);
  const inc = createIncidentStore({ dir: path.join(v2, 'incidents') });
  await inc.report({ type: 'host.cpu_pressure', host_id: 'host-a', symptom: 'synthetic', reporter: { reporter: 'test', task_id: t.task_id } });
  createAdmissionController({ file: path.join(v2, 'admission.json') }).pause('test');
  const q = createIntegrationQueue({ dir: path.join(v2, 'integration-queue') });
  await q.enqueue({ task_id: t.task_id, repo: 'demo', target: 'main', source_branch: 'b', source_sha: SHA_A, base_sha: SHA_A, developer: { id: 'dev-1' }, diff_scope: ['x'] }, { idempotencyKey: 'k' });
  // A restart replays V2 state from v2/ alone.
  const again = createTaskStore({ dir: v2, fs: spy, ...clock() });
  await again.recover();
  assert.equal((await again.get(t.task_id)).status, 'clarified');

  for (const p of touched) assert.ok(path.resolve(p).startsWith(`${v2}${path.sep}`) || path.resolve(p) === v2, `store touched ${p}`);
  const after = hashTree(state);
  const added = Object.keys(after).filter((k) => !(k in before));
  assert.ok(added.length > 5);
  assert.deepEqual(added.filter((k) => !k.startsWith('v2/')), [], 'nothing new outside v2/');
  for (const [k, h] of Object.entries(before)) assert.equal(after[k], h, `${k} unchanged (bytes, mode, mtime)`);
  // Legacy readers still read the same thing.
  const layoutAfter = await createLayoutStore({ file: path.join(state, 'layout.json') }).get();
  assert.deepEqual(layoutAfter, layoutBefore);

  // Reversible: deleting v2/ leaves exactly the legacy tree.
  fs.rmSync(v2, { recursive: true, force: true });
  assert.deepEqual(hashTree(state), before);
});
