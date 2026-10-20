import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';

const dir = tmp('ghosty-mergedec-');
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000' });
delete process.env.JEV_URL; delete process.env.JEV_API_KEY;
const m = await import('../manager.js');
const { validateDecision } = await import('../orchestration/task-contract.js');
const { makeRepo } = await import('./helpers-git.js');

const typed = [], owner = [], notices = [], cancelled = [];
let jevReply = { skipped: 'not configured' };
let policyNow = { action: 'allow', reason: 'ok' };
const heldMap = new Map();
await m.initManager({
  managerSessions: () => ['mgr'],
  onOwnerNeeded: (session, stall, reason) => owner.push({ session, reason }),
  sendKey: async () => {}, sendKeys: async (session, text) => { typed.push({ session, text }); },
  onMergeDecision: (session, rec) => notices.push({ session, rec }),
  onMergeCancelled: (session, r) => cancelled.push({ session, r }),
  policy: () => policyNow, heldStore: { get: (n) => heldMap.get(n) || null, set: (n, h) => heldMap.set(n, h) },
  mergeJev: async () => jevReply,
});
const cfg = (o = {}) => m.setManagerConfig({ aiTriage: 'off', routerShadow: false, wakeShadow: false, autoSend: true, delayMs: 30, ...o });
await cfg();

const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { for (let t = 0; t < ms && !fn(); t += 20) await wait(20); };
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const stalls = () => lines(join(dir, 'stalls.jsonl'));
const GREEN = 'Tests: 1826/1826 pass on feat.';

// Drives one stop: the session works, then stops with `body`, and the manager gets two ticks past the settle time.
async function stop(name, cwd, body, { settle = 400, state = 'done' } = {}) {
  const t = (st, p, now) => m.observe({ name, state: st, agent: 'claude', plain: p, raw: p, changed: true, realWork: state === 'working', project: 'p', cwd, now });
  const p = pane(body);
  t('working', ['busy'], 0); t(state, p, 1000); t(state, p, 2500);
  if (settle > 100) await until(() => stalls().some((r) => r.session === name && ['answer', 'escalated', 'answer_cancelled'].includes(r.type)), 8000);   // the stop's outcome is logged
  else await until(() => stalls().some((r) => r.session === name && r.type === 'stall'), 8000);
}

test('1. merge question, tests green, clean merge: the manager answers "merge", journals it and tells the feed', async () => {
  const repo = makeRepo();
  await stop('s1', repo, `${GREEN}\n\nShould I merge feat into main?`);
  assert.equal(typed.length, 1, JSON.stringify({ typed, owner, stalls: stalls().map((s) => s.type) }));
  assert.equal(typed[0].session, 's1');
  assert.match(typed[0].text, /Merge: yes - the manager evaluated proj feat -> main/);
  assert.match(typed[0].text, /Do not merge it yourself\.$/);
  assert.doesNotMatch(typed[0].text, /rest of your question/);
  const j = lines(join(dir, 'manager-decisions.jsonl'));
  assert.equal(j.length, 1);
  assert.deepEqual(validateDecision(j[0]).errors, []);
  assert.equal(j[0].chosen, 'merge'); assert.equal(j[0].session, 's1'); assert.equal(j[0].repo, 'proj');
  assert.equal(notices.length, 1); assert.equal(notices[0].rec.decision_id, j[0].decision_id);
  const log = stalls();
  assert.ok(log.some((r) => r.type === 'merge_decision' && r.verdict === 'merge' && r.session === 's1' && r.branch === 'feat'));
  const ans = log.find((r) => r.type === 'answer' && r.session === 's1');
  assert.equal(ans.source, 'manager_decision');
  assert.ok(!owner.some((o) => o.session === 's1'), 'nothing left for the owner');
  assert.equal(ans.merge_decision_id, j[0].decision_id);   // m1: the send outcome points at the journal record
  assert.match(String(notices[0].rec.decision_id), /^merge-/);
});

test('2. red tests escalate with the reason; unknown tests escalate with "no green test report"', async () => {
  const n = typed.length, o = owner.length;
  await stop('s2', makeRepo(), '2 failed, 1824 passed.\n\nShould I merge feat into main?');
  await stop('s3', makeRepo(), 'I changed the module.\n\nShould I merge feat into main?');
  assert.equal(typed.length, n);
  const mine = owner.slice(o);
  assert.match(mine.find((x) => x.session === 's2').reason, /merge not decided: tests reported red: .*2 failed/);
  assert.match(mine.find((x) => x.session === 's3').reason, /merge not decided: no green test report on the branch/);
  const recs = lines(join(dir, 'manager-decisions.jsonl'));
  assert.equal(recs.filter((r) => r.chosen === 'escalate').length, 2);
  assert.ok(notices.filter((x) => x.rec.chosen === 'escalate').length === 2);
});

