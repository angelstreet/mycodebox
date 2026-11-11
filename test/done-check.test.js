import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finding, shipOfferOf, shipOfferMessage, message, uncommittedOf, namedRefs, createDoneCheck } from '../done-check.js';

test('finding: commits not on main and uncommitted files disagree with done; a clean checkout agrees', () => {
  assert.equal(finding({ branch: 'main', notOnMain: [], uncommitted: [] }), null);
  assert.equal(finding(null), null);
  const f = finding({ branch: 'task59-ui', notOnMain: [{ sha: 'cdc80ab3a' }, { sha: 'a3ed0c37f' }], uncommitted: ['frontend/src/a.tsx'] });
  assert.match(f.text, /2 commit\(s\) on task59-ui not on main \(cdc80ab3a, a3ed0c37f\)/);
  assert.match(f.text, /1 uncommitted file\(s\) \(frontend\/src\/a\.tsx\)/);
  assert.notEqual(f.sig, finding({ branch: 'task59-ui', notOnMain: [{ sha: 'cdc80ab3a' }], uncommitted: [] }).sig);
});

test('uncommittedOf: porcelain paths, renames to their new name, VERSION.txt stamps ignored', () => {
  assert.deepEqual(uncommittedOf(' M VERSION.txt\n M a/b.js\nR  old.js -> new.js\n'), ['a/b.js', 'new.js']);
  assert.deepEqual(uncommittedOf(''), []);
});

test('message: names what git shows and offers a one-line reason instead of work', () => {
  const m = message({ text: '7 commit(s) on x not on main (a, b, c)' });
  assert.match(m, /STATUS says done, but git disagrees: 7 commit/);
  assert.match(m, /why it stays as is/);
});

// Fake git: a repo per cwd. /w/clean agrees; /w/t59 has 2 unmerged commits; /w/dirty has an uncommitted file.
function fakeGit(calls) {
  return async (cwd, args) => {
    calls.push(args[0]);
    if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return args[2] === '--git-dir' ? (cwd === '/w/shared' ? '/r/.git\n' : `/r/.git/worktrees${cwd}\n`) : '/r/.git\n';
    if (args[0] === 'rev-parse' && args[1] === '-q') { if (args[3] === 'origin/main') return 'abc\n'; throw new Error('no ref'); }
    if (args[0] === 'rev-parse') return cwd === '/w/t59' ? 'task59\n' : 'main\n';
    if (args[0] === 'log') return cwd === '/w/t59' ? 'cdc80ab3a\tfix(ui): a\na3ed0c37f\tfix(ui): b\n' : '';
    if (args[0] === 'status') return cwd === '/w/dirty' || cwd === '/w/shared' ? ' M src/x.js\n M VERSION.txt\n' : ' M VERSION.txt\n';
    return '';
  };
}

