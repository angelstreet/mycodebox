// Proof by risk (owner 2026-11-25): cosmetic UI change = no e2e; UI fix / feature = headless e2e on the deployed URL after the deploy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp } from './helpers-tmp.js';
import { classifyRisk, logicLinesOf, proofGapOf, proofGapMessage, screenshotPathsOf, deployedUrlsOf, declaredRiskOf } from '../proof-risk.js';
import { createDoneCheck } from '../done-check.js';

const F = 'frontend/src/Page.tsx';
const patch = (...l) => [`+++ b/${F}`, '@@ -1 +1 @@', ...l].join('\n');
const DEPLOY = '2026-11-25T10:00:00Z';
const ui = (over = {}) => ({ id: 'int-1', repo: 'virtualpytest', files: [F], patch: patch('+  <Typography>New wording</Typography>'), mergedAt: '2026-11-25T09:59:00Z', deployedAt: DEPLOY, ...over });
const line = (extra = '') => `Tested ${extra}\nSTATUS: done — x · closing review: docs release note none needed: UI check only for this test · leftovers none · unverified none · bugs: none`;

test('classifyRisk: wording, JSX text, sx, CSS and docs are cosmetic', () => {
  assert.equal(classifyRisk({ files: [F, 'docs/RELEASE-NOTES.md'], patch: patch('-  <Typography>Old</Typography>', '+  <Typography>New wording</Typography>', '+  sx={{ p: 2, color: "red" }}', '+  label="Save all"') }).risk, 'cosmetic');
  assert.equal(classifyRisk({ files: ['frontend/src/a.css', 'docs/x.md'], patch: '+++ b/frontend/src/a.css\n+.a { color: red; if (x) }' }).risk, 'cosmetic');
  assert.equal(classifyRisk({ files: ['docs/x.md', 'skills/a/SKILL.md'] }).applies, false, 'docs only: no web UI');
});

test('classifyRisk: logic lines, other code or missing diff make it a fix; backend-only is out of scope', () => {
  assert.equal(classifyRisk({ files: [F], patch: patch('+  const ids = items.map((i) => i.id);') }).risk, 'fix');
  assert.equal(classifyRisk({ files: [F], patch: patch('+  onClick={() => save()}') }).risk, 'fix');
  assert.equal(classifyRisk({ files: [F], patch: patch('+import { x } from "./x";') }).risk, 'fix');
  assert.equal(classifyRisk({ files: [F, 'server.js'], patch: patch('+  <b>hi</b>') }).risk, 'fix', 'UI plus backend route');
  assert.equal(classifyRisk({ files: [F], patch: null }).risk, 'fix');
  assert.equal(classifyRisk({ files: ['server.js', 'integration-lane.js'] }).applies, false);
  assert.equal(classifyRisk({ files: ['frontend/src/a.test.tsx'] }).applies, false, 'tests are not UI');
});

test('classifyRisk: a declared risk: cosmetic loses to a logic diff; declared fix/feature is honoured', () => {
  const logic = patch('+  if (ok) go();');
  assert.equal(classifyRisk({ files: [F], patch: logic, text: 'risk: cosmetic' }).risk, 'fix');
  assert.equal(classifyRisk({ files: [F], patch: logic, text: 'risk: feature' }).risk, 'feature');
  assert.equal(classifyRisk({ files: [F], patch: patch('+  <b>hi</b>'), text: 'risk: fix' }).risk, 'fix');
  assert.equal(declaredRiskOf('done · risk: cosmetic ·'), 'cosmetic');
  assert.ok(logicLinesOf(logic).logic.length);
});

test('extractors: screenshot paths skip URLs; localhost and vite ports are not the deployed host', () => {
  assert.deepEqual(screenshotPathsOf('shot /tmp/a/b.png at https://x.io/a.png and ~/p/q.jpg'), ['/tmp/a/b.png', '~/p/q.jpg']);
  assert.deepEqual(deployedUrlsOf('http://localhost:5173/a https://127.0.0.1/x http://h.io:5174/ https://app.example.io/page'), ['https://app.example.io/page']);
});

