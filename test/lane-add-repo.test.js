import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { addRepo } from '../scripts/lane-add-repo.js';
import { tmp } from './helpers-tmp.js';

const mkOrigin = () => { const d = tmp('lar-origin-'); execFileSync('git', ['init', '-q', '-b', 'master', d]); execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i']); return d; };

test('adds the entry, clones the lane clone, keeps other repos, is idempotent', () => {
  const state = tmp('lar-state-'), origin = mkOrigin(), clone = join(tmp('lar-clone-'), 'website');
  fs.writeFileSync(join(state, 'integration.json'), JSON.stringify({ repos: { other: { clone: '/x', target: 'main' } } }));
  const entry = { clone, remote: 'origin', target: 'master', test: 'true', deploy: null, conventions: [] };
  const acts = addRepo({ key: 'website', entry, origin, stateDir: state });
  assert.equal(acts.length, 2);
  const cfg = JSON.parse(fs.readFileSync(join(state, 'integration.json'), 'utf8'));
  assert.deepEqual(Object.keys(cfg.repos), ['other', 'website']);
  assert.ok(fs.existsSync(join(clone, '.git')));
  assert.deepEqual(addRepo({ key: 'website', entry, origin, stateDir: state }), []);
});

test('refuses an invalid entry and a missing clone without --origin; dry run writes nothing', () => {
  const state = tmp('lar-state-');
  assert.throws(() => addRepo({ key: 'w', entry: { clone: 'relative' }, stateDir: state }), /invalid entry/);
  assert.throws(() => addRepo({ key: 'w', entry: { clone: join(state, 'nope') }, stateDir: state }), /--origin/);
  fs.mkdirSync(join(state, '.git'));   // an existing clone
  assert.equal(addRepo({ key: 'w', entry: { clone: state }, stateDir: state, dryRun: true }).length, 1);
  assert.equal(fs.existsSync(join(state, 'integration.json')), false);
});
