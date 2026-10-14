// Round 8 (OWNER_DECISIONS §15): autonomy by default. One decision step for merge / push / deploy, "do the recommended option"
// by default, the autonomy migration of a saved manager.json, and the decided-for-you journal the decisions feed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ghosty-autonomy-'));
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000' });
delete process.env.JEV_URL; delete process.env.JEV_API_KEY;
const m = await import('../manager.js');
const { validateDecision } = await import('../orchestration/task-contract.js');
const { makeRepo, git } = await import('./helpers-git.js');
const { decidedItems } = await import('../decided.js');

const digests = [];
const typedKeys = [], typed = [], owner = [], notices = [];
let snapshot = { ok: true, deploys: [], deployed: {}, envs: ['env-a', 'env-b'] };
let leases = { ok: true, leases: [], waiters: [] };
const fresh = m.managerConfig();   // before any config call: the defaults of a fresh install
await m.initManager({
  managerSessions: () => ['mgr'],
  onOwnerNeeded: (session, stall, reason, state) => owner.push({ session, reason, stall, state }),
  sendKey: async (session, key) => { typedKeys.push({ session, key }); }, sendKeys: async (session, text) => { typed.push({ session, text }); },
  onMergeDecision: (session, rec) => notices.push({ session, rec }),
  policy: () => ({ action: 'allow', reason: 'ok' }), heldStore: { get: () => null, set: () => {} },
  decideContext: () => ({ deploys: snapshot, leases, envs: snapshot.envs }),
  onDigest: (d) => digests.push(d),
  mergeJev: async () => ({ skipped: 'not configured' }),
});
const cfg = (o = {}) => m.setManagerConfig({ aiTriage: 'off', routerShadow: false, wakeShadow: false, delayMs: 30, deployRunner: true, ...o });
await cfg();

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { for (let t = 0; t < ms && !fn(); t += 20) await wait(20); };
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const stalls = () => lines(join(dir, 'stalls.jsonl'));
const journal = () => lines(join(dir, 'manager-decisions.jsonl'));
const esc = (name) => stalls().find((r) => r.type === 'escalated' && r.session === name);   // a live menu is already shown to the owner by ghosty's waiting alert: the escalation is logged
const GREEN = 'Tests: 1826/1826 pass on feat.';
function withOrigin(opts = {}) {
  const repo = makeRepo(opts);
  const bare = join(mkdtempSync(join(tmpdir(), 'auto-origin-')), 'origin.git');
  git(repo, 'init', '-q', '--bare', bare); git(repo, 'remote', 'add', 'origin', bare); git(repo, 'push', '-q', 'origin', 'main', 'feat'); git(repo, 'fetch', '-q', 'origin');
  return repo;
}
async function stop(name, cwd, body, { state = 'done' } = {}) {
  const t = (st, p, now) => m.observe({ name, state: st, agent: 'claude', plain: p, raw: p, changed: true, realWork: st === 'working', project: 'p', cwd, now });
  const p = state === 'waiting' ? body.split('\n') : pane(body);
  t('working', ['busy'], 0); t(state, p, 1000); t(state, p, 2500);
  await until(() => stalls().some((r) => r.session === name && ['answer', 'escalated', 'answer_cancelled'].includes(r.type)));
}

test('defaults of a fresh install: autoSend on, autoCases continue + menu_recommended, push / deploy decisions on, autonomyVersion 1', () => {
  assert.equal(fresh.autoSend, true);
  assert.deepEqual(fresh.autoCases, ['continue', 'menu_recommended']);
  assert.equal(fresh.pushDecisions, true); assert.equal(fresh.deployDecisions, true);
  assert.equal(fresh.pushMinConfidence, 0.85); assert.equal(fresh.deployMinConfidence, 0.85);
  assert.equal(fresh.autonomyVersion, 1); assert.equal(fresh.decidedDigestHour, 18);
});

