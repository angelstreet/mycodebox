import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';
import { parseTaskDoc, splitRows, scanTaskDocs, computeUnfinished, docLeftoversFor, createUnfinished } from '../unfinished.js';

// Shape of the real TASK-178 doc (rows 1,2,3,5,6,7,8 open, 4 not applicable); abbreviated, no real brand names.
const DOC = `---
title: TASK-178 — xtel trees
---
# TASK-178 — xtel trees

| # | Goal | Done when | State |
|---|---|---|---|
| 1 | Credentials ready | env keys exist | open |
| 2 | App installed | listed | open (Play Store sign-in is the owner's if the device asks) |
| 3 | web-xtel | run passes | open |
| 4 | androidmobile-xtel | tree | **not applicable (2026-10-27)** |
| 5 | androidtv-xtel | tree | open: needs a TV device |
| 6 | Languages | fr + en | open |
| 7 | Localize | coverage | in progress |
| 8 | Publish | prod | blocked: owner must supply the production login |
| 9 | Cleanup | done | done |
| 10 | Owner sign-off | ok | open |
`;
const DONE_DOC = '# TASK-5 — finished\n\n| # | Goal | State |\n|---|---|---|\n| 1 | a | done |\n| 2 | b | merged |\n';

test('parseTaskDoc: open / in progress / blocked rows only; owner-only detected; closed rows skipped', () => {
  const d = parseTaskDoc(DOC);
  assert.equal(d.title, 'TASK-178 — xtel trees');
  assert.deepEqual(d.rows.map((r) => r.n), ['1', '2', '3', '5', '6', '7', '8', '10']);
  assert.equal(d.rows.find((r) => r.n === '7').kind, 'in-progress');
  assert.equal(d.rows.find((r) => r.n === '8').ownerOnly, true);
  assert.equal(d.rows.find((r) => r.n === '2').ownerOnly, false);
  const s = splitRows(d.rows);
  assert.deepEqual(s.actionable.map((r) => r.n), ['1', '2', '3', '5', '6', '7']);
  assert.deepEqual(s.ownerOnly.map((r) => r.n), ['8', '10']);   // blocked on the owner: owner-only wins
  assert.deepEqual(s.blocked.map((r) => r.n), []);
  assert.deepEqual(parseTaskDoc(DONE_DOC).rows, []);
  assert.deepEqual(parseTaskDoc('no table here').rows, []);
});

test('scanTaskDocs: newest copy of the same doc across worktrees wins', async () => {
  const a = tmp('uf-a-'), b = tmp('uf-b-');
  for (const [d, doc, t] of [[a, DONE_DOC, 1000], [b, DOC, 2000]]) {
    mkdirSync(join(d, 'docs', 'tasks'), { recursive: true });
    const f = join(d, 'docs', 'tasks', 'TASK-178-xtel.md'); writeFileSync(f, doc);
    const { utimesSync } = await import('node:fs'); utimesSync(f, t, t);
  }
  writeFileSync(join(a, 'docs', 'tasks', 'README.md'), 'x');
  const docs = await scanTaskDocs([{ path: a }, { path: b }, { path: '/nonexistent-dir' }]);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].task, 'TASK-178'); assert.equal(docs[0].dir, b); assert.equal(docs[0].rows.length, 8);
});

const T0 = 1.8e12, H = 3600 * 1000;
const docs = () => [{ task: 'TASK-178', num: 178, file: '/x/TASK-178-xtel.md', title: 't', ...parseTaskDoc(DOC) }, { task: 'TASK-5', num: 5, file: '/x/TASK-5.md', title: 'f', ...parseTaskDoc(DONE_DOC) }];
const inst = (o) => ({ name: 'task178-xtel-trees', provider: 'claude', model: 'sonnet', cwd: '/w', prompt_ref: null, handover_ref: null, start: T0 - 5 * H, end: null, end_reason: null, ...o });

test('computeUnfinished: ended session + open rows = orphaned; finished task never listed', () => {
  const r = computeUnfinished({ docs: docs(), instances: [inst({ end: T0 - 2 * H, end_reason: 'killed' })], now: T0 });
  assert.deepEqual(r.orphaned.map((o) => o.task), ['TASK-178']);
  assert.deepEqual(r.orphaned[0].open.map((x) => x.n), ['1', '2', '3', '5', '6', '7']);
  assert.deepEqual(r.orphaned[0].ownerOnly.map((x) => x.n), ['8', '10']);
  assert.match(r.orphaned[0].why, /killed/);
  assert.equal(r.orphaned[0].lastSession.model, 'sonnet');
  assert.ok(![...r.orphaned, ...r.covered, ...r.other].some((o) => o.task === 'TASK-5'));
});

test('computeUnfinished: live session (by name, prompt_ref or handover_ref) covers; recent end, no history, stale are not orphaned', () => {
  const run = (instances, live) => computeUnfinished({ docs: docs(), instances, live, now: T0 });
  assert.equal(run([inst({})]).covered.length, 1);
  assert.equal(run([inst({ name: 'other', handover_ref: '/h/task-178-resume.md' })]).covered.length, 1);
  assert.equal(run([inst({ name: 'other', prompt_ref: 'continue TASK-178 rows' })]).covered.length, 1);
  assert.equal(run([inst({ end: T0 - 5 * 60000 })]).orphaned.length, 0);
  assert.match(run([inst({ end: T0 - 5 * 60000 })]).other[0].why, /quiet/);
  assert.match(run([]).other[0].why, /no session/);
  const st = run([inst({ end: T0 - 20 * 24 * H })]);
  assert.equal(st.orphaned.length, 0); assert.equal(st.other[0].stale, true);
  assert.equal(run([inst({ end: T0 - 2 * H })], new Set(['task178-xtel-trees'])).covered.length, 1);   // name reused and live
  assert.equal(run([inst({ name: 'task1780-else', end: T0 - 2 * H })]).orphaned.length, 0);          // TASK-1780 is not TASK-178
});

