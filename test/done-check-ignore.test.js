// Done-check ignores long-lived branches (owner, 2026-10-28): the real false wake was
// "X said done, git disagrees: 13 commit(s) on task44-ai-manager not on main (d050aa7, 5995a60, 0c47b8e)".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp } from './helpers-tmp.js';
import { createDoneCheck, DEFAULT_IGNORE_BRANCHES } from '../done-check.js';

const THIRTEEN = Array.from({ length: 13 }, (_, i) => ['d050aa7', '5995a60', '0c47b8e'][i] || `c0ffee${i}`);
// /w/mgr: a worktree of the manager's long-lived branch; /w/det: detached HEAD inside it; /w/feat: a session's own branch.
function git(calls = []) {
  return async (cwd, args) => {
    calls.push(args.join(' '));
    const a = args.join(' ');
    if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return args[2] === '--git-dir' ? `/r/.git/worktrees${cwd}\n` : '/r/.git\n';
    if (args[0] === 'rev-parse' && args[1] === '-q') { if (/origin\/main$|origin\/task44-ai-manager$/.test(a)) return 'abc\n'; throw new Error('no ref'); }
    if (args[0] === 'rev-parse') return cwd === '/w/det' ? 'HEAD\n' : cwd === '/w/mgr' ? 'task44-ai-manager\n' : 'feat/x\n';
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'log') return (cwd === '/w/mgr' || cwd === '/w/det' || cwd === '/w/feat' || /task44-ai-manager$/.test(a)) ? THIRTEEN.map((c) => `${c}\tcommit`).join('\n') + '\n' : '';
    return '';
  };
}
function run(sessions, over = {}) {
  const sent = [];
  const w = createDoneCheck({ stateDir: tmp('ghosty-dci-'), git: git(), listDone: async () => sessions, send: async (n, t) => { sent.push([n, t]); }, log: { error() {} }, pressure: () => ({ loadPerCore: 0.1, ramAvailPct: 80 }), ...over });
  return { w, sent };
}
const BUGS = '\nSTATUS: done — merged; bugs: none';

test('default list names task44-ai-manager', () => assert.deepEqual(DEFAULT_IGNORE_BRANCHES, ['task44-ai-manager']));

test('a session that sat on the manager branch is not judged on it (13 commits not on main, no finding)', async () => {
  const h = run([{ name: 'mgr-user', cwd: '/w/mgr', text: 'all good' + BUGS }]);
  const r = await h.w.tick();
  assert.deepEqual(r.findings, []);
  assert.equal(h.sent.length, 0);
});

test('a detached HEAD that is part of the manager branch is not judged either', async () => {
  const h = run([{ name: 'det', cwd: '/w/det', text: 'ok' + BUGS }]);
  assert.deepEqual((await h.w.tick()).findings, []);
});

test('a closing text that names the manager branch does not pull it in; the session\'s own branch still counts', async () => {
  const h = run([{ name: 'feat', cwd: '/w/feat', text: 'I touched task44-ai-manager docs too.' + BUGS }]);
  const r = await h.w.tick();
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].text, /on feat\/x/);
  assert.doesNotMatch(r.findings[0].text, /task44-ai-manager/);
  const m = run([{ name: 'm2', cwd: '/w/clean', text: 'Updated task44-ai-manager manual.' + BUGS }]);
  assert.deepEqual((await m.w.tick()).findings, []);
});

test('the list is config: an empty list judges the branch again; a custom list ignores another branch', async () => {
  const off = run([{ name: 'mgr-user', cwd: '/w/mgr', text: 'x' + BUGS }], { ignoreBranches: () => [] });
  const r = await off.w.tick();
  assert.match(r.findings[0].text, /13 commit\(s\) on task44-ai-manager not on main \(d050aa7, 5995a60, 0c47b8e\)/);
  const custom = run([{ name: 'f', cwd: '/w/feat', text: 'x' + BUGS }], { ignoreBranches: () => ['feat/x'] });
  assert.deepEqual((await custom.w.tick()).findings, []);
});
