// Fingerprint algorithm floor (owner 2026-11-22): approval by a manager AND a retest report, virtualpytest repo only. Temp state only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createIntegrationLane } from '../integration-lane.js';
import { fingerprintGate, parseFingerprintPaths, matchesFingerprintPath } from '../merge-policy.js';
import { makeWorld } from './helpers-lane.js';
import { tmp } from './helpers-tmp.js';

const ALGO = 'backend_host/src/services/localize/matcher.py';
const mk = (w, key = 'virtualpytest') => {
  const items = [];
  const lane = createIntegrationLane({ stateDir: tmp('fpgate-'), config: { repos: { [key]: w.cfg() } }, managerItem: (i) => items.push(i),
    managerSessions: () => ['manager'], pollMs: 1, sleep: () => new Promise((r) => setTimeout(r, 1)) });
  lane.start();
  return { lane, items, go: (input) => { const q = lane.enqueue({ repo: key, ...input }); return lane.wait(q.id, 30000); } };
};

test('unit: path list parsing, globs, docs excluded', () => {
  const list = parseFingerprintPaths('# c\n\nalgo/\nlib/fp*.py\nexact.py\n');
  assert.deepEqual(list, ['algo/', 'lib/fp*.py', 'exact.py']);
  assert.ok(matchesFingerprintPath('algo/x/y.py', list) && matchesFingerprintPath('lib/fp_a.py', list) && matchesFingerprintPath('exact.py', list));
  assert.ok(!matchesFingerprintPath('lib/other.py', list));
  assert.deepEqual(fingerprintGate({ files: ['algo/README.md'], list }).reasons, []);
});

test('algorithm path touched without approval: returned with the reason and the modop', async () => {
  const w = makeWorld(); w.branch('fp', { [ALGO]: 'x\n' });
  const { lane, items, go } = mk(w); const before = w.main();
  const r = await go({ branch: 'fp', session: 'worker' });
  assert.equal(r.state, 'returned'); assert.equal(r.outcome, 'needs_approval');
  assert.match(r.reason, /fingerprint algorithm/); assert.match(r.reason, /FINGERPRINT_RETEST\.md/);
  assert.equal(w.main(), before); assert.equal(items.length, 1); assert.match(items[0].text, /--approved-by manager/);
  lane.stop();
});

test('a self-approval from a non-manager is ignored: still returned', async () => {
  const w = makeWorld(); w.branch('fp', { [ALGO]: 'x\n', 'docs/agent/navigation/retest-reports/r.md': 'ok\n' });
  const { lane, go } = mk(w);
  const r = await go({ branch: 'fp', session: 'worker', approvedBy: 'manager' });
  assert.equal(r.state, 'returned'); assert.equal(r.outcome, 'needs_approval');
  lane.stop();
});

test('approved but no report: returned; report file in the diff: merged; report path in --note: merged', async () => {
  const w = makeWorld(); w.branch('fp1', { [ALGO]: 'x\n' });
  const { lane, go } = mk(w);
  const a = await go({ branch: 'fp1', session: 'manager', approvedBy: 'manager' });
  assert.equal(a.state, 'returned'); assert.equal(a.outcome, 'needs_report'); assert.match(a.reason, /retest report/);
  w.branch('fp2', { [ALGO]: 'y\n', 'docs/agent/navigation/retest-reports/2026-11-22.md': 'all green\n' });
  const b = await go({ branch: 'fp2', session: 'manager', approvedBy: 'manager' });
  assert.equal(b.state, 'merged', JSON.stringify(b));
  w.branch('fp3', { 'backend_host/src/services/localize/other.py': 'z\n' });
  const c = await go({ branch: 'fp3', session: 'manager', approvedBy: 'manager', note: 'retest report docs/agent/navigation/retest-reports/2026-11-22.md' });
  assert.equal(c.state, 'merged', JSON.stringify(c));
  lane.stop();
});

test('docs-only change inside the algorithm folder is not blocked; other repos are not gated', async () => {
  const w = makeWorld(); w.branch('d', { 'backend_host/src/services/localize/README.md': 'doc\n' });
  const m = mk(w); const r = await m.go({ branch: 'd', session: 'worker' });
  assert.equal(r.state, 'merged', JSON.stringify(r)); m.lane.stop();
  const w2 = makeWorld(); w2.branch('o', { [ALGO]: 'x\n' });
  const m2 = mk(w2, 'other'); const r2 = await m2.go({ branch: 'o', session: 'worker' });
  assert.equal(r2.state, 'merged', JSON.stringify(r2)); m2.lane.stop();
});

test('the list is read from the target repo at merge time', async () => {
  const w = makeWorld(); w.moveMain({ 'scripts/review/fingerprint_algorithm_paths.txt': '# list\nonly/here.py\n' });
  w.branch('p', { [ALGO]: 'x\n' }); w.branch('q', { 'only/here.py': 'x\n' });
  const { lane, go } = mk(w);
  assert.equal((await go({ branch: 'p', session: 'worker' })).state, 'merged', 'placeholder path no longer gated');
  const r = await go({ branch: 'q', session: 'worker' });
  assert.equal(r.outcome, 'needs_approval'); lane.stop();
});

test('docs state the rule', () => {
  for (const f of ['AGENTS.md', 'docs/REFERENCE.md']) assert.match(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /fingerprint_algorithm_paths\.txt/);
});
