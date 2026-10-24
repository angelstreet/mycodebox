// Round 9 item 5: the manager settles version / progress / "does this file exist" questions itself; one open ask per session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';

import { join } from 'node:path';
import { tmp } from './helpers-tmp.js';

const dir = tmp('ghosty-selfcheck-');
Object.assign(process.env, { GHOSTY_STATE_DIR: dir, STALL_SETTLE_MS: '1000' });
delete process.env.JEV_URL; delete process.env.JEV_API_KEY;
const { selfAsk, answerVersion, answerFile, pathsIn } = await import('../self-check.js');
const { openAsks, newestPerSession, supersedeOlder, readOpenAsks } = await import('../owner-asks.js');
const m = await import('../manager.js');
const { makeRepo } = await import('./helpers-git.js');

test('selfAsk: version, progress, file; ordinary questions are not self-checks', () => {
  assert.equal(selfAsk('What version is deployed on env-a?').kind, 'version');
  assert.equal(selfAsk('Which build is live on env-b right now?').kind, 'version');
  assert.equal(selfAsk('Is the run finished?').kind, 'progress');
  assert.equal(selfAsk('What is the progress of the export job?').kind, 'progress');
  assert.equal(selfAsk('Does docs/NOTES.md exist?').kind, 'file');
  assert.equal(selfAsk('Is there a file `scripts/run.sh`?').kind, 'file');
  assert.equal(selfAsk('Should I refactor the parser?'), null);
  assert.equal(selfAsk('Does it exist?'), null);   // no path
  assert.deepEqual(pathsIn('Does `a/b.md` or c/d.txt exist?'), ['a/b.md', 'c/d.txt']);
});
test('answerVersion: from the deployed-now ledger, named env first, target filter', () => {
  const deployed = { 'env-a': { server: { ref: 'main', commit: 'abcdef0123456789', version: 'main-12' }, frontend: { ref: 'main', commit: '1111111111111111' } }, 'env-b': { server: { ref: 'rel', commit: '2222222222222222' } } };
  assert.equal(answerVersion({ ask: 'what version is on env-a?', deployed, envs: ['env-a', 'env-b'] }), 'Running now (from the ledger): env-a: frontend main@111111111111, server main@abcdef012345 (version main-12).');
  assert.match(answerVersion({ ask: 'which server build is on env-b?', deployed }), /env-b: server rel@222222222222/);
  assert.equal(answerVersion({ ask: 'what version?', deployed: {} }), null);
});
test('answerFile: stat inside the roots only; never outside, never a secret path, never content', async () => {
  const root = tmp('self-root-'), outside = tmp('self-out-');
  mkdirSync(join(root, 'docs')); writeFileSync(join(root, 'docs', 'NOTES.md'), 'hello'); writeFileSync(join(outside, 'x.txt'), 'x'); writeFileSync(join(root, '.env'), 'K=V');
  symlinkSync(outside, join(root, 'link'));
  assert.match(await answerFile({ ask: 'does docs/NOTES.md exist?', roots: [root] }), /^Yes: docs\/NOTES\.md exists in .* \(file, 5 bytes, modified \d+ min ago\)\.$/);
  assert.match(await answerFile({ ask: 'does docs/MISSING.md exist?', roots: [root] }), /^No: docs\/MISSING\.md does not exist in /);
  assert.match(await answerFile({ ask: `does ${join(root, 'docs')} exist?`, roots: [root] }), /directory/);
  assert.equal(await answerFile({ ask: `does ${join(outside, 'x.txt')} exist?`, roots: [root] }), null);   // outside
  assert.equal(await answerFile({ ask: 'does link/x.txt exist?', roots: [root] }), null);                    // symlink out
  assert.equal(await answerFile({ ask: 'does ../x.txt exist?', roots: [root] }), null);
  assert.equal(await answerFile({ ask: 'does .env exist?', roots: [root] }), null);                         // secret path
  assert.equal(await answerFile({ ask: 'does /etc/hostname exist?', roots: [root] }), null);
  assert.equal(await answerFile({ ask: 'does docs/NOTES.md exist?', roots: [] }), null);
});

