import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushOf, replyFor, optionsOf, floorOf } from '../owner-push.js';

// Closing texts below are the owner-pushed stops of 2026-10-27, host and account names replaced by fakes.

test('suggestions: done with its own proposal fires; the reply asks to implement and list what was skipped', () => {
  const t = [
    'My "about 4 players" ceiling therefore rests on one noisy run. To pin it down properly, I\'d add players one at a time and hold each for 60 s.',
    'It needs a lab-host-a lease and about 8 minutes, and I haven\'t started it.',
    'STATUS: done — load jump between 4 and 5 players is unexplained; a controlled 60 s-per-player run with memory and swap sampling would settle it',
  ].join('\n');
  const p = pushOf(t);
  assert.equal(p.kind, 'suggestions');
  assert.match(p.items[0], /I'd add players one at a time/);
  assert.match(replyFor(p), /^Implement your own proposals now: .*list what you skip and why/);
  const v = pushOf('**Suite rules at fault:**\n- The walk assumes BACK returns to the list.\nThe page also has these as proposals.\nSTATUS: done — verdict page published; fixes proposed on the page');
  assert.equal(v.kind, 'suggestions');
});

test('suggestions: a clean done, a listed "Left to do" (done-leftovers.js) and owner-only proposals do not fire', () => {
  assert.equal(pushOf('All 12 tests pass.\nSTATUS: done — merged and deployed'), null);
  assert.equal(pushOf('Left to do:\n1. web node builds\nI\'d add a cache later.\nSTATUS: done — open: web node builds'), null);
  // the team chip needs a key only the owner has: not a push
  assert.equal(pushOf('If you want, I can show the team chip once you put the admin api key in .env.\nSTATUS: done — chip live'), null);
  const mixed = pushOf("I'd add a retry on the walk. I'd also add a step that deletes the old recordings.\nSTATUS: done — walk fixed");
  assert.deepEqual(mixed.items, ["I'd add a retry on the walk."]);
  assert.match(mixed.skipped[0], /deletes.*\(owner: deletes\)/);
});

test('routine-ask: needs-manager menus answer the "yes" or recommended option unless it is on the floor', () => {
  const y = pushOf('STATUS: needs-manager: implement fixes 1–5 on the suite in my own worktree [1 yes, fixes 1+2 first / 2 hand the plan to the other session]');
  assert.deepEqual([y.kind, y.option], ['routine-ask', 1]);
  assert.match(replyFor(y), /^Yes, option 1: yes, fixes 1\+2 first\./);
  const r = pushOf('STATUS: needs-manager: lab-host-b can\'t load any web page in Chrome; options: 1 let me capture a Chrome net-log on lab-host-b (recommended), 2 drop the two boxes from the fleet');
  assert.equal(r.option, 1);   // "drop" sits in the option not taken
  const h = pushOf('STATUS: needs-manager: lab-web is on an old host build. Bring it to main with `update_core.sh main --hosts lab-web`? [1 yes, I can run it on a lease / 2 no, I keep waiting]');
  assert.equal(h.option, 1);
  // hardware, money, sideloading, a down box to bring back: the owner's
  assert.equal(pushOf('STATUS: needs-manager: the app cannot be installed; options: 1 provide a real TV box (recommended), 2 approve sideloading APKs, 3 close as blocked'), null);
  assert.equal(pushOf('STATUS: needs-manager: options: 1 buy four PCs (recommended), 2 use what we have'), null);
  assert.equal(pushOf('STATUS: needs-manager: lab-host-c is down. Options: 1 bring lab-host-c back (recommended), 2 give me another host'), null);
  // no recommendation and no "yes" first: a real choice
  assert.equal(pushOf('STATUS: needs-manager: which layout? [1 grid / 2 list]'), null);
});

test('routine-ask: a needs-owner menu is the owner\'s review; a needs-owner routine step still fires', () => {
  assert.equal(pushOf('STATUS: needs-owner: approve the rename table [1 yes all / 2 yes except the ones you mark / 3 change the convention]'), null);
  const t = [
    'Rollback: set THE_SWITCH=off in the service environment, or revert abc1234 through the lane.',
    'The dispatcher changes are merged in main (abc1234).',
    'STATUS: needs-owner: approve installing the new lease-service.js on the registry host and restarting the lease registry there (about 30 live leases)',
  ].join('\n');
  const p = pushOf(t);
  assert.equal(p.kind, 'routine-ask');
  assert.match(p.step, /merged code with a rollback line/);
  assert.match(replyFor(p), /^Yes, do it: approve installing/);
  // the same ask without a rollback line is not routine
  assert.equal(pushOf(t.split('\n').slice(1).join('\n')), null);
  assert.equal(pushOf('STATUS: needs-owner: may I apply the additive migration (CREATE TABLE ai_usage)?').kind, 'routine-ask');
  assert.equal(pushOf('STATUS: needs-owner: may I apply the migration that drops column x?'), null);
});

test('routine-ask: credentials, logins, SMS codes, sudoers, production and force-push never fire', () => {
  for (const ask of [
    'STATUS: needs-owner: sign a Google account into the emulator lab-tv so the apps can be installed',
    'STATUS: needs-owner: send the 6-digit SMS code just texted to the account',
    'STATUS: needs-owner: password for the shop account (save it, then say "saved")',
    'STATUS: needs-owner: restart the registry on the production host; rollback: revert, merged',
    'STATUS: needs-owner: add a sudoers line so the service restarts itself; merged, rollback: revert',
    'STATUS: needs-manager: options: 1 force-push the branch (recommended), 2 rebase',
    'STATUS: needs-manager: options: 1 delete the old reports (recommended), 2 keep them',
  ]) assert.equal(pushOf(ask), null, ask);
});

test('blocked-host: blocked on a locked or down host, or a long lease queue; a short wait does not fire', () => {
  const b = pushOf('STATUS: blocked: the smoke re-runs need a quiet web host. `lab-a` is locked by the scheduled game deployment and `lab-b` and `lab-c` are down.');
  assert.equal(b.kind, 'blocked-host');
  assert.match(replyFor(b), /vpt-lease list/);
  assert.equal(pushOf('FT-01..FT-10 on stb-a is queued with a 3300 s lease wait behind the other sweeps.\nSTATUS: waiting: run ft-1, task b7uf7, log /tmp/ft-1.log').kind, 'blocked-host');
  assert.equal(pushOf('The offline check is 89 of 89 green.\nSTATUS: waiting: run r-12, log /tmp/r.log'), null);
  assert.equal(pushOf('STATUS: waiting: integration int-abc'), null);
});

test('optionsOf and floorOf', () => {
  assert.deepEqual(optionsOf('go? [1 yes now (recommended) / 2 later]').opts.map((o) => [o.n, o.rec]), [[1, true], [2, false]]);
  assert.equal(optionsOf('no menu here'), null);
  assert.ok(floorOf('put the token in .env'));
  assert.equal(floorOf('rerun the content suite on a free host'), null);
});

// The watcher wiring (server.js passes this classify) and the feed record.
import { createLeftovers, pushableItems, IDLE_MS } from '../done-leftovers.js';
import { createManagerEvents, FILE_NAME } from '../manager-events.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const classify = (text) => {
  const items = pushableItems(text);
  if (items) return { kind: 'leftovers', items, title: 'done with leftovers' };
  const p = pushOf(text);
  return p && { kind: 'push', items: p.items, title: `push (${p.kind})`, pushKind: p.kind, reply: replyFor(p) };
};