test('3. a conflict outside the convention files escalates; one only in VERSION.txt is allowed', async () => {
  const n = typed.length, o = owner.length;
  await stop('s4', makeRepo({ files: { 'src.js': 'export const a = 1;\n' }, mainFiles: { 'src.js': 'export const a = 2;\n' } }), `${GREEN}\n\nShould I merge feat into main?`);
  assert.equal(typed.length, n);
  assert.match(owner.slice(o)[0].reason, /conflicts outside convention: src\.js/);
  await stop('s5', makeRepo({ files: { 'VERSION.txt': '2\n', 'x.js': '1\n' }, mainFiles: { 'VERSION.txt': '3\n' } }), `${GREEN}\n\nShould I merge feat into main?`);
  assert.equal(typed.length, n + 1);
  assert.equal(typed.at(-1).session, 's5');
});

test('4. merge + deploy: the merge is answered, the deploy goes to the owner, the reply has no deploy word', async () => {
  const n = typed.length, o = owner.length;
  await stop('s6', makeRepo({ branch: 'task90-open' }), `Tests: 1826/1826 pass on task90-open.\n\nmerge task90-open and deploy once the host frees?`);
  await until(() => typed.length > n);
  assert.equal(typed.length, n + 1, JSON.stringify({ owner: owner.slice(o), st: stalls().slice(-3) }));
  const t = typed.at(-1).text;
  assert.match(t, /Merge: yes - the manager evaluated proj task90-open -> main/);
  assert.match(t, /The rest of your question went to the owner: wait for their answer on it\.$/);
  assert.doesNotMatch(t, /deploy/i);
  const e = owner.slice(o).find((x) => x.session === 's6');
  assert.ok(e, 'escalated');
  assert.match(e.reason, /deploy not decided: deploy runner off/); assert.match(e.reason, /merge answered by the manager/);   // round 8: the deploy is evaluated, and escalated by its floor
});

test('5. a mixed ask: the information is answered from the docs, with its source', async () => {
  const n = typed.length, o = owner.length;
  const repo = makeRepo({ branch: 'task90-open', files: { 'docs/HANDOVER.md': '# Handover\n\n- SRF 1 buffer: /data/fake/srf1-buffer\n- SRF 2 buffer: /data/fake/srf2-buffer\n', 'src.js': 'export const a = 1;\n' } });
  await stop('s7', repo, `Tests: 1826/1826 pass on task90-open.\n\n(a) send the SRF 1 buffer path for row b, and (b) say whether to merge task90-open?`);
  await until(() => typed.length > n);
  assert.equal(typed.length, n + 1, JSON.stringify({ owner: owner.slice(o), st: stalls().slice(-3) }));
  const t = typed.at(-1).text;
  assert.match(t, /\/data\/fake\/srf1-buffer \(from docs\/HANDOVER\.md:3\)/);
  assert.match(t, /Merge: yes/);
  assert.ok(!owner.slice(o).some((x) => x.session === 's7'), 'everything answered');
});

test('docs-only change without a test report merges; sensitive paths and an opted-out repo escalate', async () => {
  const n = typed.length, o = owner.length;
  await stop('d1', makeRepo({ files: { 'docs/N.md': 'x\n' } }), 'Updated the notes.\n\nShould I merge feat into main?');
  assert.equal(typed.length, n + 1);
  for (const [i, file] of ['.env', 'migrations/x.sql', 'systemd/x.service'].entries()) {
    await stop(`sens${i}`, makeRepo({ files: { [file]: 'a\n' } }), `${GREEN}\n\nShould I merge feat into main?`);
  }
  assert.equal(typed.length, n + 1);
  assert.equal(owner.slice(o).filter((x) => /^sens/.test(x.session) && /touches/.test(x.reason)).length, 3);
  await m.setManagerConfig({ mergeOptOut: ['proj'] });
  await stop('opt', makeRepo(), `${GREEN}\n\nShould I merge feat into main?`);
  assert.equal(typed.length, n + 1);
  assert.match(owner.at(-1).reason, /opted out/);
  await m.setManagerConfig({ mergeOptOut: [] });
});