function harness(t, { sessions, mode = 'live', pressure }) {
  const dir = mkdtempSync(join(tmpdir(), 'done-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent = [], events = [], calls = [];
  const w = createDoneCheck({ stateDir: dir, git: fakeGit(calls), listDone: async () => sessions(), mode: () => mode, log: { error() {} },
    pressure: pressure || (() => ({ loadPerCore: 0.2, ramAvailPct: 60 })),
    send: async (n, text) => { sent.push([n, text]); }, record: async (e) => { events.push(e.key); } });
  return { w, dir, sent, events, calls };
}

test('tick: tells only the sessions git disagrees with, once per finding, fetching the repo once', async (t) => {
  const s = [{ name: 'clean', cwd: '/w/clean' }, { name: 'TASK59', cwd: '/w/t59' }, { name: 'dirty', cwd: '/w/dirty' }];
  const h = harness(t, { sessions: () => s });
  const r = await h.w.tick();
  assert.equal(r.checked, 3);
  assert.deepEqual(r.findings.map((f) => f.name), ['TASK59', 'dirty']);
  assert.deepEqual(h.sent.map((x) => x[0]), ['TASK59', 'dirty']);
  assert.match(h.sent[0][1], /2 commit\(s\) on task59 not on main/);
  assert.deepEqual(h.events, ['done-check:TASK59', 'done-check:dirty']);
  assert.equal(h.calls.filter((c) => c === 'fetch').length, 1);
  await h.w.tick();
  assert.equal(h.sent.length, 2, 'the same finding is not told twice');
});

test('tick: a working session, a busy host and dry mode tell nobody; off checks nothing', async (t) => {
  const busy = harness(t, { sessions: () => [{ name: 'TASK59', cwd: '/w/t59', working: true }] });
  await busy.w.tick(); assert.equal(busy.sent.length, 0);
  const loaded = harness(t, { sessions: () => [{ name: 'TASK59', cwd: '/w/t59' }], pressure: () => ({ loadPerCore: 4, ramAvailPct: 60 }) });
  assert.equal((await loaded.w.tick()).held, 'host busy'); assert.equal(loaded.sent.length, 0);
  const dry = harness(t, { sessions: () => [{ name: 'TASK59', cwd: '/w/t59' }], mode: 'dry' });
  await dry.w.tick(); assert.equal(dry.sent.length, 0); assert.deepEqual(dry.events, []);
  assert.match(readFileSync(join(dry.dir, 'done-check.jsonl'), 'utf8'), /"dry":true.*TASK59/);
  const off = harness(t, { sessions: () => { throw new Error('must not list'); }, mode: 'off' });
  assert.equal((await off.w.tick()).mode, 'off');
});

test('namedRefs: branches and worktree paths in a closing text, main/master skipped', () => {
  const r = namedRefs('STATUS: done — merged task59-frontend-ui-rules; left origin/feat/x and ~/vpt-task59, main is green.', '/home/user');
  assert.ok(r.branches.includes('task59-frontend-ui-rules'));
  assert.ok(r.branches.includes('feat/x'));
  assert.ok(!r.branches.includes('main'));
  assert.deepEqual(r.paths, ['/home/user/vpt-task59']);
});

test('tick: a session on main whose STATUS names a branch with unmerged commits is caught (TASK59, 2026-10-15)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'done-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = async (cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return args[2] === '--git-dir' ? '/r/.git/worktrees/w\n' : '/r/.git\n';
    if (args[0] === 'rev-parse' && args[1] === '-q') { if (args[3] === 'origin/main' || args[3] === 'refs/remotes/origin/task59-ui') return 'x\n'; throw new Error('no ref'); }
    if (args[0] === 'rev-parse') return 'main\n';
    if (args[0] === 'log') return args.includes('origin/main...refs/remotes/origin/task59-ui') ? 'cdc80ab3a\tfix(ui): widths\n' : '';
    return '';
  };
  const sent = [];
  const w = createDoneCheck({ stateDir: dir, git, log: { error() {} }, pressure: () => ({ loadPerCore: 0, ramAvailPct: 90 }),
    listDone: async () => [{ name: 'TASK59', cwd: '/w/vpt', text: 'STATUS: done — task59-ui shipped and deployed; nothing pending.' }],
    send: async (n, x) => { sent.push(x); } });
  const r = await w.tick();
  assert.match(r.findings[0].text, /1 commit\(s\) on task59-ui not on main \(cdc80ab3a\)/);
  assert.equal(sent.length, 1);
});

test('tick: commits whose content is already on main (clean trial merge, no change) are not a finding', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'done-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mk = (clean) => async (cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return args[2] === '--git-dir' ? '/r/.git/worktrees/w\n' : '/r/.git\n';
    if (args[0] === 'rev-parse' && args[1] === '-q') { if (args[3] === 'origin/main') return 'x\n'; throw new Error('no ref'); }
    if (args[0] === 'rev-parse') return 'squashed\n';
    if (args[0] === 'log') return 'abc1234\tfeat: x\n';
    if (args[0] === 'merge-tree') { if (!clean) throw new Error('conflict'); return 'tree1\n'; }
    if (args[0] === 'diff') return '';
    return '';
  };
  for (const [clean, n] of [[true, 0], [false, 1]]) {
    const w = createDoneCheck({ stateDir: dir, git: mk(clean), mode: () => 'dry', log: { error() {} }, listDone: async () => [{ name: 's', cwd: '/w' }], send: async () => {} });
    assert.equal((await w.tick()).findings.length, n, clean ? 'clean, no-change merge' : 'conflicting merge');
  }
});

test('tick: uncommitted files in the shared main checkout are not blamed on the sessions sitting in it', async (t) => {
  const h = harness(t, { sessions: () => [{ name: 'a', cwd: '/w/shared' }, { name: 'b', cwd: '/w/dirty' }] });
  const r = await h.w.tick();
  assert.deepEqual(r.findings.map((f) => f.name), ['b']);
});

test('leftovers nudge: a done line with leftovers or "not fully confirmed" is sent back to finish (2026-11-01)', async () => {
  const { leftoversMessage, leftoverItemsOf } = await import('../done-check.js');
  assert.deepEqual(leftoverItemsOf('STATUS: done'), []);
  assert.match(leftoverItemsOf('STATUS: done — merged; not fully confirmed: device run')[0], /not fully confirmed: device run/);
  assert.match(leftoverItemsOf('Left to do:\n- run the validation\nSTATUS: done')[0], /run the validation/);
  assert.match(leftoversMessage(['run the validation']), /Finish it now.*not an end state/);
});

