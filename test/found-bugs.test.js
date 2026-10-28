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