const mtimes = (m) => (p) => (p in m ? Date.parse(m[p]) : null);
const good = line('with playwright headless, screenshot /tmp/s.png on https://ghosty.example.io/x');
test('proofGapOf: cosmetic and backend-only owe nothing; fix with full proof passes', () => {
  assert.equal(proofGapOf(line(), [ui()]), null, 'cosmetic');
  assert.equal(proofGapOf(line(), [{ id: 'i', files: ['server.js'], patch: null }]), null, 'backend only');
  const fix = ui({ patch: patch('+  if (x) y();') });
  assert.equal(proofGapOf(good, [fix], { statMtime: mtimes({ '/tmp/s.png': '2026-11-25T10:05:00Z' }) }), null);
});

test('proofGapOf: missing headless, screenshot, stale screenshot, localhost URL are each named', () => {
  const fix = ui({ patch: patch('+  if (x) y();') });
  const none = proofGapOf(line(), [fix], { statMtime: mtimes({}) });
  assert.equal(none.missing.length, 3); assert.equal(none.risk, 'fix');
  const stale = proofGapOf(good, [fix], { statMtime: mtimes({ '/tmp/s.png': '2026-11-25T09:00:00Z' }) });
  assert.match(stale.missing.join(), /after the deploy/);
  const absent = proofGapOf(good, [fix], { statMtime: mtimes({}) });
  assert.match(absent.missing.join(), /was not found/);
  const local = proofGapOf(line('playwright /tmp/s.png http://localhost:5173/'), [fix], { statMtime: mtimes({ '/tmp/s.png': '2026-11-25T10:05:00Z' }) });
  assert.match(local.missing.join(), /deployed host/);
  assert.equal(proofGapOf(line('playwright /tmp/s.png http://localhost:5173/'), [fix], { goal: 'local worktree preview of the page', statMtime: mtimes({ '/tmp/s.png': '2026-11-25T10:05:00Z' }) }), null);
  assert.match(proofGapMessage(none), /vpt-headless-verify/);
});

function harness(text, ints, over = {}) {
  const dir = tmp('ghosty-proof-'); const sent = []; const events = []; const sessions = [{ name: 'a', cwd: '/w/a', text }];
  const git = async (cwd, args) => { if (args[0] === 'rev-parse' && args[1] === '-q') { if (args[3] === 'origin/main') return 'abc\n'; throw new Error('no ref'); } if (args[0] === 'rev-parse' && args[2] === '--git-dir') return `/r/.git/worktrees${cwd}\n`; if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return '/r/.git\n'; if (args[0] === 'rev-parse') return 'main\n'; return ''; };
  const w = createDoneCheck({ stateDir: dir, git, listDone: async () => sessions, send: async (n, x) => { sent.push([n, x]); }, record: async (e) => { events.push(e); }, integrationsOf: async () => ints, proofStat: () => null, now: () => Date.parse('2026-11-25T11:00:00Z'), log: { error() {} }, pressure: () => ({ loadPerCore: 0.1, ramAvailPct: 80 }), ...over });
  return { w, sent, events, sessions };
}

test('done-check (P): one push, then a distinct second miss goes to the manager only; cosmetic, dry and off push nothing', async () => {
  const fix = ui({ patch: patch('+  if (x) y();') });
  const h = harness(line('playwright'), [fix]);
  await h.w.tick(); await h.w.tick();
  assert.equal(h.sent.length, 1); assert.match(h.sent[0][1], /deployed site/);
  h.sessions[0].text = line('playwright /tmp/none.png http://localhost:5173/');   // a different miss
  await h.w.tick(); await h.w.tick();
  assert.equal(h.sent.length, 1, 'no second push');
  assert.equal(h.events.length, 1); assert.match(h.events[0].key, /^proof-risk:a$/);
  for (const [txt, over] of [[line(), {}], [line('playwright'), { proofMode: () => 'dry' }], [line('playwright'), { proofMode: () => 'off' }]]) {
    const x = harness(txt, [over.proofMode ? fix : ui()], over); await x.w.tick(); assert.equal(x.sent.length, 0);
  }
});
