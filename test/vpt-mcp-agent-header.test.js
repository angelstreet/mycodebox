import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { plan, addArgs, HEADER, HEADER_VALUE } from '../scripts/vpt-mcp-agent-header.js';
import { tmp } from './helpers-tmp.js';

const entry = (headers) => ({ type: 'http', url: 'http://srv.example:5109/server/mcp', headers });

test('plan: only an http virtualpytest entry without the header needs a fix', () => {
  const cj = { projects: {
    '/a': { mcpServers: { virtualpytest: entry({ Authorization: 'Bearer x' }) } },
    '/b': { mcpServers: { virtualpytest: entry({ Authorization: 'Bearer x', [HEADER]: HEADER_VALUE }) } },
    '/c': { mcpServers: { other: entry({}) } },
    '/d': {},
  } };
  assert.deepEqual(plan(cj).map((p) => p.dir), ['/a']);
});

test('addArgs keeps the old headers and adds the env-expanded name', () => {
  const [p] = plan({ projects: { '/a': { mcpServers: { virtualpytest: entry({ Authorization: 'Bearer x' }) } } } });
  const a = addArgs(p);
  assert.ok(a.includes('Authorization: Bearer x'));
  assert.ok(a.includes(`${HEADER}: \${VPT_AGENT_NAME:-}`));
  assert.deepEqual(a.slice(0, 4), ['mcp', 'add', 'virtualpytest', 'http://srv.example:5109/server/mcp']);
});

test('the script lists without changing anything, and never prints the Authorization value', () => {
  const home = tmp('mcphdr-');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { '/a': { mcpServers: { virtualpytest: entry({ Authorization: 'Bearer SECRET' }) } } } }));
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'vpt-mcp-agent-header.js');
  const r = spawnSync('node', [script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.match(r.stdout, /missing X-Agent-Name: \/a/);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
});