test('computeUnfinished: only owner-only rows left -> not orphaned', () => {
  const d = [{ task: 'TASK-9', num: 9, file: '/x', title: '', rows: [{ n: '1', goal: 'g', state: 'needs-owner: pay', kind: 'open', ownerOnly: true }] }];
  const r = computeUnfinished({ docs: d, instances: [inst({ name: 'task9', end: T0 - 2 * H })], now: T0 });
  assert.equal(r.orphaned.length, 0); assert.match(r.other[0].why, /owner-only/);
});

test('docLeftoversFor: live session says done, doc has open rows -> items; not done or other session -> null', () => {
  const r = computeUnfinished({ docs: docs(), instances: [inst({})], now: T0 });
  const dl = docLeftoversFor('task178-xtel-trees', 'all good\nSTATUS: done — merged', r.covered);
  assert.equal(dl.task, 'TASK-178'); assert.match(dl.items[0], /TASK-178 row 1/);
  assert.equal(docLeftoversFor('task178-xtel-trees', 'STATUS: blocked', r.covered), null);
  assert.equal(docLeftoversFor('someone-else', 'STATUS: done', r.covered), null);
});

test('createUnfinished: one orphaned-task event per task per day, survives a restart, off switch, payload for the feed', async () => {
  const dir = tmp('uf-w-'); let t = Date.parse('2026-10-28T10:00:00Z'); const seen = []; let mode = 'live';
  const compute = async () => computeUnfinished({ docs: docs(), instances: [inst({ end: t - 2 * H })], now: t });
  const mk = () => createUnfinished({ compute, record: async (e) => { seen.push(e); }, stateDir: dir, mode: () => mode, now: () => t, log: { error() {} } });
  let w = mk(); await w.tick(); await w.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, 'TASK-178:orphaned-task'); assert.equal(seen[0].task.id, 'TASK-178'); assert.equal(seen[0].items.length, 6);
  w = mk(); await w.tick(); assert.equal(seen.length, 1);              // restart: still told today
  t += 24 * H; await w.tick(); assert.equal(seen.length, 2);           // next day
  mode = 'off'; t += 24 * H; await w.tick(); assert.equal(seen.length, 2);
});

test('scripts/resume-task: dry run builds the handover for an orphan; refuses covered, finished and owner-only tasks', async () => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { readFileSync, existsSync } = await import('node:fs');
  const home = tmp('uf-home-'), cwd = tmp('uf-cwd-');
  const row = (n) => ({ n, goal: `goal ${n}`, state: 'open', kind: 'open' });
  const body = { ok: true,
    orphaned: [{ task: 'TASK-178', doc: '/x/docs/tasks/TASK-178-xtel.md', title: 'xtel trees', open: [row('3'), row('5')], ownerOnly: [{ n: '8', goal: 'prod login', state: 'needs-owner', kind: 'blocked' }], blocked: [], liveSessions: [], lastSession: { name: 'task178-old', provider: 'claude', model: 'sonnet', cwd, endedAt: '2026-10-28T05:00:00Z', reason: 'killed' }, why: 'x' },
      { task: 'TASK-9', doc: '/x/9.md', title: '', open: [], ownerOnly: [row('1')], blocked: [], liveSessions: [], lastSession: null, why: 'x' }],
    covered: [{ task: 'TASK-7', open: [row('1')], ownerOnly: [], blocked: [], liveSessions: ['task7'] }], other: [] };
  const srv = createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(body)); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const run = (...a) => new Promise((ok) => execFile('node', [join(import.meta.dirname, '..', 'scripts', 'resume-task'), ...a], { encoding: 'utf8', env: { ...process.env, HOME: home, PORT: String(srv.address().port) } }, (err, stdout, stderr) => ok({ status: err ? err.code : 0, stdout, stderr })));   // async: the stub server shares this event loop
  try {
    const ok = await run('TASK-178', '--dry-run');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /cbsession -n resume-task178 -d .* -p claude -m sonnet -H /);
    const ho = readFileSync(join(home, 'handovers', 'resume-task178.md'), 'utf8');
    assert.match(ho, /row 3: goal 3/); assert.match(ho, /row 5: goal 5/);
    assert.match(ho, /Owner-only rows: do NOT work on these[\s\S]*row 8: prod login/);
    assert.match(ho, /TASK-178-xtel\.md/);
    assert.equal((await run('TASK-7', '--dry-run')).status, 3);          // live session covers it
    assert.match((await run('TASK-7', '--dry-run')).stderr, /not orphaned/);
    assert.equal((await run('TASK-9', '--dry-run')).status, 3);          // nothing the session can do
    assert.equal((await run('TASK-55', '--dry-run')).status, 3);         // finished / unknown
    assert.equal((await run('nonsense')).status, 2);
    assert.ok(!existsSync(join(home, '.local')));                // a dry run records nothing
  } finally { srv.close(); }
});

test('withHomeDirs: adds home subdirectories missing from the dirs list, skips dot dirs and files, no duplicates', async () => {
  const { withHomeDirs } = await import('../unfinished.js');
  const home = tmp('uf-home2-');
  for (const d of ['proj-a', 'proj-b', '.hidden']) mkdirSync(join(home, d));
  writeFileSync(join(home, 'file.txt'), 'x');
  const r = await withHomeDirs([{ path: join(home, 'proj-a') }], home);
  assert.deepEqual(r.map((d) => d.path).sort(), [join(home, 'proj-a'), join(home, 'proj-b')]);
  assert.deepEqual(await withHomeDirs(null, '/nonexistent-home'), []);
});
