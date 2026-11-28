// A service restart leaves a running UI review behind (KillMode=process). The resumed request reuses its tree: the old
// preview then wrote a real frontend/node_modules there and the new review could not find '@vitejs/plugin-react'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDefaultRun, createIntegrationLane } from '../integration-lane.js';
import { leftoverGroups } from '../ui-review-lane.js';
import { makeWorld } from './helpers-lane.js';
import { tmp } from './helpers-tmp.js';

// First run: stays up like the orphaned preview and, whenever its tree has no node_modules, makes a real folder there.
// A later run: that folder is why Vite does not find the packages (the real gate links only when nothing is there).
const gate = (marker) => `import sys, pathlib, time
a = sys.argv[1:]
tree = pathlib.Path(a[a.index('--tree') + 1]); marker = pathlib.Path(${JSON.stringify(marker)})
mods = tree / 'frontend' / 'node_modules'
if not marker.exists():
    marker.write_text('1')
    for _ in range(1200):
        if (tree / 'frontend' / 'src').is_dir() and not mods.exists():
            mods.mkdir()
        time.sleep(0.02)
    sys.exit(0)
time.sleep(0.5)
if mods.is_dir():
    print("ui-review-gate: cannot uir-2 the preview did not start: Cannot find package '@vitejs/plugin-react'"); sys.exit(3)
print('ui-review-gate: pass uir-2 1 page(s) no worse'); sys.exit(0)
`;
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; while (!fn()) { assert.ok(Date.now() < end, 'timed out'); await new Promise((r) => setTimeout(r, 20)); } };

test('a resumed request stops the review its restart left behind, then reviews on a clean tree', async () => {
  const marker = join(tmp('gate-'), 'first-run');
  const w = makeWorld({ base: { 'VERSION.txt': '1\n', 'scripts/review/ui_review_gate.py': gate(marker), 'frontend/src/App.tsx': 'ok\n' } });
  w.branch('feat', { 'frontend/src/Page.tsx': 'fine\n' });
  const stateDir = tmp('lane-state-');
  const opts = { stateDir, config: { repos: { 'env-a': w.cfg({ uiReview: { paths: ['^frontend/src/'], from: w.lane } }) } }, pollMs: 1 };
  const real = createDefaultRun();
  // the first service "dies" during the review: its child keeps running and the service never hears of it again
  const dying = (cmd, o) => { const p = real(cmd, o); return cmd.includes('ui_review_gate.py') ? new Promise(() => {}) : p; };
  const first = createIntegrationLane({ ...opts, run: dying });
  first.start();
  const q = first.enqueue({ repo: 'env-a', branch: 'feat', session: 's1' });
  await until(() => existsSync(marker));
  first.stop();
  const prefix = join(stateDir, 'integration', 'ui-review', q.id) + '/';
  assert.equal(leftoverGroups([prefix]).length, 1, 'the old review still runs');
  const second = createIntegrationLane(opts);
  second.start();
  try {
    const r = await second.wait(q.id, 60000);
    assert.equal(r.uiReview?.verdict, 'pass', JSON.stringify(r.uiReview));
    assert.equal(r.state, 'merged');
    assert.deepEqual(leftoverGroups([prefix]), []);
  } finally { second.stop(); for (const g of leftoverGroups([prefix])) process.kill(-g, 'SIGKILL'); }
});

test('only a review of the same request is a leftover, and never this process', async () => {
  const state = tmp('lane-state-'), mine = join(state, 'int-1') + '/';
  const sleeper = (out) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', '--out', out], { detached: true, stdio: 'ignore' });
  const a = sleeper(`${mine}live`), b = sleeper(join(state, 'int-12', 'live'));
  try {
    await until(() => leftoverGroups([mine]).length > 0);
    assert.deepEqual(leftoverGroups([mine]), [a.pid]);
  } finally { a.kill('SIGKILL'); b.kill('SIGKILL'); }
});