const probe = (saved) => {
  const d = mkdtempSync(join(tmpdir(), 'ghosty-mig-'));
  if (saved) writeFileSync(join(d, 'manager.json'), JSON.stringify(saved));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(new URL('../manager.js', import.meta.url).href)}); await m.initManager({}); console.log(JSON.stringify(m.managerConfig()));`],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', GHOSTY_STATE_DIR: d }, encoding: 'utf8' });
  return { cfg: JSON.parse(out.trim().split('\n').pop()), file: JSON.parse(readFileSync(join(d, 'manager.json'), 'utf8')) };
};
test('migration: a saved manager.json without autonomyVersion gains menu_recommended and the decisions once; autoSend false stays false', () => {
  const { cfg: c, file } = probe({ autoSend: false, autoCases: ['continue'], delayMs: 5000 });
  assert.deepEqual(c.autoCases, ['continue', 'menu_recommended']);
  assert.equal(c.autoSend, false); assert.equal(c.delayMs, 5000);
  assert.equal(c.pushDecisions, true); assert.equal(c.deployDecisions, true); assert.equal(c.autonomyVersion, 1);
  assert.equal(file.autonomyVersion, 1); assert.deepEqual(file.autoCases, ['continue', 'menu_recommended']);   // written back
  const keep = probe({ autoSend: true, autoCases: [], pushDecisions: false });
  assert.equal(keep.cfg.pushDecisions, false, 'a saved choice wins'); assert.equal(keep.cfg.deployDecisions, true);
});
test('migration: with autonomyVersion 1 saved, an owner who removed menu_recommended is not given it back', () => {
  const { cfg: c } = probe({ autoSend: true, autoCases: ['continue'], autonomyVersion: 1, pushDecisions: false, deployDecisions: false });
  assert.deepEqual(c.autoCases, ['continue']);
  assert.equal(c.pushDecisions, false); assert.equal(c.deployDecisions, false);
});

test('mixed: "merge, push and deploy to env-a?" all pass -> one reply with three parts and three journal records', async () => {
  const repo = withOrigin();
  await stop('mx1', repo, `${GREEN}\n\nShould I merge feat into main, push and deploy to env-a?`);
  await until(() => typed.some((x) => x.session === 'mx1'));
  const t = typed.find((x) => x.session === 'mx1').text;
  assert.match(t, /^Merge: yes - .*Merge it now\. Push: yes - proj main -> origin\/main: .*Push it now\. Deploy: yes - env-a full main@[0-9a-f]{12}: .*Request it through the deploy queue/);
  assert.match(t, /Rollback: the previous release is unknown for env-a \(full\): ask the owner before deploying anything else\.$/);
  assert.ok(!owner.some((o) => o.session === 'mx1'), 'nothing left for the owner');
  const j = journal().filter((r) => r.session === 'mx1');
  assert.deepEqual(j.map((r) => r.kind).sort(), ['deploy', 'merge', 'push']);
  for (const r of j) assert.deepEqual(validateDecision(r).errors, [], r.kind);
  const ans = stalls().find((r) => r.type === 'answer' && r.session === 'mx1');
  assert.deepEqual(ans.decided, ['merge', 'push', 'deploy']);
  assert.equal(ans.decision_ids.length, 3);
  const items = decidedItems({ recs: stalls(), journal: journal() }).filter((i) => i.session === 'mx1');
  assert.deepEqual(items.map((i) => i.kind).sort(), ['deploy', 'merge', 'push']);
});

test('mixed: "merge and delete the old branch?" -> the merge is answered, the delete goes to the owner', async () => {
  const repo = withOrigin();
  await stop('mx2', repo, `${GREEN}\n\nShould I merge feat into main and delete the old branch?`);
  await until(() => typed.some((x) => x.session === 'mx2'));
  const t = typed.find((x) => x.session === 'mx2').text;
  assert.match(t, /^Merge: yes/); assert.match(t, /rest of your question went to the owner/); assert.doesNotMatch(t, /delet/i);
  const e = owner.find((o) => o.session === 'mx2');
  assert.match(e.reason, /delete question/); assert.match(e.reason, /merge answered by the manager/);
});

test('deploy leased by another agent: the push is answered, the deploy escalated with the lease holder', async () => {
  leases = { ok: true, leases: [{ id: 'l1', env: 'env-a', resource: '*', agent: 'codebox:other', kind: 'server' }], waiters: [] };
  const repo = withOrigin(); git(repo, 'commit', '-q', '--allow-empty', '-m', 'more');
  await stop('dl1', repo, `${GREEN}\n\nShall I push feat and deploy it to env-a?`);
  await until(() => typed.some((x) => x.session === 'dl1'));
  assert.match(typed.find((x) => x.session === 'dl1').text, /^Push: yes - proj feat -> origin\/feat/);
  assert.match(owner.find((o) => o.session === 'dl1').reason, /deploy not decided: env-a leased by codebox:other \(\*\)/);
  leases = { ok: true, leases: [], waiters: [] };
});

test('pushDecisions / deployDecisions off: the topic goes to the owner', async () => {
  await cfg({ pushDecisions: false });
  const repo = withOrigin(); git(repo, 'commit', '-q', '--allow-empty', '-m', 'more');
  const n = typed.length;
  await stop('off1', repo, `${GREEN}\n\nShall I push feat?`);
  await wait(200);
  assert.equal(typed.length, n);
  assert.ok(owner.some((o) => o.session === 'off1'));
  await cfg({ pushDecisions: true });
});

// ---- "do the recommended option" ----
const MENU_TAIL = ' Enter to select · ↑/↓ to navigate · Esc to cancel';
test('menu_recommended is an auto case by default: a live menu is answered with the key only', async () => {
  await stop('mn1', makeRepo(), `How should I proceed?\n ❯ 1. Keep going\n   2. Stop and report (Recommended)\n   3. Ask later\n${MENU_TAIL}`.replace('❯ 1.', '  1.').replace('   2.', ' ❯ 2.'), { state: 'waiting' });
  await until(() => typedKeys.some((x) => x.session === 'mn1'));
  assert.deepEqual(typedKeys.filter((x) => x.session === 'mn1'), [{ session: 'mn1', key: '2' }]);
  assert.ok(!typed.some((x) => x.session === 'mn1'), 'no free text into a live menu');
});

test('menu: other options may mention anything; only the recommended option decides', async () => {
  await stop('mn2', makeRepo(), `Clean up how?\n ❯ 1. Keep the old branch (Recommended)\n   2. Delete the old branch and wipe the cache\n${MENU_TAIL}`, { state: 'waiting' });
  await until(() => typedKeys.some((x) => x.session === 'mn2'));
  assert.deepEqual(typedKeys.filter((x) => x.session === 'mn2'), [{ session: 'mn2', key: '1' }]);
});

test('menu: a recommended option that deletes is escalated, never taken', async () => {
  const n = typedKeys.length;
  await stop('mn3', makeRepo(), `Clean up how?\n ❯ 1. Delete the old branch (Recommended)\n   2. Keep it\n${MENU_TAIL}`, { state: 'waiting' });
  await wait(200);
  assert.equal(typedKeys.length, n);
  assert.match(esc('mn3').reason, /delete/i);
  await stop('mn4', makeRepo(), `Send how?\n ❯ 1. Publish the package (Recommended)\n   2. Keep it\n${MENU_TAIL}`, { state: 'waiting' });
  await wait(200);
  assert.equal(typedKeys.length, n);
});

test('menu: a recommended option that touches a deploy is evaluated first (pass -> key; fail -> escalate with the reason)', async () => {
  const repo = withOrigin();
  const n = typedKeys.length;
  await stop('mn5', repo, `${GREEN}\n\nWhat next?\n ❯ 1. Deploy feat to env-a (Recommended)\n   2. Wait\n${MENU_TAIL}`, { state: 'waiting' });
  await until(() => typedKeys.length > n || esc('mn5'));
  // nothing merged feat yet and no green report on main: tests are green on feat only -> the deploy needs the branch merged
  assert.equal(typedKeys.length, n);
  assert.match(esc('mn5').reason, /deploy not decided/);
  // feat merged into main: green on feat counts; the live menu is answered by the key only
  const ok = withOrigin();
  snapshot = { ...snapshot, deployed: { 'env-a': { server: { ref: 'main', commit: git(ok, 'rev-list', '--max-parents=0', 'HEAD').trim() } } } };   // the migration check needs a deployed commit
  git(ok, 'checkout', '-q', 'main'); git(ok, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat'); git(ok, 'push', '-q', 'origin', 'main'); git(ok, 'checkout', '-q', 'feat');
  await stop('mn6', ok, `${GREEN}\n\nWhat next?\n ❯ 1. Deploy main to env-a (Recommended)\n   2. Wait\n${MENU_TAIL}`, { state: 'waiting' });
  await until(() => typedKeys.some((x) => x.session === 'mn6'));
  assert.deepEqual(typedKeys.filter((x) => x.session === 'mn6'), [{ session: 'mn6', key: '1' }]);
  const rec = journal().find((r) => r.session === 'mn6' && r.kind === 'deploy');
  assert.equal(rec.chosen, 'deploy'); assert.match(rec.evidence[0], /tests green on feat, which is merged into main/);
  assert.deepEqual(validateDecision(rec).errors, []);
  // the same recommendation on a finished turn: free text, with the journal record
  const fin = withOrigin();
  snapshot = { ...snapshot, deployed: { 'env-a': { server: { ref: 'main', commit: git(fin, 'rev-list', '--max-parents=0', 'HEAD').trim() } } } };
  git(fin, 'checkout', '-q', 'main'); git(fin, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat'); git(fin, 'push', '-q', 'origin', 'main'); git(fin, 'checkout', '-q', 'feat');
  await stop('mn8', fin, `${GREEN}\n\nWhat next?\n1. Deploy main to env-a (Recommended)\n2. Wait\n\nShould I go with option 1?`);
  await until(() => typed.some((x) => x.session === 'mn8'));
  assert.equal(typed.find((x) => x.session === 'mn8').text, 'Yes, go with your recommendation.');
  assert.ok(journal().some((r) => r.session === 'mn8' && r.kind === 'deploy' && r.chosen === 'deploy'));
});

test('menu: a finished-turn question with a recommended option gets "Yes, go with your recommendation."', async () => {
  await stop('mn7', makeRepo(), 'Which way?\n1. Add the retry (Recommended)\n2. Skip it\n\nShould I go with option 1?');
  await until(() => typed.some((x) => x.session === 'mn7'));
  assert.equal(typed.find((x) => x.session === 'mn7').text, 'Yes, go with your recommendation.');
});

test('journal: manager-decisions.jsonl is the journal; the round-7 file is still read; the merge alias filters kind merge', async () => {
  writeFileSync(join(dir, 'merge-decisions.jsonl'), JSON.stringify({ decision_id: 'merge-old1', kind: 'merge', chosen: 'merge', session: 'old', branch: 'x', target: 'main', ts: new Date().toISOString() }) + '\n');
  const all = await m.readJournal();
  assert.ok(all.some((r) => r.decision_id === 'merge-old1'));
  assert.ok(all.some((r) => r.kind === 'push') && all.some((r) => r.kind === 'deploy'));
  assert.ok(all.filter((r) => r.kind === 'merge').every((r) => r.kind === 'merge'));
});

test('daily digest: once a day at decidedDigestHour, only when something was decided, with the summary and the day', async () => {
  const c = await m.setManagerConfig({ decidedDigestHour: 0 });
  assert.equal(c.decidedDigestHour, 0);
  await assert.rejects(m.setManagerConfig({ decidedDigestHour: 24 }), /decidedDigestHour/);
  const now = Date.now();
  assert.equal(await m.decidedDigestTick({ now }), true);
  assert.equal(digests.length, 1);
  assert.match(digests[0].day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(digests[0].count >= 3);
  assert.match(digests[0].text, /^In the last 24 hours the manager decided \d+ things for you: .*\. Nothing failed\.$/);
  assert.equal(await m.decidedDigestTick({ now: now + 60e3 }), false, 'already sent today');
  assert.equal(digests.length, 1);
  // the next day: only with something decided in its window
  const later = now + 25 * 3600e3;
  assert.equal(await m.decidedDigestTick({ now: later }), false, 'nothing decided in the 24 h before');
  require_append(join(dir, 'stalls.jsonl'), { type: 'answer', id: 'future1', session: 'zz', at: new Date(later - 3600e3).toISOString(), answer: { text: 'Yes, continue.' }, case: 'continue', source: 'rule' });
  assert.equal(await m.decidedDigestTick({ now: later + 120e3 }), false, 'the day was already marked (an empty day counts)');
  const next = later + 25 * 3600e3;
  require_append(join(dir, 'stalls.jsonl'), { type: 'answer', id: 'future2', session: 'zz', at: new Date(next - 3600e3).toISOString(), answer: { text: 'Yes, continue.' }, case: 'continue', source: 'rule' });
  assert.equal(await m.decidedDigestTick({ now: next }), true);
  assert.equal(digests.length, 2);
  assert.equal(digests[1].count, 1);
});
function require_append(f, rec) { writeFileSync(f, readFileSync(f, 'utf8') + JSON.stringify(rec) + '\n'); }

test('decidedView: { items, summary } newest first; hours / since / limit', async () => {
  const v = await m.decidedView({ hours: 24, limit: 100 });
  assert.ok(Array.isArray(v.items) && v.items.length >= 3);
  assert.deepEqual(Object.keys(v), ['items', 'summary']);
  assert.deepEqual(Object.keys(v.summary), ['count', 'byKind', 'text']);
  for (let i = 1; i < v.items.length; i++) assert.ok(Date.parse(v.items[i - 1].at) >= Date.parse(v.items[i].at));
  assert.equal((await m.decidedView({ hours: 24, limit: 2 })).items.length, 2);
  assert.equal((await m.decidedView({ since: new Date(Date.now() + 200 * 3600e3).toISOString() })).items.length, 0);
  await assert.rejects(m.decidedView({ since: 'nope' }), /since/);
  const item = await m.decidedItem(v.items.find((i) => i.kind === 'merge').id);
  assert.equal(item.kind, 'merge');
});

// ---- round 8 review fixes ----
test('R8-1 BLOCKER: a hard topic in the question stem or in the recommended option is never answered, whatever the generic option says', async () => {
  const cases = [
    ['bl1', 'Drop the production customer table now?\n ❯ 1. Yes (Recommended)\n   2. No\n' + MENU_TAIL, 'waiting'],
    ['bl2', 'Drop the production table users_old now?\n ❯ 1. Yes, go ahead (Recommended)\n   2. No\n' + MENU_TAIL, 'waiting'],
    ['bl3', 'Should I delete the production customer database now?\n1. Yes (recommended)\n2. No', 'done'],
    ['bl4', 'I can rotate the API key and update .env on the host.\n1. Do it now (Recommended)\n2. Skip it\n\nShall I go with option 1?', 'done'],
    ['bl5', 'Plan: rm -rf the data directory, then rebuild.\n1. Proceed as planned (Recommended)\n2. Stop\n\nShall I go with option 1?', 'done'],
    ['bl6', 'Send the e-mail to the customer now?\n1. Send it (Recommended)\n2. Hold', 'done'],
    ['bl7', 'Pay the invoice with the card on file?\n1. Yes (Recommended)\n2. No', 'done'],
  ];
  const keys0 = typedKeys.length, text0 = typed.length;
  for (const [name, body, state] of cases) {
    await stop(name, makeRepo(), body, { state });
    await wait(150);
    assert.ok(!typedKeys.some((x) => x.session === name), `${name}: no key`);
    assert.ok(!typed.some((x) => x.session === name), `${name}: no free text`);
    assert.ok(esc(name) || owner.some((o) => o.session === name), `${name}: escalated`);
  }
  assert.equal(typedKeys.length, keys0); assert.equal(typed.length, text0);
});

test('R8-1: a generic recommended option inherits the question\'s topic: a decided deploy question is evaluated, not waved through', async () => {
  const repo = withOrigin();   // feat not merged, no deployed commit: the deploy evaluation escalates, and nothing is typed
  const n = typedKeys.length;
  await stop('bl8', repo, `${GREEN}\n\nShall I deploy feat to env-a?\n ❯ 1. Yes (Recommended)\n   2. No\n${MENU_TAIL}`, { state: 'waiting' });
  await until(() => journal().some((r) => r.session === 'bl8' && r.kind === 'deploy'));
  assert.equal(typedKeys.length, n);
  assert.match(esc('bl8').reason, /deploy not decided/);
});

test('R8-2: a noun mention is not a request (no Deploy reply, no push evaluation)', async () => {
  const n = typed.length;
  await stop('nn1', withOrigin(), 'Should the deploy queue page also show the env-a name?');
  await stop('nn2', withOrigin(), 'Should I add push notifications to the settings page?');
  await wait(150);
  assert.equal(typed.length, n);
  assert.ok(!stalls().some((r) => /_decision$/.test(r.type) && ['nn1', 'nn2'].includes(r.session)), 'neither was evaluated as a deploy or a push');
});

test('R8-11: a decided menu pick is re-checked at fire time against the switches', async () => {
  await cfg({ delayMs: 1500 });
  const ok = withOrigin();
  snapshot = { ...snapshot, deployed: { 'env-a': { server: { ref: 'main', commit: git(ok, 'rev-list', '--max-parents=0', 'HEAD').trim() } } } };
  git(ok, 'checkout', '-q', 'main'); git(ok, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat'); git(ok, 'push', '-q', 'origin', 'main'); git(ok, 'checkout', '-q', 'feat');
  const n = typedKeys.length;
  m.observe({ name: 'fz1', state: 'working', agent: 'claude', plain: ['busy'], raw: ['busy'], changed: true, realWork: true, project: 'p', cwd: ok, now: 0 });
  const p = `${GREEN}\n\nWhat next?\n ❯ 1. Deploy main to env-a (Recommended)\n   2. Wait\n${MENU_TAIL}`.split('\n');
  m.observe({ name: 'fz1', state: 'waiting', agent: 'claude', plain: p, raw: p, changed: true, realWork: false, project: 'p', cwd: ok, now: 1000 });
  m.observe({ name: 'fz1', state: 'waiting', agent: 'claude', plain: p, raw: p, changed: true, realWork: false, project: 'p', cwd: ok, now: 2500 });
  await until(() => m.autoOf('fz1'));
  assert.ok(m.autoOf('fz1'), 'the pick is pending');
  await m.setManagerConfig({ deployDecisions: false });
  await wait(1700);
  assert.equal(typedKeys.length, n);
  assert.match(stalls().find((r) => r.type === 'answer_cancelled' && r.session === 'fz1').reason, /deploy decisions are off/);
  await cfg({ delayMs: 30, deployDecisions: true });
});

test('R8-18: a menu pick is journaled with kind "menu" and shows in Decided for you with its reason', async () => {
  const rec = journal().find((r) => r.session === 'mn1' && r.kind === 'menu');
  assert.ok(rec, 'menu record');
  assert.deepEqual(validateDecision(rec).errors, []);
  assert.equal(rec.decision_id.startsWith('menu-'), true); assert.equal(rec.key, 2);
  const item = decidedItems({ recs: stalls(), journal: journal() }).find((i) => i.session === 'mn1');
  assert.equal(item.kind, 'menu'); assert.match(item.what, /took the recommended option 2/); assert.match(item.why, /marked .* as its recommendation/);
});

test('R8-17: an unreadable manager.json fails closed (auto-answer off for the run); the migration records one notice', () => {
  const run = (saved, raw) => {
    const d = mkdtempSync(join(tmpdir(), 'ghosty-mig2-'));
    if (raw != null) writeFileSync(join(d, 'manager.json'), raw); else if (saved) writeFileSync(join(d, 'manager.json'), JSON.stringify(saved));
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(new URL('../manager.js', import.meta.url).href)}); const n = []; await m.initManager({ onNotice: (t) => n.push(t) }); console.log(JSON.stringify({ autoSend: m.managerConfig().autoSend, n }));`],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', GHOSTY_STATE_DIR: d }, encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
  };
  assert.equal(run(null, '{ not json').autoSend, false, 'unreadable file: fail closed');
  assert.deepEqual(run(null, null), { autoSend: true, n: [] }, 'fresh install: defaults, no notice');
  const mig = run({ autoSend: true, autoCases: ['continue'] });
  assert.equal(mig.n.length, 1); assert.equal(mig.n[0], 'Autonomy on (round 8): auto-answer, recommended option, merge/push/deploy decisions; switches in the manager sheet');
  assert.equal(run({ autoSend: true, autonomyVersion: 1 }).n.length, 0, 'once');
});

