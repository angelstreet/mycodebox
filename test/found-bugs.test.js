import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmp } from './helpers-tmp.js';
import { redact, normalize, createFoundBugs, unreportedBugOf } from '../found-bugs.js';
import { createLeftovers, IDLE_MS } from '../done-leftovers.js';
import { createManagerEvents } from '../manager-events.js';

const REVISE = "I could not list the virtual scripts through the REST endpoint (the call returned an error), so my evidence is that the dispatcher's own lookup succeeds.\n\nSTATUS: done — ft-revise merged";
const CLEAN = 'All merged and deployed, tests green.\n\nSTATUS: done — branch x merged and deployed';

test('redact: tokens, keys, passwords and URL credentials never reach the store', () => {
  const t = redact('curl -H "x-ghosty-reporter-token: abcd1234efgh5678" token=ghp_abcdefghijklmnop1234 password: hunter22 https://u:pw@host/x ' + 'A'.repeat(48));
  assert.doesNotMatch(t, /abcd1234efgh|ghp_abc|hunter22|u:pw|AAAAAAAA/);
  assert.match(t, /redacted/);
  assert.equal(redact('plain text about /api/x'), 'plain text about /api/x');
});

test('normalize: title required, blocking parsed, fields clipped', () => {
  assert.equal(normalize({}).invalid, 'title required');
  const r = normalize({ title: 'x', blocking: 'yes', session: 's 1!', repro: 'r '.repeat(2500) });
  assert.equal(r.blocking, true); assert.equal(r.session, 's1'); assert.ok(r.repro.length <= 1200);
  assert.equal(normalize({ title: 'x', blocking: 'no' }).blocking, false);
});

test('store: add appends, dedupes same title + session within 24 h, then allows again; counts; remove only test reports', async () => {
  const dir = tmp('ghosty-fb-'); let t = 1e12; const seen = [];
  const fb = createFoundBugs({ stateDir: dir, now: () => t, onNew: async (b) => { seen.push(b.id); } });
  const a = await fb.add({ title: 'REST list errors', session: 'ft', blocking: 'yes', error: 'token=supersecret99' });
  assert.equal(a.ok, true); assert.equal(a.duplicate, false);
  assert.doesNotMatch(readFileSync(fb.file, 'utf8'), /supersecret99/);
  t += 3600e3;
  assert.equal((await fb.add({ title: 'rest LIST errors', session: 'ft' })).duplicate, true);
  assert.equal((await fb.add({ title: 'REST list errors', session: 'other' })).duplicate, false);
  t += 24 * 3600e3;
  assert.equal((await fb.add({ title: 'REST list errors', session: 'ft' })).duplicate, false);
  assert.equal(seen.length, 3);
  assert.deepEqual(await fb.counts(), { total: 3, blocking: 1, last24h: 2 });
  assert.equal((await fb.remove(a.bug.id)).ok, false);
  const tb = await fb.add({ title: 'probe', session: 'ft', test: true });
  assert.equal((await fb.remove(tb.bug.id)).ok, true);
  assert.equal((await fb.list()).some((b) => b.id === tb.bug.id), false);
  assert.equal(await fb.recentBy('ft'), true);
});

test('unreportedBugOf: the real ft-revise sentence is caught, a clean closing text and one that filed a bug are not', () => {
  assert.match(unreportedBugOf(REVISE).sentence, /could not list the virtual scripts/);
  assert.equal(unreportedBugOf(CLEAN), null);
  assert.equal(unreportedBugOf(REVISE + '\nFiled with found-bug (bug-1a2b3c4d).'), null);
  assert.equal(unreportedBugOf(''), null);
  assert.ok(unreportedBugOf('The failing test is pre-existing and unrelated to my change.\nSTATUS: done'));
});

test('watcher: bug-unreported fires once for an idle done session; a recent found-bug record silences it', async () => {
  const events = []; const recent = new Set();
  const w = createLeftovers({ listIdle: async () => [{ name: 'ft-revise', text: REVISE, idleMs: IDLE_MS + 1 }], record: async (e) => { events.push(e); }, log: { error() {} },
    classify: (text, name) => { const ub = unreportedBugOf(text); return ub && !recent.has(name) ? { kind: 'bug-unreported', items: [ub.sentence], title: 'bug mentioned, not reported' } : null; } });
  await w.tick(); await w.tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'ft-revise:bug-unreported');
  assert.match(events[0].items[0], /returned an error/);
  recent.add('ft-revise');
  const w2 = createLeftovers({ listIdle: async () => [{ name: 'ft-revise', text: REVISE, idleMs: IDLE_MS + 1 }], record: async (e) => { events.push(e); }, log: { error() {} },
    classify: (text, name) => { const ub = unreportedBugOf(text); return ub && !recent.has(name) ? { kind: 'x', items: ['x'] } : null; } });
  await w2.tick();
  assert.equal(events.length, 1);
});

test('feed: kind bug carries the bug object; bug-unreported carries items; both pass the manager event filter', async () => {
  const dir = tmp('ghosty-fb-feed-');
  const me = createManagerEvents({ stateDir: dir });
  await me.record({ key: 'ft:bug', title: 'ft: bug found: x', body: 'b', bug: { id: 'bug-1', title: 'x', blocking: true } });
  await me.record({ key: 'ft:bug-unreported', title: 't', body: 'b', items: ['could not do it'] });
  const rows = await me.tail();
  assert.equal(rows[0].kind, 'bug'); assert.equal(rows[0].bug.blocking, true);
  assert.equal(rows[1].kind, 'bug-unreported'); assert.deepEqual(rows[1].items, ['could not do it']);
  const SH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'manager-event-filter.sh');
  const r = spawnSync('bash', [SH], { env: { ...process.env, GHOSTY_STATE_DIR: dir }, input: rows.map((x) => JSON.stringify(x)).join('\n') + '\n', encoding: 'utf8', timeout: 20000 });
  assert.deepEqual(r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).l.kind), ['bug', 'bug-unreported']);
  assert.ok(existsSync(SH));
});

