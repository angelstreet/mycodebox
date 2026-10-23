import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, message, stamp, createRulesWatch } from '../rules-watch.js';

const H = 'a'.repeat(40), H2 = 'b'.repeat(40);
const T = Date.parse('2026-10-14T12:00:00Z');
const RULES = { hash: H, at: T, subject: 'docs: autonomy' };   // what the harness git mock reports for AGENTS.md

test('plan: only sessions whose agent started before the AGENTS.md change, idle, not told this hash, not script-busy', () => {
  const rules = new Map([['/r/.git', { hash: H, at: T, subject: 'docs: autonomy' }]]);
  const repoOf = new Map([['/w/a', '/r/.git'], ['/w/b', '/r/.git'], ['/w/c', '/r/.git'], ['/w/d', '/r/.git'], ['/w/e', '/r/.git'], ['/x', null]]);
  const targets = [
    { name: 'old', cwd: '/w/a', startedAt: T - 3600e3, working: false, scriptBusy: false },
    { name: 'new', cwd: '/w/b', startedAt: T + 60e3, working: false, scriptBusy: false },
    { name: 'busy', cwd: '/w/c', startedAt: T - 3600e3, working: true, scriptBusy: false },
    { name: 'told', cwd: '/w/d', startedAt: T - 3600e3, working: false, scriptBusy: false },
    { name: 'scripted', cwd: '/w/e', startedAt: T - 3600e3, working: false, scriptBusy: true },
    { name: 'norepo', cwd: '/x', startedAt: 1, working: false, scriptBusy: false },
  ];
  const a = plan({ targets, rules, repoOf, told: { told: H } });
  assert.deepEqual(a.send.map((p) => p.name), ['old']);
  assert.deepEqual(a.skipScript, ['scripted']);                   // the script-busy one is held, not told
  const b = plan({ targets, rules, repoOf, told: { told: H2 } });
  assert.deepEqual(b.send.map((p) => p.name), ['old', 'told']);   // a newer change is told again
  assert.deepEqual(b.skipScript, ['scripted']);                   // the script-busy one is still held
  const c = plan({ targets, rules, repoOf, told: {} });
  assert.deepEqual(c.send.map((p) => p.name), ['old', 'told']);   // capped at MAX_SENDS_PER_TICK (2)
  assert.deepEqual(c.skipScript, ['scripted']);                   // the script-busy one is held, not told
});

test("plan: at most 2 sessions per tick", () => {
  const rules = new Map([['/r/.git', { hash: H, at: T, subject: 's' }]]);
  const repoOf = new Map([['/w', '/r/.git']]);
  const targets = Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, cwd: '/w', startedAt: T - 1, working: false, scriptBusy: false }));
  assert.equal(plan({ targets, rules, repoOf, told: {} }).send.length, 2);
});

test("plan: a script-busy pane is moved to skipScript, never to send", () => {
  const rules = new Map([['/r/.git', { hash: H, at: T, subject: 's' }]]);
  const repoOf = new Map([['/w', '/r/.git']]);
  const targets = [
    { name: 'idle', cwd: '/w', startedAt: T - 1, working: false, scriptBusy: false },
    { name: 'scripted', cwd: '/w', startedAt: T - 1, working: false, scriptBusy: true },
  ];
  const r = plan({ targets, rules, repoOf, told: {} });
  assert.deepEqual(r.send.map((p) => p.name), ['idle']);
  assert.deepEqual(r.skipScript, ['scripted']);
  // cap is only applied to send; skipScript reports all scripted panes this tick
  const many = Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, cwd: '/w', startedAt: T - 1, working: false, scriptBusy: true }));
  const r2 = plan({ targets: many, rules, repoOf, told: {} });
  assert.equal(r2.send.length, 0);
  assert.equal(r2.skipScript.length, 5);
});

test('message: names the commit and the precedence rule, and never asks the owner anything', () => {
  const m = message({ hash: H, at: T, subject: 'docs: autonomy by default' });
  for (const s of ['aaaaaaaaa', '2026-10-14T12:00Z', 'docs: autonomy by default', 'win over your task doc', 'never hand the owner commands', 'git show origin/main:AGENTS.md', 'STATUS']) assert.ok(m.includes(s), s);
});

