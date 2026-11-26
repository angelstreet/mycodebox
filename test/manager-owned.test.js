// Sessions the manager started never ask the owner (manager-owned.js, owner 2026-11-26): who counts, what they are told, what the dashboard and the app
// show, who may answer their suggestions, how an owner-only item reaches the owner, and the one "ready to close" claim. Owner-started: as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers-tmp.js';
import { isManagerStarted, childrenOf, createManagerOwned, forManagerSession, ownerAskRoute, MANAGER_RULE } from '../manager-owned.js';
import { createSessionHistory, validateRecord, fold } from '../session-history.js';
import { reflectionQuestion, openSuggestionsMessage, missingReplyMessage, isReflectionAsk } from '../reflection.js';
import { createSuggestions } from '../suggestions.js';
import { leftoversMessage } from '../done-check.js';
import { displayState } from '../public/state.js';
import { isOwnersTurn, buildQueue, unattachedAsks } from '../public/ask-model.js';
import { stopItem } from '../voice.js';
import { fileAsk, readOpenAsks, resolveMovedOn } from '../owner-asks.js';
import { askSummary } from '../public/manager-ask.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const facts = ({ meta = {}, inst = {}, children = new Map() } = {}) => ({ startedBy: (n) => meta[n] || null, instanceOf: (n) => inst[n] || null, children });

test('who is the manager\'s: started by the manager, the sessions those start, and manager-children.jsonl when no starter was recorded', () => {
  const f = facts({ meta: { w: 'manager', grandchild: 'w', mm: 'mm-manager', agent: 'manager-agent', mine: 'owner', mineChild: 'mine' },
    inst: { h: { started_by: 'manager', start: 5 }, p: { started_by: 'cbsession', parent: 'h', start: 6 }, dash: { started_by: 'dashboard', start: 1e12 }, reused: { started_by: 'unknown', start: Date.parse('2026-11-26T00:00:00Z') } },
    children: childrenOf('{"session":"listed","by":"manager"}\n{"name":"dash","started":"2026-11-01T00:00Z"}\n{"name":"reused","started":"2026-10-01T00:00Z"}\nnot json\n{"id":"byid","at":"2026-11-11T20:51:08Z"}') });
  for (const n of ['w', 'grandchild', 'mm', 'agent', 'h', 'p', 'listed', 'byid']) assert.equal(isManagerStarted(n, f), true, n);
  // owner-started (dashboard, terminal, their own children), the manager itself, and a reused name with an old children line: not the manager's
  for (const n of ['mine', 'mineChild', 'dash', 'reused', 'nobody', 'manager', 'mm-manager', '']) assert.equal(isManagerStarted(n, f), false, n);
  assert.equal(isManagerStarted('a', facts({ meta: { a: 'b', b: 'a' } })), false, 'a loop ends');
});

test('history keeps a starter that is a session name as parent, and the CLI cbsession calls answers from the state dir', async () => {
  assert.equal(validateRecord({ kind: 'session.started', name: 'c', started_by: 'cbsession', parent: 'w', ts: 1 }).parent, 'w');
  assert.equal(fold([{ kind: 'session.started', name: 'c', started_by: 'unknown', ts: 1 }, { kind: 'session.started', name: 'c', started_by: 'cbsession', parent: 'w', ts: 2 }])[0].parent, 'w');
  const dir = tmp('mowned-');
  const h = createSessionHistory({ file: join(dir, 'session-history.jsonl') });
  await h.append({ kind: 'session.started', name: 'w', started_by: 'manager' });
  await h.append({ kind: 'session.started', name: 'c', started_by: 'cbsession', parent: 'w' });
  const owned = createManagerOwned({ stateDir: dir });
  assert.equal(owned('c'), true);
  const cli = (starter) => spawnSync(process.execPath, [join(ROOT, 'manager-owned.js'), starter], { env: { ...process.env, GHOSTY_STATE_DIR: dir }, encoding: 'utf8' });
  for (const s of ['manager', 'manager-agent', 'w', 'c']) { const r = cli(s); assert.equal(r.status, 0, s); assert.equal(r.stdout.trim(), MANAGER_RULE); }
  for (const s of ['cbsession', 'dashboard', 'owner-shell']) { const r = cli(s); assert.equal(r.status, 1, s); assert.equal(r.stdout, ''); }
});

