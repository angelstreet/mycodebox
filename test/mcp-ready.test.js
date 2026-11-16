import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serversOf, waitReady, answers, mainCheckout } from '../scripts/mcp-ready.js';
import { tmp } from './helpers-tmp.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'mcp-ready.js');
const http_ = (url) => ({ type: 'http', url, headers: { Authorization: 'Bearer SECRET' } });
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const serve = (port) => new Promise((res) => { const s = http.createServer((q, r) => { r.statusCode = 401; r.end('no'); }); s.listen(port, '127.0.0.1', () => res(s)); });
const runScript = (home, args, env = {}) => new Promise((res) => {
  const c = spawn('node', [SCRIPT, ...args], { env: { PATH: process.env.PATH, HOME: home, MCP_READY_EVERY_MS: '100', ...env } });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  c.on('close', (code) => res({ code, out }));
});

test('serversOf: the project of the dir, then of its main checkout, then user scope; http entries only', () => {
  const cj = {
    mcpServers: { global: http_('https://g.example/mcp'), vpt: http_('http://other:1/mcp') },
    projects: {
      '/repo': { mcpServers: { vpt: http_('http://srv:5109/server/mcp'), local: { command: 'npx', args: ['x'] } } },
      '/repo-wt': {},
    },
  };
  assert.deepEqual(serversOf(cj, '/repo-wt', '/repo'), [
    { name: 'vpt', url: 'http://srv:5109/server/mcp' }, { name: 'global', url: 'https://g.example/mcp' }]);
  assert.deepEqual(serversOf(cj, '/elsewhere').map((s) => s.name), ['global', 'vpt']);
  assert.deepEqual(serversOf({}, '/x'), []);
});

test('answers: a closed port is down, a 401 is up', async () => {
  const port = await freePort();
  assert.equal(await answers(`http://127.0.0.1:${port}/server/mcp`, 1000), false);
  const s = await serve(port);
  try { assert.equal(await answers(`http://127.0.0.1:${port}/server/mcp`, 1000), true); } finally { s.close(); }
});

test('waitReady returns as soon as the server is back, and names what stays down', async () => {
  let n = 0;
  const ask = async (url) => (url === 'u-late' ? ++n >= 3 : url === 'u-up');
  assert.deepEqual(await waitReady([{ name: 'a', url: 'u-up' }, { name: 'b', url: 'u-late' }], 2000, 10, ask), []);
  assert.equal(n, 3, 'asked until it answered, not longer');
  const down = await waitReady([{ name: 'a', url: 'u-up' }, { name: 'c', url: 'u-never' }], 60, 10, ask);
  assert.deepEqual(down, [{ name: 'c', url: 'u-never' }]);
});

test('mainCheckout: a worktree resolves to its main checkout', () => {
  const root = tmp('mcprdy-git-');
  const main = path.join(root, 'main'); fs.mkdirSync(main);
  const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git(main, 'init', '-q'); git(main, 'commit', '-q', '--allow-empty', '-m', 'x');
  const wt = path.join(root, 'wt');
  assert.equal(git(main, 'worktree', 'add', '-q', wt, '-b', 'w').status, 0);
  assert.equal(fs.realpathSync(mainCheckout(wt)), fs.realpathSync(main));
  assert.equal(mainCheckout(root), '');
});

test('the script waits through a restart: a server that comes back within the wait = exit 0, nothing printed', async () => {
  const home = tmp('mcprdy-');
  const port = await freePort();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [home]: { mcpServers: { virtualpytest: http_(`http://127.0.0.1:${port}/server/mcp`) } } } }));
  let server;
  const timer = setTimeout(async () => { server = await serve(port); }, 400);
  const r = await runScript(home, [home, '--wait', '10']);
  clearTimeout(timer); server?.close();
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, '');
});

test('the script names a server that stays down (exit 3) and never prints its Authorization', async () => {
  const home = tmp('mcprdy-');
  const port = await freePort();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [home]: { mcpServers: { virtualpytest: http_(`http://127.0.0.1:${port}/server/mcp`) } } } }));
  const r = await runScript(home, [home, '--wait', '0.3']);
  assert.equal(r.code, 3);
  assert.equal(r.out.trim(), `virtualpytest (127.0.0.1:${port})`);
  assert.doesNotMatch(r.out, /SECRET/);
});

test('no ~/.claude.json or no MCP server: exit 0 at once (never blocks a start)', async () => {
  const home = tmp('mcprdy-');
  assert.equal((await runScript(home, [home])).code, 0);
  fs.writeFileSync(path.join(home, '.claude.json'), '{"projects":{}}');
  assert.equal((await runScript(home, [home])).code, 0);
});

test('cbsession: a server down at start = a warning and a note in the prompt; a server up = neither', async () => {
  const CB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cbsession');
  const home = tmp('mcprdy-cb-');
  const work = path.join(home, 'work'); fs.mkdirSync(work);
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  // tmux and sleep stubs: nothing starts, the trust / remote-control wait loop does not wait.
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\n[ "$1" = has-session ] && exit 1\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const port = await freePort();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [work]: { mcpServers: { virtualpytest: http_(`http://127.0.0.1:${port}/server/mcp`) } } } }));
  const start = (name) => new Promise((res) => {
    const c = spawn('bash', [CB, '-n', name, '-d', work, '-N', '-t', 'do it'], { env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: home, GHOSTY_STATE_DIR: path.join(home, 'state'), CBSESSION_MCP_WAIT: '0.3', MCP_READY_EVERY_MS: '100' } });
    let err = ''; c.stderr.on('data', (d) => { err += d; }); c.stdout.resume();
    c.on('close', (code) => res({ code, err, prompt: fs.readFileSync(path.join(home, 'handovers', `${name}.prompt.md`), 'utf8') }));
  });
  const down = await start('mcp-down');
  assert.equal(down.code, 0, down.err);
  assert.match(down.err, new RegExp(`warning: MCP server not answering after 0.3 s: virtualpytest \\(127.0.0.1:${port}\\)`));
  assert.match(down.prompt, /\*\*MCP not connected\*\* \(cbsession, \d\d:\d\d UTC\): the MCP server virtualpytest \(127\.0\.0\.1:\d+\) did not answer/);
  assert.match(down.prompt, /vpt_quicktest\.py/);
  assert.doesNotMatch(down.err + down.prompt, /SECRET/);
  const server = await serve(port);
  try {
    const up = await start('mcp-up');
    assert.equal(up.code, 0, up.err);
    assert.doesNotMatch(up.err, /MCP server not answering/);
    assert.doesNotMatch(up.prompt, /MCP not connected/);
  } finally { server.close(); }
});
