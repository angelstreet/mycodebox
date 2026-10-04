import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trustClaude, trustCodex } from '../trust.js';

const tmp = async () => fs.mkdtemp(join(tmpdir(), 'trust-'));

test('trustClaude adds a trusted project and keeps everything else', async () => {
  const f = join(await tmp(), 'claude.json');
  await fs.writeFile(f, JSON.stringify({ numStartups: 3, projects: { '/a': { hasTrustDialogAccepted: false, lastCost: 2 } } }), { mode: 0o600 });
  assert.equal(await trustClaude('/b', f), true);
  assert.equal(await trustClaude('/a', f), true);
  assert.equal(await trustClaude('/a', f), false);   // already trusted: untouched
  const c = JSON.parse(await fs.readFile(f, 'utf8'));
  assert.equal(c.numStartups, 3);
  assert.equal(c.projects['/b'].hasTrustDialogAccepted, true);
  assert.equal(c.projects['/a'].hasTrustDialogAccepted, true);
  assert.equal(c.projects['/a'].lastCost, 2);
  assert.equal((await fs.stat(f)).mode & 0o777, 0o600);
});

test('trustClaude does nothing when Claude has never run', async () => {
  assert.equal(await trustClaude('/x', join(await tmp(), 'missing.json')), false);
});

test('trustCodex appends a trusted block once', async () => {
  const f = join(await tmp(), 'config.toml');
  await fs.writeFile(f, 'model = "x"');
  assert.equal(await trustCodex('/home/u/p', f), true);
  assert.equal(await trustCodex('/home/u/p', f), false);
  const t = await fs.readFile(f, 'utf8');
  assert.match(t, /\[projects\."\/home\/u\/p"\]\ntrust_level = "trusted"/);
  assert.match(t, /^model = "x"/);
});
