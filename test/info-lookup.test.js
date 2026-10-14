import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitAsk, lookupInfo } from '../info-lookup.js';
import { makeRepo } from './helpers-git.js';

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

test('lookupInfo: one path in the docs of a repo answers, with its source', () => {
  const repo = makeRepo({ files: { 'docs/HANDOVER.md': '# Handover\n\n- SRF 1 buffer: /data/fake/srf1-buffer\n- SRF 2 buffer: /data/fake/srf2-buffer\n' } });
  const r = lookupInfo('send the SRF 1 buffer path for row b', { roots: [repo] });
  assert.deepEqual(r, { answer: '/data/fake/srf1-buffer', source: 'docs/HANDOVER.md:3' });
  assert.equal(lookupInfo('send the SRF 3 buffer path', { roots: [repo] }), null);
  assert.equal(lookupInfo('send the buffer path', { roots: [repo] }), null);   // two candidates: ambiguous
  assert.equal(lookupInfo('send the SRF 1 buffer path', { roots: ['/nonexistent-dir-xyz'] }), null);
});

test('lookupInfo: untracked docs and a plain (non-git) directory are read', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'notes'));
  writeFileSync(join(repo, 'notes', 'a.md'), 'Telemetry export dir: ~/exports/telemetry-out\n');
  assert.equal(lookupInfo('where is the telemetry export dir', { roots: [repo] }).answer, '~/exports/telemetry-out');
  const plain = mkdtempSync(join(tmpdir(), 'info-plain-'));
  writeFileSync(join(plain, 'state.json'), JSON.stringify({ note: 'gamma cache path /var/fake/gamma-cache' }));
  const r = lookupInfo('what is the gamma cache path', { roots: [plain] });
  assert.equal(r.answer, '/var/fake/gamma-cache'); assert.equal(r.source, 'state.json:1');
});

test('lookupInfo: nothing the hard floor flags is ever returned', () => {
  const repo = makeRepo({ files: { 'docs/A.md': 'the beta file path is /data/fake/secrets/beta\n' } });
  assert.equal(lookupInfo('send the beta file path', { roots: [repo] }), null);
});