test('harness texts: a manager-started session is told needs-manager, never to write needs-owner; owner-started texts are unchanged', () => {
  assert.match(MANAGER_RULE, /never end `STATUS: needs-owner`/);
  for (const msg of [reflectionQuestion, missingReplyMessage]) {
    assert.match(msg({ manager: true }), /STATUS: needs-manager: improvement suggestions above/);
    assert.doesNotMatch(msg({ manager: true }), /STATUS: needs-owner|OWNER answers/);
    assert.match(msg(), /STATUS: needs-owner: improvement suggestions above/);
  }
  assert.match(reflectionQuestion({ manager: true }), /MANAGER answers yes or no/);
  const open = openSuggestionsMessage([{ n: 1, text: 'x' }], { manager: true });
  assert.match(open, /no yes or no from the manager/); assert.doesNotMatch(open, /needs-owner|Only the owner/);
  assert.match(openSuggestionsMessage([{ n: 1, text: 'x' }]), /Only the owner answers/);
  assert.equal(isReflectionAsk('STATUS: needs-manager: improvement suggestions above, nothing built — should I do 1?'), true);
  // done-check and the rest go through one choke point
  const done = forManagerSession(leftoversMessage(['a']));
  assert.doesNotMatch(done, /STATUS: needs-owner/);
  assert.match(done, /STATUS: needs-manager.*read every "needs-owner" above as needs-manager/s);
  assert.equal(forManagerSession(done), done, 'applied once');
  assert.equal(forManagerSession('Continue.'), 'Continue.');
});

test('dashboard, app and voice: never the owner\'s turn for a manager-started session; the same row of an owner-started one still is', () => {
  const rows = {
    'needs-owner line': { state: 'done', stall: { id: 's1', case: 'owner_decision', status: 'needs-owner', question: 'May I publish it?', escalated: true }, triage: { state: 'done' } },
    'open suggestions': { state: 'done', suggestions: { state: 'open', open: 1, items: [{ n: 1, text: 'x' }] }, stall: { id: 's2', case: 'done', status: 'needs-manager', question: 'should I do 1?' } },
    'live prompt': { state: 'waiting', stall: { id: 's3', case: 'permission', question: 'Proceed?', escalated: true } },
  };
  for (const [what, row] of Object.entries(rows)) {
    const mine = { ...row, managerStarted: true };
    assert.equal(isOwnersTurn(row), true, `owner-started: ${what}`);
    assert.equal(isOwnersTurn(mine), false, what);
    assert.equal(displayState(mine), 'manager', what);
    assert.deepEqual(buildQueue({ s: mine }, {}, [{ name: 's' }]), [], what);
    assert.equal(stopItem('s', mine), null, what);
  }
  assert.equal(displayState(rows['open suggestions']), 'waiting');
  assert.equal(displayState({ state: 'working', managerStarted: true }), 'working');
});