function harness(t, { targets, mode = 'live' }) {
  const dir = mkdtempSync(join(tmpdir(), 'rules-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent = [], events = [], gitCalls = [], logs = [];
  const w = createRulesWatch({
    stateDir: dir, mode: () => mode, log: { error() {}, warn(...a) { logs.push(['warn', ...a]); } },
    git: async (cwd, args) => {
      gitCalls.push(args[0]);
      if (args[0] === 'rev-parse') return '/r/.git\n';
      if (args[0] === 'log') return `${H}\t${T / 1000}\tdocs: autonomy\n`;
      return '';
    },
    listTargets: async () => targets(),
    send: async (n, text) => { sent.push([n, text]); },
    record: async (e) => { events.push(e); },
  });
  return { w, dir, sent, events, gitCalls, logs };
}

test('tick: tells a stale idle session once, fetches each repo once, records one feed line, forgets ended sessions', async (t) => {
  let targets = [{ name: 'old', cwd: '/w/a', startedAt: T - 1e6, working: false, scriptBusy: false }, { name: 'old2', cwd: '/w/b', startedAt: T - 1e6, working: false, scriptBusy: false }];
  const h = harness(t, { targets: () => targets });
  await h.w.tick();
  assert.deepEqual(h.sent.map((s) => s[0]), ['old', 'old2']);
  assert.equal(h.gitCalls.filter((c) => c === 'fetch').length, 1);
  assert.deepEqual(h.events.map((e) => e.key), ['rules-watch:told']);
  await h.w.tick();
  assert.equal(h.sent.length, 2, 'not told twice');
  targets = [targets[0]];
  await h.w.tick();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(h.dir, 'rules-watch.json'), 'utf8')).told), ['old']);
});

test('tick: a working session waits for a later tick; dry mode only journals; off does nothing', async (t) => {
  let working = true;
  const h = harness(t, { targets: () => [{ name: 'busy', cwd: '/w', startedAt: T - 1, working, scriptBusy: false }] });
  await h.w.tick(); assert.equal(h.sent.length, 0);
  working = false; await h.w.tick(); assert.equal(h.sent.length, 1);
  const dry = harness(t, { targets: () => [{ name: 's', cwd: '/w', startedAt: T - 1, working: false, scriptBusy: false }], mode: 'dry' });
  await dry.w.tick();
  assert.equal(dry.sent.length, 0); assert.deepEqual(dry.events.map((e) => e.key), []);
  assert.match(readFileSync(join(dry.dir, 'rules-watch.jsonl'), 'utf8'), /"dry":true.*"session":"s"/);
  const off = harness(t, { targets: () => { throw new Error('must not list'); }, mode: 'off' });
  assert.equal((await off.w.tick()).mode, 'off');
});

test('tick: a busy host holds every message; the message tells an idle session to start nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rules-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let pr = { loadPerCore: 5, ramAvailPct: 50 };
  const sent = [];
  const w = createRulesWatch({ stateDir: dir, pressure: () => pr, log: { error() {} },
    git: async (c, a) => (a[0] === 'rev-parse' ? '/r/.git\n' : a[0] === 'log' ? `${H}\t${T / 1000}\ts\n` : ''),
    listTargets: async () => Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, cwd: '/w', startedAt: T - 1, working: false, scriptBusy: false })),
    send: async (n) => { sent.push(n); } });
  assert.match((await w.tick()).held, /host busy/); assert.equal(sent.length, 0);
  pr = { loadPerCore: 0.5, ramAvailPct: 10 }; await w.tick(); assert.equal(sent.length, 0);
  pr = { loadPerCore: 0.5, ramAvailPct: 50 }; await w.tick(); assert.equal(sent.length, 2, 'two per check');
  assert.match(message({ hash: H, at: T, subject: 's' }), /idle with nothing pending, start nothing new/);
});

test('tick: a script-busy session is skipped, logged as "skipped: script pane", and journaled, but is NOT told', async (t) => {
  // TASK33-pokemon-shape: an idle-looking pane whose process tree is a bash script driving
  // a non-interactive `claude -p` turn. rules-watch must NOT type into it; it would land
  // in the terminal input and get read by bash as commands when the script ends.
  const h = harness(t, { targets: () => [
    { name: 'TASK33-pokemon', cwd: '/w', startedAt: T - 1e6, working: false, scriptBusy: true },
    { name: 'plain', cwd: '/w', startedAt: T - 1e6, working: false, scriptBusy: false },
  ] });
  const snap = await h.w.tick();
  // only the non-scripted session is told; the scripted one is held back
  assert.deepEqual(h.sent.map((s) => s[0]), ['plain']);
  assert.deepEqual(snap.skipped, ['TASK33-pokemon']);
  assert.deepEqual(snap.stale, ['plain']);
  // the skip is logged with the exact label the task asks for
  assert.ok(h.logs.some((l) => l[0] === 'warn' && /skipped: script pane/.test(l[1]) && l.includes('TASK33-pokemon')), 'expected a "skipped: script pane" log for TASK33-pokemon');
  // the skip is journaled so the owner can see it in the feed
  const journal = readFileSync(join(h.dir, 'rules-watch.jsonl'), 'utf8');
  assert.match(journal, /"skipped":"script pane".*"session":"TASK33-pokemon"/);
  // the scripted session is NOT in the `told` map, so a later tick can still tell it once the script ends
  const told = JSON.parse(readFileSync(join(h.dir, 'rules-watch.json'), 'utf8')).told;
  assert.deepEqual(Object.keys(told), ['plain']);
});