// ---- owner-asks: one open ask per session ----
const L = (...o) => o.map((x) => JSON.stringify(x));
test('owner-asks: newest open ask per session; supersedeOlder appends {id, state: superseded, by}', async () => {
  const lines = L({ at: '2026-10-15T01:00:00Z', id: 'Q1', session: 'A', question: 'old?', state: 'open' }, { at: '2026-10-15T02:00:00Z', id: 'Q2', session: 'A', question: 'newer?', state: 'open' }, { at: '2026-10-15T03:00:00Z', id: 'Q3', session: 'B', question: 'other?', state: 'open' });
  // the owner's rule: the newest of a session stands, and the older one is hidden only while its replacement is listed
  assert.deepEqual(newestPerSession(openAsks(lines), new Map([['Q1', 'Q2']])).map((a) => a.id), ['Q3', 'Q2']);
  const f = join(dir, 'asks-test.jsonl');
  writeFileSync(f, lines.join('\n') + '\n');
  assert.deepEqual(await supersedeOlder(f, 'A', 'Q2'), ['Q1']);   // only a question of the ledger replaces a question
  const recs = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(recs.filter((r) => r.state === 'superseded').map((r) => [r.id, r.by]), [['Q1', 'Q2']]);
  assert.deepEqual((await readOpenAsks(f)).map((a) => a.id), ['Q3', 'Q2']);
  assert.deepEqual(await supersedeOlder(join(dir, 'nope.jsonl'), 'A', 'N'), []);   // a missing ledger is not created
  assert.equal(existsSync(join(dir, 'nope.jsonl')), false);
});

