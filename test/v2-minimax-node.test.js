// MiniMax Code needs a supported Node first on PATH (mcode 0.6.3 refuses Node 23): the adapter's injected nodeDir.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdapter } from '../orchestration/adapters/minimax.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-mcode-node-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// Stub mcode: version 24.0.0 when the first PATH entry (where `#!/usr/bin/env node` looks first) is the node dir.
const bin = path.join(tmp, 'mcode');
fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then case "$(echo "$PATH" | cut -d: -f1)" in */node24/bin) echo 24.0.0;; *) echo 23.6.0;; esac; exit 0; fi\necho \'{"type":"exec.completed","result":"ok"}\'\n');
fs.chmodSync(bin, 0o755);
const nodeDir = path.join(tmp, 'node24', 'bin');
fs.mkdirSync(nodeDir, { recursive: true });

test('minimax adapter: nodeDir (or MCODE_NODE_DIR) is put first on the child PATH for probes and runs; absent, PATH is unchanged', async () => {
  const env = { PATH: '/usr/bin:/bin', HOME: tmp };
  assert.equal((await createAdapter({ bin, env, nodeDir }).probeCapabilities()).version, '24.0.0');
  assert.equal((await createAdapter({ bin, env: { ...env, MCODE_NODE_DIR: nodeDir } }).probeCapabilities()).version, '24.0.0');
  assert.equal((await createAdapter({ bin, env }).probeCapabilities()).version, '23.6.0');
  for (const bad of ['relative/bin', `${nodeDir}:/evil`]) assert.throws(() => createAdapter({ bin, env, nodeDir: bad }), { code: 'E_INVALID' });
  const run = createAdapter({ bin, env, nodeDir, allowedRoots: [tmp] }).start({ cwd: tmp, prompt: 'hi' });
  assert.equal((await run.done).error, null);
});
