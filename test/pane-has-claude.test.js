import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const LIB = new URL('../scripts/pane-has-claude.sh', import.meta.url).pathname;

// pane -> bash -c -> launch script -> claude: the manager's real shape. A direct-child check (pgrep -P) misses it and
// the watchdog typed the launch command into the live session every 5 min.
test('pane_has_claude finds claude as a grandchild, and none under an unrelated shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pane-claude-'));
  const fake = join(dir, 'claude');
  symlinkSync('/bin/sleep', fake);
  const pane = spawn('bash', ['-c', `bash -c '${fake} 30; true'; true`], { stdio: 'ignore', detached: false });
  const idle = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    spawnSync('sleep', ['0.5']);
    const run = (pid) => spawnSync('bash', ['-c', `. ${LIB}; pane_has_claude ${pid}`]).status;
    assert.equal(run(pane.pid), 0, 'claude two levels down is found');
    assert.equal(run(idle.pid), 1, 'no claude under a bare process');
  } finally {
    spawnSync('pkill', ['-P', String(pane.pid)]); pane.kill(); idle.kill();
    spawnSync('pkill', ['-f', fake]);
    rmSync(dir, { recursive: true, force: true });
  }
});