test('R8-9/16: the revert path is guarded and the digest day is marked after the view is read (source wiring)', () => {
  const srv = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(srv, /revertedIds\(\)\)\.has\(id\)/);
  assert.match(srv, /await assertAgentPane\(item\.session, by\)/);
  assert.match(srv, /logSend\(item\.session, by, \{ keys: plan\.send \}\)/);
  assert.match(srv, /onDigest: \(\{ count, text \}\) => \{[\s\S]*?push\.record\(item\); else push\.notify\(item\)/);
  assert.doesNotMatch(srv, /alert\(`decided:digest/);
  const mgr = readFileSync(new URL('../manager.js', import.meta.url), 'utf8');
  assert.match(mgr, /v = await decidedView\([\s\S]*?writeFile\(DIGEST_FILE/);
});

// ---- round 8, third fix round ----
test('R8-r3-1 BLOCKER: a hard sentence far above the menu (beyond any pane window) still escalates the pick', async () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => `Step ${i + 1} of the routine checks completed fine.`).join('\n');
  const cases = [
    ['wd1', 'Plan: I will drop the customers table in prod, then re-seed.\nChecked the schema.\nRan the linter.\nRan the unit tests.\nUpdated the notes.\nShould I go ahead?\n1. Yes (recommended)\n2. No', 'done'],
    ['wd2', 'Plan: I will drop the customers table in prod, then re-seed.\nChecked the schema.\nRan the linter.\nRan the unit tests.\nUpdated the notes.\nShould I go ahead?\n ❯ 1. Yes (recommended)\n   2. No\n' + MENU_TAIL, 'waiting'],
    ['wd3', `Plan: rm -rf the data directory on the host, then re-seed.\n${filler(11)}\nProceed with the plan?\n ❯ 1. Proceed as planned (Recommended)\n   2. Stop\n${MENU_TAIL}`, 'waiting'],
    ['wd4', `Plan: rm -rf the data directory on the host, then re-seed.\n${filler(11)}\nProceed with the plan?\n1. Proceed as planned (Recommended)\n2. Stop`, 'done'],
  ];
  const k0 = typedKeys.length, t0 = typed.length;
  for (const [name, body, state] of cases) {
    await stop(name, makeRepo(), body, { state });
    await wait(150);
    assert.ok(!typedKeys.some((x) => x.session === name) && !typed.some((x) => x.session === name), `${name}: nothing typed`);
    assert.ok(esc(name) || owner.some((o) => o.session === name), `${name}: escalated`);
  }
  assert.equal(typedKeys.length, k0); assert.equal(typed.length, t0);
});

test('R8-r3-1: the reporter\'s whole turn text is read, not the 90 closing lines of it', async () => {
  const body = ['Plan: I will drop the customers table in prod, then re-seed.', ...Array.from({ length: 140 }, (_, i) => `Routine step ${i} finished.`), 'Should I go ahead?', '1. Yes (recommended)', '2. No'].join('\n');
  const rep = { turnForStop: () => ({ text: body, at: 1, reason: 'end_turn', backgroundWork: 0 }), promptSince: () => null };
  const t = (st, now) => m.observe({ name: 'wd5', state: st, agent: 'claude', plain: pane(body), raw: pane(body), changed: true, realWork: st === 'working', project: 'p', cwd: makeRepo(), now, rep });
  t('working', 0); t('done', 1000); t('done', 2500);
  await until(() => stalls().some((r) => r.session === 'wd5' && ['answer', 'escalated', 'answer_cancelled'].includes(r.type)));
  await wait(150);
  assert.ok(!typed.some((x) => x.session === 'wd5') && !typedKeys.some((x) => x.session === 'wd5'));
  assert.ok(esc('wd5'));
});

test('R8-r3-2: a settled, escalated live menu raises the asks alert with the stop id; the voice item and its buttons answer it, a stale id gets 409', async () => {
  await cfg({ autoSend: false });
  const { stopItem, feedActions, createVoice } = await import('../voice.js');
  const body = 'How should I proceed?\n ❯ 1. Keep going (Recommended)\n   2. Stop and report\n' + MENU_TAIL;
  await stop('lv1', makeRepo(), body, { state: 'waiting' });
  const alert = owner.find((o) => o.session === 'lv1');
  assert.ok(alert, 'asks alert for a live menu');
  assert.equal(alert.state, 'waiting');
  const stOf = () => ({ state: 'waiting', stall: m.stallOf('lv1'), triage: m.triageOf('lv1'), auto: m.autoOf('lv1'), lastActivitySec: 0 });
  assert.ok(stOf().stall.id, 'the stop has its id once settled');
  const item = stopItem('lv1', stOf());
  assert.ok(item, 'a voice item'); assert.deepEqual(feedActions(item), [{ action: 'recommended', title: 'Do recommended' }]);
  const sent = [];
  const voice = createVoice({ status: async () => ({ lv1: stOf() }), ownerAsks: async () => [], managerSessions: () => ['mgr'], send: async (x) => { sent.push(x); }, logChoice: async () => {}, digestSources: async () => ({}) });
  const stale = await voice.answer({ id: item.id.replace(/:[0-9a-f]{8}$/, ':deadbeef'), option: 1, via: 'notification' });
  assert.equal(stale.status, 409);
  const ok = await voice.answer({ id: item.id, option: item.options.find((o) => o.recommended).n, via: 'notification' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(sent, [{ session: 'lv1', answer: { key: '1' }, by: 'owner-voice' }]);
  await cfg({ autoSend: true });
});

test('R8-r3-2: stallOf never hands the previous stop\'s id to a new stop\'s content', async () => {
  const p1 = pane('First question?\n1. A (Recommended)\n2. B');
  const t = (p, now, st = 'done') => m.observe({ name: 'sid1', state: st, agent: 'claude', plain: p, raw: p, changed: true, realWork: false, project: 'p', cwd: makeRepo(), now });
  m.observe({ name: 'sid1', state: 'working', agent: 'claude', plain: ['busy'], raw: ['busy'], changed: true, realWork: true, project: 'p', cwd: makeRepo(), now: 0 });
  t(p1, 1000); t(p1, 2500);
  await until(() => m.stallOf('sid1')?.id);
  const first = m.stallOf('sid1').id;
  assert.ok(first);
  const p2 = pane('A different second question about something else entirely?\n1. X\n2. Y');
  t(p2, 3000);   // the pane changed; the new stop is not settled yet
  assert.equal(m.stallOf('sid1').id, null);
});

test('R8-r4: "Should I run the deploy tests?" is not a deploy request: nothing is typed, the owner gets it (runner on, ledger known, tests green)', async () => {
  const repo = withOrigin();
  snapshot = { ...snapshot, deployed: { 'env-a': { server: { ref: 'main', commit: git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim() } } } };
  git(repo, 'checkout', '-q', 'main');
  const t0 = typed.length;
  for (const [i, q] of ['Should I run the deploy tests?', 'Should I queue the deploy job page refactor?', 'Should I retry the deploy check?'].entries()) {
    await stop(`nd${i}`, repo, `Tests: 1826/1826 pass on main.\n\n${q}`);
    await wait(150);
    assert.ok(!typed.some((x) => x.session === `nd${i}`), q);
    assert.ok(!stalls().some((r) => r.type === 'deploy_decision' && r.session === `nd${i}`), `${q}: no deploy evaluation`);
    assert.ok(esc(`nd${i}`) || owner.some((o) => o.session === `nd${i}`), `${q}: escalated`);
  }
  assert.equal(typed.length, t0);
});