test('Jev: escalate or low confidence escalates; a confident merge goes through', async () => {
  const n = typed.length, o = owner.length;
  jevReply = { success: true, decision_id: 'jv-1', answers: { choice: { choice: 'escalate', confidence: 0.9 } } };
  await stop('j1', makeRepo(), `${GREEN}\n\nShould I merge feat into main?`);
  jevReply = { success: true, decision_id: 'jv-2', answers: { choice: { choice: 'merge', confidence: 0.7 } } };
  await stop('j2', makeRepo(), `${GREEN}\n\nShould I merge feat into main?`);
  assert.equal(typed.length, n);
  assert.match(owner.slice(o).find((x) => x.session === 'j1').reason, /Jev rates it escalate/);
  assert.match(owner.slice(o).find((x) => x.session === 'j2').reason, /Jev confidence 0.70 below 0.85/);
  jevReply = { success: true, decision_id: 'jv-3', answers: { choice: { choice: 'merge', confidence: 0.95 } } };
  await stop('j3', makeRepo(), `${GREEN}\n\nShould I merge feat into main?`);
  assert.equal(typed.length, n + 1);
  assert.equal(lines(join(dir, 'manager-decisions.jsonl')).find((r) => r.session === 'j3').jev_decision_id, 'jv-3');
  jevReply = { skipped: 'not configured' };
});

test('auto-answer off: nothing is typed, the stop is escalated as before', async () => {
  await cfg({ autoSend: false });
  const n = typed.length, o = owner.length;
  await stop('off1', makeRepo(), `${GREEN}\n\nShould I merge feat into main?`);
  assert.equal(typed.length, n);
  assert.ok(owner.slice(o).some((x) => x.session === 'off1'));
  await cfg({ autoSend: true });
});

test('mergeDecisions off: the merge is not decided', async () => {
  await m.setManagerConfig({ mergeDecisions: false });
  const n = typed.length, o = owner.length;
  await stop('md0', makeRepo(), `${GREEN}\n\nShould I merge feat into main?`);
  assert.equal(typed.length, n);
  assert.ok(owner.slice(o).some((x) => x.session === 'md0'));
  await m.setManagerConfig({ mergeDecisions: true });
});

test('fire-time gates: turned off, or a raised confidence floor, during the countdown cancels the reply and tells the owner', async () => {
  await cfg({ delayMs: 1500 });
  const n = typed.length, o = owner.length;
  const t = (name, cwd, body) => stop(name, cwd, body, { settle: 20 });
  await t('f1', makeRepo(), `${GREEN}\n\nShould I merge feat into main?`);
  await until(() => m.autoOf('f1'));
  assert.equal(m.autoOf('f1').case, 'owner_decision');   // the pending manager answer shows with its countdown
  assert.match(m.autoOf('f1').answer, /^Merge: yes/);
  await m.setManagerConfig({ autoSend: false });
  await wait(1700);
  assert.ok(owner.slice(o).some((x) => x.session === 'f1'), 'escalated when the reply could not go');
  await cfg({ delayMs: 1500 });
  await t('f2', makeRepo(), `${GREEN}\n\nShould I merge feat into main?`);
  await until(() => m.autoOf('f2'));
  await m.setManagerConfig({ mergeMinConfidence: 0.95 });
  await wait(1700);
  assert.equal(typed.length, n);
  const cancelledRecs = stalls().filter((r) => r.type === 'answer_cancelled');
  assert.ok(cancelled.some((x) => x.session === 'f1' && /auto-answer turned off/.test(x.r.reason) && /^merge-/.test(x.r.merge_decision_id)), 'feed hook for a cancelled merge reply');   // R2-7
  assert.match(cancelledRecs.find((r) => r.session === 'f1').reason, /auto-answer turned off/);
  assert.match(cancelledRecs.find((r) => r.session === 'f2').reason, /merge confidence 0\.90 below 0\.95/);
  await cfg({ delayMs: 30, mergeMinConfidence: 0.85 });
});

test('fire-time gate: a manager_decision reply is re-checked against the hard floor (source)', () => {
  const src = readFileSync(new URL('../manager.js', import.meta.url), 'utf8');
  assert.match(src, /hardMatch\(auto\.answer\?\.text \|\| '', hardOpts\)/);
  assert.match(src, /decisionBlock\(name, kinds\)/);
});

test('config validation', async () => {
  await assert.rejects(m.setManagerConfig({ mergeMinConfidence: 2 }), /mergeMinConfidence/);
  await assert.rejects(m.setManagerConfig({ mergeOptOut: [''] }), /mergeOptOut/);
  await assert.rejects(m.setManagerConfig({ mergeOptOut: Array(51).fill('x') }), /mergeOptOut/);
  await assert.rejects(m.setManagerConfig({ infoRoots: ['relative/path'] }), /infoRoots/);
  await assert.rejects(m.setManagerConfig({ mergeConventionFiles: 'VERSION.txt' }), /mergeConventionFiles/);
  const c = await m.setManagerConfig({ mergeMinConfidence: 0.9, mergeConventionFiles: ['VERSION.txt', 'CHANGELOG.md'], infoRoots: ['/data/fake'], infoAnswers: false });
  assert.equal(c.mergeMinConfidence, 0.9); assert.deepEqual(c.infoRoots, ['/data/fake']); assert.equal(c.infoAnswers, false); assert.equal(c.mergeDecisions, true);
  await m.setManagerConfig({ mergeMinConfidence: 0.85, mergeConventionFiles: ['VERSION.txt'], infoRoots: [], infoAnswers: true });
});

