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
  onOwnerNeeded: (session, stall, reason) => owner.push({ session, reason }),
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
  assert.match(t, /Rollback: request a deploy of the previous release to env-a \(full\)\.$/);
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
  git(ok, 'checkout', '-q', 'main'); git(ok, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat'); git(ok, 'push', '-q', 'origin', 'main'); git(ok, 'checkout', '-q', 'feat');
  await stop('mn6', ok, `${GREEN}\n\nWhat next?\n ❯ 1. Deploy main to env-a (Recommended)\n   2. Wait\n${MENU_TAIL}`, { state: 'waiting' });
  await until(() => typedKeys.some((x) => x.session === 'mn6'));
  assert.deepEqual(typedKeys.filter((x) => x.session === 'mn6'), [{ session: 'mn6', key: '1' }]);
  const rec = journal().find((r) => r.session === 'mn6' && r.kind === 'deploy');
  assert.equal(rec.chosen, 'deploy'); assert.match(rec.evidence[0], /tests green on feat, which is merged into main/);
  assert.deepEqual(validateDecision(rec).errors, []);
  // the same recommendation on a finished turn: free text, with the journal record
  const fin = withOrigin();
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
