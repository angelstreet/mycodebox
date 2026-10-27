// scripts/mm-manager-wake.py standby gate (owner, 2026-10-27): only failover state `minimax` wakes mm-manager.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp } from './helpers-tmp.js';

const PY = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("mmw", "scripts/mm-manager-wake.py")
mm = importlib.util.module_from_spec(spec); spec.loader.exec_module(mm)
calls = []
mm.api = lambda path, body=None: calls.append((path, body)) or {}
mm.ready = lambda: True
mm.filtered = lambda lines: lines
line = json.dumps({"k":"a","l":{"key":"s:x","session":"s","title":"s asks","kind":"asks","body":"b"}})
out = []
for step in json.loads(sys.argv[1]):
    if step is None:
        os.remove(mm.FAILOVER_STATE) if os.path.exists(mm.FAILOVER_STATE) else None
    else:
        open(mm.FAILOVER_STATE, "w").write(step)
    n = len(calls)
    mm.handle_batch([line])
    out.append(len(calls) - n)
print(json.dumps(out))
`;

function run(steps) {
  const dir = tmp('mmw');
  const r = spawnSync('python3', ['-c', PY, JSON.stringify(steps)], {
    encoding: 'utf8', env: { ...process.env, GHOSTY_STATE_DIR: dir, FAILOVER_STATE: join(dir, 'failover-state') },
  });
  assert.equal(r.status, 0, r.stderr);
  return { sends: JSON.parse(r.stdout.trim().split('\n').pop()), log: r.stdout };
}

test('state claude drops the batch: no send', () => assert.deepEqual(run(['claude\n']).sends, [0]));
test('state minimax wakes the session', () => assert.deepEqual(run(['minimax\n']).sends, [1]));
test('missing state file counts as claude', () => assert.deepEqual(run([null]).sends, [0]));
test('garbage state counts as claude', () => assert.deepEqual(run(['wat']).sends, [0]));
test('state is re-read every batch', () => assert.deepEqual(run(['claude', 'minimax', 'claude', 'minimax']).sends, [0, 1, 0, 1]));
test('standing-by is logged once per hour', () => {
  const { log } = run(['claude', 'claude', 'claude']);
  assert.equal(log.split('\n').filter((l) => l.includes('standing by')).length, 1);
});

test('mm-manager.sh tail mode makes no model call while the state is claude', () => {
  const dir = tmp('mmsh');
  const ev = join(dir, 'manager-events.jsonl');
  writeFileSync(ev, '');
  const mcodeLog = join(dir, 'mcode.log');
  const fake = join(dir, 'mcode');
  writeFileSync(fake, `#!/bin/sh\necho called >> ${mcodeLog}\n`, { mode: 0o755 });
  const st = join(dir, 'state'); writeFileSync(st, 'claude\n');
  const script = `(sleep 2; echo '{"kind":"asks","session":"s","title":"t"}' >> ${ev}) & scripts/mm-manager.sh & p=$!; sleep 6; kill $p; wait`;
  spawnSync('bash', ['-c', script], { env: { ...process.env, GHOSTY_STATE_DIR: dir, FAILOVER_STATE: st, MCODE: fake, BATCH_S: '1', GHOSTY_PORT: '1' }, timeout: 20000 });
  assert.equal(existsSync(mcodeLog), false);
});
