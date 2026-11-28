// token audit 2026-11-28 saving #5: 1-hour prompt cache TTL, default off, per session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';
import { cache1hOn, cacheEnvFor, CACHE_1H_ENV } from '../cache-ttl.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('default off: no env, no config file -> nothing', () => {
  assert.equal(cache1hOn('s1', { env: {}, config: {} }), false);
  assert.deepEqual(cacheEnvFor('s1', { env: {}, stateDir: tmp('c1h-') }), {});
});

test('on by env, by session list, by all; the two verified Claude Code switches', () => {
  assert.deepEqual(CACHE_1H_ENV, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', ENABLE_PROMPT_CACHING_1H: '1' });
  assert.equal(cache1hOn('s1', { env: { CBSESSION_CACHE_1H: '1' } }), true);
  assert.equal(cache1hOn('s1', { env: { CBSESSION_CACHE_1H: '0' } }), false);
  const dir = tmp('c1h-');
  fs.writeFileSync(path.join(dir, 'cache-1h.json'), JSON.stringify({ sessions: ['idle-one'] }));
  assert.deepEqual(cacheEnvFor('idle-one', { env: {}, stateDir: dir }), CACHE_1H_ENV);
  assert.deepEqual(cacheEnvFor('other', { env: {}, stateDir: dir }), {});
  assert.equal(cache1hOn('x', { env: {}, config: { all: true } }), true);
  fs.writeFileSync(path.join(dir, 'cache-1h.json'), '{broken');
  assert.deepEqual(cacheEnvFor('idle-one', { env: {}, stateDir: dir }), {}, 'a broken file is off');
});

test('cbsession dry run: the launch file exports the switches only for a selected session', () => {
  const home = tmp('c1h-cbs-'), work = path.join(home, 'w'), state = path.join(home, 'state');
  fs.mkdirSync(work); fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'cache-1h.json'), JSON.stringify({ sessions: ['c1h-on'] }));
  const run = (name, extra = {}) => spawnSync('bash', [path.join(ROOT, 'scripts', 'cbsession'), '-x', '-n', name, '-d', work, '-t', 'x'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, GHOSTY_STATE_DIR: state, ...extra } });
  const launch = (n) => fs.readFileSync(path.join(home, 'handovers', `${n}.launch.sh`), 'utf8');
  let r = run('c1h-on'); assert.equal(r.status, 0, r.stderr);
  assert.match(launch('c1h-on'), /\nexport CLAUDE_CODE_PROMPT_CACHE_TTL=1h\nexport ENABLE_PROMPT_CACHING_1H=1\n/);
  r = run('c1h-off'); assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(launch('c1h-off'), /PROMPT_CACHE_TTL|CACHING_1H/);
  r = run('c1h-env', { CBSESSION_CACHE_1H: '1' }); assert.equal(r.status, 0, r.stderr);
  assert.match(launch('c1h-env'), /export CLAUDE_CODE_PROMPT_CACHE_TTL=1h/);
});

test('the V2 claude adapter passes an explicit per-run env (o.env) through to the child', async () => {
  const { buildEnv } = await import('../orchestration/adapters/common.js');
  const e = buildEnv({ PATH: '/bin', SECRET: 'x' }, [/^ANTHROPIC_/, /^CLAUDE_CODE_/], CACHE_1H_ENV);
  assert.equal(e.CLAUDE_CODE_PROMPT_CACHE_TTL, '1h');
  assert.equal(e.ENABLE_PROMPT_CACHING_1H, '1');
  assert.equal(e.SECRET, undefined);
});
