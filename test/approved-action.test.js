// Round 9 item 2: the hard floor reads the approved action (option / question clause + its commands), not every word of the ask.
// Includes the round-8 manager probe sweep (m01-m26): every hard case still escalates, the two controls are still answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-approved-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000' });
delete process.env.JEV_URL; delete process.env.JEV_API_KEY;
const { approvedAction, isPastNarrative, classifyStall, forbiddenMatch } = await import('../stall.js');
const m = await import('../manager.js');
const { makeRepo, git } = await import('./helpers-git.js');

test('approvedAction: a specific option is the action; description narrative is not', () => {
  const closing = ['The skill differs from the installed copy.', '1. Sync the skill (recommended)', '   Copies the skill; overwrites its older SKILL.md in the target.', '2. Leave it'].join('\n');
  const options = [{ n: 1, text: 'Sync the skill (recommended)', recommended: true }, { n: 2, text: 'Leave it' }];
  const a = approvedAction({ closing, options, question: 'Which one?' });
  assert.equal(a.source, 'option');
  assert.equal(forbiddenMatch([a.text, ...a.commands].join('\n')), null);
});
test('approvedAction: the option text itself still counts, and so do its backticked / $ commands', () => {
  const options = [{ n: 1, text: 'Apply database migrations from the page (recommended)', recommended: true }];
  assert.ok(forbiddenMatch(approvedAction({ closing: '1. Apply database migrations from the page (recommended)', options }).text));
  const o2 = [{ n: 1, text: 'Clean up (recommended)', recommended: true }];
  const a = approvedAction({ closing: '1. Clean up (recommended)\n   runs `rm -rf build`\n   $ ls', options: o2 });
  assert.deepEqual(a.commands, ['rm -rf build', 'ls']);
  assert.ok(forbiddenMatch(a.commands.join('\n')));
});
test('approvedAction: a generic option inherits the question and the plan; a bare label too', () => {
  for (const text of ['Yes (Recommended)', 'Proceed', 'Yes, continue as planned (recommended)', 'A (recommended)']) {
    const options = [{ n: 1, text, recommended: true }];
    const a = approvedAction({ closing: `Plan: rm -rf build; then rebuild.\n1. ${text}`, options, question: 'Proceed as planned?' });
    assert.equal(a.source, 'option+question', text);
    assert.ok(forbiddenMatch(a.text), text);
  }
});
test('approvedAction: a named plan step is read', () => {
  const options = [{ n: 1, text: 'Step 2 (recommended)', recommended: true }];
  const a = approvedAction({ closing: 'Step 1: build.\nStep 2: wipe the cache directory.\n1. Step 2 (recommended)\n2. Step 1', options, question: 'Which?' });
  assert.ok(forbiddenMatch(a.text));
});
test('isPastNarrative: finished work only, plain spelling, destructive verbs only', () => {
  assert.equal(isPastNarrative('I removed the debug log earlier.'), true);
  assert.equal(isPastNarrative('The old script overwrote the cache yesterday.'), true);
  assert.equal(isPastNarrative('I deleted the stale branch already.'), true);
  assert.equal(isPastNarrative('The old backups will be deleted first.'), false);   // future / plan
  assert.equal(isPastNarrative('I removed the production data directory.'), false);   // no time marker
  assert.equal(isPastNarrative('The backups were d e l e t e d already.'), false);   // disguised spelling
  assert.equal(isPastNarrative('I paid the invoice already.'), false);                  // money is not narrative
  assert.equal(isPastNarrative('I deployed it earlier.'), false);
  assert.equal(isPastNarrative('Did I remove it earlier?'), false);
});

const plainOf = (body) => body.split('\n');
test('continue path: narrative no longer blocks, a stated plan still does', () => {
  const ok = classifyStall({ plain: plainOf('I removed the debug log earlier and the old script overwrote the cache yesterday.\nShall I continue?'), state: 'done' });
  assert.equal(ok.case, 'continue'); assert.equal(ok.forbidden, null);
  for (const body of ['Shall I continue? The old backups will be deleted first.', 'Plan: rm -rf build; then rebuild.\nProceed as planned? Shall I continue?', 'Shall I continue? The cleanup step removes the data directory.']) {
    const c = classifyStall({ plain: plainOf(body), state: 'done' });
    assert.ok(c.forbidden, body);
  }
});

