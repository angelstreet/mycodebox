import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { checkCopies, render } from '../scripts/installed-copies-check.js';
import { parseCheckResult } from '../scripts/daily-checks.js';
import { tmp } from './helpers-tmp.js';

function world() {
  const repo = tmp('icc-repo-'), home = tmp('icc-home-');
  mkdirSync(join(repo, 'scripts')); mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(join(repo, 'scripts/integrate'), '#!/bin/sh\nnew wording\n');
  return { repo, home };
}
const entries = [{ name: 'integrate', repo: 'scripts/integrate', installed: '.local/bin/integrate' }];

test('identical copy: ok, no finding', () => {
  const { repo, home } = world(); writeFileSync(join(home, '.local/bin/integrate'), '#!/bin/sh\nnew wording\n');
  const r = checkCopies({ repoRoot: repo, home, entries });
  assert.equal(r.results[0].status, 'ok'); assert.deepEqual(r.findings, []);
});

test('different copy: DRIFT with the exact fix command', () => {
  const { repo, home } = world(); writeFileSync(join(home, '.local/bin/integrate'), '#!/bin/sh\nold wording\n');
  const r = checkCopies({ repoRoot: repo, home, entries });
  assert.equal(r.results[0].status, 'drift');
  assert.equal(r.results[0].fix, `cp ${join(repo, 'scripts/integrate')} ${join(home, '.local/bin/integrate')}`);
  assert.equal(r.findings.length, 1); assert.match(r.findings[0].body, /DRIFT: .* Fix: cp /);
  const out = render(r); assert.match(out.summary, /1 installed script copy/);
  // the daily-checks runner accepts the shape
  const parsed = parseCheckResult({ id: 'installed-copies' }, { status: 0, stdout: JSON.stringify(out) });
  assert.equal(parsed.findings.length, 1); assert.equal(parsed.broken, undefined);
});

test('missing installed copy: reported as missing, not as an error or a finding', () => {
  const { repo, home } = world();
  const r = checkCopies({ repoRoot: repo, home, entries });
  assert.equal(r.results[0].status, 'missing'); assert.deepEqual(r.findings, []);
  assert.match(render(r).report, /integrate: MISSING/);
});

test('a symlink into the repo is always current', () => {
  const { repo, home } = world(); symlinkSync(join(repo, 'scripts/integrate'), join(home, '.local/bin/integrate'));
  assert.equal(checkCopies({ repoRoot: repo, home, entries }).results[0].status, 'symlink');
});

import { checkMacHooks } from '../scripts/installed-copies-check.js';
import { createHash } from 'node:crypto';
test('Mac hook: a machine whose reported sha differs from the repo script is DRIFT; a current or long-silent one is not', () => {
  const repo = tmp('icc-mac-repo-'), state = tmp('icc-mac-state-');
  mkdirSync(join(repo, 'scripts')); writeFileSync(join(repo, 'scripts/mac-stop-hook.sh'), '#!/bin/sh\nhook\n');
  const good = createHash('sha256').update('#!/bin/sh\nhook\n').digest('hex'), now = Date.parse('2026-11-12T00:00:00Z');
  writeFileSync(join(state, 'remote-hooks-seen.json'), JSON.stringify({
    'mac-a': { hook_sha: good, at: '2026-11-11T20:00:00Z' },
    'mac-b': { hook_sha: 'a'.repeat(64), at: '2026-11-11T20:00:00Z' },
    'mac-nosha': { hook_sha: null, at: '2026-11-11T20:00:00Z' },
    'mac-old': { hook_sha: 'b'.repeat(64), at: '2026-09-01T00:00:00Z' } }));
  const r = checkMacHooks({ repoRoot: repo, stateDir: state, now });
  assert.deepEqual(r.results.map((x) => [x.name, x.status]), [['mac-stop-hook@mac-a', 'ok'], ['mac-stop-hook@mac-b', 'drift'], ['mac-stop-hook@mac-nosha', 'drift']]);
  assert.equal(r.findings.length, 2); assert.match(r.findings[0].body, /mac-b/);
});
