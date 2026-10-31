// Owner 2026-10-31 ("why so many questions"): a stop whose STATUS line waits on a deploy, a lease, an integration or an owner
// answer already in the ledger is a system wait, not an "asks you" alert, and the [hard: X] tag comes from the question asked,
// never from a word in a plan sentence. The example lines are the real ones from that day (host / device names neutral).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall, systemWaitOf, askHardOf } from '../stall.js';
import { opsAsk, systemWaitKind } from '../ops-ask.js';

const RULE = '─'.repeat(60);
const claude = (body) => ['⏺ Bash(npm test)', '  ⎿  5 passed', '', ...body.split('\n').map((l, i) => (i === 0 ? `⏺ ${l}` : `  ${l}`)), '', '✻ Baked for 1m', RULE, '❯ ', RULE];
const classify = (body) => classifyStall({ plain: claude(body), raw: null, state: 'done' });

const REAL = [
  ['STATUS: waiting 9s ... owner replug (the manager tells you) / deploy waiting - queue it (Phase 7)', 'publish'],
  ['STATUS: waiting: the <lab-host> lease is held by two queued host deploys; I resume when it frees, then the full walk and publish', 'publish'],
  ['STATUS: waiting: tree fixes - rerun S7 and web hosts once when the manager says the paid plan quota is back', 'paid'],
  ['STATUS: blocked: deploy dep-1a2b3c4 queued behind the host lease; then I publish the tree', 'publish'],
  ['STATUS: blocked: integration int-1a19289593f192eb5 running; after the merge I run sudo-free checks', 'sudo'],
  ['STATUS: blocked: lease L-42 on <lab-host> held by a run; next: publish the report', 'publish'],
];

test('the real "asks you" lines of 2026-10-31 are system waits: manager items, no hard tag', () => {
  for (const [line] of REAL) {
    const s = classify(`Phase 6 done, tests green.\n${line}`);
    assert.ok(s.systemWait, `${line} -> ${JSON.stringify(s.systemWait)}`);
    assert.equal(askHardOf(s), null, line);
    assert.ok(systemWaitKind(s), line);
  }
});

test('blocked on an owner answer is a system wait only when the ledger has that ask open', () => {
  const s = classify('Checked the adapter.\nSTATUS: blocked: owner answer to Q259 (the manager tells you)');
  assert.equal(s.systemWait, 'owner-answer');
  assert.equal(systemWaitKind(s), null, 'not in the ledger: a real blocker, it reaches someone');
  assert.equal(systemWaitKind({ ...s, ownerAskOpen: true }), 'deploy');
  // a waiting line on an owner answer is always a wait
  assert.equal(systemWaitKind(classify('Checked it.\nSTATUS: waiting: owner replug (the manager tells you)')), 'deploy');
});

test('real asks and real blockers are unchanged', () => {
  // a money block inside a wait is the owner's (task-135 step B): the blocker clause, not a plan sentence
  const credit = classify('Queued.\nSTATUS: waiting: deploy d-1 (full update_core main, background task t1); step B blocked on AI credit, provider balance $0.27 left, needs about $5');
  assert.equal(credit.systemWait, undefined);
  assert.equal(systemWaitKind(credit), null);
  assert.equal(systemWaitOf('blocked', 'the test token is exposed; it must be replaced by the owner'), null);
  assert.equal(systemWaitOf('blocked', 'should I deploy dep-1a2b3c4 now?'), null, 'a question is not a wait');
  assert.equal(systemWaitOf('needs-owner', 'deploy dep-1a2b3c4'), null);
  assert.equal(systemWaitOf('done', 'deploy dep-1a2b3c4 done'), null);
  const real = classify('The token in the test config is exposed.\nSTATUS: needs-owner: may I publish the package to the registry?');
  assert.equal(real.systemWait, undefined);
  assert.equal(askHardOf(real), 'publish', 'a hard word in the question itself still tags it');
  assert.equal(systemWaitKind(real), null);
});

test('the hard tag reads the question, not a plan sentence beside it', () => {
  const s = { case: 'owner_decision', status: 'needs-owner', question: 'After the walk I publish the tree. Shall I replug the IR dongle on <lab-host>?', topics: {} };
  assert.equal(askHardOf(s), null);
  assert.equal(askHardOf({ ...s, question: 'Shall I publish the package?' }), 'publish');
  const menu = { case: 'menu_recommended', question: 'Which one?', options: [{ n: 1, text: 'Leave it (recommended)', recommended: true }, { n: 2, text: 'force-push main' }] };
  assert.equal(askHardOf(menu), null, 'only the option being asked');
});

test('a needs-manager menu with a recommended option and no floor word still routes to the manager', () => {
  const s = classify('Two ways.\n1. Retry the walk (recommended)\n2. Skip it\nSTATUS: needs-manager: pick option 1 or 2');
  assert.equal(s.case, 'needs_manager');
  assert.equal(s.systemWait, undefined);
  assert.equal(opsAsk(s), 'lease');
});