// ---- manager level: the review's examples and the round-8 probe sweep ------------------------------------------------
const typedKeys = [], typed = [];
let snapshot = { ok: true, deploys: [], deployed: {}, envs: ['env-a', 'env-b'] };
await m.initManager({
  managerSessions: () => ['mgr'], onOwnerNeeded: () => {},
  sendKey: async (session, key) => { typedKeys.push({ session, key }); }, sendKeys: async (session, text) => { typed.push({ session, text }); },
  onMergeDecision: () => {}, policy: () => ({ action: 'allow', reason: 'ok' }), heldStore: { get: () => null, set: () => {} },
  decideContext: () => ({ deploys: snapshot, leases: { ok: true, leases: [], waiters: [] }, envs: snapshot.envs }),
  onDigest: () => {}, mergeJev: async () => ({ skipped: 'not configured' }),
});
await m.setManagerConfig({ aiTriage: 'off', routerShadow: false, wakeShadow: false, delayMs: 30, deployRunner: true });
const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { for (let t = 0; t < ms && !fn(); t += 20) await wait(20); };
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const stalls = () => lines(join(dir, 'stalls.jsonl'));
const esc = (name) => stalls().find((r) => r.type === 'escalated' && r.session === name);
function withOrigin() {
  const repo = makeRepo();
  const bare = join(mkdtempSync(join(tmpdir(), 'appr-origin-')), 'origin.git');
  git(repo, 'init', '-q', '--bare', bare); git(repo, 'remote', 'add', 'origin', bare); git(repo, 'push', '-q', 'origin', 'main', 'feat'); git(repo, 'fetch', '-q', 'origin');
  return repo;
}
function deployable() {
  const ok = withOrigin();
  snapshot = { ...snapshot, deployed: { 'env-a': { server: { ref: 'main', commit: git(ok, 'rev-list', '--max-parents=0', 'HEAD').trim() } } } };
  git(ok, 'checkout', '-q', 'main'); git(ok, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat'); git(ok, 'push', '-q', 'origin', 'main'); git(ok, 'checkout', '-q', 'feat');
  return ok;
}
async function stop(name, cwd, body, state = 'done') {
  const t = (st, p, now) => m.observe({ name, state: st, agent: 'claude', plain: p, raw: p, changed: true, realWork: st === 'working', project: 'p', cwd, now });
  const p = state === 'waiting' ? body.split('\n') : pane(body);
  t('working', ['busy'], 0); t(state, p, 1000); t(state, p, 2500);
  await until(() => stalls().some((r) => r.session === name && ['answer', 'escalated', 'answer_cancelled'].includes(r.type)));
  await wait(120);
  return { typed: typed.filter((x) => x.session === name).map((x) => x.text), keys: typedKeys.filter((x) => x.session === name).map((x) => x.key), esc: esc(name) };
}
const MENU_TAIL = ' Enter to select · ↑/↓ to navigate · Esc to cancel';
const GREEN = 'Tests: 1826/1826 pass on feat.';

test('review examples: description narrative is answered, the approved option naming migrations is escalated', async () => {
  const a = await stop('r1', makeRepo(), 'The skill differs from the installed copy.\nWhat next?\n ❯ 1. Sync the skill (recommended)\n      Copies the skill and overwrites its older SKILL.md.\n   2. Leave it\n' + MENU_TAIL, 'waiting');
  assert.deepEqual(a.keys, ['1']); assert.equal(a.esc, undefined);
  const b = await stop('r2', makeRepo(), 'What next?\n ❯ 1. Apply database migrations from the page (recommended)\n   2. Leave it\n' + MENU_TAIL, 'waiting');
  assert.deepEqual(b.keys, []); assert.ok(b.esc);
  const c = await stop('r3', makeRepo(), 'I removed the debug log earlier. The old script overwrote the cache yesterday.\nShall I continue?');
  assert.deepEqual(c.typed, ['Yes, continue.']); assert.equal(c.esc, undefined);
});

const sweep = [
  ['m01', 'done', () => withOrigin(), `${GREEN}\n\nShould I merge feat into main, push, deploy to env-a and delete the old backups?`],
  ['m02', 'done', () => makeRepo(), 'Shall I continue? The old backups will be deleted first.'],
  ['m03', 'done', () => withOrigin(), `${GREEN}\n\nShould the old data be deleted and feat be merged into main?`],
  ['m04', 'done', () => withOrigin(), `${GREEN}\n\nShall I push feat and rotate the API key in .env?`],
  ['m05', 'done', () => deployable(), `${GREEN}\n\nShould I deploy main to env-a? The invoice was paid already.`],
  ['m06', 'done', () => withOrigin(), `${GREEN}\n\nMerge feat into main and sudo systemctl restart nginx?`],
  ['m07', 'done', () => deployable(), `${GREEN}\n\nShould I run alembic upgrade head and then deploy main to env-a?`],
  ['m08', 'done', () => withOrigin(), `${GREEN}\n\nShall I push feat --force to fix the history and deploy?`],
  ['m09', 'done', () => withOrigin(), `${GREEN}\n\nShall I push the v1.2 tag and publish the package to npm?`],
  ['m10', 'done', () => withOrigin(), `${GREEN}\n\nShould I push origin HEAD: production-v2?`],
  ['m11', 'waiting', () => deployable(), `${GREEN}\n\nDeploy main to env-a?\n ❯ 1. Yes, and drop the old table (Recommended)\n   2. No\n${MENU_TAIL}`],
  ['m12', 'waiting', () => makeRepo(), `The customer e-mail is drafted. Send how?\n ❯ 1. Proceed (Recommended)\n   2. Wait\n${MENU_TAIL}`],
  ['m13', 'done', () => makeRepo(), 'I removed the production data directory. Next?\n1. Continue as planned (Recommended)\n2. Stop\n\nShould I go with option 1?'],
  ['m14', 'done', () => makeRepo(), 'Shall I continue? The script deletes the old backups first.'],
  ['m15', 'done', () => withOrigin(), `${GREEN}\n\nShall I continue and reboot the host after merging feat into main?`],
  ['m16', 'done', () => withOrigin(), `${GREEN}\n\nShould I merge feat into main? Note: the customer's data was wiped by the migration.`],
  ['m17', 'done', () => withOrigin(), `${GREEN}\n\nShould I merge feat into main? The backups were d e l e t e d already.`],
  ['m18', 'done', () => makeRepo(), 'Shall I continue? The old backups were dele­ted first.'],
  ['m19', 'done', () => withOrigin(), `${GREEN}\n\nShall I push feat? Also the token was revoked and I paid the invoice.`],
  ['m20', 'done', () => makeRepo(), 'Shall I continue? The old backups will be erased first.'],
  ['m21', 'done', () => makeRepo(), 'Shall I continue? Removal of the old backups comes first.'],
  ['m22', 'done', () => makeRepo(), 'Shall I continue? The cleanup step removes the data directory.'],
  ['m23', 'waiting', () => withOrigin(), `${GREEN}\n\nWhat next?\n ❯ 1. Push feat and git push --tags (Recommended)\n   2. Wait\n${MENU_TAIL}`],
  ['m24', 'done', () => withOrigin(), `${GREEN}\n\nShould I merge feat into main and then push origin feat:main?`],
];
test('round-8 probe sweep m01-m24: every hard case still reaches the owner', async () => {
  for (const [name, state, repoOf, body] of sweep) {
    const r = await stop(name, repoOf(), body, state);
    assert.ok(r.esc, `${name} must still escalate`);
    assert.deepEqual(r.keys, [], `${name} must not take the menu`);
  }
});
test('round-8 probe sweep controls: m25 takes the menu, m26 is answered', async () => {
  const a = await stop('m25', deployable(), `${GREEN}\n\nDeploy main to env-a?\n ❯ 1. Yes (Recommended)\n   2. No\n${MENU_TAIL}`, 'waiting');
  assert.deepEqual(a.keys, ['1']); assert.equal(a.esc, undefined);
  const b = await stop('m26', withOrigin(), `${GREEN}\n\nShould I merge feat into main and push?`);
  assert.ok(b.typed.length === 1 && /^Merge: yes/.test(b.typed[0])); assert.equal(b.esc, undefined);
});

// ---- round 9 item 3: unmarked menus ------------------------------------------------------------------------------------
test('unmarked menu: option 1 is taken (key), journaled as unmarked; a hard or way-out first option goes to the owner', async () => {
  const a = await stop('u1', makeRepo(), 'Which page layout?\n ❯ 1. Use the compact layout for the settings page\n   2. Use the wide layout\n' + MENU_TAIL, 'waiting');
  assert.deepEqual(a.keys, ['1']); assert.equal(a.esc, undefined);
  const j = lines(join(dir, 'manager-decisions.jsonl')).find((r) => r.kind === 'menu' && r.session === 'u1');
  assert.equal(j.unmarked, true); assert.match(j.rationale, /no option as recommended/);
  const { decidedItems } = await import('../decided.js');
  const items = decidedItems({ recs: stalls(), journal: lines(join(dir, 'manager-decisions.jsonl')) });
  const it = items.find((i) => i.session === 'u1');
  assert.equal(it.productVisible, true); assert.match(it.what, /unmarked first option/);
  for (const [n, first] of [['u2', 'Skip the migration step'], ['u3', 'Delete the old backups'], ['u4', 'Apply database migrations']]) {
    const r = await stop(n, makeRepo(), `Which one?\n ❯ 1. ${first}\n   2. Use the wide layout\n` + MENU_TAIL, 'waiting');
    assert.deepEqual(r.keys, [], n); assert.ok(r.esc, n);
  }
  const b = await stop('u5', makeRepo(), 'Two ways to name it.\n1. Call it the sync helper\n2. Call it the copier\nWhich do you prefer?');
  assert.deepEqual(b.typed, ['Go with option 1.']);
});
