// OWNER_DECISIONS §19 end to end: today's real asks (sanitized fixtures) driven through the real stall path
// (manager.observe -> classify -> escalate), asserting where each one lands. Hosts, paths, ids and amounts are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(homedir(), 'ghosty-e2e-never-asked-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000', JEV_URL: '', JEV_API_KEY: '' });
const m = await import('../manager.js');
const pushes = [], items = [];
await m.initManager({ onOwnerNeeded: (s) => pushes.push(s), onManagerItem: (it) => items.push(it) });
await m.setManagerConfig({ aiTriage: 'off', routerShadow: false, wakeShadow: false, autoSend: false });

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const tick = (name, state, plain, now) => m.observe({ name, state, agent: 'claude', plain, raw: plain, changed: true, realWork: state === 'working', project: 'p', now });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => (existsSync(join(dir, 'stalls.jsonl')) ? readFileSync(join(dir, 'stalls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
async function stop(name, body) {
  tick(name, 'working', ['busy'], 0); tick(name, 'done', pane(body), 1000); tick(name, 'done', pane(body), 2500);
  const end = Date.now() + 4000;
  while (Date.now() < end) { const e = log().find((r) => r.type === 'escalated' && r.session === name); if (e) return e; await wait(25); }
  return null;
}
const landed = (name, e) => ({ target: e?.target || (e ? 'owner' : 'none'), pushed: pushes.includes(name), item: items.some((i) => i.session === name), escalatedTo: m.stallOf(name)?.escalatedTo });

// Fixtures are the real asks of 2026-10-19 with hosts, paths, ids and amounts replaced. "Real routing today" is what the stall log
// recorded before the round 12 finish; "expected" is OWNER_DECISIONS §19 plus the hard floor (REFERENCE "Autonomy by default").

test('case 1, task-135 step B "AI credit": a money block is a hard-floor ask, the owner is correct (top-up cannot be done by an agent)', async () => {
  // today: the session stayed `waiting` (deploy waiting) and the manager agent later put the top-up on the owner's desk by hand.
  // before this change the needs-owner form was routed to the manager only because "deploy" matched, hiding the money part.
  const a = await stop('credit', 'Step A is done.\nSTATUS: needs-owner: deploy d-1 (full update_core main) waits; step B is blocked on AI credit, provider balance $0.27 left, needs about $5 to top up. Top up?');
  assert.notEqual(a.target, 'manager', 'money must not be filed as a manager item');
  assert.ok(pushes.includes('credit'));
  assert.equal(m.stallOf('credit').escalatedTo, 'owner');
  // the deploy-waiting form carries the same money block: also the owner's, with the deploy itself still queued by the runner
  const b = await stop('creditWait', 'Queued.\nSTATUS: waiting: deploy d-1 (full update_core main, background task t1); step B blocked on AI credit, provider balance $0.27 left, needs about $5');
  assert.notEqual(b.target, 'manager');
  assert.equal(m.stallOf('creditWait').escalatedTo, 'owner');
  // control: the same deploy wait without the money block is a manager item
  const c = await stop('plainWait', 'Deploy d-1 queued (full update_core main).\nSTATUS: waiting: deploy d-1');
  assert.equal(c.target, 'manager'); assert.equal(c.kind, 'deploy');
  assert.ok(!pushes.includes('plainWait'));
});

test('case 2, theme-backgrounds "fix ... now?": asking leave to fix its own defect is a manager item, never an owner push', async () => {
  // today: the Mac session asked the owner directly (Mac sessions bypassed the harness); locally the same text went to the owner.
  const a = await stop('theme', 'Background images are live on env-a (merge abc1234, build main-1). The dark upload text is hard to read.\nSTATUS: needs-owner: fix dark-upload readability now?');
  assert.equal(a.target, 'manager'); assert.equal(a.kind, 'fix');
  assert.ok(!pushes.includes('theme'));
  assert.ok(items.some((i) => i.session === 'theme' && i.kind === 'fix'));
  assert.equal(m.stallOf('theme').escalatedTo, 'manager');
  // a fix question that touches the floor stays with the owner
  const b = await stop('themeHard', 'Done.\nSTATUS: needs-owner: fix the customer invoice template now?');
  assert.notEqual(b.target, 'manager');
});

test('case 3, TASK66 "git branch -D": deleting a branch ref is a deletion, a hard-floor item: the owner is correct', async () => {
  // today: owner (the stall was flagged "[hard: Removing]"); the floor now also matches `branch -D` itself.
  const a = await stop('del', 'The branch is local only.\nSTATUS: needs-owner: 12 unpushed commits sit on a local-only branch ref in <repo> — should I git branch -D fix/old-branch (commits recoverable via reflog)?');
  assert.notEqual(a.target, 'manager');
  assert.ok(pushes.includes('del'));
  assert.equal(m.stallOf('del').escalatedTo, 'owner');
});

test('a lease or deploy question never reaches the owner: lease, deploy and approval asks all land as manager items', async () => {
  const before = pushes.length;
  for (const [n, body] of [
    ['l1', 'STATUS: needs-owner: env-a/server is held by codebox:other, wait for the lease or take it? [1 wait 2 take]'],
    ['d1', 'STATUS: needs-owner: deploy main to env-a once the lease frees? [1 yes 2 wait]'],
    ['d2', 'STATUS: waiting: deploy d-7'],
  ]) { const e = await stop(n, `Ready.\n${body}`); assert.equal(e.target, 'manager', n); }
  assert.equal(pushes.length, before);
});