// ---- manager level ----
const typed = [], owner = [];
const ledger = join(dir, 'manager-owner-asks.jsonl');
const progress = { text: null };
await m.initManager({
  managerSessions: () => ['mgr'], onOwnerNeeded: (session, stall, reason) => owner.push({ session, reason }),
  sendKey: async () => {}, sendKeys: async (session, text) => { typed.push({ session, text }); },
  onMergeDecision: () => {}, policy: () => ({ action: 'allow', reason: 'ok' }), heldStore: { get: () => null, set: () => {} },
  decideContext: () => ({ deploys: { ok: true, deploys: [], deployed: { 'env-a': { server: { ref: 'main', commit: 'abcdef0123456789', version: 'main-12' } } }, envs: ['env-a'] }, leases: { ok: true, leases: [], waiters: [] }, envs: ['env-a'] }),
  onDigest: () => {}, mergeJev: async () => ({ skipped: 'not configured' }),
  ownJobs: { progressOf: async () => progress.text, watch: async () => ({}), forget: () => {} },
});
await m.setManagerConfig({ aiTriage: 'off', routerShadow: false, wakeShadow: false, delayMs: 30, deployRunner: true });
const RULE = '─'.repeat(40);
const pane = (body) => [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { for (let t = 0; t < ms && !fn(); t += 20) await wait(20); };
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const stalls = () => lines(join(dir, 'stalls.jsonl'));
async function stop(name, cwd, body) {
  const t = (st, p, now) => m.observe({ name, state: st, agent: 'claude', plain: p, raw: p, changed: true, realWork: st === 'working', project: 'p', cwd, now });
  const p = pane(body);
  t('working', ['busy'], 0); t('done', p, 1000); t('done', p, 2500);
  await until(() => stalls().some((r) => r.session === name && ['answer', 'escalated', 'answer_cancelled'].includes(r.type)));
  await wait(150);
  return { typed: typed.filter((x) => x.session === name).map((x) => x.text), esc: stalls().find((r) => r.type === 'escalated' && r.session === name) };
}

test('manager: version, file and progress questions are answered from the registry and hosts; unknown progress and outside paths escalate', async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'NOTES.md'), 'x');
  const v = await stop('sc1', repo, 'Tests are green on feat.\n\nWhat version is deployed on env-a?');
  assert.equal(v.typed.length, 1, JSON.stringify(v.esc)); assert.match(v.typed[0], /Version: Running now \(from the ledger\): env-a: server main@abcdef012345 \(version main-12\)\./);
  assert.equal(v.esc, undefined);
  const f = await stop('sc2', repo, 'Tests are green on feat.\n\nDoes NOTES.md exist?');
  assert.match(f.typed[0], /File: Yes: NOTES\.md exists/); assert.equal(f.esc, undefined);
  const out = await stop('sc3', repo, 'Tests are green on feat.\n\nDoes /etc/hostname exist?');
  assert.deepEqual(out.typed, []); assert.ok(out.esc);
  const none = await stop('sc4', repo, 'The export is going.\n\nIs the run finished?');
  assert.deepEqual(none.typed, []); assert.ok(none.esc);   // no job known: the owner is asked
  progress.text = 'job (pid 4242) is still running (pid 4242).';
  const known = await stop('sc5', repo, 'The export is going.\n\nIs the run finished?');
  assert.match(known.typed[0], /Progress: job \(pid 4242\) is still running/); assert.equal(known.esc, undefined);
  progress.text = null;
});
test('manager: an escalation closes no owner question: a stop is not a question', async () => {
  writeFileSync(ledger, L({ at: '2026-10-15T01:00:00Z', id: 'OLD1', session: 'sc6', question: 'older?', state: 'open' }, { at: '2026-10-15T01:00:00Z', id: 'KEEP', session: 'other', question: 'unrelated?', state: 'open' }).join('\n') + '\n');
  const r = await stop('sc6', makeRepo(), 'Tests are green.\n\nShould I rotate the API key now?');
  assert.ok(r.esc);
  await wait(300);
  assert.deepEqual(lines(ledger).filter((x) => x.state === 'superseded'), [], 'the stop closed no question (E22)');
  assert.deepEqual((await readOpenAsks(ledger)).map((a) => a.id), ['OLD1', 'KEEP'], 'the session\'s question is still open');
});
test('manager: an own_job_wait stop is never an escalation and starts the watcher; moving on forgets it', async () => {
  const calls = [];
  await m.initManager({ ownJobs: { progressOf: async () => null, watch: async (n, o) => { calls.push(['watch', n, o.text]); return { kind: 'pid', label: 'job (pid 99)' }; }, forget: (n) => calls.push(['forget', n]) } });
  const r = await stop('sc7', makeRepo(), 'Started the final run.\nSTATUS: waiting: final score_matrix run (pid 99)');
  await until(() => calls.some((c) => c[0] === 'watch'));
  assert.equal(r.esc, undefined); assert.deepEqual(r.typed, []);
  assert.deepEqual(calls.find((c) => c[0] === 'watch'), ['watch', 'sc7', 'final score_matrix run (pid 99)']);
  assert.ok(stalls().some((x) => x.type === 'own_job' && x.session === 'sc7'));
  assert.equal(m.stillStopped('sc7', stalls().find((x) => x.type === 'own_job' && x.session === 'sc7').id), true);
  m.observe({ name: 'sc7', state: 'working', agent: 'claude', plain: ['busy'], raw: ['busy'], changed: true, realWork: true, project: 'p', cwd: null, now: 9000 });
  assert.ok(calls.some((c) => c[0] === 'forget' && c[1] === 'sc7'));
  assert.equal(m.toOwnerCase({ case: 'own_job_wait' }), false);
});