test('suggestions: the manager\'s answer is recorded as the manager\'s; ready to close is claimed once, after an accepted done with nothing open', () => {
  const dir = tmp('mowned-s-'), seen = [];
  const s = createSuggestions({ stateDir: dir, onResolved: (n, how, info) => seen.push([n, how, info.done]) });
  s.observe('w', 'Suggestions:\n1. add a retry\n\nSTATUS: done — x');
  assert.equal(s.claimReadyToClose('w'), false, 'open');
  s.asked('w', 'STATUS: done — x');
  assert.equal(s.claimReadyToClose('w'), false, 'still open');
  assert.equal(s.ownerMessage('w', 'no all', { via: 'send', by: 'manager' }).open, 0);
  assert.equal(s.get('w').items[0].by, 'manager');
  assert.match(readFileSync(join(dir, 'suggestions.jsonl'), 'utf8'), /"by":"manager"/);
  assert.deepEqual(seen, [['w', 'answered', true]]);
  assert.equal(s.claimReadyToClose('w'), true);
  assert.equal(s.claimReadyToClose('w'), false, 'once');
  assert.equal(createSuggestions({ stateDir: dir }).claimReadyToClose('w'), false, 'once across a restart');
  // `no suggestions` after the question: ready; a list nobody asked about (no accepted done): not ready
  s.asked('q', 'STATUS: done — y');
  s.observe('q', 'no suggestions\n\nSTATUS: done — y, again', { at: Date.now() + 1000 });
  assert.equal(s.claimReadyToClose('q'), true);
  s.observe('r', 'Suggestions:\n1. z\n\nSTATUS: needs-manager: improvement suggestions above, nothing built — should I do 1?');
  s.ownerMessage('r', 'no all', { by: 'manager' });
  assert.equal(s.claimReadyToClose('r'), false, 'its done was never accepted');
  assert.equal(createSuggestions({ stateDir: tmp('mowned-o-') }).answer('none', {}).answered.length, 0);
});

const ASK = { question: 'Publish the package to the public registry now?', what: 'The session built the package. Option 1 publishes it. Option 2 leaves it unpublished.',
  options: ['1 publish it', '2 leave it unpublished'], recommend: '1', floor: 'history_rewrite', why: 'A publish cannot be taken back: the package would be public.' };

test('an owner-only item: the manager files it naming the source session, it stays open when that session moves on, and the session itself is refused', async () => {
  const owned = (n) => n === 'w';
  assert.deepEqual(ownerAskRoute(owned, { session: 'manager', source: 'w' }), { session: 'manager:w', source: 'w' });
  assert.deepEqual(ownerAskRoute(owned, { session: 'w' }), { session: 'manager:w', source: 'w' });
  assert.deepEqual(ownerAskRoute(owned, { session: 'mine', caller: 'mine' }), { session: 'mine', source: '' });
  assert.match(ownerAskRoute(owned, { session: 'x', caller: 'w' }).refuse, /needs-manager/);
  const dir = tmp('mowned-a-'), ledger = join(dir, 'manager-owner-asks.jsonl');
  const filed = await fileAsk(ledger, { ...ASK, ...ownerAskRoute(owned, { source: 'w' }), recommendation: '1' });
  assert.equal(filed.ok, true, filed.why);
  const [a] = await readOpenAsks(ledger);
  assert.deepEqual([a.session, a.source], ['manager:w', 'w']);
  assert.match(askSummary(a).what, /\(from session w\)$/);
  assert.deepEqual(await resolveMovedOn(ledger, 'w', { status: 'done', now: new Date(Date.now() + 60_000) }), []);
  assert.equal(unattachedAsks([a], { w: { state: 'done', managerStarted: true } }, [{ name: 'w' }]).length, 1);
  // the real CLI, from a state dir where the manager started `w`
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ w: { startedBy: 'manager' } }));
  const args = ['--session', 'w', '--question', 'Delete the old backup table?', '--what', 'An old backup table of the session.', '--options', '1 delete it|2 keep it', '--recommend', '1', '--floor', 'deleting_data', '--why', 'The table rows would be deleted for good.'];
  const run = (env) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'owner-ask.js'), 'ask', ...args], { env: { PATH: process.env.PATH, GHOSTY_STATE_DIR: dir, ...env }, encoding: 'utf8' });
  const own = run({ CBSESSION_PARENT: 'w' });
  assert.equal(own.status, 2); assert.match(own.stderr, /never ask the owner/);
  const mgr = run({});
  assert.equal(mgr.status, 0, mgr.stderr);
  assert.ok((await readOpenAsks(ledger)).some((x) => x.id === mgr.stdout.trim() && x.source === 'w' && x.session === 'manager:w'));
  assert.ok(existsSync(ledger));
});