test('store: filing with every field set still works after a test report was removed (tombstone has no title)', async () => {
  const fb = createFoundBugs({ stateDir: tmp('ghosty-fb-tomb-') });
  const t = await fb.add({ title: 'probe', session: 's', test: true });
  assert.equal((await fb.remove(t.bug.id)).ok, true);
  const full = { title: 'All Fields', endpoint: 'GET /api/x', repro: 'steps', error: 'exact text', workaround: 'w', blocking: 'yes', session: 's' };
  const a = await fb.add(full);
  assert.equal(a.ok, true); assert.equal(a.bug.blocking, true);
  assert.equal((await fb.add({ ...full, title: 'all fields' })).duplicate, true);
  // a removed test report does not dedupe a new filing of the same title
  const again = await fb.add({ title: 'probe', session: 's', test: true });
  assert.equal(again.duplicate, false);
});

test('store: fixed marks a report, keeps it listed with fixed: true and leaves the open counts; unknown ids fail', async () => {
  const fb = createFoundBugs({ stateDir: tmp('ghosty-fb-fixed-') });
  const a = await fb.add({ title: 'detector false positive', session: 'manager', blocking: 'yes' });
  assert.deepEqual(await fb.counts(), { total: 1, blocking: 1, last24h: 1 });
  assert.equal((await fb.fixed(a.bug.id, 'guards in owner-push.js token=sekret123')).ok, true);
  const l = (await fb.list())[0];
  assert.equal(l.fixed, true); assert.doesNotMatch(l.fixedNote, /sekret123/);
  assert.deepEqual(await fb.counts(), { total: 0, blocking: 0, last24h: 0 });
  assert.equal((await fb.fixed('bug-00000000')).ok, false);
  assert.equal((await fb.add({ title: 'next one', session: 'manager' })).ok, true);
});

test('store: resolve records state, commit, who and when; unresolved filter and counts drop it; bad state / missing commit fail', async () => {
  const fb = createFoundBugs({ stateDir: tmp('ghosty-fb-resolve-') });
  const a = (await fb.add({ title: 'one', session: 's' })).bug, b = (await fb.add({ title: 'two', session: 's' })).bug;
  assert.equal((await fb.resolve(a.id, { state: 'fixed' })).ok, false);
  assert.equal((await fb.resolve(a.id, { state: 'nope', commit: 'abc1234' })).ok, false);
  assert.equal((await fb.resolve('bug-00000000', { state: 'wontfix' })).ok, false);
  assert.equal((await fb.resolve(a.id, { state: 'fixed', commit: 'abc1234', note: 'token=sekret123 done', by: 'sweep' })).ok, true);
  assert.equal((await fb.resolve(b.id, { state: 'doc-only', note: 'rule in docs', by: 'sweep' })).ok, true);
  const l = await fb.list();
  assert.equal(l[0].state, 'fixed'); assert.equal(l[0].fixed, true); assert.equal(l[0].commit, 'abc1234'); assert.equal(l[0].resolvedBy, 'sweep'); assert.doesNotMatch(l[0].resolvedNote, /sekret123/);
  assert.equal(l[1].state, 'doc-only'); assert.notEqual(l[1].fixed, true);
  assert.equal((await fb.list({ unresolved: true })).length, 0);
  assert.deepEqual(await fb.counts(), { total: 0, blocking: 0, last24h: 0 });
});

// Regression (task176-tree-naming reported "Cannot read properties of undefined (reading 'toLowerCase')" with every flag set):
// the real CLI with the full flag set against a store that already holds tombstone, fixed and resolve marker lines (no title).
test('CLI: every flag set files cleanly against a store with marker lines', async () => {
  const { createServer } = await import('node:http');
  const { createFoundBugs } = await import('../found-bugs.js');
  const fb = createFoundBugs({ stateDir: tmp('ghosty-fb-cli-') });
  const old = (await fb.add({ title: 'old', session: 's' })).bug, t = (await fb.add({ title: 'probe', session: 's', test: true })).bug;
  await fb.remove(t.id); await fb.fixed(old.id, 'n'); await fb.resolve(old.id, { state: 'fixed', commit: 'abc1234' });
  const srv = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const r = await fb.add(JSON.parse(body));
    res.writeHead(r.ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(r));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const { promisify } = await import('node:util');
    const { execFile } = await import('node:child_process');
    const env = { ...process.env, PORT: String(srv.address().port) };
    const flags = ['--title', 'host unreachable (No route to host)', '--endpoint', 'ssh host:227', '--repro', 'ssh from codebox', '--error', 'ssh: No route to host', '--workaround', 'none', '--blocking', 'no', '--session', 'cli-test'];
    const out = await promisify(execFile)(process.execPath, ['scripts/found-bug', ...flags], { env });
    assert.match(out.stdout, /^filed bug-[0-9a-f]{8}/);
    const again = await promisify(execFile)(process.execPath, ['scripts/found-bug', ...flags], { env });
    assert.match(again.stdout, /already filed/);
    const rows = (await fb.list()).filter((b) => b.session === 'cli-test');
    assert.equal(rows.length, 1); assert.equal(rows[0].blocking, false); assert.equal(rows[0].workaround, 'none');
  } finally { srv.close(); }
});