// ---- round 9 review fixes ----
const { createOwnJobs } = await import('../own-jobs.js');
test('review: a words-only job STATUS is the session\'s own only when the agent has a live child; remote sessions are skipped; wakes use the decision gates', async () => {
  const calls = [];
  let child = false;
  await m.initManager({ ownJobs: { progressOf: async () => null, hasLiveChild: async () => child, watch: async (n, o) => { calls.push(['watch', n, o.text]); return { kind: 'tree', label: 'job' }; }, forget: () => {} } });
  const a = await stop('sc8', makeRepo(), 'Kicked off the nightly run.\nSTATUS: blocked: waiting for the CI run to finish');
  assert.ok(a.esc, 'no child process: the old case, escalated'); assert.equal(calls.length, 0);
  child = true;
  const b = await stop('sc9', makeRepo(), 'Kicked off the nightly run.\nSTATUS: blocked: waiting for the final score_matrix run to finish');
  await until(() => calls.length > 0);
  assert.equal(b.esc, undefined); assert.equal(calls[0][1], 'sc9');
  // remote (Mac) sessions: no watcher, no progress / file self-check, no mockup answer
  const n0 = calls.length;
  const RULE2 = '─'.repeat(40);
  const rstop = async (name, body) => {
    const p = [...body.split('\n'), '✻ Baked for 1m · done 3:59 PM', RULE2, '❯ ', RULE2, '  ⏵⏵ bypass permissions on'];
    m.observe({ name, remote: true, machine: 'mac-test', state: 'done', agent: 'claude', plain: p, raw: p, changed: true, realWork: false, project: 'p', cwd: null, now: 1000 });
    m.observe({ name, remote: true, machine: 'mac-test', state: 'done', agent: 'claude', plain: p, raw: p, changed: true, realWork: false, project: 'p', cwd: null, now: 3000 });
    await until(() => stalls().some((r) => r.session === name && ['answer', 'escalated', 'answer_cancelled'].includes(r.type)));
    await wait(150);
    return { typed: typed.filter((x) => x.session === name).map((x) => x.text), esc: stalls().find((r) => r.type === 'escalated' && r.session === name) };
  };
  progress.text = 'job (pid 4242) is still running.';
  const r1 = await rstop('mac:s1', 'Started the export.\nSTATUS: waiting: pid 4242 on host-b to finish');
  assert.equal(calls.length, n0);
  const r2 = await rstop('mac:s2', 'The export is going.\n\nIs the run finished?');
  assert.deepEqual(r2.typed, []); assert.ok(r2.esc);
  const r3 = await rstop('mac:s3', 'Done.\n\nDoes NOTES.md exist?');
  assert.deepEqual(r3.typed, []); assert.ok(r3.esc);
  const r4 = await rstop('mac:s4', 'The settings page layout is designed.\n\nShall I show you the mockup before I build it?');
  assert.ok(!r4.typed.some((x) => /mockups/.test(x))); void r1;
  progress.text = null;
  // wake gates: canType follows autoSend / hourly cap / pause / draft
  assert.equal(m.canType('sc9'), true);
  m.countSent('sc9'); m.countSent('sc9'); m.countSent('sc9'); m.countSent('sc9');
  assert.equal(m.canType('sc9'), false, 'hourly cap reached');
  const saved = m.managerConfig();
  await m.setManagerConfig({ autoSend: false }); assert.equal(m.canType('sc8'), false);
  await m.setManagerConfig({ autoSend: saved.autoSend });
});

test('review: only a question of the ledger replaces a question, and only the asks older than it', async () => {
  const t0 = Date.now() - 60000;
  writeFileSync(ledger, L({ at: new Date(t0).toISOString(), id: 'OLDER', session: 'sc10', question: 'old?', state: 'open' }, { at: new Date(Date.now() + 3600e3).toISOString(), id: 'NEWER', session: 'sc10', question: 'later?', state: 'open' }).join('\n') + '\n');
  const r = await stop('sc10', makeRepo(), 'Tests are green.\n\nShould I rotate the API key now?');
  assert.ok(r.esc);
  await wait(300);
  assert.deepEqual(lines(ledger).filter((x) => x.state === 'superseded'), [], 'the escalation closed nothing (E22)');
  // the newer question of the session replaces the older one, and only the asks written before it
  assert.deepEqual(await supersedeOlder(ledger, 'sc10', 'NEWER', { before: Date.now() + 3600e3 }), ['OLDER']);
  appendFileSync(ledger, JSON.stringify({ at: new Date(t0 - 1000).toISOString(), id: 'LATE', session: 'sc10', question: 'again?', state: 'open' }) + '\n');
  const p = await supersedeOlder(ledger, 'sc10', 'NEWER', { before: t0 });
  assert.deepEqual(p, ['LATE']);
});

test('review round 3: a local pid that is not running here escalates to the owner with the reason', async () => {
  await m.initManager({ ownJobs: { progressOf: async () => null, hasLiveChild: async () => false, watch: async () => ({ kind: 'pid', label: 'job (pid 4242)', unseen: true, pid: 4242 }), forget: () => {} } });
  const r = await stop('sc11', makeRepo(), 'Started the export on host-b.\nSTATUS: waiting: pid 4242 on host-b to finish');
  assert.ok(r.esc); assert.match(r.esc.reason, /pid 4242 is not running on this host/); assert.equal(r.esc.case, 'owner_decision');
});
