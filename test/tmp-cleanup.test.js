// Tests must not leave temp dirs behind: unchecked mkdtemp() calls filled the system temp dir until codebox ran out
// of inodes. Static: the tracked prefixes may only be created through helpers-tmp.js. Dynamic: the tracker really
// removes its dirs when the test file ends (a child node --test run over every prefix).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const DIR = dirname(fileURLToPath(import.meta.url));
const TRACKER = join(DIR, 'helpers-tmp.js');
const PREFIXES = ['merge-pol-', 'lease-svc-', 'lane-', 'lane-state-', 'v2-loop-', 'ghosty-dep-', 'v2-grants-'];

test('no test file creates a tracked temp prefix with an untracked mkdtemp', () => {
  const leaks = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.js') || f === 'helpers-tmp.js') continue;
    for (const [i, line] of readFileSync(join(DIR, f), 'utf8').split('\n').entries())
      if (/mkdtemp(Sync)?\(/.test(line) && PREFIXES.some((p) => line.includes(`'${p}`))) leaks.push(`test/${f}:${i + 1}: ${line.trim()}`);
  }
  assert.deepEqual(leaks, [], `create dirs with tmp() from test/helpers-tmp.js:\n${leaks.join('\n')}`);
});

test('the tracker removes every dir it made when the importing test file ends', () => {
  const home = mkdtempSync(join(homedir(), 'tmp-cleanup-'));
  const report_ = join(home, 'made.json');
  const fixture = join(home, 'fixture.test.js');
  writeFileSync(fixture, `import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { tmp } from ${JSON.stringify(TRACKER)};
const PREFIXES = ${JSON.stringify(PREFIXES)};
test('makes one dir per tracked prefix', () => {
  const made = PREFIXES.map((p) => tmp(p));
  writeFileSync(${JSON.stringify(report_)}, JSON.stringify(made));
  assert.ok(made.every((d) => existsSync(d)), 'the dirs exist while the test runs');
});
`);
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;   // the runner marks its own children: without this the child would run as one
    execFileSync(process.execPath, ['--test', '--test-force-exit', fixture], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const made = JSON.parse(readFileSync(report_, 'utf8'));
    assert.equal(made.length, PREFIXES.length, 'the fixture made one dir per prefix');
    assert.deepEqual(made.filter(existsSync), [], `left behind in the temp dir: ${made.filter(existsSync).join(', ')}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});