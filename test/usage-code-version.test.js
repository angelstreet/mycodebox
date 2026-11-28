import test from 'node:test';
import assert from 'node:assert/strict';
import { writerStamp, createBehindCheck, WRITER_PATHS } from '../usage/code-version.js';
import { staleWriterHtml } from '../public/usage-view.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const fail = (code) => Object.assign(new Error('exit'), { code });

test('writerStamp: commit, pid and start time; no repo = sha null', () => {
  const w = writerStamp({ cwd: '/x', pid: 42, now: Date.parse('2026-11-28T14:00:00Z'), uptimeS: 60, git: () => `${A}\n` });
  assert.deepEqual(w, { pid: 42, startedAt: '2026-11-28T13:59:00.000Z', sha: A });
  assert.equal(writerStamp({ cwd: '/x', git: () => { throw new Error('not a repo'); } }).sha, null);
  assert.equal(writerStamp({ cwd: '/x', git: () => 'garbage' }).sha, null);
});

test('behind: same commit = false; tailer paths changed = true; unchanged = false; unknown commit or bad sha = null', async () => {
  const calls = [];
  const mk = (diff) => createBehindCheck({ cwd: '/x', exec: async (args) => { calls.push(args); if (args[0] === 'rev-parse') return { stdout: `${B}\n` }; return diff(); } });
  assert.equal(await mk(() => { throw new Error('never'); })(B), false);
  assert.equal(await mk(() => { throw fail(1); })(A), true);
  assert.deepEqual(calls.at(-1), ['diff', '--quiet', A, B, '--', ...WRITER_PATHS]);
  assert.equal(await mk(() => ({ stdout: '' }))(A), false);
  assert.equal(await mk(() => { throw fail(128); })(A), null);
  assert.equal(await mk(() => ({ stdout: '' }))('not-a-sha'), null);
  assert.equal(await mk(() => ({ stdout: '' }))(null), null);
});

test('behind: cached per sha within the ttl', async () => {
  let n = 0, t = 0;
  const behind = createBehindCheck({ cwd: '/x', now: () => t, ttlMs: 30e3, exec: async (args) => { n++; if (args[0] === 'rev-parse') return { stdout: B }; throw fail(1); } });
  assert.equal(await behind(A), true); const after = n;
  t = 10e3; assert.equal(await behind(A), true); assert.equal(n, after);
  t = 40e3; await behind(A); assert.ok(n > after);
});

test('usage page: a warning row only when the tailer runs older usage code', () => {
  assert.match(staleWriterHtml({ writer: { behind: true, startedAt: '2026-11-28T08:45:00Z' } }), /older usage code.*started \d\d:\d\d/);
  for (const u of [null, {}, { writer: { behind: false } }, { writer: { behind: null } }]) assert.equal(staleWriterHtml(u), '');
});