test('unconfirmed STATUS (2026-11-03): not fully confirmed / partial are leftovers; waiting/blocked are real stops', async () => {
  const { unconfirmedStatusOf, leftoverItemsOf } = await import('../done-check.js');
  assert.equal(unconfirmedStatusOf('STATUS: not fully confirmed: live, replay'), 'live, replay');
  assert.equal(unconfirmedStatusOf('STATUS: partial'), '');
  assert.equal(unconfirmedStatusOf('STATUS: waiting: not fully confirmed run'), null);
  assert.equal(unconfirmedStatusOf('STATUS: blocked: x'), null);
  assert.equal(unconfirmedStatusOf('STATUS: done; bugs: none'), null);
  assert.deepEqual(leftoverItemsOf('STATUS: not fully confirmed: live'), ['not fully confirmed: live']);
});

test('unconfirmed STATUS: pushed once per distinct list, capped at 3 a day, then the manager is told once', async (t) => {
  let n = 0;
  const h = harness(t, { sessions: () => [{ name: 'a', cwd: '/w/clean', text: `STATUS: not fully confirmed: item ${n}` }] });
  for (n = 0; n < 5; n++) { await h.w.tick(); await h.w.tick(); }
  assert.equal(h.sent.length, 3);
  assert.match(h.sent[0][1], /not an end state/);
  assert.equal(h.events.filter((k) => k === 'done-check-left-cap:a').length, 1);
});

// (E) ship without asking (owner, 2026-11-11). The Haiku Mac session, closing texts verbatim.
const OWNER_HAIKU = "Done: the Details row is now 36px high in Navigation_NodeEditDialog.tsx.\n\nI haven't checked this visually or run the typecheck. Nothing is committed. If you want, I can open the dialog in the browser to confirm, then commit.\n\nShould I open the dialog in the browser to check it visually?";
const OWNER_HAIKU_2 = 'Okay, I\'ll leave it there. The change is in the working tree, not committed, not visually checked.';
const HAIKU_VARIANT = 'Fixed the off-by-one in paginate(). Want me to commit and push this?';

test('shipOfferOf: the owner\'s Haiku transcript and a variant are offers; STATUS lines, hard-floor topics and plain reports are not', () => {
  assert.match(shipOfferOf(OWNER_HAIKU), /Nothing is committed|haven't checked|If you want/i);
  assert.ok(shipOfferOf(OWNER_HAIKU_2));
  assert.ok(shipOfferOf(HAIKU_VARIANT));
  assert.ok(shipOfferOf('Done. Should I push the branch?'));
  assert.equal(shipOfferOf(OWNER_HAIKU + '\nSTATUS: needs-owner: open the browser?'), null);
  assert.equal(shipOfferOf('Fixed it. Want me to delete the production database backups?'), null);
  assert.equal(shipOfferOf('Fixed and pushed; integration int-1 merged.'), null);
  assert.equal(shipOfferOf(''), null);
  assert.match(shipOfferMessage({ text: '1 uncommitted file(s) (a.tsx)' }), /do not ask[\s\S]*vpt-headless-verify[\s\S]*integrate request/);
});

test('tick (E): an offer with a dirty tree gets one authorised-push, not the generic git message; a clean tree or a STATUS line gets none; once per text', async (t) => {
  const s = [
    { name: 'haiku', cwd: '/w/dirty', text: OWNER_HAIKU }, { name: 'clean', cwd: '/w/clean', text: OWNER_HAIKU },
    { name: 'status', cwd: '/w/dirty', text: 'Done.\nSTATUS: done — x' },
  ];
  const h = harness(t, { sessions: () => s });
  const r = await h.w.tick();
  const toHaiku = h.sent.filter((x) => x[0] === 'haiku');
  assert.equal(toHaiku.length, 1);
  assert.match(toHaiku[0][1], /You are authorised|authorised \(AGENTS\.md/);
  assert.doesNotMatch(toHaiku[0][1], /STATUS says done/);
  assert.equal(h.sent.some((x) => x[0] === 'clean'), false);
  assert.deepEqual(r.shipOffers, ['haiku']);
  await h.w.tick();
  assert.equal(h.sent.filter((x) => x[0] === 'haiku').length, 1);
});

test('tick (E): dry mode and a drafting owner send nothing', async (t) => {
  const h = harness(t, { sessions: () => [{ name: 'haiku', cwd: '/w/dirty', text: HAIKU_VARIANT }], mode: 'dry' });
  await h.w.tick();
  assert.equal(h.sent.length, 0);
  const h2 = harness(t, { sessions: () => [{ name: 'haiku', cwd: '/w/dirty', text: HAIKU_VARIANT, draft: true }] });
  await h2.w.tick();
  assert.equal(h2.sent.length, 0);
});