// 2026-10-23: AGENTS.md had not been edited for a day, yet the feed fired dozens of times, each time naming a
// different rotating pair of sessions, because the title said "AGENTS.md changed". The owner read it as a fresh
// edit and went looking, every time. The title now states the relation that is actually true and cites the commit.
test('tick: the feed title never claims a change, and cites the commit in the message() shape', async (t) => {
  const h = harness(t, { targets: () => [{ name: 'old', cwd: '/w/a', startedAt: T - 1e6, working: false, scriptBusy: false }] });
  await h.w.tick();
  const e = h.events.at(-1);
  assert.equal(e.key, 'rules-watch:told');
  assert.ok(!/\bchang/i.test(e.title), `title must not claim a change happened: ${e.title}`);
  assert.ok(!/newer rules|updated rules|commit [0-9a-f]/.test(e.title), e.title);
  assert.equal(e.title, `AGENTS.md is newer than 1 session(s) - told to re-read (${stamp(RULES)})`);
  assert.equal(e.body, 'old');                                    // body is still exactly the session names
  // the same stamp the session itself reads, so title and message never disagree
  assert.ok(e.title.includes(H.slice(0, 9)), 'short hash in the title');
  assert.ok(h.sent[0][1].includes(stamp(RULES)), 'same stamp in the message');
});

test('tick: the same unchanged commit re-delivered to a restarted pair is a byte-identical title', async (t) => {
  const stale = (names) => names.map((n, i) => ({ name: n, cwd: `/w/${i}`, startedAt: T - 1e6, working: false, scriptBusy: false }));
  let targets = stale(['a1', 'a2']);
  const h = harness(t, { targets: () => targets });
  await h.w.tick();
  targets = stale(['b1', 'b2']);                                  // the pair restarted; AGENTS.md itself did not
  await h.w.tick();
  assert.deepEqual(h.sent.map((s) => s[0]), ['a1', 'a2', 'b1', 'b2']);
  assert.equal(h.events.length, 2);
  assert.equal(h.events[1].title, h.events[0].title, 'same commit + same count -> a reader sees a repeat, not an edit');
  assert.notEqual(h.events[1].body, h.events[0].body, 'the body still names this tick\'s own sessions');
});

test('tick: two repos with two different AGENTS.md commits cite both, one entry each', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rules-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repos = {
    '/w/a': { key: '/r1/.git', rules: { hash: H, at: T, subject: 'docs: one' } },
    '/w/b': { key: '/r2/.git', rules: { hash: H2, at: T - 86400e3, subject: 'docs: two' } },
  };
  const events = [];
  const w = createRulesWatch({
    stateDir: dir, log: { error() {} },
    git: async (cwd, args) => args[0] === 'rev-parse' ? `${repos[cwd].key}\n`
      : args[0] === 'log' ? `${repos[cwd].rules.hash}\t${repos[cwd].rules.at / 1000}\t${repos[cwd].rules.subject}\n` : '',
    listTargets: async () => Object.keys(repos).map((cwd, i) => ({ name: `s${i}`, cwd, startedAt: T - 7 * 86400e3, working: false, scriptBusy: false })),
    send: async () => {}, record: async (e) => { events.push(e); },
  });
  await w.tick();
  const e = events.at(-1);
  assert.equal(e.body, 's0, s1');
  assert.match(e.title, /is newer than 2 session\(s\)/);
  for (const r of Object.values(repos).map((x) => x.rules)) assert.ok(e.title.includes(stamp(r)), stamp(r));
});

test('tick: the body names exactly the sessions told, and MAX_SENDS_PER_TICK still caps the event', async (t) => {
  const targets = Array.from({ length: 3 }, (_, i) => ({ name: `s${i}`, cwd: '/w', startedAt: T - 1e6, working: false, scriptBusy: false }));
  const h = harness(t, { targets: () => targets });
  await h.w.tick();
  const e = h.events.at(-1);
  assert.deepEqual(h.sent.map((s) => s[0]), ['s0', 's1']);
  assert.equal(e.body, h.sent.map((s) => s[0]).join(', '));
  assert.match(e.title, /is newer than 2 session\(s\)/);
});