test('B1: a live select menu or a numbered option list is never answered with free text', async () => {
  const n = typed.length;
  const menu = 'Merge feat?\n ❯ 1. Yes, merge and deploy\n   2. Merge only\n   3. Hold\n Enter to select · ↑/↓ to navigate · Esc to cancel';
  await m.setManagerConfig({ aiTriage: 'off' });
  const t = (name, state, body) => { const p = pane(body); m.observe({ name, state, agent: 'claude', plain: p, raw: p, changed: true, realWork: false, project: 'p', cwd: makeRepo(), now: 0 }); m.observe({ name, state, agent: 'claude', plain: p, raw: p, changed: true, realWork: false, project: 'p', cwd: makeRepo(), now: 1200 }); m.observe({ name, state, agent: 'claude', plain: p, raw: p, changed: true, realWork: false, project: 'p', cwd: makeRepo(), now: 2500 }); };
  m.observe({ name: 'menu1', state: 'working', agent: 'claude', plain: ['busy'], raw: ['busy'], changed: true, realWork: true, cwd: makeRepo(), now: 0 });
  t('menu1', 'waiting', menu);
  await until(() => stalls().some((r) => r.session === 'menu1' && r.type === 'stall'), 8000);
  await wait(300);
  await stop('menu2', makeRepo(), `${GREEN}\n\nShould I merge feat into main?\n1. Merge and deploy\n2. Merge only\n3. Hold`);
  assert.equal(typed.length, n);
  assert.ok(!stalls().some((r) => r.type === 'merge_decision' && ['menu1', 'menu2'].includes(r.session)), 'no merge evaluation for a menu');
});

test('M9: a part that carries a choice but was filtered out keeps the stop open', async () => {
  const n = typed.length, o = owner.length;
  const repo = makeRepo({ files: { 'docs/H.md': 'Alpha cache path: /data/fake/alpha-cache\n' } });
  await stop('m9a', repo, 'Send the alpha cache path? Rebuild or reuse the cache (both are fine).');
  await until(() => typed.length > n);
  assert.equal(typed.length, n + 1);
  assert.match(typed.at(-1).text, /\/data\/fake\/alpha-cache/);
  assert.match(typed.at(-1).text, /rest of your question/);
  assert.ok(owner.slice(o).some((x) => x.session === 'm9a'), 'the choice was escalated');
  const n2 = typed.length;
  await stop('m9b', repo, 'Send the alpha cache path; then option A (rebuild) or option B (reuse cache)?');
  await until(() => typed.length > n2);
  assert.match(typed.at(-1).text, /alpha-cache/);
  assert.ok(owner.slice(o).some((x) => x.session === 'm9b'));
});

test('M11: a held manager reply is released by the quota recovery through decisionBlock', async () => {
  const n = typed.length, o = owner.length;
  policyNow = { action: 'hold', reason: 'quota' };
  await stop('h1', makeRepo(), `${GREEN}\n\nShould I merge feat into main?`);
  await stop('h2', makeRepo(), `${GREEN}\n\nShould I merge feat into main?`);
  await wait(200);
  assert.equal(typed.length, n, 'held, not typed');
  policyNow = { action: 'allow', reason: 'ok' };
  await m.setManagerConfig({ mergeMinConfidence: 0.95 });   // h2 and h1 now fall below the merge floor
  m.reevaluateHolds();
  await wait(200);
  assert.equal(typed.length, n);
  assert.ok(owner.slice(o).some((x) => x.session === 'h1' && /held reply not sent/.test(x.reason)));
  await m.setManagerConfig({ mergeMinConfidence: 0.85 });
  policyNow = { action: 'hold', reason: 'quota' };
  await stop('h3', makeRepo(), `${GREEN}\n\nShould I merge feat into main?`);
  policyNow = { action: 'allow', reason: 'ok' };
  m.reevaluateHolds();
  await until(() => typed.some((x) => x.session === 'h3'));
  assert.ok(typed.some((x) => x.session === 'h3' && /^Merge: yes/.test(x.text)), 'released and sent');
});

test('R2-2: partialDecision rechecks the stop after the information lookups', () => {
  const src = readFileSync(new URL('../manager.js', import.meta.url), 'utf8');
  assert.match(src, /lookupInfo\(p, \{ roots \}\)[\s\S]*?if \(w\.hash !== h\) return out;[\s\S]*?const wanted = s\.cwd \? topicsWanted/);
});
