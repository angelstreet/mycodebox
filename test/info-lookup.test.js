import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { splitAsk, lookupInfo } from '../info-lookup.js';
import { makeRepo, git } from './helpers-git.js';
import { tmp } from './helpers-tmp.js';

test('splitAsk: (a)/(b), numbers, semicolons, "and" before an imperative', () => {
  assert.deepEqual(splitAsk('(a) send the SRF 1 buffer path for row b, and (b) say whether to merge task90-open'),
    [{ text: 'send the SRF 1 buffer path for row b', kind: 'info' }, { text: 'say whether to merge task90-open', kind: 'merge' }]);
  const p = splitAsk('merge task90-open and deploy once the host frees?');
  assert.equal(p.length, 2); assert.equal(p[0].text, 'merge task90-open'); assert.equal(p[0].kind, 'merge'); assert.match(p[1].text, /^deploy once/);
  assert.deepEqual(splitAsk('1) what is the branch name 2) rename it').map((x) => x.kind), ['info', 'other']);
  assert.deepEqual(splitAsk('merge X; send me the log dir').map((x) => x.kind), ['merge', 'info']);
  assert.deepEqual(splitAsk('merge task90-open plus send the SRF 1 buffer path').map((x) => x.kind), ['merge', 'info']);
  assert.deepEqual(splitAsk('Should I use A and B?').length, 1);
  assert.deepEqual(splitAsk(''), []);
});

test('lookupInfo: one path in the docs of a repo answers, with its source', async () => {
  const repo = makeRepo({ files: { 'docs/HANDOVER.md': '# Handover\n\n- SRF 1 buffer: /data/fake/srf1-buffer\n- SRF 2 buffer: /data/fake/srf2-buffer\n' } });
  const r = await lookupInfo('send the SRF 1 buffer path for row b', { roots: [repo] });
  assert.deepEqual(r, { answer: '/data/fake/srf1-buffer', source: 'docs/HANDOVER.md:3' });
  assert.equal(await lookupInfo('send the SRF 3 buffer path', { roots: [repo] }), null);
  assert.equal(await lookupInfo('send the buffer path', { roots: [repo] }), null);   // two candidates: ambiguous
  assert.equal(await lookupInfo('send the SRF 1 buffer path', { roots: ['/nonexistent-dir-xyz'] }), null);
});

test('lookupInfo: untracked docs and a plain (non-git) directory are read', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'notes'));
  writeFileSync(join(repo, 'notes', 'a.md'), 'Telemetry export dir: ~/exports/telemetry-out\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'notes');   // git grep reads tracked files only
  assert.equal((await lookupInfo('where is the telemetry export dir', { roots: [repo] })).answer, '~/exports/telemetry-out');
  const plain = tmp('info-plain-');
  writeFileSync(join(plain, 'state.md'), 'gamma cache path /var/fake/gamma-cache\n');
  const r = await lookupInfo('what is the gamma cache path', { roots: [plain] });
  assert.equal(r.answer, '/var/fake/gamma-cache'); assert.equal(r.source, 'state.md:1');
});

test('lookupInfo: nothing the hard floor flags is ever returned', async () => {
  const repo = makeRepo({ files: { 'docs/A.md': 'the beta file path is /data/fake/secrets/beta\n' } });
  assert.equal(await lookupInfo('send the beta file path', { roots: [repo] }), null);
});

test('M8: only filesystem paths from clean lines are answered', async () => {
  const repo = makeRepo({ files: { 'docs/A.md': [
    'Dashboard url: https://example.invalid/dash/view', 'Query path: /data/fake/q?x=1', 'Mail path: ops@example.invalid/inbox', 'Ntfy topic path: /data/fake/topic-dir',
    'Vapid key file path: /data/fake/vapid-dir', 'Gamma cache path: /data/fake/gamma-cache', ''].join('\n') } });
  assert.equal(await lookupInfo('send the dashboard url', { roots: [repo] }), null);
  assert.equal(await lookupInfo('send the query path', { roots: [repo] }), null);
  assert.equal(await lookupInfo('send the mail path', { roots: [repo] }), null);
  assert.equal(await lookupInfo('send the ntfy topic path', { roots: [repo] }), null);
  assert.equal(await lookupInfo('send the vapid key file path', { roots: [repo] }), null);
  assert.equal((await lookupInfo('send the gamma cache path', { roots: [repo] })).answer, '/data/fake/gamma-cache');
});
test('M8: json files in a plain directory and untracked docs are not read', async () => {
  const plain = tmp('info-plain-');
  writeFileSync(join(plain, 'state.json'), JSON.stringify({ note: 'delta cache path /var/fake/delta-cache' }));
  assert.equal(await lookupInfo('what is the delta cache path', { roots: [plain] }), null);
  const repo = makeRepo();
  writeFileSync(join(repo, 'new.md'), 'Epsilon cache path: /data/fake/epsilon\n');   // untracked
  assert.equal(await lookupInfo('what is the epsilon cache path', { roots: [repo] }), null);
});

test('R2-4: a host name is not a repo directory', async () => {
  const repo = makeRepo({ files: { 'docs/A.md': 'Hook path: hooks.example/T000/B000/XXXX\nDash path: box.tail1234.ts.net/dash\nReal dir path: docs/real-dir\n' } });
  assert.equal(await lookupInfo('send the hook path', { roots: [repo] }), null);
  assert.equal(await lookupInfo('send the dash path', { roots: [repo] }), null);
  assert.equal((await lookupInfo('send the real dir path', { roots: [repo] })).answer, 'docs/real-dir');
});