test('watcher: a push stop emits one `<session>:push` event with pushKind and reply; leftovers keep their key', async () => {
  const events = [];
  const rows = [
    { name: 'a', text: "I'd add a retry on the walk. I'd also add a step that logs each retry.\nSTATUS: done — walk fixed", idleMs: IDLE_MS + 1 },
    { name: 'b', text: 'Left to do:\n- wire the retry counter\nSTATUS: done — merged', idleMs: IDLE_MS + 1 },
    { name: 'c', text: 'STATUS: needs-owner: password for the shop account', idleMs: IDLE_MS + 1 },
    { name: 'd', text: "I'd add a retry.\nSTATUS: done — x", idleMs: IDLE_MS + 1, draft: true },
  ];
  const w = createLeftovers({ listIdle: async () => rows, record: async (e) => { events.push(e); }, classify, log: { error() {} } });
  await w.tick(); await w.tick();
  assert.deepEqual(events.map((e) => e.key), ['a:push', 'b:leftovers']);
  assert.equal(events[0].pushKind, 'suggestions');
  assert.match(events[0].reply, /^Implement your own proposals now/);
  assert.equal(events[0].title, 'a: push (suggestions)');
  assert.equal(events[1].title, 'b: done with leftovers');
  assert.deepEqual(w.snapshot().found.map((f) => [f.name, f.kind, f.pushKind]), [['a', 'push', 'suggestions'], ['b', 'leftovers', undefined]].map(([n, k, p]) => [n, k, p]));
});

test('feed: push events pass with items, pushKind and reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-push-'));
  const ev = createManagerEvents({ stateDir: dir });
  assert.equal(await ev.record({ key: 'ft:push', title: 'ft: push (routine-ask)', body: 'x', items: ['x'], pushKind: 'routine-ask', reply: 'Yes, option 1: x.' }), true);
  const r = JSON.parse(readFileSync(join(dir, FILE_NAME), 'utf8').trim());
  assert.deepEqual([r.kind, r.session, r.pushKind, r.reply, r.items], ['push', 'ft', 'routine-ask', 'Yes, option 1: x.', ['x']]);
});

// bug-1f0455fc (2026-10-28): the two acknowledgements of the owner's script-rename freeze, sanitised. The detector filed
// push(suggestions) from "proposal, final names wait for the owner" and told the sessions to "Implement your own proposals now".
test('suggestions: a freeze acknowledgement never fires (deferred proposal, answers the freeze, no list)', () => {
  const a = [
    'Acknowledged: the script-rename freeze is in effect. I made no renames. My tree-naming table stays a proposal, final names wait for the owner.',
    'STATUS: done — freeze acknowledged; proposal, final names wait for the owner.',
  ].join('\n');
  const b = [
    'Stop message received. Nothing is renamed and nothing will be until the owner validates the convention; the review notes below are a proposal only.',
    'STATUS: done — holding all renames; proposal, final names wait for the owner.',
  ].join('\n');
  assert.equal(pushOf(a), null);
  assert.equal(pushOf(b), null);
});

test('suggestions: each guard alone holds, and real proposals still fire', () => {
  // deferred only: the single proposal is negated
  assert.equal(pushOf("I'd add the names table, but not until the owner has validated the convention.\nSTATUS: done — table drafted"), null);
  // freeze wording alone, even with two proposal sentences
  assert.equal(pushOf("The freeze is acknowledged. I'd add a cache. I'd also add a retry.\nSTATUS: done — x"), null);
  // one stray proposal phrase is not a list
  assert.equal(pushOf("I'd add a cache later.\nSTATUS: done — merged"), null);
  // a Suggestions heading is a list even with one item; two proposal sentences are a list
  assert.equal(pushOf('Suggestions: add a retry on the walk\nSTATUS: done — walk fixed').kind, 'suggestions');
  assert.equal(pushOf("I'd add a cache. I'd also add a retry.\nSTATUS: done — x").kind, 'suggestions');
});
